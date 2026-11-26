import { randomBytes } from "node:crypto";

import { availabilityRules, bookings, chargers, hosts, payments, transfers, users } from "@nd/db";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import {
  authoriseBookingJob,
  expireRequestJob,
  hostTransferJob,
  noShowJob,
} from "../bookings/jobs.ts";
import { captureForBooking, createHostTransfer } from "../payments/settlement.ts";
import type { Services } from "../services.ts";
import { stripePaymentsFrom } from "../stripe/payments.ts";

const HOUR = 3_600_000;
const WEBHOOK_SECRET = "whsec_test_secret";

/** A clock the tests move forward; starts at the real time so pg-boss and Postgres agree. */
const clock = {
  current: new Date(),
  now() {
    return this.current;
  },
};

let h: Harness;
let driver: string;
let driverId: string;
let hostCookie: string;
let hostUserId: string;
let services: Services;

/** 22:00 UTC (22:00 in Dublin in winter), `days` days from the real date. */
function nightIn(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(22, 0, 0, 0);
  return date;
}

const call = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  cookie: string | undefined,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload }),
  });

/** A listed charger of the signed-in host, open 20:00–08:00 every day at 250 cents an hour. */
async function listCharger({ instantBook = true } = {}): Promise<string> {
  const [host] = await h.database.db
    .insert(hosts)
    .values({
      userId: hostUserId,
      payoutStatus: "enabled",
      stripeAccountId: "acct_host_1",
      maxSessionsPerDay: 10,
    })
    .onConflictDoUpdate({ target: hosts.userId, set: { payoutStatus: "enabled" } })
    .returning({ id: hosts.id });
  if (host === undefined) throw new Error("no host");
  const suffix = randomBytes(4).toString("hex");
  const [charger] = await h.database.db
    .insert(chargers)
    .values({
      hostId: host.id,
      model: "zappi_v2_1",
      serial: `2${suffix}`,
      chargeboxId: `ND${suffix}`,
      firmware: "5.794",
      maxKw: 7.4,
      connectorType: "tethered",
      location: { lat: 53.33, lng: -6.25 },
      address: "7 Test Row, Dublin 6",
      status: "online",
      acceptingBookings: true,
    })
    .returning({ id: chargers.id });
  if (charger === undefined) throw new Error("no charger");
  await h.database.db.insert(availabilityRules).values(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      chargerId: charger.id,
      weekday,
      startTime: "20:00",
      endTime: "08:00",
      pricePerHourCents: 250,
      instantBook,
    })),
  );
  return charger.id;
}

async function book(chargerId: string, start: Date, hours: number, cookie = driver) {
  return call("POST", "/bookings", cookie, {
    chargerId,
    from: start.toISOString(),
    to: new Date(start.getTime() + hours * HOUR).toISOString(),
    vehiclePlate: "251-d-1234",
  });
}

interface BookingBody {
  id: string;
  status: string;
  quotedAmountCents: number;
  feeCents: number;
  addressVisible: boolean;
  address: string | null;
  payment: {
    status: string;
    authorisedCents: number;
    capturedCents: number;
    authoriseAt: string | null;
  };
}

async function booked(chargerId: string, start: Date, hours = 4): Promise<BookingBody> {
  const response = await book(chargerId, start, hours);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<BookingBody>();
}

async function paymentOf(bookingId: string) {
  const [row] = await h.database.db
    .select()
    .from(payments)
    .where(eq(payments.bookingId, bookingId));
  if (row === undefined) throw new Error("no payment");
  return row;
}

async function bookingRow(bookingId: string) {
  const [row] = await h.database.db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (row === undefined) throw new Error("no booking");
  return row;
}

function signed(event: object) {
  const payload = JSON.stringify(event);
  return {
    payload,
    signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
  };
}

const postWebhook = (payload: string, signature: string) =>
  h.app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    payload,
  });

beforeAll(async () => {
  h = await startHarness({ clock });
  hostCookie = await h.user("niamh@example.com", "+353861230101");
  driver = await h.user("cian@example.com", "+353861230102");
  const [hostUser] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "niamh@example.com"));
  const [driverUser] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "cian@example.com"));
  if (hostUser === undefined || driverUser === undefined) throw new Error("users missing");
  hostUserId = hostUser.id;
  driverId = driverUser.id;

  // The driver saves a card: a SetupIntent, then (in the app) Stripe confirms it.
  const setup = await call("POST", "/me/payment-methods/setup-intent", driver);
  expect(setup.statusCode, setup.body).toBe(200);
  expect(setup.json()).toMatchObject({ clientSecret: expect.any(String) as unknown });
  const [withCustomer] = await h.database.db
    .select({ customerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, driverId));
  const customerId = withCustomer?.customerId ?? null;
  if (customerId === null) throw new Error("no customer");
  h.stripeMock.saveCard(customerId, "pm_card_driver");

  services = {
    db: h.database.db,
    clock,
    payments: stripePaymentsFrom(h.stripeMock.sdk),
    jobs: h.jobs,
    platformFeeBps: 0,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
});

afterAll(async () => {
  await h.close();
});

describe("payment methods", () => {
  it("lists saved cards with brand, last four and expiry only", async () => {
    const response = await call("GET", "/me/payment-methods", driver);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cards: [
        {
          id: "pm_card_driver",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        },
      ],
      defaultPaymentMethodId: "pm_card_driver",
    });
  });

  it("reuses the customer and lets the driver pick a default", async () => {
    const before = h.stripeMock.created.length;
    expect((await call("POST", "/me/payment-methods/setup-intent", driver)).statusCode).toBe(200);
    const [row] = await h.database.db
      .select({ customerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, driverId));
    const second = h.stripeMock.saveCard(row?.customerId ?? "", "pm_card_second");
    const chosen = await call("POST", "/me/payment-methods/default", driver, {
      paymentMethodId: second,
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({ defaultPaymentMethodId: "pm_card_second" });
    const back = await call("POST", "/me/payment-methods/default", driver, {
      paymentMethodId: "pm_card_driver",
    });
    expect(back.json()).toMatchObject({ defaultPaymentMethodId: "pm_card_driver" });
    const unknown = await call("POST", "/me/payment-methods/default", driver, {
      paymentMethodId: "pm_someone_else",
    });
    expect(unknown.statusCode).toBe(404);
    expect(h.stripeMock.created.length).toBe(before);
  });

  it("is empty for a user without a customer", async () => {
    const cookie = await h.user("aoife@example.com");
    const response = await call("GET", "/me/payment-methods", cookie);
    expect(response.json()).toEqual({ cards: [], defaultPaymentMethodId: null });
  });
});

describe("POST /bookings", () => {
  it("quotes 4 hours at €2.50 at 1000 cents with no fee, and authorises it at once", async () => {
    const chargerId = await listCharger();
    const before = h.stripeMock.created.length;
    const body = await booked(chargerId, nightIn(2), 4);
    expect(body).toMatchObject({
      status: "confirmed",
      quotedAmountCents: 1000,
      feeCents: 0,
      payment: { status: "authorised", authorisedCents: 1000, capturedCents: 0 },
      addressVisible: true,
      address: "7 Test Row, Dublin 6",
    });
    expect(h.stripeMock.created.length).toBe(before + 1);
    const params = h.stripeMock.created.at(-1);
    expect(params).toMatchObject({
      amount: 1000,
      currency: "eur",
      capture_method: "manual",
      confirm: true,
      off_session: true,
      payment_method: "pm_card_driver",
      transfer_group: body.id,
    });
    expect(params).not.toHaveProperty("application_fee_amount");
    expect(params).not.toHaveProperty("transfer_data");
    const payment = await paymentOf(body.id);
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe(
      "requires_capture",
    );
    const row = await bookingRow(body.id);
    expect(row.idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect(row.pricePerHourCents).toBe(250);
    expect(row.vehiclePlate).toBe("251-D-1234");
  });

  it("refuses an overlapping slot with 409 and creates no PaymentIntent", async () => {
    const chargerId = await listCharger();
    await booked(chargerId, nightIn(3), 4);
    const before = h.stripeMock.created.length;
    const other = await h.user("sam@example.com", "+353861230103");
    const response = await book(chargerId, new Date(nightIn(3).getTime() + 2 * HOUR), 2, other);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "slot-taken" });
    expect(h.stripeMock.created.length).toBe(before);
  });

  it("saves the card for a far slot and authorises it with a job 24 hours ahead", async () => {
    const chargerId = await listCharger();
    const start = nightIn(10);
    const before = h.stripeMock.created.length;
    const body = await booked(chargerId, start, 4);
    const authoriseAt = new Date(start.getTime() - 24 * HOUR);
    expect(body.payment).toMatchObject({
      status: "card_saved",
      authorisedCents: 0,
      authoriseAt: authoriseAt.toISOString(),
    });
    expect(h.stripeMock.created.length).toBe(before);

    const jobs = await h.database.db.execute<{ start_after: Date; singleton_key: string }>(
      sql`select start_after, singleton_key from pgboss.job
          where name = ${authoriseBookingJob.name} and data->>'bookingId' = ${body.id}`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(new Date(jobs.rows[0]?.start_after ?? 0).toISOString()).toBe(authoriseAt.toISOString());
    expect(jobs.rows[0]?.singleton_key).toBe(body.id);

    await h.jobs.runNow(authoriseBookingJob, { bookingId: body.id });
    const payment = await paymentOf(body.id);
    expect(payment).toMatchObject({ status: "authorised", authorisedCents: 1000 });
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe(
      "requires_capture",
    );
    // Running it again changes nothing.
    await h.jobs.runNow(authoriseBookingJob, { bookingId: body.id });
    expect(h.stripeMock.created.length).toBe(before + 1);
  });

  it("cancels the booking at no charge when the saved card is declined on the last attempt", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(11), 4);
    h.stripeMock.declineNext("insufficient_funds");
    await h.jobs.runNow(authoriseBookingJob, { bookingId: body.id });
    expect(await paymentOf(body.id)).toMatchObject({
      status: "failed",
      failureReason: "insufficient_funds",
    });
    expect(await bookingRow(body.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      cancellationReason: "payment_failed: insufficient_funds",
    });
  });

  it("answers 402 and cancels the booking when the card is declined at booking", async () => {
    const chargerId = await listCharger();
    h.stripeMock.declineNext("card_declined");
    const response = await book(chargerId, nightIn(1), 3);
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ code: "payment-declined" });
    const [row] = await h.database.db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.chargerId, chargerId));
    expect(row?.status).toBe("cancelled");
    // The slot is free again.
    expect((await book(chargerId, nightIn(1), 3)).statusCode).toBe(201);
  });

  it("keeps windows inside the host's availability and under the daily cap", async () => {
    const chargerId = await listCharger();
    const morning = new Date(nightIn(4).getTime() + 9 * HOUR); // 07:00 → 09:00 runs past 08:00
    const outside = await book(chargerId, morning, 2);
    expect(outside.statusCode).toBe(422);
    expect(outside.json()).toMatchObject({ code: "outside-availability" });

    await h.database.db
      .update(hosts)
      .set({ maxSessionsPerDay: 1 })
      .where(eq(hosts.userId, hostUserId));
    await booked(chargerId, nightIn(13), 1);
    const second = await book(chargerId, new Date(nightIn(13).getTime() + HOUR), 1);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "host-day-full" });
    await h.database.db
      .update(hosts)
      .set({ maxSessionsPerDay: 10 })
      .where(eq(hosts.userId, hostUserId));
  });

  it("needs a verified phone and a saved card", async () => {
    const chargerId = await listCharger();
    const unverified = await h.user("oisin@example.com");
    expect((await book(chargerId, nightIn(6), 2, unverified)).statusCode).toBe(403);
    const noCard = await h.user("roisin@example.com", "+353861230104");
    const response = await book(chargerId, nightIn(6), 2, noCard);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "payment-method-required" });
  });
});

describe("cancellation", () => {
  it("before the cutoff releases the authorisation", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(2), 4);
    const response = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      cancelledBy: "driver",
      feeCents: 0,
      payment: { status: "cancelled", capturedCents: 0 },
      addressVisible: false,
      address: null,
    });
    const payment = await paymentOf(body.id);
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe("canceled");
    const again = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
    expect(again.statusCode).toBe(409);
  });

  it("after the cutoff captures only the fee of one hour, and holds the host's transfer", async () => {
    const chargerId = await listCharger();
    const start = nightIn(3);
    const body = await booked(chargerId, start, 4);
    clock.current = new Date(start.getTime() - HOUR);
    try {
      const response = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        status: "cancelled",
        feeCents: 250,
        payment: { status: "captured", authorisedCents: 1000, capturedCents: 250 },
      });
    } finally {
      clock.current = new Date();
    }
    const payment = await paymentOf(body.id);
    const intent = h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "");
    expect(intent).toMatchObject({ status: "succeeded", amount_received: 250 });
    expect(payment.stripeChargeId).toBe(intent?.latest_charge);

    await h.jobs.drain();
    const [transfer] = await h.database.db
      .select()
      .from(transfers)
      .where(eq(transfers.paymentId, payment.id));
    expect(transfer).toMatchObject({
      status: "held",
      holdReason: "tax_details_incomplete",
      amountCents: 250,
    });
  });

  it("is free for the driver when the host cancels", async () => {
    const chargerId = await listCharger();
    const start = nightIn(4);
    const body = await booked(chargerId, start, 2);
    clock.current = new Date(start.getTime() - HOUR);
    try {
      const response = await call("POST", `/bookings/${body.id}/cancel`, hostCookie, {
        reason: "Charger needs a repair",
      });
      expect(response.json()).toMatchObject({
        role: "host",
        cancelledBy: "host",
        cancellationReason: "Charger needs a repair",
        feeCents: 0,
      });
    } finally {
      clock.current = new Date();
    }
  });

  it("is refused once the driver has arrived, and to strangers", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(5), 2);
    const stranger = await h.user("eoin@example.com", "+353861230105");
    expect((await call("POST", `/bookings/${body.id}/cancel`, stranger, {})).statusCode).toBe(404);
    await h.database.db.update(bookings).set({ status: "arrived" }).where(eq(bookings.id, body.id));
    const response = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "cannot-cancel" });
  });
});

describe("host approval", () => {
  it("approves a request: confirmed, with an idTag", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const body = await booked(chargerId, nightIn(2), 3);
    expect(body).toMatchObject({ status: "requested", addressVisible: false, address: null });
    expect((await bookingRow(body.id)).idTag).toBeNull();
    expect(
      (await call("POST", `/bookings/${body.id}/approve`, driver)).statusCode,
      "only the host approves",
    ).toBe(404);
    const response = await call("POST", `/bookings/${body.id}/approve`, hostCookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "confirmed", role: "host" });
    expect((await bookingRow(body.id)).idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect((await call("POST", `/bookings/${body.id}/approve`, hostCookie)).statusCode).toBe(409);
  });

  it("declines a request and cancels its PaymentIntent", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const body = await booked(chargerId, nightIn(3), 3);
    const response = await call("POST", `/bookings/${body.id}/decline`, hostCookie, {});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      cancelledBy: "host",
      cancellationReason: "declined",
      payment: { status: "cancelled" },
    });
    const payment = await paymentOf(body.id);
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe("canceled");
  });

  it("expires a request the host never answered, releasing the authorisation", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const start = nightIn(4);
    const body = await booked(chargerId, start, 3);
    await h.jobs.runNow(expireRequestJob, { bookingId: body.id });
    expect((await bookingRow(body.id)).status, "not before the slot starts").toBe("requested");
    clock.current = new Date(start.getTime() + 60_000);
    try {
      await h.jobs.runNow(expireRequestJob, { bookingId: body.id });
    } finally {
      clock.current = new Date();
    }
    expect(await bookingRow(body.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "host_did_not_respond",
    });
    expect((await paymentOf(body.id)).status).toBe("cancelled");
  });
});

describe("no-show job", () => {
  it("marks a confirmed booking never arrived at as a no-show and captures the fee", async () => {
    const chargerId = await listCharger();
    const start = nightIn(2);
    const body = await booked(chargerId, start, 4);
    const jobs = await h.database.db.execute<{ start_after: Date }>(
      sql`select start_after from pgboss.job
          where name = ${noShowJob.name} and data->>'bookingId' = ${body.id}`,
    );
    expect(new Date(jobs.rows[0]?.start_after ?? 0).toISOString()).toBe(
      new Date(start.getTime() + 4 * HOUR + 15 * 60_000).toISOString(),
    );
    clock.current = new Date(start.getTime() + 4 * HOUR + 16 * 60_000);
    try {
      await h.jobs.runNow(noShowJob, { bookingId: body.id });
    } finally {
      clock.current = new Date();
    }
    expect(await bookingRow(body.id)).toMatchObject({
      status: "no_show",
      cancellationFeeCents: 250,
    });
    expect(await paymentOf(body.id)).toMatchObject({ status: "captured", capturedCents: 250 });
  });
});

describe("capture and transfer helpers", () => {
  it("never capture above the authorisation, are idempotent, and transfer from the charge", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(5), 4);
    await expect(captureForBooking(services, body.id, 1001)).rejects.toThrow(RangeError);
    const first = await captureForBooking(services, body.id, 900);
    const second = await captureForBooking(services, body.id, 900);
    expect(second).toEqual(first);
    await expect(captureForBooking(services, body.id, 800)).rejects.toThrow(/another amount/);

    await h.database.db
      .update(hosts)
      .set({ taxDetailsComplete: true })
      .where(eq(hosts.userId, hostUserId));
    const transfer = await createHostTransfer(services, first.paymentId);
    expect(transfer).toMatchObject({ status: "sent", amountCents: 900, holdReason: null });
    expect(h.stripeMock.transfers.at(-1)).toMatchObject({
      amount: 900,
      currency: "eur",
      destination: "acct_host_1",
      source_transaction: first.chargeId,
      transfer_group: body.id,
    });
    const forBooking = () =>
      h.stripeMock.transfers.filter((sent) => sent.transfer_group === body.id).length;
    expect(forBooking()).toBe(1);
    expect(await createHostTransfer(services, first.paymentId)).toMatchObject({ status: "sent" });
    await h.jobs.send(hostTransferJob, { paymentId: first.paymentId });
    await h.jobs.drain();
    expect(forBooking()).toBe(1);
  });
});

describe("reading bookings", () => {
  it("shows a booking to its driver and host only, and lists them", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(7), 2);
    const asHost = await call("GET", `/bookings/${body.id}`, hostCookie);
    expect(asHost.json()).toMatchObject({
      role: "host",
      driverFirstName: expect.any(String) as unknown,
      vehiclePlate: "251-D-1234",
      address: "7 Test Row, Dublin 6",
    });
    const asDriver = await call("GET", `/bookings/${body.id}`, driver);
    expect(asDriver.json()).toMatchObject({ role: "driver", driverFirstName: null });
    const stranger = await h.user("aine@example.com");
    expect((await call("GET", `/bookings/${body.id}`, stranger)).statusCode).toBe(404);

    const mine = await call("GET", "/bookings?status=confirmed", driver);
    expect(mine.json<{ bookings: { id: string }[] }>().bookings.map((b) => b.id)).toContain(
      body.id,
    );
    const window = `from=${nightIn(7).toISOString()}&to=${nightIn(8).toISOString()}`;
    const hostList = await call("GET", `/hosts/bookings?status=confirmed&${window}`, hostCookie);
    expect(hostList.statusCode, hostList.body).toBe(200);
    expect(hostList.json<{ bookings: { id: string }[] }>().bookings.map((b) => b.id)).toEqual([
      body.id,
    ]);
    const empty = await call("GET", "/hosts/bookings", stranger);
    expect(empty.json()).toEqual({ bookings: [] });
  });
});

describe("POST /webhooks/stripe", () => {
  it("rejects a bad signature", async () => {
    const { payload } = signed({ id: "evt_bad", type: "account.updated", data: { object: {} } });
    const response = await postWebhook(payload, "t=1,v1=deadbeef");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid-signature" });
  });

  it("mirrors account.updated onto the host, so publishing then succeeds, and skips a replay", async () => {
    const chargerId = await listCharger();
    await h.database.db
      .update(hosts)
      .set({ payoutStatus: "pending", stripeAccountId: "acct_host_1" })
      .where(eq(hosts.userId, hostUserId));
    const blocked = await call("PATCH", `/hosts/chargers/${chargerId}`, hostCookie, {
      acceptingBookings: true,
    });
    expect(blocked.statusCode).toBe(409);

    const event = {
      id: `evt_${randomBytes(6).toString("hex")}`,
      object: "event",
      type: "account.updated",
      data: {
        object: {
          id: "acct_host_1",
          object: "account",
          charges_enabled: false,
          payouts_enabled: true,
          capabilities: { transfers: "active" },
          requirements: { disabled_reason: null },
        },
      },
    };
    const { payload, signature } = signed(event);
    const first = await postWebhook(payload, signature);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ received: true, outcome: "processed" });
    const [host] = await h.database.db
      .select({ payoutStatus: hosts.payoutStatus })
      .from(hosts)
      .where(eq(hosts.userId, hostUserId));
    expect(host?.payoutStatus).toBe("enabled");

    const published = await call("PATCH", `/hosts/chargers/${chargerId}`, hostCookie, {
      acceptingBookings: true,
    });
    expect(published.statusCode, published.body).toBe(200);

    await h.database.db
      .update(hosts)
      .set({ payoutStatus: "pending" })
      .where(eq(hosts.userId, hostUserId));
    const replay = await postWebhook(payload, signature);
    expect(replay.json()).toEqual({ received: true, outcome: "duplicate" });
    const [after] = await h.database.db
      .select({ payoutStatus: hosts.payoutStatus })
      .from(hosts)
      .where(eq(hosts.userId, hostUserId));
    expect(after?.payoutStatus, "a replay changes nothing").toBe("pending");
    await h.database.db
      .update(hosts)
      .set({ payoutStatus: "enabled" })
      .where(eq(hosts.userId, hostUserId));
  });

  it("records PaymentIntent events against the payment", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(8), 2);
    const payment = await paymentOf(body.id);
    const { payload, signature } = signed({
      id: `evt_${randomBytes(6).toString("hex")}`,
      object: "event",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: payment.stripePaymentIntentId,
          object: "payment_intent",
          metadata: { bookingId: body.id },
        },
      },
    });
    const response = await postWebhook(payload, signature);
    expect(response.json()).toEqual({ received: true, outcome: "processed" });
    expect((await paymentOf(body.id)).status).toBe("cancelled");
  });
});
