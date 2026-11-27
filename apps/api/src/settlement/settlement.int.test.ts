import { randomBytes } from "node:crypto";

import {
  availabilityRules,
  bookings,
  chargers,
  hosts,
  meterValues,
  ocppMessages,
  payments,
  refunds,
  sessions,
  users,
} from "@nd/db";
import { CHARGER_EVENTS_CHANNEL } from "@nd/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { stripePaymentsFrom } from "../stripe/payments.ts";
import { DEFAULT_TIMINGS } from "../timings.ts";
import { reconcileSessionJob, settlementSweepJob } from "./jobs.ts";
import { reconcileSession } from "./reconcile.ts";
import type { SettlementServices } from "./services.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

/** A 4-hour booking tomorrow night (1000 cents), paid upfront with the driver's card. */
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
  expect(body.payment).toEqual({ status: "paid", amountCents: 1000 });
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

async function refundsOf(bookingId: string) {
  const payment = await paymentOf(bookingId);
  return h.database.db.select().from(refunds).where(eq(refunds.paymentId, payment.id));
}

/** Money stripe-mock saw move for a booking: captures and refunds of its PaymentIntent. */
async function moneyMoved(bookingId: string) {
  const payment = await paymentOf(bookingId);
  const intent = payment.stripePaymentIntentId;
  return {
    captures: h.stripeMock.captures.filter((capture) => capture.id === intent).length,
    refunds: h.stripeMock.refunds.filter((refund) => refund.payment_intent === intent).length,
  };
}

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
    fees: { platformFeeBps: 0, cardFeeBps: 150, cardFeeFixedCents: 25 },
    taxRecordRetentionYears: 6,
    timings: DEFAULT_TIMINGS,
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

  it("records the energy on session_stopped and moves no money: the booking was paid upfront", async () => {
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
    expect(await sessionRow(sessionId)).toMatchObject({ kwh: 22.5, reviewReason: null });
    // Stopping 21 minutes early changes nothing: the driver paid for the booked hours.
    expect(await paymentOf(booked.bookingId)).toMatchObject({ status: "paid", amountCents: 1000 });
    expect(await moneyMoved(booked.bookingId)).toEqual({ captures: 0, refunds: 0 });
  });

  it("is a no-op when run again", async () => {
    await expect(reconcileSession(services, sessionId)).resolves.toBe("already_reconciled");
    await h.jobs.runNow(reconcileSessionJob, { sessionId });
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await moneyMoved(booked.bookingId)).toEqual({ captures: 0, refunds: 0 });
  });

  it("shows the driver a receipt: the price paid, and the session as evidence", async () => {
    const response = await call("GET", `/bookings/${booked.bookingId}/receipt`, driver);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      bookingId: booked.bookingId,
      role: "driver",
      bookingStatus: "completed",
      currency: "EUR",
      start: booked.slot.start.toISOString(),
      end: booked.slot.end.toISOString(),
      bookedMinutes: 240,
      pricePerHourCents: 250,
      paidCents: 1000,
      refunds: [],
      refundedCents: 0,
      totalCents: 1000,
      session: {
        sessionId,
        status: "reconciled",
        startedAt: booked.slot.start.toISOString(),
        stoppedAt: new Date(booked.slot.start.getTime() + 219 * MINUTE).toISOString(),
        stopReason: "Remote",
        kwh: 22.5,
        meter: { startKwh: 1, stopKwh: 23.5 },
        samples: [
          {
            at: new Date(booked.slot.start.getTime() + 60 * MINUTE).toISOString(),
            registerKwh: 8,
            kw: 7,
          },
          {
            at: new Date(booked.slot.start.getTime() + 218 * MINUTE).toISOString(),
            registerKwh: 23.4,
            kw: 7,
          },
        ],
      },
      effectiveCentsPerKwh: 44,
      card: { brand: "visa", last4: "4242" },
      hostEarnings: null,
      review: null,
      canReview: true,
    });
  });

  it("shows the host the card fee passed on and what they keep, and nobody else anything", async () => {
    const host = await call("GET", `/bookings/${booked.bookingId}/receipt`, hostCookie);
    expect(host.json()).toMatchObject({
      role: "host",
      card: null,
      hostEarnings: { grossCents: 1000, cardFeeCents: 40, platformFeeCents: 0, netCents: 960 },
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

  it("has no receipt or review before the booking finishes", async () => {
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

  it("flags a meter that does not add up, and support refunds by hand", async () => {
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
    expect(await moneyMoved(mismatch.bookingId)).toEqual({ captures: 0, refunds: 0 });

    // Support refunds part of it; only admins may, and never more than was paid.
    const path = `/admin/bookings/${mismatch.bookingId}/refund`;
    const note = "Charger stopped early; half refunded";
    expect((await call("POST", path, driver, { amountCents: 500, note })).statusCode).toBe(403);
    expect((await call("POST", path, stranger, { amountCents: 1001, note })).json()).toMatchObject({
      code: "refund-too-large",
    });
    const refunded = await call("POST", path, stranger, { amountCents: 500, note });
    expect(refunded.statusCode, refunded.body).toBe(201);
    expect(refunded.json()).toMatchObject({ amountCents: 500, status: "succeeded" });
    expect(await refundsOf(mismatch.bookingId)).toMatchObject([
      { amountCents: 500, reason: "support", note, issuedById: admins[0] },
    ]);
    expect((await call("POST", path, stranger, { amountCents: 501, note })).statusCode).toBe(422);
    const receipt = await call("GET", `/bookings/${mismatch.bookingId}/receipt`, hostCookie);
    expect(receipt.json()).toMatchObject({
      refundedCents: 500,
      totalCents: 500,
      hostEarnings: { grossCents: 500, cardFeeCents: 20, netCents: 480 },
    });
  });
});

describe("a session that delivered nothing", () => {
  /** A booking with a stopped session that delivered 0 kWh, stopped for `reason`. */
  async function emptySession(reason: string): Promise<{ booked: Booked; sessionId: string }> {
    clock.current = new Date();
    const booked = await book();
    const sessionId = await insertSession(booked, {
      status: "stopped",
      minutes: 30,
      meterStartWh: 4_000,
      meterStopWh: 4_000,
      samples: [{ minute: 10, energyWh: 4_000 }],
    });
    await h.database.db
      .update(sessions)
      .set({ stopReason: reason })
      .where(eq(sessions.id, sessionId));
    return { booked, sessionId };
  }

  it("is refunded in full when the charger ended it or faulted, and not otherwise", async () => {
    const powerLoss = await emptySession("PowerLoss");
    const faulted = await emptySession("Remote");
    await h.database.db.insert(ocppMessages).values({
      chargerId: faulted.booked.chargerId,
      direction: "in",
      messageType: "call",
      messageId: randomBytes(8).toString("hex"),
      action: "StatusNotification",
      payload: { connectorId: 1, errorCode: "GroundFailure", status: "Faulted" },
      ts: new Date(faulted.booked.slot.start.getTime() + 5 * MINUTE),
    });
    const unplugged = await emptySession("EVDisconnected");
    for (const { sessionId } of [powerLoss, faulted, unplugged]) {
      await h.jobs.runNow(reconcileSessionJob, { sessionId });
      expect((await sessionRow(sessionId)).status).toBe("reconciled");
    }
    for (const { booked } of [powerLoss, faulted]) {
      expect(await refundsOf(booked.bookingId)).toMatchObject([
        { amountCents: 1000, reason: "charger_fault", status: "succeeded" },
      ]);
    }
    expect(await refundsOf(unplugged.booked.bookingId)).toEqual([]);
    // Running it again refunds nothing more.
    await h.jobs.runNow(reconcileSessionJob, { sessionId: powerLoss.sessionId });
    expect(await moneyMoved(powerLoss.booked.bookingId)).toEqual({ captures: 0, refunds: 1 });
  });

  it("is refunded in full when the charger dropped it without delivering anything", async () => {
    clock.current = new Date();
    const booked = await book();
    const sessionId = await insertSession(booked, {
      status: "charging",
      minutes: 0,
      meterStartWh: 5_000,
      samples: [{ minute: 30, energyWh: 5_000 }],
    });
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await sessionRow(sessionId)).toMatchObject({ status: "reconciled", kwh: 0 });
    expect(await refundsOf(booked.bookingId)).toMatchObject([
      { amountCents: 1000, reason: "charger_fault" },
    ]);
  });
});

describe("a session without a StopTransaction", () => {
  /** An open session whose slot has ended, with meter values up to 3 h 30 min. */
  async function abandoned(lastEnergyWh = 26_000): Promise<{ booked: Booked; sessionId: string }> {
    clock.current = new Date();
    const booked = await book();
    const sessionId = await insertSession(booked, {
      status: "charging",
      minutes: 0,
      meterStartWh: 5_000,
      samples: [
        { minute: 30, energyWh: 8_500 },
        { minute: 210, energyWh: lastEnergyWh },
      ],
    });
    return { booked, sessionId };
  }

  it("is closed from the last MeterValue 10 minutes after the slot, with its energy recorded", async () => {
    const { booked, sessionId } = await abandoned();
    clock.current = new Date(booked.slot.end.getTime() + 9 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect((await sessionRow(sessionId)).status).toBe("charging");

    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await sessionRow(sessionId)).toMatchObject({
      status: "reconciled",
      stopReason: "NoStopTransaction",
      meterStopWh: 26_000,
      kwh: 21,
      stoppedAt: new Date(booked.slot.start.getTime() + 210 * MINUTE),
    });
    const [booking] = await h.database.db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, booked.bookingId));
    expect(booking?.status).toBe("completed");
    expect(await moneyMoved(booked.bookingId)).toEqual({ captures: 0, refunds: 0 });
    expect(
      (await call("GET", `/bookings/${booked.bookingId}/receipt`, driver)).json(),
    ).toMatchObject({ totalCents: 1000, session: { kwh: 21, stopReason: "NoStopTransaction" } });
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
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    return row?.status;
  };

  it("is a no-show, not refunded, when the driver never plugged in", async () => {
    const booked = await arrivedBooking();
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await statusOf(booked.bookingId)).toBe("no_show");
    expect(await refundsOf(booked.bookingId)).toEqual([]);
  });

  /** A start that timed out, and the connector state the charger reported just after. */
  async function timedOut(booked: Booked, connector: "Preparing" | "Available") {
    const failedAt = new Date(booked.slot.start.getTime() + 2 * MINUTE);
    await h.database.db.insert(sessions).values({
      bookingId: booked.bookingId,
      status: "failed",
      stopReason: "start_timeout",
      createdAt: booked.slot.start,
      updatedAt: failedAt,
    });
    await h.database.db.insert(ocppMessages).values({
      chargerId: booked.chargerId,
      direction: "in",
      messageType: "call",
      messageId: randomBytes(8).toString("hex"),
      action: "StatusNotification",
      payload: { connectorId: 1, errorCode: "NoError", status: connector },
      ts: new Date(failedAt.getTime() + 5_000),
    });
  }

  it("is not refunded when the driver alone stopped the start, or nothing was plugged in", async () => {
    const stoppedByDriver = await arrivedBooking();
    await h.database.db
      .update(bookings)
      .set({ pluggedInAt: stoppedByDriver.slot.start })
      .where(eq(bookings.id, stoppedByDriver.bookingId));
    await h.database.db.insert(sessions).values({
      bookingId: stoppedByDriver.bookingId,
      status: "failed",
      stopReason: "stopped_before_start",
    });
    const unplugged = await arrivedBooking();
    await timedOut(unplugged, "Available");
    clock.current = new Date(unplugged.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    for (const booked of [stoppedByDriver, unplugged]) {
      expect(await statusOf(booked.bookingId)).toBe("no_show");
      expect(await refundsOf(booked.bookingId)).toEqual([]);
    }
  });

  it("is refunded in full, automatically, when the charger never started", async () => {
    const booked = await arrivedBooking();
    await timedOut(booked, "Preparing");
    clock.current = new Date(booked.slot.end.getTime() + 11 * MINUTE);
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await statusOf(booked.bookingId)).toBe("completed");
    expect(await refundsOf(booked.bookingId)).toMatchObject([
      { amountCents: 1000, reason: "charger_fault", status: "succeeded" },
    ]);
    expect(await moneyMoved(booked.bookingId)).toEqual({ captures: 0, refunds: 1 });
    // Running the sweep again refunds nothing more.
    await h.jobs.runNow(settlementSweepJob, {});
    await h.jobs.drain();
    expect(await moneyMoved(booked.bookingId)).toEqual({ captures: 0, refunds: 1 });
  });
});

describe("the sweep", () => {
  it("queues a lifecycle job that went missing, once it is due", async () => {
    clock.current = new Date();
    const booked = await book();
    // The no-show job was lost (a crash between the commit and the queue).
    await h.database.db.execute(
      sql`delete from pgboss.job where data->>'bookingId' = ${booked.bookingId}`,
    );
    clock.current = new Date(booked.slot.end.getTime() + 16 * MINUTE);
    try {
      await h.jobs.runNow(settlementSweepJob, {});
      await h.jobs.drain();
    } finally {
      clock.current = new Date();
    }
    const [row] = await h.database.db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, booked.bookingId));
    expect(row?.status).toBe("no_show");
  });

  it("resumes a charge whose outcome was never recorded, with the same idempotency key", async () => {
    clock.current = new Date();
    const booked = await book();
    const before = await paymentOf(booked.bookingId);
    // As if Stripe's answer was lost: the row still says pending.
    await h.database.db
      .update(payments)
      .set({ status: "pending", stripePaymentIntentId: null, stripeChargeId: null })
      .where(eq(payments.id, before.id));
    const created = h.stripeMock.created.length;
    clock.current = new Date(Date.now() + 3 * MINUTE);
    try {
      await h.jobs.runNow(settlementSweepJob, {});
      await h.jobs.drain();
    } finally {
      clock.current = new Date();
    }
    const after = await paymentOf(booked.bookingId);
    expect(after).toMatchObject({
      status: "paid",
      stripePaymentIntentId: before.stripePaymentIntentId,
    });
    // The replayed request made no new PaymentIntent.
    expect(h.stripeMock.created.length).toBe(created);
  });
});
