import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment, PAYMENT_ID } from "../../test/booking-detail.ts";
import { unitServices } from "../../test/services.ts";
import * as data from "../data/bookings.ts";
import * as paymentData from "../data/payments.ts";
import { BOOKING_JOBS, expireRequestJob, noShowJob, resumePaymentJob } from "./jobs.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/payments.ts");

const DRIVER = "user-cian";
const attempt = { jobId: "j1", retryCount: 0, lastAttempt: false };

let env: ReturnType<typeof unitServices>;

beforeEach(() => {
  vi.resetAllMocks();
  env = unitServices(new Date("2027-01-11T22:00:00Z"));
  vi.mocked(data.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.updateBookingFrom).mockResolvedValue(true);
  vi.mocked(paymentData.unsentRefunds).mockResolvedValue([]);
});

/** The booking (and its payment, also returned by findPayment) the jobs will read. */
function given(overrides: Parameters<typeof bookingDetail>[1] = {}) {
  const detail = bookingDetail(DRIVER, overrides);
  vi.mocked(data.findBookingDetail).mockResolvedValue(detail);
  vi.mocked(data.findPayment).mockResolvedValue(detail.payment ?? undefined);
  return detail;
}

describe("BOOKING_JOBS", () => {
  it("lists every job once", () => {
    expect(BOOKING_JOBS.map((job) => job.name)).toEqual([
      "booking-no-show",
      "booking-expire-request",
      "resume-payment",
    ]);
  });
});

describe("booking-no-show", () => {
  const end = new Date("2027-01-13T02:00:00Z");

  it("waits until 15 minutes after the slot", async () => {
    given();
    env.clock.current = new Date(end.getTime() + 14 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("marks the booking a no-show, keeping what was paid", async () => {
    given();
    env.clock.current = new Date(end.getTime() + 15 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["confirmed"],
      { status: "no_show" },
    );
    expect(env.payments.calls).toHaveLength(0);
  });

  it("leaves bookings that were not left confirmed", async () => {
    given({ booking: { status: "completed" } });
    env.clock.current = new Date(end.getTime() + 60 * 60_000);
    await noShowJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });
});

describe("booking-expire-request", () => {
  const requested = {
    booking: { status: "requested" as const, idTag: null },
    payment: { status: "authorised" as const, captureMethod: "manual" as const },
  };

  it("cancels an unanswered request 24 hours after it was made, then releases the hold", async () => {
    given(requested);
    env.clock.current = new Date("2027-01-11T11:59:00Z");
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
    env.clock.current = new Date("2027-01-11T12:00:00Z");
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      cancellationReason: "host_did_not_respond",
    });
    expect(env.payments.callsTo("cancelAuthorisation")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      idempotencyKey: `booking-${BOOKING_ID}-release`,
    });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["authorised"],
      { status: "cancelled" },
    );
  });

  it("releases nothing when another change won the booking first", async () => {
    given(requested);
    vi.mocked(data.updateBookingFrom).mockResolvedValue(false);
    env.clock.current = new Date("2027-01-12T00:00:00Z");
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(env.payments.calls).toHaveLength(0);
  });

  it("leaves answered requests alone", async () => {
    given();
    env.clock.current = new Date("2027-01-12T00:00:00Z");
    await expireRequestJob.run({ bookingId: BOOKING_ID }, env.services, attempt);
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });
});

describe("resume-payment", () => {
  const run = () => resumePaymentJob.run({ paymentId: PAYMENT_ID }, env.services, attempt);

  it("does nothing for a payment that is gone", async () => {
    vi.mocked(data.findPayment).mockResolvedValue(undefined);
    await run();
    vi.mocked(data.findPayment).mockResolvedValue(payment());
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    await run();
    expect(env.payments.calls).toHaveLength(0);
  });

  it("asks again for a charge whose outcome was not known, with the same key", async () => {
    given({ payment: { status: "pending", stripePaymentIntentId: null } });
    vi.mocked(data.findPayment)
      .mockResolvedValueOnce(payment({ status: "pending", stripePaymentIntentId: null }))
      .mockResolvedValueOnce(payment({ status: "paid" }));
    await run();
    expect(env.payments.callsTo("charge")[0]?.input).toMatchObject({
      destination: "acct_host",
      applicationFeeCents: 40,
      idempotencyKey: `booking-${BOOKING_ID}-charge`,
    });
    expect(vi.mocked(data.updatePaymentFrom).mock.calls[0]?.[3]).toMatchObject({ status: "paid" });
  });

  it("throws, so the job retries, while Stripe still does not answer", async () => {
    given({ payment: { status: "pending" } });
    env.payments.state.charge = { status: "error" };
    await expect(run()).rejects.toThrow(/still unknown/);
  });

  it("cancels the booking when the charge turns out declined", async () => {
    given({ payment: { status: "pending" } });
    env.payments.state.charge = { status: "failed", reason: "insufficient_funds" };
    vi.mocked(data.findPayment)
      .mockResolvedValueOnce(payment({ status: "pending" }))
      .mockResolvedValueOnce(payment({ status: "failed", failureReason: "insufficient_funds" }));
    await run();
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancelledBy: "system",
      cancellationReason: "payment_failed: insufficient_funds",
    });
  });

  it("leaves a pending payment it cannot charge for support", async () => {
    given({ payment: { status: "pending" }, host: { stripeAccountId: null } });
    await run();
    expect(env.payments.calls).toHaveLength(0);
  });

  it("releases a hold on a cancelled booking", async () => {
    given({ booking: { status: "cancelled" }, payment: { status: "authorised" } });
    await run();
    expect(env.payments.callsTo("cancelAuthorisation")).toHaveLength(1);
    env.payments.state.release = "error";
    await expect(run()).rejects.toThrow(/unanswered/);
  });

  it("captures the hold of an approved request, and cancels it when the hold lapsed", async () => {
    given({ payment: { status: "authorised", captureMethod: "manual" } });
    await run();
    expect(env.payments.callsTo("capture")[0]?.input).toEqual({
      paymentIntentId: "pi_1",
      idempotencyKey: `booking-${BOOKING_ID}-capture`,
    });
    env.payments.state.capture = "lapsed";
    await run();
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancellationReason: "payment_failed: authorisation_expired",
    });
    env.payments.state.capture = "error";
    await expect(run()).rejects.toThrow(/unanswered/);
  });

  it("leaves a request's hold in place while the host decides", async () => {
    given({ booking: { status: "requested", idTag: null }, payment: { status: "authorised" } });
    await run();
    expect(env.payments.calls).toHaveLength(0);
  });

  it("cancels a booking still holding its slot without a payment", async () => {
    given({ payment: { status: "failed", failureReason: null } });
    await run();
    expect(vi.mocked(data.updateBookingFrom).mock.calls[0]?.[3]).toMatchObject({
      cancellationReason: "payment_failed: failed",
    });
    vi.mocked(data.updateBookingFrom).mockClear();
    given({ booking: { status: "cancelled" }, payment: { status: "cancelled" } });
    await run();
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("sends refunds that were recorded but not sent", async () => {
    given({ booking: { status: "cancelled" } });
    const refund = {
      id: "r1",
      paymentId: PAYMENT_ID,
      amountCents: 1000,
      currency: "EUR" as const,
      reason: "driver_cancelled" as const,
      status: "pending" as const,
      stripeRefundId: null,
      issuedById: null,
      note: null,
      operationId: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(paymentData.unsentRefunds).mockResolvedValueOnce([refund]).mockResolvedValueOnce([]);
    await run();
    expect(env.payments.callsTo("refund")[0]?.input).toMatchObject({
      paymentIntentId: "pi_1",
      amountCents: 1000,
      idempotencyKey: "refund-r1",
    });
    vi.mocked(paymentData.unsentRefunds).mockResolvedValue([refund]);
    env.payments.state.refund = "error";
    await expect(run()).rejects.toThrow(/unanswered/);
  });
});
