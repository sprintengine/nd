import { randomBytes } from "node:crypto";

import {
  availabilityRules,
  bookings,
  chargers,
  disputes,
  hosts,
  meterValues,
  payments,
  sessions,
  transfers,
  users,
} from "@nd/db";
import { billedAmount, CHARGER_EVENTS_CHANNEL } from "@nd/domain";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { stripePaymentsFrom } from "../stripe/payments.ts";
import {
  confirmationTimeoutJob,
  reconcileSessionJob,
  settlementSweepJob,
  weeklyPayoutSummaryJob,
} from "./jobs.ts";
import { reconcileSession } from "./reconcile.ts";
import type { SettlementServices } from "./services.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEBHOOK_SECRET = "whsec_test_secret";

/** A clock the tests move; starts at the real time so pg-boss and Postgres agree. */
const clock = {
  current: new Date(),
  now() {
    return this.current;
  },
};
const admins: string[] = [];

let h: Harness;
let driver: string;
let driverId: string;
let hostCookie: string;
let hostUserId: string;
let hostId: string;
let stranger: string;
let services: SettlementServices;

/** 22:00 UTC (22:00 in Dublin in winter), `days` days from the real date. */
function nightIn(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(22, 0, 0, 0);
  return date;
}

const call = (method: "GET" | "POST" | "PUT", url: string, cookie?: string, payload?: object) =>
  h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload }),
  });

async function userId(email: string): Promise<string> {
  const [row] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
}

/** A new listed charger of the host, open 20:00–08:00 every day at 250 cents an hour. */
async function listCharger(): Promise<string> {
  const suffix = randomBytes(4).toString("hex");
  const [charger] = await h.database.db
    .insert(chargers)
    .values({
      hostId,
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
      instantBook: true,
    })),
  );
  return charger.id;
}

interface Booked {
  bookingId: string;
  chargerId: string;
  slot: { start: Date; end: Date };
}

/** A 4-hour booking tomorrow night (quote 1000 cents), authorised on the driver's card. */
async function book(): Promise<Booked> {
  const chargerId = await listCharger();
  const start = nightIn(1);
  const end = new Date(start.getTime() + 4 * HOUR);
  const response = await call("POST", "/bookings", driver, {
    chargerId,
    from: start.toISOString(),
    to: end.toISOString(),
    vehiclePlate: "251-d-1234",
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ id: string; quotedAmountCents: number; payment: object }>();
  expect(body.quotedAmountCents).toBe(1000);
  expect(body.payment).toMatchObject({ status: "authorised", authorisedCents: 1000 });
  return { bookingId: body.id, chargerId, slot: { start, end } };
}

/** A session for the booking, with meter samples; the booking becomes active or completed. */
async function insertSession(
  booked: Booked,
  values: {
    status: "charging" | "stopped";
    minutes: number;
    meterStartWh: number;
    meterStopWh?: number;
    samples: readonly { minute: number; energyWh: number }[];
  },
): Promise<string> {
  const startedAt = booked.slot.start;
  const stopped = values.status === "stopped";
  await h.database.db
    .update(bookings)
    .set({ status: stopped ? "completed" : "active" })
    .where(eq(bookings.id, booked.bookingId));
  const [session] = await h.database.db
    .insert(sessions)
    .values({
      bookingId: booked.bookingId,
      status: values.status,
      startedAt,
      meterStartWh: values.meterStartWh,
      ...(stopped
        ? {
            stoppedAt: new Date(startedAt.getTime() + values.minutes * MINUTE),
            meterStopWh: values.meterStopWh,
            stopReason: "Remote",
          }
        : {}),
    })
    .returning({ id: sessions.id });
  if (session === undefined) throw new Error("no session");
  await h.database.db.insert(meterValues).values(
    values.samples.map((sample) => ({
      sessionId: session.id,
      ts: new Date(startedAt.getTime() + sample.minute * MINUTE),
      energyWh: sample.energyWh,
      powerW: 7000,
    })),
  );
  return session.id;
}

async function sessionRow(sessionId: string) {
  const [row] = await h.database.db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (row === undefined) throw new Error("no session");
  return row;
}

async function paymentOf(bookingId: string) {
  const [row] = await h.database.db
    .select()
    .from(payments)
    .where(eq(payments.bookingId, bookingId));
  if (row === undefined) throw new Error("no payment");
  return row;
}

async function transferOf(bookingId: string) {
  const payment = await paymentOf(bookingId);
  const [row] = await h.database.db
    .select()
    .from(transfers)
    .where(eq(transfers.paymentId, payment.id));
  return row;
}

/** Captures stripe-mock recorded for a booking's PaymentIntent. */
async function capturesOf(bookingId: string) {
  const payment = await paymentOf(bookingId);
  return h.stripeMock.captures.filter((capture) => capture.id === payment.stripePaymentIntentId);
}

const transfersSentFor = (bookingId: string) =>
  h.stripeMock.transfers.filter((sent) => sent.transfer_group === bookingId);

/** A stopped session of 3 h 39 min with 22.5 kWh delivered, the last MeterValue agreeing. */
const STOPPED_219 = {
  status: "stopped",
  minutes: 219,
  meterStartWh: 1_000,
  meterStopWh: 23_500,
  samples: [
    { minute: 60, energyWh: 8_000 },
    { minute: 218, energyWh: 23_400 },
  ],
} as const;

beforeAll(async () => {
  h = await startHarness({ clock, config: { adminUserIds: admins } });
  hostCookie = await h.user("niamh@example.com", "+353861230201");
  driver = await h.user("cian@example.com", "+353861230202");
  stranger = await h.user("aoife@example.com", "+353861230203");
  hostUserId = await userId("niamh@example.com");
  driverId = await userId("cian@example.com");
  admins.push(await userId("aoife@example.com"));

  const [host] = await h.database.db
    .insert(hosts)
    .values({
      userId: hostUserId,
      payoutStatus: "enabled",
      stripeAccountId: "acct_host_1",
      taxDetailsComplete: true,
      maxSessionsPerDay: 20,
    })
    .returning({ id: hosts.id });
  if (host === undefined) throw new Error("no host");
  hostId = host.id;

  const setup = await call("POST", "/me/payment-methods/setup-intent", driver);
  expect(setup.statusCode, setup.body).toBe(200);
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
    email: h.mail.email,
    realtime: { bookingChanged: () => undefined, sessionChanged: () => undefined },
  };
});

afterAll(async () => {
  await h.close();
});

describe("reconciliation", () => {
  let booked: Booked;
  let sessionId: string;

  it("reconciles on session_stopped: 3 h 39 min at €2.50 with a 4-hour quote", async () => {
    booked = await book();
    sessionId = await insertSession(booked, STOPPED_219);
    const event = {
      v: 1,
      type: "session_stopped",
      at: new Date().toISOString(),
      chargerId: booked.chargerId,
      chargeboxId: "NDTEST",
      sessionId,
      bookingId: booked.bookingId,
      transactionId: 1,
      sessionStatus: "stopped",
      meterStopWh: 23_500,
      kwh: 22.5,
      reason: "Remote",
    };
    // The gateway publishes on NOTIFY; the API's LISTEN dispatcher queues the job.
    await h.database.db.execute(
      sql`select pg_notify(${CHARGER_EVENTS_CHANNEL}, ${JSON.stringify(event)})`,
    );
    await vi.waitFor(
      async () => {
        await h.jobs.drain();
        expect((await sessionRow(sessionId)).status).toBe("reconciled");
      },
      { timeout: 10_000, interval: 200 },
    );

    const expected = billedAmount(
      booked.slot.start,
      new Date(booked.slot.start.getTime() + 219 * MINUTE),
      250,
      1000,
    );
    expect(expected).toBe(917);
    expect(expected).toBeLessThan(1000);
    expect(await capturesOf(booked.bookingId)).toEqual([
      expect.objectContaining({ amount: expected }),
    ]);
    expect(await paymentOf(booked.bookingId)).toMatchObject({
      status: "captured",
      capturedCents: expected,
      platformFeeCents: 0,
    });
    expect(await sessionRow(sessionId)).toMatchObject({ kwh: 22.5, reviewReason: null });
    expect(await transferOf(booked.bookingId)).toMatchObject({
      status: "sent",
      amountCents: expected,
    });
    expect(transfersSentFor(booked.bookingId)).toEqual([
      expect.objectContaining({ amount: expected, destination: "acct_host_1" }),
    ]);
  });

  it("is a no-op when run again", async () => {
    await expect(reconcileSession(services, sessionId)).resolves.toBe("already_reconciled");
    await h.jobs.runNow(reconcileSessionJob, { sessionId });
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await capturesOf(booked.bookingId)).toHaveLength(1);
    expect(transfersSentFor(booked.bookingId)).toHaveLength(1);
  });

  it("shows the driver a receipt", async () => {
    const response = await call("GET", `/bookings/${booked.bookingId}/receipt`, driver);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      bookingId: booked.bookingId,
      sessionId,
      role: "driver",
      status: "paid",
      sessionStatus: "reconciled",
      currency: "EUR",
      startedAt: booked.slot.start.toISOString(),
      stoppedAt: new Date(booked.slot.start.getTime() + 219 * MINUTE).toISOString(),
      durationMinutes: 219,
      billedMinutes: 220,
      kwh: 22.5,
      meter: { startKwh: 1, stopKwh: 23.5 },
      pricePerHourCents: 250,
      quotedAmountCents: 1000,
      lines: [{ kind: "time", description: "3 h 40 min at €2.50 an hour", amountCents: 917 }],
      capNote: null,
      totalCents: 917,
      platformFeeCents: 0,
      effectiveCentsPerKwh: 41,
      card: { brand: "visa", last4: "4242" },
      hostPayout: null,
      review: null,
      canReview: true,
    });
  });

  it("shows the host the payout instead of the card, and nobody else anything", async () => {
    const host = await call("GET", `/bookings/${booked.bookingId}/receipt`, hostCookie);
    expect(host.json()).toMatchObject({
      role: "host",
      card: null,
      hostPayout: { amountCents: 917, status: "sent", holdReason: null },
      canReview: false,
    });
    const other = await call("GET", `/bookings/${booked.bookingId}/receipt`, stranger);
    expect(other.statusCode).toBe(404);
  });

  it("lets the driver review once, and the listing shows the rating", async () => {
    const byHost = await call("POST", `/bookings/${booked.bookingId}/review`, hostCookie, {
      rating: 5,
    });
    expect(byHost.statusCode).toBe(403);
    const first = await call("POST", `/bookings/${booked.bookingId}/review`, driver, {
      rating: 4,
      comment: "Easy to find, worked first time",
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ rating: 4, comment: "Easy to find, worked first time" });
    const again = await call("POST", `/bookings/${booked.bookingId}/review`, driver, {
      rating: 1,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already-reviewed" });

    const listing = await call("GET", `/chargers/${booked.chargerId}`);
    expect(listing.json()).toMatchObject({
      rating: 4,
      reviewCount: 1,
      host: { rating: 4, reviewCount: 1 },
    });
    const receipt = await call("GET", `/bookings/${booked.bookingId}/receipt`, driver);
    expect(receipt.json()).toMatchObject({ review: { rating: 4 }, canReview: false });
  });

  it("has no receipt or review before the session stops", async () => {
    const pending = await book();
    expect(
      (await call("GET", `/bookings/${pending.bookingId}/receipt`, driver)).json(),
    ).toMatchObject({ status: 409, code: "receipt-not-ready" });
    const review = await call("POST", `/bookings/${pending.bookingId}/review`, driver, {
      rating: 5,
    });
    expect(review.json()).toMatchObject({ status: 409, code: "booking-not-completed" });
    await h.database.db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: "driver" })
      .where(eq(bookings.id, pending.bookingId));
  });

  it("sends a session to review when the meter and the last MeterValue disagree by 0.5 kWh", async () => {
    const mismatch = await book();
    const id = await insertSession(mismatch, {
      ...STOPPED_219,
      samples: [{ minute: 218, energyWh: 23_000 }],
    });
    await h.jobs.runNow(reconcileSessionJob, { sessionId: id });
    expect(await sessionRow(id)).toMatchObject({
      status: "needs_review",
      reviewReason: "meter_mismatch",
    });
    expect(await capturesOf(mismatch.bookingId)).toEqual([]);
    expect(await paymentOf(mismatch.bookingId)).toMatchObject({ status: "authorised" });
    expect(await transferOf(mismatch.bookingId)).toBeUndefined();
    const receipt = await call("GET", `/bookings/${mismatch.bookingId}/receipt`, driver);
    expect(receipt.json()).toMatchObject({ status: "needs_review", totalCents: 917 });

    // Support resolves it with an amount; only admins may.
    const path = `/admin/sessions/${id}/resolve`;
    expect((await call("POST", path, driver, { amountCents: 800 })).statusCode).toBe(403);
    expect((await call("POST", path, stranger, { amountCents: 1001 })).statusCode).toBe(422);
    const resolved = await call("POST", path, stranger, {
      amountCents: 800,
      note: "Meter checked",
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(await sessionRow(id)).toMatchObject({ status: "reconciled" });
    expect(await capturesOf(mismatch.bookingId)).toEqual([
      expect.objectContaining({ amount: 800 }),
    ]);
    expect(await transferOf(mismatch.bookingId)).toMatchObject({
      status: "sent",
      amountCents: 800,
    });
    expect((await call("POST", path, stranger, { amountCents: 800 })).statusCode).toBe(409);
    const adjusted = await call("GET", `/bookings/${mismatch.bookingId}/receipt`, driver);
    expect(adjusted.json()).toMatchObject({
      status: "paid",
      totalCents: 800,
      lines: [
        { kind: "time", amountCents: 917 },
        { kind: "adjustment", amountCents: -117 },
      ],
    });
  });
});

describe("a session without a StopTransaction", () => {
  /** An open session whose slot has ended, with meter values up to 3 h 30 min. */
  async function abandoned(): Promise<{ booked: Booked; sessionId: string }> {
    clock.current = new Date();
    const booked = await book();
    const sessionId = await insertSession(booked, {
      status: "charging",
      minutes: 0,
      meterStartWh: 5_000,
      samples: [
        { minute: 30, energyWh: 8_500 },
        { minute: 210, energyWh: 26_000 },
      ],
    });
    return { booked, sessionId };
  }

  it("is closed from the last MeterValue 10 minutes after the slot and flagged for the host", async () => {
    const { booked, sessionId } = await abandoned();
    clock.current = new Date(booked.slot.end.getTime() + 9 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect((await sessionRow(sessionId)).status).toBe("charging");

    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    const mailBefore = h.mail.emails.length;
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    const lastTs = new Date(booked.slot.start.getTime() + 210 * MINUTE);
    expect(await sessionRow(sessionId)).toMatchObject({
      status: "needs_host_confirmation",
      reviewReason: "missing_stop",
      meterStopWh: 26_000,
      kwh: 21,
      stoppedAt: lastTs,
      confirmationDueAt: new Date(clock.current.getTime() + 72 * HOUR),
    });
    const [booking] = await h.database.db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, booked.bookingId));
    expect(booking?.status).toBe("completed");
    const mail = h.mail.emails.slice(mailBefore);
    expect(mail.map((message) => message.to).sort()).toEqual([
      "cian@example.com",
      "niamh@example.com",
    ]);
    expect(mail.find((message) => message.to === "niamh@example.com")?.text).toContain("21.0 kWh");
    expect(await capturesOf(booked.bookingId)).toEqual([]);
    expect(
      (await call("GET", `/bookings/${booked.bookingId}/receipt`, driver)).json(),
    ).toMatchObject({ status: "awaiting_host_confirmation", billedMinutes: 210, totalCents: 875 });

    // Only the host can confirm; then it is captured.
    const path = `/hosts/sessions/${sessionId}/confirm`;
    expect((await call("POST", path, driver)).statusCode).toBe(404);
    const confirmed = await call("POST", path, hostCookie);
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    await h.jobs.drain();
    expect(await sessionRow(sessionId)).toMatchObject({ status: "reconciled" });
    expect(await capturesOf(booked.bookingId)).toEqual([expect.objectContaining({ amount: 875 })]);
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "sent", amountCents: 875 });
    expect((await call("POST", path, hostCookie)).statusCode).toBe(409);
  });

  it("is captured after 72 hours when the host does not answer", async () => {
    const { booked, sessionId } = await abandoned();
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect((await sessionRow(sessionId)).status).toBe("needs_host_confirmation");

    clock.current = new Date(clock.current.getTime() + 71 * HOUR);
    await h.jobs.runNow(confirmationTimeoutJob, { sessionId });
    expect((await sessionRow(sessionId)).status).toBe("needs_host_confirmation");
    expect(await capturesOf(booked.bookingId)).toEqual([]);

    clock.current = new Date(clock.current.getTime() + 1 * HOUR + MINUTE);
    await h.jobs.runNow(confirmationTimeoutJob, { sessionId });
    expect(await sessionRow(sessionId)).toMatchObject({ status: "reconciled" });
    expect(await capturesOf(booked.bookingId)).toEqual([expect.objectContaining({ amount: 875 })]);
  });

  it("goes to support when the host disputes it, and is not captured at 72 hours", async () => {
    const { booked, sessionId } = await abandoned();
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    const disputed = await call("POST", `/hosts/sessions/${sessionId}/dispute`, hostCookie, {
      reason: "The car was still plugged in at 07:00",
    });
    expect(disputed.statusCode, disputed.body).toBe(201);
    expect(await sessionRow(sessionId)).toMatchObject({
      status: "needs_review",
      reviewReason: "host_dispute",
    });
    const [dispute] = await h.database.db
      .select()
      .from(disputes)
      .where(eq(disputes.bookingId, booked.bookingId));
    expect(dispute).toMatchObject({ status: "open", raisedById: hostUserId });

    clock.current = new Date(clock.current.getTime() + 73 * HOUR);
    await h.jobs.runNow(confirmationTimeoutJob, { sessionId });
    expect((await sessionRow(sessionId)).status).toBe("needs_review");
    expect(await capturesOf(booked.bookingId)).toEqual([]);

    const resolved = await call("POST", `/admin/sessions/${sessionId}/resolve`, stranger, {
      amountCents: 1000,
      note: "Host's account accepted",
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const [closed] = await h.database.db
      .select()
      .from(disputes)
      .where(eq(disputes.bookingId, booked.bookingId));
    expect(closed).toMatchObject({ status: "resolved", resolution: "Host's account accepted" });
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "sent", amountCents: 1000 });
  });
});

describe("an arrival that never got a session", () => {
  async function arrivedBooking(): Promise<Booked> {
    clock.current = new Date();
    const booked = await book();
    await h.database.db
      .update(bookings)
      .set({ status: "arrived", arrivedAt: booked.slot.start })
      .where(eq(bookings.id, booked.bookingId));
    return booked;
  }

  const statusOf = async (bookingId: string) => {
    const [row] = await h.database.db
      .select({ status: bookings.status, fee: bookings.cancellationFeeCents })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    return row;
  };

  it("is a no-show, paying one hour, when the driver never plugged in", async () => {
    const booked = await arrivedBooking();
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await statusOf(booked.bookingId)).toEqual({ status: "no_show", fee: 250 });
    expect(await capturesOf(booked.bookingId)).toEqual([expect.objectContaining({ amount: 250 })]);
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "sent", amountCents: 250 });
  });

  it("is completed with nothing billed when a start was tried", async () => {
    const booked = await arrivedBooking();
    await h.database.db.insert(sessions).values({
      bookingId: booked.bookingId,
      status: "failed",
      stopReason: "no_start_transaction",
    });
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await statusOf(booked.bookingId)).toEqual({ status: "completed", fee: 0 });
    expect(await capturesOf(booked.bookingId)).toEqual([]);
    expect(await paymentOf(booked.bookingId)).toMatchObject({ status: "cancelled" });
  });
});

describe("held transfers", () => {
  it("holds a transfer for incomplete tax details until the host saves them", async () => {
    clock.current = new Date();
    await h.database.db
      .update(hosts)
      .set({ taxDetailsComplete: false })
      .where(eq(hosts.id, hostId));
    const booked = await book();
    const sessionId = await insertSession(booked, STOPPED_219);
    await h.jobs.runNow(reconcileSessionJob, { sessionId });
    expect(await sessionRow(sessionId)).toMatchObject({ status: "reconciled" });
    expect(await transferOf(booked.bookingId)).toMatchObject({
      status: "held",
      holdReason: "tax_details_incomplete",
    });
    expect(transfersSentFor(booked.bookingId)).toEqual([]);
    expect(
      (await call("GET", `/bookings/${booked.bookingId}/receipt`, hostCookie)).json(),
    ).toMatchObject({ hostPayout: { status: "held", holdReason: "tax_details_incomplete" } });

    const saved = await call("PUT", "/hosts/me/tax-details", hostCookie, {
      type: "individual",
      legalName: "Niamh Byrne",
      dateOfBirth: "1988-03-02",
      address: {
        line1: "7 Test Row",
        city: "Dublin",
        region: "Co. Dublin",
        postalCode: "D06 X000",
        country: "ie",
      },
      taxCountry: "IE",
      tin: "1234567 fa",
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await h.jobs.drain();
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "sent", holdReason: null });
    expect(transfersSentFor(booked.bookingId)).toHaveLength(1);
  });

  it("releases transfers held for payouts once Stripe enables them", async () => {
    await h.database.db.update(hosts).set({ payoutStatus: "pending" }).where(eq(hosts.id, hostId));
    const booked = await book();
    const sessionId = await insertSession(booked, STOPPED_219);
    await h.jobs.runNow(reconcileSessionJob, { sessionId });
    expect(await transferOf(booked.bookingId)).toMatchObject({
      status: "held",
      holdReason: "payouts_not_enabled",
    });
    // Nothing to release while payouts are still off.
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "held" });

    const payload = JSON.stringify({
      id: `evt_${randomBytes(6).toString("hex")}`,
      object: "event",
      type: "account.updated",
      data: {
        object: {
          id: "acct_host_1",
          payouts_enabled: true,
          charges_enabled: true,
          capabilities: { transfers: "active" },
        },
      },
    });
    const webhook = await h.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_SECRET,
        }),
      },
      payload,
    });
    expect(webhook.json()).toEqual({ received: true, outcome: "processed" });
    await h.jobs.drain();
    expect(await transferOf(booked.bookingId)).toMatchObject({ status: "sent" });
    expect(transfersSentFor(booked.bookingId)).toHaveLength(1);
  });
});

describe("weekly payout summary", () => {
  it("emails the host the week's sessions, amounts and held transfers", async () => {
    clock.current = new Date(nightIn(1).getTime() + 7 * HOUR);
    const before = h.mail.emails.length;
    await h.jobs.runNow(weeklyPayoutSummaryJob, {});
    await h.jobs.drain();
    const summary = h.mail.emails.slice(before).find((mail) => mail.to === "niamh@example.com");
    expect(summary?.subject).toMatch(/^Your payouts for /);
    expect(summary?.text).toContain("€9.17");
    expect(summary?.text).toContain("paid out");
  });
});
