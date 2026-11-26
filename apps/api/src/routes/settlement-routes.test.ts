import type * as NdDb from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail } from "../../test/booking-detail.ts";
import { SESSION_ID, sessionRow, settlementSession } from "../../test/settlement-session.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");
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

describe("GET /bookings/:id/receipt", () => {
  it("shows the driver the time billed, the cap, the card and the energy", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "completed" },
        payment: { status: "captured", capturedCents: 1000, platformFeeCents: 100 },
      }),
    );
    vi.mocked(data.billedSessionOf).mockResolvedValue(
      sessionRow({
        status: "reconciled",
        stoppedAt: new Date("2027-01-13T02:01:00Z"),
        meterStopWh: 31_000,
      }),
    );
    vi.mocked(bookingData.findTransfer).mockResolvedValue(undefined);
    vi.mocked(data.findReview).mockResolvedValue(undefined);
    const response = await inject("GET", `/bookings/${BOOKING_ID}/receipt`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      role: "driver",
      status: "paid",
      durationMinutes: 241,
      billedMinutes: 245,
      kwh: 30,
      meter: { startKwh: 1, stopKwh: 31 },
      lines: [
        { kind: "time", description: "4 h 5 min at €2.50 an hour", amountCents: 1021 },
        { kind: "cap", description: "Capped at the quoted €10.00", amountCents: -21 },
        { kind: "platform_fee", amountCents: 100 },
      ],
      capNote: expect.stringContaining("never goes above the quote of €10.00") as unknown,
      totalCents: 1000,
      platformFeeCents: 100,
      effectiveCentsPerKwh: 33,
      card: { brand: "visa", last4: "4242" },
      hostPayout: null,
      canReview: true,
    });
  });

  it("shows the host the transfer and the driver's review, without the card", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { host: { userId: USER_ID } }),
    );
    vi.mocked(data.billedSessionOf).mockResolvedValue(
      sessionRow({ meterStopWh: null, meterStartWh: null, kwh: null, startedAt: null }),
    );
    vi.mocked(bookingData.findTransfer).mockResolvedValue({
      amountCents: 917,
      status: "held",
      holdReason: "tax_details_incomplete",
    } as never);
    vi.mocked(data.findReview).mockResolvedValue({
      id: "r1",
      rating: 5,
      comment: null,
      createdAt: new Date("2027-01-13T09:00:00Z"),
    });
    const response = await inject("GET", `/bookings/${BOOKING_ID}/receipt`);
    expect(response.json()).toMatchObject({
      role: "host",
      status: "pending",
      kwh: null,
      meter: { startKwh: null, stopKwh: null },
      effectiveCentsPerKwh: null,
      card: null,
      hostPayout: { amountCents: 917, status: "held", holdReason: "tax_details_incomplete" },
      review: { rating: 5, comment: null, createdAt: "2027-01-13T09:00:00.000Z" },
      canReview: false,
    });
    expect(unit.payments.callsTo("findCard")).toEqual([]);
  });

  it("shows the status of a session waiting for the host or for review, even without a card", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { payment: null }),
    );
    vi.mocked(data.billedSessionOf).mockResolvedValue(
      sessionRow({ status: "needs_host_confirmation" }),
    );
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).json()).toMatchObject({
      status: "awaiting_host_confirmation",
      card: null,
      totalCents: 917,
    });
    vi.mocked(data.billedSessionOf).mockResolvedValue(sessionRow({ status: "needs_review" }));
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    vi.spyOn(unit.payments.payments, "findCard").mockRejectedValue(new Error("Stripe down"));
    expect((await inject("GET", `/bookings/${BOOKING_ID}/receipt`)).json()).toMatchObject({
      status: "needs_review",
      card: null,
    });
  });

  it("is 404 for anyone else and 409 before the session stops", async () => {
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

describe("host session routes", () => {
  const awaiting = () => {
    const found = settlementSession({
      session: { status: "needs_host_confirmation", confirmationDueAt: new Date() },
    });
    vi.mocked(data.findSettlementSession).mockResolvedValue({
      ...found,
      host: { ...found.host, userId: USER_ID },
    });
  };

  it("confirms a session and queues its reconciliation", async () => {
    awaiting();
    const response = await inject("POST", `/hosts/sessions/${SESSION_ID}/confirm`);
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ sessionId: SESSION_ID, confirmed: true });
    expect(unit.jobs.sent.map((job) => job.name)).toEqual(["reconcile-session"]);
  });

  it("records a dispute", async () => {
    awaiting();
    vi.mocked(data.insertDispute).mockResolvedValue("88888888-8888-4888-8888-888888888888");
    const response = await inject("POST", `/hosts/sessions/${SESSION_ID}/dispute`, {
      reason: "Car was still charging at 07:00",
      details: "The app showed 30 kWh",
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      sessionId: SESSION_ID,
      disputeId: "88888888-8888-4888-8888-888888888888",
    });
    expect(data.insertDispute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: "The app showed 30 kWh" }),
    );
    awaiting();
    await inject("POST", `/hosts/sessions/${SESSION_ID}/dispute`, { reason: "No details" });
    expect(data.insertDispute).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ details: null }),
    );
  });
});

describe("POST /admin/sessions/:id/resolve", () => {
  it("is for admins only", async () => {
    await app.close();
    unit = startUnitApp();
    app = unit.app;
    signInAs(app);
    const response = await inject("POST", `/admin/sessions/${SESSION_ID}/resolve`, {
      amountCents: 500,
    });
    expect(response.json()).toMatchObject({ status: 403, code: "admin-only" });
    const anonymous = await app.inject({
      method: "POST",
      url: `/admin/sessions/${SESSION_ID}/resolve`,
      payload: { amountCents: 500 },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("lets an admin settle a session in review", async () => {
    vi.mocked(data.findSettlementSession).mockResolvedValue(
      settlementSession({ session: { status: "needs_review" } }),
    );
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    vi.mocked(bookingData.updatePaymentFrom).mockResolvedValue(true);
    vi.mocked(bookingData.findTransfer).mockResolvedValue({ id: "t1" } as never);
    const response = await inject("POST", `/admin/sessions/${SESSION_ID}/resolve`, {
      amountCents: 500,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ sessionId: SESSION_ID, amountCents: 500 });
    expect(data.resolveOpenDisputes).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      "Resolved by support",
      expect.any(Date),
    );
  });
});
