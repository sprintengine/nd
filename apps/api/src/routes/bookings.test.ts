import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOKING_ID,
  bookingDetail,
  CHARGER_ID,
  HOST_USER_ID,
  PAYMENT_ID,
} from "../../test/booking-detail.ts";
import type { fakePayments, memoryJobs } from "../../test/fakes.ts";
import { NOW, SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as data from "../data/bookings.ts";
import * as listing from "../data/listing.ts";
import * as paymentData from "../data/payments.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/listing.ts");
vi.mock("../data/payments.ts");

let app: FastifyInstance;
let payments: ReturnType<typeof fakePayments>;
let jobs: ReturnType<typeof memoryJobs>;

const charger = {
  id: CHARGER_ID,
  status: "online",
  acceptingBookings: true,
  timezone: "Europe/Dublin",
  hostId: "host-1",
  hostUserId: HOST_USER_ID,
  maxSessionsPerDay: 2,
  stripeAccountId: "acct_host",
  payoutStatus: "enabled",
} satisfies data.BookableCharger;

const rule = (
  overrides: Partial<Awaited<ReturnType<typeof listing.chargerRules>>[number]> = {},
) => ({
  weekday: 2,
  startTime: "20:00:00",
  endTime: "08:00:00",
  pricePerHourCents: 250,
  currency: "EUR" as const,
  kwhCap: null,
  instantBook: true,
  ...overrides,
});

// NOW is Monday 2027-01-11 12:00 UTC; the slot is Tuesday night.
const request = {
  chargerId: CHARGER_ID,
  from: "2027-01-12T22:00:00Z",
  to: "2027-01-13T02:00:00Z",
  vehiclePlate: " 251 d  1234 ",
};

const send = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  ({ app, payments, jobs } = startUnitApp());
  signInAs(app);
  vi.mocked(data.findBookableCharger).mockResolvedValue(charger);
  vi.mocked(listing.chargerRules).mockResolvedValue([rule()]);
  vi.mocked(data.openRequestCount).mockResolvedValue(0);
  vi.mocked(data.slotTaken).mockResolvedValue(false);
  vi.mocked(data.findCustomer).mockResolvedValue({
    id: USER_ID,
    name: "Aoife",
    email: "aoife@example.com",
    stripeCustomerId: "cus_1",
  });
  vi.mocked(data.insertBookingWithPayment).mockResolvedValue({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
  });
  vi.mocked(data.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.updateBookingFrom).mockResolvedValue(true);
  vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
  vi.mocked(paymentData.updateBookingWithRefund).mockImplementation(
    (_db, _id, _from, _change, refund) =>
      Promise.resolve({
        changed: true,
        refund:
          refund === undefined
            ? undefined
            : {
                ...refund,
                // The payment fixture is 1000 cents, nothing refunded yet.
                amountCents: refund.amountCents === "remainder" ? 1000 : refund.amountCents,
                id: "refund-1",
                currency: "EUR",
                status: "pending",
                stripeRefundId: null,
                issuedById: null,
                note: null,
                operationId: null,
                failureReason: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
      }),
  );
});

afterEach(async () => {
  await app.close();
  vi.resetAllMocks();
});

describe("POST /bookings", () => {
  it("needs a session and a verified phone", async () => {
    vi.restoreAllMocks();
    const anonymous = await app.inject({ method: "POST", url: "/bookings", payload: request });
    expect(anonymous.statusCode).toBe(401);
    signInAs(app, { phoneVerified: false });
    expect((await send("POST", "/bookings", request)).statusCode).toBe(403);
  });

  it("books an instant slot: prices it, charges it upfront and schedules the no-show check", async () => {
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ id: BOOKING_ID, status: "confirmed", role: "driver" });
    const [, inserted, payment, cap] = vi.mocked(data.insertBookingWithPayment).mock.calls[0] ?? [];
    expect(inserted).toMatchObject({
      status: "confirmed",
      quotedAmountCents: 1000,
      pricePerHourCents: 250,
      vehiclePlate: "251 D 1234",
    });
    expect(inserted?.idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect(payment).toEqual({
      paymentMethodId: "pm_card_visa",
      amountCents: 1000,
      platformFeeCents: 0,
      cardFeeCents: 40,
      captureMethod: "automatic",
    });
    expect(cap).toMatchObject({ hostId: "host-1", maxSessionsPerDay: 2 });
    expect(payments.callsTo("charge")[0]?.input).toEqual({
      bookingId: BOOKING_ID,
      amountCents: 1000,
      currency: "EUR",
      customerId: "cus_1",
      paymentMethodId: "pm_card_visa",
      destination: "acct_host",
      applicationFeeCents: 40,
      captureMethod: "automatic",
      idempotencyKey: `booking-${BOOKING_ID}-charge`,
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending"],
      {
        status: "paid",
        stripePaymentIntentId: "pi_1",
        stripeChargeId: "ch_pi_1",
        failureReason: null,
      },
    );
    expect(jobs.sent).toEqual([
      {
        name: "booking-no-show",
        payload: { bookingId: BOOKING_ID },
        options: { startAfter: new Date("2027-01-13T02:15:00Z"), singletonKey: BOOKING_ID },
      },
      {
        name: "notify",
        payload: { type: "booking_created", bookingId: BOOKING_ID },
        options: { singletonKey: `booking:${BOOKING_ID}:booking_created` },
      },
    ]);
  });

  it("holds a request's price on the card and lets the host answer within 24 hours", async () => {
    vi.mocked(listing.chargerRules).mockResolvedValue([rule({ instantBook: false })]);
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "requested", idTag: null },
        payment: { status: "pending", captureMethod: "manual", stripePaymentIntentId: null },
      }),
    );
    expect((await send("POST", "/bookings", request)).statusCode).toBe(201);
    const [, inserted, payment] = vi.mocked(data.insertBookingWithPayment).mock.calls[0] ?? [];
    expect(inserted).toMatchObject({ status: "requested", idTag: null });
    expect(payment?.captureMethod).toBe("manual");
    expect(payments.callsTo("charge")[0]?.input).toMatchObject({ captureMethod: "manual" });
    expect(vi.mocked(data.updatePaymentFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "authorised",
    });
    // The booking was made 2027-01-10 12:00: the host has until the next day at noon.
    expect(jobs.sent[0]).toMatchObject({
      name: "booking-expire-request",
      options: { startAfter: new Date("2027-01-11T12:00:00Z") },
    });
  });

  it("charges a slot weeks away upfront too", async () => {
    const response = await send("POST", "/bookings", {
      ...request,
      from: "2027-02-09T22:00:00Z",
      to: "2027-02-10T02:00:00Z",
    });
    expect(response.statusCode).toBe(201);
    expect(payments.callsTo("charge")).toHaveLength(1);
  });

  it("uses the card asked for, if it is the driver's", async () => {
    const ok = await send("POST", "/bookings", { ...request, paymentMethodId: "pm_card_visa" });
    expect(ok.statusCode).toBe(201);
    const other = await send("POST", "/bookings", { ...request, paymentMethodId: "pm_other" });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: "payment-method-invalid" });
  });

  it("needs a saved card", async () => {
    payments.state.defaultCardId = null;
    expect((await send("POST", "/bookings", request)).json()).toMatchObject({
      code: "payment-method-required",
    });
    vi.mocked(data.findCustomer).mockResolvedValue(undefined);
    expect((await send("POST", "/bookings", request)).json()).toMatchObject({
      code: "payment-method-required",
    });
  });

  it.each([
    [
      "charger-not-found",
      404,
      () => vi.mocked(data.findBookableCharger).mockResolvedValue(undefined),
    ],
    [
      "own-charger",
      409,
      () =>
        vi.mocked(data.findBookableCharger).mockResolvedValue({ ...charger, hostUserId: USER_ID }),
    ],
    [
      "charger-unavailable",
      409,
      () =>
        vi.mocked(data.findBookableCharger).mockResolvedValue({ ...charger, status: "offline" }),
    ],
    [
      "charger-unavailable",
      409,
      () =>
        vi
          .mocked(data.findBookableCharger)
          .mockResolvedValue({ ...charger, acceptingBookings: false }),
    ],
    [
      "charger-unavailable",
      409,
      () =>
        vi
          .mocked(data.findBookableCharger)
          .mockResolvedValue({ ...charger, payoutStatus: "pending" }),
    ],
    [
      "charger-unavailable",
      409,
      () =>
        vi
          .mocked(data.findBookableCharger)
          .mockResolvedValue({ ...charger, stripeAccountId: null }),
    ],
    ["outside-availability", 422, () => vi.mocked(listing.chargerRules).mockResolvedValue([])],
    [
      "too-many-requests",
      409,
      () => {
        vi.mocked(listing.chargerRules).mockResolvedValue([rule({ instantBook: false })]);
        vi.mocked(data.openRequestCount).mockResolvedValue(3);
      },
    ],
    [
      "host-day-full",
      409,
      () => vi.mocked(data.insertBookingWithPayment).mockResolvedValue("host-day-full"),
    ],
    ["slot-taken", 409, () => vi.mocked(data.slotTaken).mockResolvedValue(true)],
    [
      "amount-too-small",
      422,
      () => vi.mocked(listing.chargerRules).mockResolvedValue([rule({ pricePerHourCents: 10 })]),
    ],
    [
      "slot-taken",
      409,
      () => vi.mocked(data.insertBookingWithPayment).mockResolvedValue("slot-taken"),
    ],
  ] as const)("answers %s (%d) without charging", async (code, status, arrange) => {
    arrange();
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(payments.callsTo("charge")).toHaveLength(0);
  });

  it("lets a driver with requests waiting still book instantly", async () => {
    vi.mocked(data.openRequestCount).mockResolvedValue(3);
    expect((await send("POST", "/bookings", request)).statusCode).toBe(201);
    expect(data.openRequestCount).not.toHaveBeenCalled();
  });

  it("refuses a slot that is not bookable as asked", async () => {
    const response = await send("POST", "/bookings", { ...request, from: "2027-01-12T22:00:30Z" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "invalid-slot" });
  });

  it("answers 402 and cancels the booking when the card is declined", async () => {
    payments.state.charge = { status: "failed", reason: "insufficient_funds" };
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(402);
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending"],
      {
        status: "failed",
        stripePaymentIntentId: "pi_1",
        failureReason: "insufficient_funds",
      },
    );
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["requested", "confirmed"],
      expect.objectContaining({ status: "cancelled", cancelledBy: "system" }),
    );
    expect(jobs.sent.map((job) => job.name)).toEqual(["notify"]);
  });

  it("keeps the booking with its payment pending, and resumes it, when Stripe does not answer", async () => {
    payments.state.charge = { status: "error" };
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(201);
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending"],
      {
        failureReason: "outcome_unknown",
      },
    );
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
    expect(jobs.sent[0]).toMatchObject({
      name: "resume-payment",
      payload: { paymentId: PAYMENT_ID },
      options: { singletonKey: PAYMENT_ID, startAfter: new Date(NOW.getTime() + 60_000) },
    });
  });

  it("resumes a charge Stripe is still processing", async () => {
    payments.state.charge = { status: "processing" };
    expect((await send("POST", "/bookings", request)).statusCode).toBe(201);
    expect(jobs.sent[0]?.name).toBe("resume-payment");
  });

  it("passes on a problem from the payments layer, such as Stripe not being configured", async () => {
    const { HttpProblem } = await import("../http/problem.ts");
    vi.spyOn(payments.payments, "charge").mockRejectedValue(
      new HttpProblem(503, "payments-unavailable", "Payments are not configured"),
    );
    expect((await send("POST", "/bookings", request)).statusCode).toBe(503);
  });

  it("fails loudly when the saved booking cannot be read back", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    expect((await send("POST", "/bookings", request)).statusCode).toBe(500);
  });
});

describe("reading bookings", () => {
  it("shows the driver their booking with the address while it holds the slot", async () => {
    const response = await send("GET", `/bookings/${BOOKING_ID}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      role: "driver",
      status: "confirmed",
      start: "2027-01-12T22:00:00.000Z",
      addressVisible: true,
      address: "7 Test Row, Dublin 6",
      driverFirstName: null,
      payment: { status: "paid", amountCents: 1000 },
    });
  });

  it("hides the address from the driver of a request", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "requested", idTag: null, pricePerHourCents: null },
        payment: null,
      }),
    );
    expect((await send("GET", `/bookings/${BOOKING_ID}`)).json()).toMatchObject({
      addressVisible: false,
      address: null,
      location: null,
      payment: null,
      pricePerHourCents: 0,
    });
  });

  it("shows the host the driver's first name and the address", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue({
      ...bookingDetail("user-cian", {
        booking: { status: "cancelled", cancelledAt: new Date("2027-01-11T10:00:00Z") },
      }),
      host: {
        id: "host-1",
        userId: USER_ID,
        cancellationCutoffMinutes: 120,
        stripeAccountId: "acct_host",
      },
    });
    expect((await send("GET", `/bookings/${BOOKING_ID}`)).json()).toMatchObject({
      role: "host",
      driverFirstName: "Cian",
      addressVisible: true,
      cancelledAt: "2027-01-11T10:00:00.000Z",
    });
  });

  it("is 404 for anyone else", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-someone"));
    expect((await send("GET", `/bookings/${BOOKING_ID}`)).statusCode).toBe(404);
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    expect((await send("GET", `/bookings/${BOOKING_ID}`)).statusCode).toBe(404);
  });

  it("lists the driver's bookings, filtered by status", async () => {
    vi.mocked(data.driverBookingIds).mockResolvedValue([BOOKING_ID]);
    vi.mocked(data.findBookingDetails).mockResolvedValue([bookingDetail(USER_ID)]);
    const response = await send("GET", "/bookings?status=confirmed,arrived&limit=10");
    expect(response.json<{ bookings: unknown[] }>().bookings).toHaveLength(1);
    expect(data.driverBookingIds).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      statuses: ["confirmed", "arrived"],
      limit: 10,
    });
    await send("GET", "/bookings");
    expect(data.driverBookingIds).toHaveBeenLastCalledWith(expect.anything(), USER_ID, {
      limit: 50,
    });
    expect((await send("GET", "/bookings?status=lost")).statusCode).toBe(400);
  });

  it("lists the host's bookings by status and window", async () => {
    vi.mocked(data.hostBookingIds).mockResolvedValue([]);
    vi.mocked(data.findBookingDetails).mockResolvedValue([]);
    const ok = await send(
      "GET",
      "/hosts/bookings?status=requested&from=2027-01-12T00:00:00Z&to=2027-01-13T00:00:00Z",
    );
    expect(ok.json()).toEqual({ bookings: [] });
    expect(data.hostBookingIds).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      statuses: ["requested"],
      window: {
        start: new Date("2027-01-12T00:00:00Z"),
        end: new Date("2027-01-13T00:00:00Z"),
      },
      limit: 50,
    });
    await send("GET", "/hosts/bookings");
    expect(data.hostBookingIds).toHaveBeenLastCalledWith(expect.anything(), USER_ID, { limit: 50 });
    expect((await send("GET", "/hosts/bookings?from=2027-01-12T00:00:00Z")).statusCode).toBe(400);
    expect(
      (await send("GET", "/hosts/bookings?from=2027-01-13T00:00:00Z&to=2027-01-12T00:00:00Z"))
        .statusCode,
    ).toBe(400);
  });
});

describe("host answers", () => {
  const asHost = (overrides: Parameters<typeof bookingDetail>[1] = {}) =>
    vi.mocked(data.findBookingDetail).mockResolvedValue({
      ...bookingDetail("user-cian", {
        ...overrides,
        booking: { status: "requested", idTag: null, ...overrides.booking },
        payment: { status: "authorised", captureMethod: "manual", ...overrides.payment },
      }),
      host: {
        id: "host-1",
        userId: USER_ID,
        cancellationCutoffMinutes: 120,
        stripeAccountId: "acct_host",
      },
    });

  it("approves a request with a new idTag, then charges the held price", async () => {
    asHost();
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(200);
    const change = vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3];
    expect(change?.status).toBe("confirmed");
    expect(change?.idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect(payments.callsTo("capture")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      idempotencyKey: `booking-${BOOKING_ID}-capture`,
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["authorised"],
      { status: "paid", stripeChargeId: "ch_pi_1", failureReason: null },
    );
    expect(jobs.sent[0]?.name).toBe("booking-no-show");
  });

  it("cancels the booking with 402 when the hold has lapsed", async () => {
    asHost();
    payments.state.capture = "lapsed";
    const response = await send("POST", `/bookings/${BOOKING_ID}/approve`);
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ code: "payment-failed" });
    expect(vi.mocked(data.updateBookingFrom).mock.calls[1]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
    });
  });

  it("confirms anyway and resumes a capture Stripe did not answer", async () => {
    asHost();
    payments.state.capture = "error";
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(200);
    expect(jobs.sent[0]).toMatchObject({ name: "resume-payment" });
  });

  it("waits for a request's hold to be in place", async () => {
    asHost({ payment: { status: "pending" } });
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).json()).toMatchObject({
      code: "payment-in-progress",
    });
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("answers 409 when the slot was taken, or the request already answered", async () => {
    asHost();
    vi.mocked(data.updateBookingFrom).mockRejectedValueOnce(
      Object.assign(new Error("exclusion"), { code: "23P01" }),
    );
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).json()).toMatchObject({
      code: "slot-taken",
    });
    vi.mocked(data.updateBookingFrom).mockRejectedValueOnce(new Error("database down"));
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(500);
    vi.mocked(data.updateBookingFrom).mockResolvedValueOnce(false);
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).json()).toMatchObject({
      code: "not-requested",
    });
    expect(payments.callsTo("capture")).toHaveLength(0);
    asHost({ booking: { status: "confirmed" } });
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(409);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(409);
  });

  it("is 404 for the driver or anyone but the host", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(404);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(404);
  });

  it("declines a request, then releases the hold", async () => {
    asHost();
    const response = await send("POST", `/bookings/${BOOKING_ID}/decline`, { reason: "Away" });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "host",
      cancellationReason: "Away",
    });
    expect(payments.callsTo("cancelAuthorisation")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      idempotencyKey: `booking-${BOOKING_ID}-release`,
    });
    vi.mocked(data.updateBookingFrom).mockResolvedValueOnce(false);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(409);
    expect(payments.callsTo("cancelAuthorisation")).toHaveLength(1);
  });

  it("resumes a release Stripe did not answer, and one whose hold is not known yet", async () => {
    asHost();
    payments.state.release = "error";
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(200);
    expect(jobs.sent[0]).toMatchObject({ name: "resume-payment" });
    asHost({ payment: { status: "pending", stripePaymentIntentId: null } });
    jobs.clear();
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(200);
    expect(jobs.sent[0]).toMatchObject({ name: "resume-payment" });
  });
});

describe("POST /bookings/:id/cancel", () => {
  // An hour after NOW: past the default two-hour cutoff.
  const soon = new Date("2027-01-11T13:00:00Z");
  const soonEnd = new Date("2027-01-11T17:00:00Z");

  it("refunds a driver in full before the cutoff", async () => {
    const response = await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(response.statusCode).toBe(200);
    expect(paymentData.updateBookingWithRefund).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["confirmed"],
      expect.objectContaining({
        status: "cancelled",
        cancelledBy: "driver",
        cancellationReason: "cancelled_by_driver",
      }),
      { paymentId: PAYMENT_ID, amountCents: "remainder", reason: "driver_cancelled" },
    );
    expect(payments.callsTo("refund")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      amountCents: 1000,
      metadata: { bookingId: BOOKING_ID, refundId: "refund-1", reason: "driver_cancelled" },
      idempotencyKey: "refund-refund-1",
    });
    expect(paymentData.updatePendingRefund).toHaveBeenCalledWith(expect.anything(), "refund-1", {
      status: "succeeded",
      stripeRefundId: "re_refund-refund-1",
    });
  });

  it("refunds nothing when the driver cancels after the host's cutoff", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { slot: { start: soon, end: soonEnd } } }),
    );
    const response = await send("POST", `/bookings/${BOOKING_ID}/cancel`, { reason: "Plans" });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(paymentData.updateBookingWithRefund).mock.calls[0]?.[4]).toBeUndefined();
    expect(payments.calls).toHaveLength(0);
  });

  it("refunds in full when the host cancels, even late", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue({
      ...bookingDetail("user-cian", { booking: { slot: { start: soon, end: soonEnd } } }),
      host: {
        id: "host-1",
        userId: USER_ID,
        cancellationCutoffMinutes: 120,
        stripeAccountId: "acct_host",
      },
    });
    await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(vi.mocked(paymentData.updateBookingWithRefund).mock.calls[0]?.[4]).toEqual({
      paymentId: PAYMENT_ID,
      amountCents: "remainder",
      reason: "host_cancelled",
    });
  });

  it("resumes a refund Stripe did not answer", async () => {
    payments.state.refund = "error";
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(200);
    expect(jobs.sent[0]).toMatchObject({ name: "resume-payment" });
  });

  it("releases a request's hold", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { status: "requested", idTag: null },
        payment: { status: "authorised", captureMethod: "manual" },
      }),
    );
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(200);
    expect(payments.callsTo("cancelAuthorisation")).toHaveLength(1);
    expect(paymentData.updateBookingWithRefund).not.toHaveBeenCalled();
    vi.mocked(data.updateBookingFrom).mockResolvedValueOnce(false);
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(409);
  });

  it("waits while the payment is still going through", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { payment: { status: "pending" } }),
    );
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).json()).toMatchObject({
      code: "payment-in-progress",
    });
  });

  it("is refused once arrived, after a race, and to strangers", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "arrived" } }),
    );
    const arrived = await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(arrived.statusCode).toBe(409);
    expect(arrived.json()).toMatchObject({
      detail: "A session that has started can only be stopped.",
    });
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "completed" } }),
    );
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).json()).not.toHaveProperty(
      "detail",
    );
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    vi.mocked(paymentData.updateBookingWithRefund).mockResolvedValueOnce({
      changed: false,
      refund: undefined,
    });
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(409);
    expect(payments.callsTo("refund")).toHaveLength(0);
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-someone"));
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(404);
  });
});
