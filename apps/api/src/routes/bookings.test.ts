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
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as data from "../data/bookings.ts";
import * as listing from "../data/listing.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/listing.ts");

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

// NOW is Monday 2027-01-11 12:00 UTC; Tuesday night is inside the 6-day horizon.
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
  vi.mocked(data.hostBookingsStarting).mockResolvedValue(0);
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

  it("books an instant slot: quotes it, authorises it now and schedules the no-show check", async () => {
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ id: BOOKING_ID, status: "confirmed", role: "driver" });
    const inserted = vi.mocked(data.insertBookingWithPayment).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      status: "confirmed",
      quotedAmountCents: 1000,
      pricePerHourCents: 250,
      vehiclePlate: "251 D 1234",
      paymentMethodId: "pm_card_visa",
    });
    expect(inserted?.idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect(payments.callsTo("authorise")[0]?.input).toMatchObject({
      bookingId: BOOKING_ID,
      amountCents: 1000,
      currency: "EUR",
      customerId: "cus_1",
      paymentMethodId: "pm_card_visa",
      idempotencyKey: `booking-${BOOKING_ID}-authorise`,
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending_authorisation"],
      { status: "authorised", stripePaymentIntentId: "pi_1", authorisedCents: 1000 },
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

  it("leaves a request without an idTag and schedules its expiry at the start", async () => {
    vi.mocked(listing.chargerRules).mockResolvedValue([rule({ instantBook: false })]);
    expect((await send("POST", "/bookings", request)).statusCode).toBe(201);
    expect(vi.mocked(data.insertBookingWithPayment).mock.calls[0]?.[1]).toMatchObject({
      status: "requested",
      idTag: null,
    });
    expect(jobs.sent[0]).toMatchObject({
      name: "booking-expire-request",
      options: { startAfter: new Date("2027-01-12T22:00:00Z") },
    });
  });

  it("keeps the saved card for a far slot and schedules its authorisation", async () => {
    const response = await send("POST", "/bookings", {
      ...request,
      from: "2027-01-19T22:00:00Z",
      to: "2027-01-20T02:00:00Z",
    });
    expect(response.statusCode).toBe(201);
    expect(payments.callsTo("authorise")).toHaveLength(0);
    const authoriseAt = new Date("2027-01-18T22:00:00Z");
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending_authorisation"],
      { status: "card_saved", authoriseAt },
    );
    expect(jobs.sent[0]).toEqual({
      name: "authorise-booking",
      payload: { bookingId: BOOKING_ID },
      options: { startAfter: authoriseAt, singletonKey: BOOKING_ID },
    });
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
    ["outside-availability", 422, () => vi.mocked(listing.chargerRules).mockResolvedValue([])],
    ["host-day-full", 409, () => vi.mocked(data.hostBookingsStarting).mockResolvedValue(2)],
    ["slot-taken", 409, () => vi.mocked(data.slotTaken).mockResolvedValue(true)],
    [
      "amount-too-small",
      422,
      () => vi.mocked(listing.chargerRules).mockResolvedValue([rule({ pricePerHourCents: 10 })]),
    ],
    [
      "slot-taken",
      409,
      () => vi.mocked(data.insertBookingWithPayment).mockResolvedValue(undefined),
    ],
  ] as const)("answers %s (%d) without authorising", async (code, status, arrange) => {
    arrange();
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(payments.callsTo("authorise")).toHaveLength(0);
  });

  it("refuses a slot that is not bookable as asked", async () => {
    const response = await send("POST", "/bookings", { ...request, from: "2027-01-12T22:00:30Z" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "invalid-slot" });
  });

  it("answers 402 and cancels the booking when the card is declined", async () => {
    payments.state.authorisation = { status: "failed", reason: "insufficient_funds" };
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(402);
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending_authorisation", "card_saved"],
      { status: "failed", failureReason: "insufficient_funds" },
    );
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["requested", "confirmed"],
      expect.objectContaining({ status: "cancelled", cancelledBy: "system" }),
    );
    expect(jobs.sent).toHaveLength(0);
  });

  it("answers 502 and cancels the booking when Stripe cannot be reached", async () => {
    payments.state.authorisation = { status: "error" };
    const response = await send("POST", "/bookings", request);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "payment-provider-error" });
    expect(data.updateBookingFrom).toHaveBeenCalled();
  });

  it("passes on a problem from the payments layer, such as Stripe not being configured", async () => {
    const { HttpProblem } = await import("../http/problem.ts");
    vi.spyOn(payments.payments, "authorise").mockRejectedValue(
      new HttpProblem(503, "payments-unavailable", "Payments are not configured"),
    );
    expect((await send("POST", "/bookings", request)).statusCode).toBe(503);
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
      payment: { status: "authorised", authorisedCents: 1000, authoriseAt: null },
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
      host: { id: "host-1", userId: USER_ID, cancellationCutoffMinutes: 120 },
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
      }),
      host: { id: "host-1", userId: USER_ID, cancellationCutoffMinutes: 120 },
    });

  it("approves a request with a new idTag and schedules the no-show check", async () => {
    asHost();
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(200);
    const change = vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3];
    expect(change?.status).toBe("confirmed");
    expect(change?.idTag).toMatch(/^[A-Z2-9]{20}$/);
    expect(jobs.sent[0]?.name).toBe("booking-no-show");
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
    asHost({ booking: { status: "confirmed" } });
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(409);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(409);
  });

  it("is 404 for the driver or anyone but the host", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    expect((await send("POST", `/bookings/${BOOKING_ID}/approve`)).statusCode).toBe(404);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(404);
  });

  it("declines a request and releases the authorisation", async () => {
    asHost();
    const response = await send("POST", `/bookings/${BOOKING_ID}/decline`, { reason: "Away" });
    expect(response.statusCode).toBe(200);
    expect(payments.callsTo("cancelAuthorisation")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      idempotencyKey: `booking-${BOOKING_ID}-release`,
    });
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "host",
      cancellationReason: "Away",
    });
    vi.mocked(data.updateBookingFrom).mockResolvedValueOnce(false);
    expect((await send("POST", `/bookings/${BOOKING_ID}/decline`)).statusCode).toBe(409);
  });
});

describe("POST /bookings/:id/cancel", () => {
  // An hour after NOW: past the default two-hour cutoff.
  const soon = new Date("2027-01-11T13:00:00Z");
  const soonEnd = new Date("2027-01-11T17:00:00Z");

  it("is free before the cutoff: the authorisation is released", async () => {
    const response = await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(response.statusCode).toBe(200);
    expect(payments.callsTo("capture")).toHaveLength(0);
    expect(payments.callsTo("cancelAuthorisation")).toHaveLength(1);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "driver",
      cancellationReason: "cancelled_by_driver",
      cancellationFeeCents: 0,
    });
  });

  it("captures one hour after the host's cutoff and queues the host's transfer", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { slot: { start: soon, end: soonEnd } } }),
    );
    const response = await send("POST", `/bookings/${BOOKING_ID}/cancel`, { reason: "Plans" });
    expect(response.statusCode).toBe(200);
    expect(payments.callsTo("capture")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      amountCents: 250,
      idempotencyKey: `booking-${BOOKING_ID}-capture`,
    });
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancellationFeeCents: 250,
      cancellationReason: "Plans",
    });
    expect(jobs.sent[0]).toEqual({
      name: "host-transfer",
      payload: { paymentId: PAYMENT_ID },
      options: { singletonKey: PAYMENT_ID },
    });
  });

  it("charges no fee without an authorisation, or when the host cancels", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, {
        booking: { slot: { start: soon, end: soonEnd } },
        payment: { status: "card_saved", stripePaymentIntentId: null },
      }),
    );
    await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(payments.callsTo("capture")).toHaveLength(0);
    expect(payments.callsTo("cancelAuthorisation")).toHaveLength(0);
    vi.mocked(data.findBookingDetail).mockResolvedValue({
      ...bookingDetail("user-cian", { booking: { slot: { start: soon, end: soonEnd } } }),
      host: { id: "host-1", userId: USER_ID, cancellationCutoffMinutes: 120 },
    });
    await send("POST", `/bookings/${BOOKING_ID}/cancel`);
    expect(payments.callsTo("capture")).toHaveLength(0);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[1]?.[3]).toMatchObject({
      cancelledBy: "host",
      cancellationFeeCents: 0,
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
    vi.mocked(data.updateBookingFrom).mockResolvedValueOnce(false);
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(409);
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-someone"));
    expect((await send("POST", `/bookings/${BOOKING_ID}/cancel`)).statusCode).toBe(404);
  });
});
