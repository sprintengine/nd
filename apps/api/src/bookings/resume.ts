import { findBookingDetail, findPayment } from "../data/bookings.ts";
import { unsentRefunds } from "../data/payments.ts";
import {
  captureHold,
  chargeBooking,
  checkPendingRefunds,
  type MoneyOutcome,
  refreshCharge,
  releaseHold,
  sendUnsentRefunds,
} from "../payments/charges.ts";
import type { Services } from "../services.ts";
import { cancelForPayment } from "./lifecycle.ts";

// Resuming a payment that stopped half way: Stripe did not answer, or the
// process stopped between saving a booking change and the Stripe call that
// follows it. What to do is read from the rows, and every Stripe call reuses
// its action's idempotency key, so a resume never charges, captures or
// refunds twice. The `resume-payment` job runs it; the settlement sweep
// queues that job for whatever needs it.

/** What resuming did. */
export type ResumeOutcome = MoneyOutcome | "booking_cancelled" | "refunds_sent" | "nothing";

/** Error thrown so the job retries a call Stripe still did not answer. */
class StillUnknownError extends Error {
  override name = "StillUnknownError";
}

export async function resumePayment(services: Services, paymentId: string): Promise<ResumeOutcome> {
  const found = await findPayment(services.db, paymentId);
  if (found === undefined) return "nothing";
  const detail = await findBookingDetail(services.db, found.bookingId);
  if (detail?.payment === undefined || detail.payment === null) return "nothing";
  const { booking } = detail;
  let payment = detail.payment;

  if (payment.status === "pending") {
    const customerId = detail.driver.stripeCustomerId;
    const destination = detail.host.stripeAccountId;
    let outcome;
    if (payment.stripePaymentIntentId !== null) {
      // Stripe has the PaymentIntent (it was processing): ask how it ended.
      outcome = await refreshCharge(services, payment);
    } else if (customerId === null || destination === null) {
      services.log.error({ paymentId }, "a pending payment has no customer or host account");
      return "nothing";
    } else {
      // No answer at all: the same idempotency key, so Stripe answers with what it did then.
      outcome = await chargeBooking(services, payment, { customerId, destination });
    }
    if (outcome === "unknown") throw new StillUnknownError(`payment ${paymentId} is still unknown`);
    const reloaded = await findPayment(services.db, paymentId);
    if (reloaded === undefined) return "nothing";
    payment = reloaded;
  }

  const live = booking.status === "requested" || booking.status === "confirmed";
  if (payment.status === "failed" || payment.status === "cancelled") {
    if (!live) return payment.status;
    await cancelForPayment(services, booking.id, payment.failureReason ?? payment.status);
    return "booking_cancelled";
  }
  if (payment.status === "authorised") {
    if (booking.status === "cancelled") {
      const outcome = await releaseHold(services, payment);
      if (outcome === "unknown") throw new StillUnknownError(`release of ${paymentId} unanswered`);
      return outcome;
    }
    if (booking.status === "confirmed") {
      const outcome = await captureHold(services, payment);
      if (outcome === "unknown") throw new StillUnknownError(`capture of ${paymentId} unanswered`);
      if (outcome === "failed") {
        await cancelForPayment(services, booking.id, "authorisation_expired");
        return "booking_cancelled";
      }
      return outcome;
    }
    return "authorised";
  }
  if (payment.status === "paid") {
    await sendUnsentRefunds(services, payment);
    await checkPendingRefunds(services, payment);
    if ((await unsentRefunds(services.db, paymentId)).length > 0) {
      throw new StillUnknownError(`refunds of ${paymentId} unanswered`);
    }
    return "refunds_sent";
  }
  return payment.status;
}
