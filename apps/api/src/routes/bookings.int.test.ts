import { randomBytes } from "node:crypto";

import { availabilityRules, bookings, chargers, hosts, payments, refunds, users } from "@nd/db";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { expireRequestJob, noShowJob, resumePaymentJob } from "../bookings/jobs.ts";
import { createBooking } from "../bookings/lifecycle.ts";
import type { Services } from "../services.ts";
import { stripePaymentsFrom } from "../stripe/payments.ts";
import { DEFAULT_TIMINGS } from "../timings.ts";

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
      taxDetailsComplete: true,
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
  addressVisible: boolean;
  address: string | null;
  payment: { status: string; amountCents: number };
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

async function refundsOf(paymentId: string) {
  return h.database.db.select().from(refunds).where(eq(refunds.paymentId, paymentId));
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
    fees: { platformFeeBps: 0, cardFeeBps: 150, cardFeeFixedCents: 25 },
    taxRecordRetentionYears: 6,
    timings: DEFAULT_TIMINGS,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    email: h.mail.email,
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
  it("prices 4 hours at €2.50 at 1000 cents and charges it upfront to the host's account", async () => {
    const chargerId = await listCharger();
    const before = h.stripeMock.created.length;
    const body = await booked(chargerId, nightIn(2), 4);
    expect(body).toMatchObject({
      status: "confirmed",
      quotedAmountCents: 1000,
      payment: { status: "paid", amountCents: 1000 },
      addressVisible: true,
      address: "7 Test Row, Dublin 6",
    });
    expect(h.stripeMock.created.length).toBe(before + 1);
    const params = h.stripeMock.created.at(-1);
    expect(params).toMatchObject({
      amount: 1000,
      currency: "eur",
      capture_method: "automatic",
      confirm: true,
      off_session: true,
      payment_method: "pm_card_driver",
      // A destination charge: the card fee estimate (1.5 % + 25 cents) is passed on to the host.
      transfer_data: { destination: "acct_host_1" },
      application_fee_amount: 40,
      transfer_group: body.id,
    });
    const payment = await paymentOf(body.id);
    expect(payment).toMatchObject({
      amountCents: 1000,
      cardFeeCents: 40,
      platformFeeCents: 0,
      captureMethod: "automatic",
    });
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe("succeeded");
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

  it("charges a slot weeks away upfront as well", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(30), 4);
    expect(body.payment).toEqual({ status: "paid", amountCents: 1000 });
  });

  it("answers 402 and cancels the booking when the card is declined", async () => {
    const chargerId = await listCharger();
    h.stripeMock.declineNext("card_declined");
    const response = await book(chargerId, nightIn(1), 3);
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ code: "payment-declined" });
    const [row] = await h.database.db
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.chargerId, chargerId));
    expect(row?.status).toBe("cancelled");
    expect(await paymentOf(row?.id ?? "")).toMatchObject({
      status: "failed",
      failureReason: "card_declined",
    });
    // The slot is free again.
    expect((await book(chargerId, nightIn(1), 3)).statusCode).toBe(201);
  });

  it("keeps windows inside the host's availability", async () => {
    const chargerId = await listCharger();
    const morning = new Date(nightIn(4).getTime() + 9 * HOUR); // 07:00 → 09:00 runs past 08:00
    const outside = await book(chargerId, morning, 2);
    expect(outside.statusCode).toBe(422);
    expect(outside.json()).toMatchObject({ code: "outside-availability" });
  });

  it("holds the host's daily cap when bookings race", async () => {
    const chargerId = await listCharger();
    const other = await listCharger();
    await h.database.db
      .update(hosts)
      .set({ maxSessionsPerDay: 1 })
      .where(eq(hosts.userId, hostUserId));
    try {
      const start = nightIn(13);
      // Two drivers book two of the host's chargers for the same night at the same moment.
      const [first, second] = await Promise.all([
        createBooking(services, {
          driverId,
          chargerId,
          window: { start, end: new Date(start.getTime() + HOUR) },
          vehiclePlate: "251-D-1",
          paymentMethodId: undefined,
        }).then(
          () => "booked",
          (error: unknown) => (error as { code?: string }).code,
        ),
        createBooking(services, {
          driverId,
          chargerId: other,
          window: { start, end: new Date(start.getTime() + HOUR) },
          vehiclePlate: "251-D-2",
          paymentMethodId: undefined,
        }).then(
          () => "booked",
          (error: unknown) => (error as { code?: string }).code,
        ),
      ]);
      expect([first, second].sort()).toEqual(["booked", "host-day-full"]);
    } finally {
      await h.database.db
        .update(hosts)
        .set({ maxSessionsPerDay: 10 })
        .where(eq(hosts.userId, hostUserId));
    }
  });

  it("lets a driver keep at most 3 requests waiting", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const asker = await h.user("fionn@example.com", "+353861230106");
    const [askerUser] = await h.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "fionn@example.com"));
    await call("POST", "/me/payment-methods/setup-intent", asker);
    const [row] = await h.database.db
      .select({ customerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, askerUser?.id ?? ""));
    h.stripeMock.saveCard(row?.customerId ?? "", "pm_card_fionn");
    for (const days of [20, 21, 22]) {
      expect((await book(chargerId, nightIn(days), 1, asker)).statusCode).toBe(201);
    }
    const fourth = await book(chargerId, nightIn(23), 1, asker);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toMatchObject({ code: "too-many-requests" });
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
  it("before the cutoff refunds the driver in full, reversing the host's share and the fee", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(2), 4);
    const response = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      cancelledBy: "driver",
      payment: { status: "paid" },
      addressVisible: false,
      address: null,
    });
    const payment = await paymentOf(body.id);
    expect(await refundsOf(payment.id)).toMatchObject([
      { amountCents: 1000, reason: "driver_cancelled", status: "succeeded" },
    ]);
    expect(h.stripeMock.refunds.at(-1)).toMatchObject({
      payment_intent: payment.stripePaymentIntentId,
      amount: 1000,
      reverse_transfer: true,
      refund_application_fee: true,
    });
    const again = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
    expect(again.statusCode).toBe(409);
  });

  it("after the cutoff refunds the driver nothing", async () => {
    const chargerId = await listCharger();
    const start = nightIn(3);
    const body = await booked(chargerId, start, 4);
    const refundsBefore = h.stripeMock.refunds.length;
    clock.current = new Date(start.getTime() - HOUR);
    try {
      const response = await call("POST", `/bookings/${body.id}/cancel`, driver, {});
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: "cancelled", payment: { status: "paid" } });
    } finally {
      clock.current = new Date();
    }
    expect(await refundsOf((await paymentOf(body.id)).id)).toEqual([]);
    expect(h.stripeMock.refunds.length).toBe(refundsBefore);
  });

  it("refunds the driver in full when the host cancels, however late", async () => {
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
      });
    } finally {
      clock.current = new Date();
    }
    expect(await refundsOf((await paymentOf(body.id)).id)).toMatchObject([
      { amountCents: 500, reason: "host_cancelled", status: "succeeded" },
    ]);
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

  it("records the refund with the cancellation, so a refund Stripe did not take is resumed", async () => {
    const chargerId = await listCharger();
    const body = await booked(chargerId, nightIn(9), 2);
    const payment = await paymentOf(body.id);
    // The refund was recorded, but the process stopped before Stripe was called.
    await h.database.db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: "driver" })
      .where(eq(bookings.id, body.id));
    await h.database.db.insert(refunds).values({
      paymentId: payment.id,
      amountCents: 500,
      currency: "EUR",
      reason: "driver_cancelled",
    });
    await h.jobs.runNow(resumePaymentJob, { paymentId: payment.id });
    expect(await refundsOf(payment.id)).toMatchObject([{ status: "succeeded" }]);
    const sent = h.stripeMock.refunds.filter(
      (refund) => refund.payment_intent === payment.stripePaymentIntentId,
    );
    expect(sent).toHaveLength(1);
    // Resuming again sends nothing more.
    await h.jobs.runNow(resumePaymentJob, { paymentId: payment.id });
    expect(
      h.stripeMock.refunds.filter(
        (refund) => refund.payment_intent === payment.stripePaymentIntentId,
      ),
    ).toHaveLength(1);
  });
});

describe("host approval", () => {
  it("holds a request's price, and charges it when the host approves", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const body = await booked(chargerId, nightIn(2), 3);
    expect(body).toMatchObject({
      status: "requested",
      addressVisible: false,
      address: null,
      payment: { status: "authorised" },
    });
    expect(h.stripeMock.created.at(-1)).toMatchObject({ capture_method: "manual" });
    expect((await bookingRow(body.id)).idTag).toBeNull();
    expect(
      (await call("POST", `/bookings/${body.id}/approve`, driver)).statusCode,
      "only the host approves",
    ).toBe(404);
    const response = await call("POST", `/bookings/${body.id}/approve`, hostCookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "confirmed",
      role: "host",
      payment: { status: "paid", amountCents: 750 },
    });
    expect((await bookingRow(body.id)).idTag).toMatch(/^[A-Z2-9]{20}$/);
    const payment = await paymentOf(body.id);
    expect(h.stripeMock.intents.get(payment.stripePaymentIntentId ?? "")?.status).toBe("succeeded");
    expect((await call("POST", `/bookings/${body.id}/approve`, hostCookie)).statusCode).toBe(409);
  });

  it("declines a request and releases its hold", async () => {
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

  it("expires a request the host did not answer within 24 hours, releasing the hold", async () => {
    const chargerId = await listCharger({ instantBook: false });
    const start = nightIn(4);
    const body = await booked(chargerId, start, 3);
    const jobs = await h.database.db.execute<{ start_after: Date }>(
      sql`select start_after from pgboss.job
          where name = ${expireRequestJob.name} and data->>'bookingId' = ${body.id}`,
    );
    const expiresAt = new Date(jobs.rows[0]?.start_after ?? 0);
    const created = (await bookingRow(body.id)).createdAt;
    expect(expiresAt.toISOString()).toBe(new Date(created.getTime() + 24 * HOUR).toISOString());
    await h.jobs.runNow(expireRequestJob, { bookingId: body.id });
    expect((await bookingRow(body.id)).status, "not before it expires").toBe("requested");
    clock.current = new Date(expiresAt.getTime() + 60_000);
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
  it("marks a confirmed booking never arrived at as a no-show, keeping what was paid", async () => {
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
    expect((await bookingRow(body.id)).status).toBe("no_show");
    const payment = await paymentOf(body.id);
    expect(payment.status).toBe("paid");
    expect(await refundsOf(payment.id)).toEqual([]);
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
    const chargerId = await listCharger({ instantBook: false });
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
