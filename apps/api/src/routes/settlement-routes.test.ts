import type * as NdDb from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail } from "../../test/booking-detail.ts";
import { sessionRow } from "../../test/settlement-session.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as bookingData from "../data/bookings.ts";
import * as paymentData from "../data/payments.ts";
import * as data from "../data/settlement.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");
vi.mock("../data/payments.ts");
vi.mock("@nd/db", async (importOriginal) => {
  const actual = await importOriginal<typeof NdDb>();
  return {
    ...actual,
    // The unit app's database never connects; run "transactions" inline.
    createDb: () => {
      const db = { transaction: (work: (tx: unknown) => Promise<unknown>) => work(db) };
      return { db, pool: {}, close: () => Promise.resolve() };
    },
  };
});

let app: FastifyInstance;
let unit: ReturnType<typeof startUnitApp>;

const inject = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  unit = startUnitApp({ adminUserIds: [USER_ID] });
  app = unit.app;
  signInAs(app);
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
});

afterEach(async () => {
  await app.close();
  vi.resetAllMocks();
});

const refundRow = (overrides: Partial<paymentData.Refund> = {}): paymentData.Refund => ({
  id: "refund-1",
  paymentId: "33333333-3333-4333-8333-333333333333",
  amountCents: 250,
  currency: "EUR",
  reason: "support",
  status: "succeeded",
  stripeRefundId: "re_1",
  issuedById: null,
  note: null,
  operationId: null,
  failureReason: null,
  createdAt: new Date("2027-01-13T09:00:00Z"),
  updatedAt: new Date("2027-01-13T09:00:00Z"),
  ...overrides,
});

describe("GET /bookings/:id/receipt", () => {
  beforeEach(() => {
    vi.mocked(paymentData.refundsOf).mockResolvedValue([]);
    vi.mocked(data.meterSamples).mockResolvedValue([]);
  });

  it("shows the driver the price paid upfront, refunds, the card and the session as evidence", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "completed" } }),
    );
    vi.mocked(data.billedSessionOf).mockResolvedValue(
      sessionRow({
        status: "reconciled",
        stoppedAt: new Date("2027-01-13T01:00:00Z"),
        meterStopWh: 21_000,
      }),
    );
    vi.mocked(data.meterSamples).mockResolvedValue([
      { ts: new Date("2027-01-12T22:30:00Z"), energyWh: 4_600, powerW: 7_200 },
      { ts: new Date("2027-01-12T23:00:00Z"), energyWh: null, powerW: null },
    ]);
    vi.mocked(paymentData.refundsOf).mockResolvedValue([
      refundRow(),
      refundRow({ id: "refund-2", status: "failed", amountCents: 100 }),
    ]);
    const response = await inject("GET", `/bookings/${BOOKING_ID}/receipt`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      role: "driver",
      bookingStatus: "completed",
      bookedMinutes: 240,
      pricePerHourCents: 250,
      paidCents: 1000,
      refundedCents: 250,
      totalCents: 750,
      refunds: [
        { amountCents: 250, reason: "support", status: "succeeded" },
        { amountCents: 100, status: "failed" },
      ],
      session: {
        status: "reconciled",
        startedAt: "2027-01-12T22:00:00.000Z",
        stoppedAt: "2027-01-13T01:00:00.000Z",
        kwh: 20,
        meter: { startKwh: 1, stopKwh: 21 },
        samples: [
          { at: "2027-01-12T22:30:00.000Z", registerKwh: 4.6, kw: 7.2 },
          { at: "2027-01-12T23:00:00.000Z", registerKwh: null, kw: null },
        ],
      },
      effectiveCentsPerKwh: 38,
      card: { brand: "visa", last4: "4242" },
      hostEarnings: null,
      canReview: true,
    });
    expect(data.meterSamples).toHaveBeenCalledWith(expect.anything(), expect.any(String), 500);
  });

  it("shows the host the card fee passed on and what they keep, without the card", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue({
      ...bookingDetail("user-cian", { booking: { status: "completed" } }),
      host: {
        id: "host-1",
        userId: USER_ID,
        cancellationCutoffMinutes: 120,
        stripeAccountId: "acct_host",
      },
    });
    vi.mocked(data.billedSessionOf).mockResolvedValue(
      sessionRow({ status: "needs_review", meterStopWh: null, kwh: null }),
    );
    vi.mocked(data.findReview).mockResolvedValue({
      id: "r1",
      rating: 4,
      comment: "Fine",
      createdAt: new Date("2027-01-13T10:00:00Z"),
    });
    const response = await inject("GET", `/bookings/${BOOKING_ID}/receipt`);
    expect(response.json()).toMatchObject({
      role: "host",
      card: null,
      session: { status: "needs_review", kwh: null },
      effectiveCentsPerKwh: null,
      hostEarnings: { grossCents: 1000, cardFeeCents: 40, platformFeeCents: 0, netCents: 960 },
      review: { rating: 4, comment: "Fine" },
      canReview: false,
    });
  });

  it("is ready for a finished booking with no session, even when the card cannot be read", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "no_show" } }),
    );
    vi.mocked(data.billedSessionOf).mockResolvedValue(undefined);
    vi.spyOn(unit.payments.payments, "findCard").mockRejectedValue(new Error("stripe down"));
    const response = await inject("GET", `/bookings/${BOOKING_ID}/receipt`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ session: null, card: null, canReview: false });
    expect(data.meterSamples).not.toHaveBeenCalled();
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "completed" },
        driver: { stripeCustomerId: null },
      }),
    );
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).json()).toMatchObject({
      card: null,
    });
  });

  it("is 404 for anyone else and 409 until a paid booking has finished", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).statusCode).toBe(404);
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(undefined);
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).statusCode).toBe(404);
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    vi.mocked(data.billedSessionOf).mockResolvedValue(sessionRow({ status: "charging" }));
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).json()).toMatchObject({
      status: 409,
      code: "receipt-not-ready",
    });
    vi.mocked(data.billedSessionOf).mockResolvedValue(undefined);
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).statusCode).toBe(409);
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "cancelled" },
        payment: { status: "cancelled" },
      }),
    );
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).statusCode).toBe(409);
  });
});

describe("POST /bookings/:id/review", () => {
  it("saves the driver's rating of a completed booking once", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "completed" } }),
    );
    vi.mocked(data.insertReview).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(data.findReview).mockResolvedValue({
      id: "r1",
      rating: 4,
      comment: "Grand",
      createdAt: new Date("2027-01-13T09:00:00Z"),
    });
    const first = await inject("POST", `/bookings/${BOOKING_ID}/review`, {
      rating: 4,
      comment: " Grand ",
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({
      rating: 4,
      comment: "Grand",
      createdAt: "2027-01-13T09:00:00.000Z",
    });
    expect(data.insertReview).toHaveBeenCalledWith(expect.anything(), {
      bookingId: BOOKING_ID,
      reviewerId: USER_ID,
      revieweeId: "user-niamh",
      rating: 4,
      comment: "Grand",
    });
    const again = await inject("POST", `/bookings/${BOOKING_ID}/review`, { rating: 2 });
    expect(again.json()).toMatchObject({ status: 409, code: "already-reviewed" });
  });

  it("refuses a bad rating, the host, strangers and unfinished bookings", async () => {
    expect((await inject("POST", `/bookings/${BOOKING_ID}/review`, { rating: 6 })).statusCode).toBe(
      400,
    );
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { host: { userId: USER_ID }, booking: { status: "completed" } }),
    );
    expect(
      (await inject("POST", `/bookings/${BOOKING_ID}/review`, { rating: 5 })).json(),
    ).toMatchObject({ status: 403, code: "driver-only" });
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    expect((await inject("POST", `/bookings/${BOOKING_ID}/review`, { rating: 5 })).statusCode).toBe(
      404,
    );
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    expect(
      (await inject("POST", `/bookings/${BOOKING_ID}/review`, { rating: 5 })).json(),
    ).toMatchObject({ status: 409, code: "booking-not-completed" });
  });
});

describe("POST /admin/bookings/:id/refund", () => {
  const url = `/admin/bookings/${BOOKING_ID}/refund`;

  beforeEach(() => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    vi.mocked(paymentData.insertRefund).mockImplementation((_db, input) =>
      Promise.resolve(
        refundRow({
          amountCents: input.amountCents === "remainder" ? 1000 : input.amountCents,
          reason: input.reason,
          status: "pending",
          stripeRefundId: null,
        }),
      ),
    );
  });

  it("is for admins only", async () => {
    await app.close();
    unit = startUnitApp();
    app = unit.app;
    signInAs(app);
    const response = await inject("POST", url, {
      amountCents: 500,
      note: "x",
      operationId: "op-12345678",
    });
    expect(response.json()).toMatchObject({ status: 403, code: "admin-only" });
    const anonymous = await app.inject({
      method: "POST",
      url,
      payload: { amountCents: 500, note: "x", operationId: "op-12345678" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("refunds part of a booking, reversing the host's share and the fee", async () => {
    const response = await inject("POST", url, {
      amountCents: 500,
      note: "Half the night lost",
      operationId: "op-12345678",
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      bookingId: BOOKING_ID,
      amountCents: 500,
      reason: "support",
      status: "succeeded",
    });
    expect(paymentData.insertRefund).toHaveBeenCalledWith(expect.anything(), {
      paymentId: "33333333-3333-4333-8333-333333333333",
      amountCents: 500,
      reason: "support",
      issuedById: USER_ID,
      note: "Half the night lost",
      operationId: "op-12345678",
    });
    expect(unit.payments.callsTo("refund")[0]?.input).toMatchObject({
      paymentIntentId: "pi_1",
      amountCents: 500,
      idempotencyKey: "refund-refund-1",
    });
  });

  it("refunds the whole price when no amount is given, and never more than is left", async () => {
    await inject("POST", url, { note: "Charger broke", operationId: "op-12345678" });
    expect(vi.mocked(paymentData.insertRefund).mock.calls[0]?.[1]).toMatchObject({
      amountCents: 1000,
    });
    vi.mocked(paymentData.insertRefund).mockResolvedValue(undefined);
    const tooMuch = await inject("POST", url, {
      amountCents: 900,
      note: "x",
      operationId: "op-12345679",
    });
    expect(tooMuch.json()).toMatchObject({ status: 422, code: "refund-too-large" });
    expect(tooMuch.json()).not.toHaveProperty("detail");
    expect(
      (await inject("POST", url, { note: "x", operationId: "op-12345670" })).json(),
    ).toMatchObject({
      detail: "Part of this booking has been refunded already; give the amount left.",
    });
  });

  it("needs an operation id, so a retried request cannot refund twice", async () => {
    const response = await inject("POST", url, { amountCents: 500, note: "x" });
    expect(response.statusCode).toBe(400);
    expect(paymentData.insertRefund).not.toHaveBeenCalled();
  });

  it("is 404 for no booking and 409 for one not paid", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(undefined);
    expect((await inject("POST", url, { note: "x", operationId: "op-12345670" })).statusCode).toBe(
      404,
    );
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: { status: "cancelled" } }),
    );
    expect(
      (await inject("POST", url, { note: "x", operationId: "op-12345670" })).json(),
    ).toMatchObject({ code: "not-paid" });
  });
});
