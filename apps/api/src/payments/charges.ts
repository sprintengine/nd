import type { RefundReason } from "@nd/domain";

import { type Payment, updatePaymentFrom } from "../data/bookings.ts";
import {
  insertRefund,
  recordStripeRefund,
  type Refund,
  refundsAwaitingStripe,
  unsentRefunds,
  updatePendingRefund,
} from "../data/payments.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";
import { type ChargeResult, PaymentRejectedError } from "../stripe/payments.ts";

// The money side of a booking, paid upfront as one destination charge to the
// host's connected account. Each step is one Stripe call with an idempotency
// key per logical action (never per retry), so calling it again, after a
// crash or a lost response, returns what Stripe did the first time. The
// booking's status change is always saved first; a call that fails half way
// leaves the payment or refund row saying so, and `resumePayment` picks it up.

/** Stripe idempotency keys: one per logical action on a booking. */
export const paymentKeys = {
  charge: (bookingId: string) => `booking-${bookingId}-charge`,
  capture: (bookingId: string) => `booking-${bookingId}-capture`,
  release: (bookingId: string) => `booking-${bookingId}-release`,
  refund: (refundId: string) => `refund-${refundId}`,
};

/** What a charge, capture or release came to. `unknown`: Stripe did not answer; resume later. */
export type MoneyOutcome = "paid" | "authorised" | "pending" | "failed" | "cancelled" | "unknown";

/** Why a payment's outcome is not known, recorded until it is resumed. */
const OUTCOME_UNKNOWN = "outcome_unknown";

/** Stripe refused a call for good; `code` is why. */
class Rejected {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

/**
 * Calls Stripe. Undefined when it did not answer (or answered with an error
 * worth retrying): the call is resumed later with the same key. A `Rejected`
 * when Stripe refused it for good. A problem the API itself raised (payments
 * not configured) passes through.
 */
async function attempt<T>(
  services: Services,
  context: Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T | Rejected | undefined> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    if (error instanceof PaymentRejectedError) {
      services.log.error({ ...context, err: error }, "Stripe refused a payment call; not retried");
      return new Rejected(error.code);
    }
    services.log.error({ ...context, err: error }, "payment call failed; it will be resumed");
    return undefined;
  }
}

/**
 * Charges a booking's price (automatic capture) or holds it (manual capture,
 * for a request), as a destination charge to `destination` with the platform
 * and card fees as the application fee. Records the outcome on the payment.
 */
export async function chargeBooking(
  services: Services,
  payment: Payment,
  input: { readonly customerId: string; readonly destination: string },
): Promise<MoneyOutcome> {
  const { bookingId } = payment;
  if (payment.stripePaymentMethodId === null) throw new Error(`payment ${payment.id} has no card`);
  const result = await attempt(services, { bookingId, paymentId: payment.id }, () =>
    services.payments.charge({
      bookingId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      customerId: input.customerId,
      paymentMethodId: payment.stripePaymentMethodId ?? "",
      destination: input.destination,
      applicationFeeCents: payment.platformFeeCents + payment.cardFeeCents,
      captureMethod: payment.captureMethod,
      idempotencyKey: paymentKeys.charge(bookingId),
    }),
  );
  return recordCharge(services, payment, result);
}

/**
 * Asks Stripe how a charge it already has (its PaymentIntent) ended, instead
 * of replaying the create, whose saved answer would never change.
 */
export async function refreshCharge(services: Services, payment: Payment): Promise<MoneyOutcome> {
  const intentId = payment.stripePaymentIntentId;
  if (intentId === null) return "unknown";
  const result = await attempt(services, { bookingId: payment.bookingId }, () =>
    services.payments.retrieveCharge(intentId),
  );
  return recordCharge(services, payment, result);
}

/** Records what became of a charge on its payment, still pending. */
async function recordCharge(
  services: Services,
  payment: Payment,
  result: ChargeResult | Rejected | undefined,
): Promise<MoneyOutcome> {
  const db = services.db;
  if (result === undefined) {
    await updatePaymentFrom(db, payment.id, ["pending"], { failureReason: OUTCOME_UNKNOWN });
    return "unknown";
  }
  if (result instanceof Rejected) {
    await updatePaymentFrom(db, payment.id, ["pending"], {
      status: "failed",
      failureReason: result.code,
    });
    return "failed";
  }
  switch (result.status) {
    case "paid":
      await updatePaymentFrom(db, payment.id, ["pending"], {
        status: "paid",
        stripePaymentIntentId: result.paymentIntentId,
        stripeChargeId: result.chargeId,
        failureReason: null,
      });
      return "paid";
    case "authorised":
      await updatePaymentFrom(db, payment.id, ["pending"], {
        status: "authorised",
        stripePaymentIntentId: result.paymentIntentId,
        failureReason: null,
      });
      return "authorised";
    case "pending":
      await updatePaymentFrom(db, payment.id, ["pending"], {
        stripePaymentIntentId: result.paymentIntentId,
        failureReason: null,
      });
      return "pending";
    case "failed":
      await updatePaymentFrom(db, payment.id, ["pending"], {
        status: "failed",
        stripePaymentIntentId: result.paymentIntentId,
        failureReason: result.reason,
      });
      return "failed";
  }
}

/** Captures a request's hold once the host has approved it. */
export async function captureHold(services: Services, payment: Payment): Promise<MoneyOutcome> {
  const intentId = payment.stripePaymentIntentId;
  if (payment.status !== "authorised" || intentId === null) return "unknown";
  const result = await attempt(services, { bookingId: payment.bookingId }, () =>
    services.payments.capture({
      paymentIntentId: intentId,
      idempotencyKey: paymentKeys.capture(payment.bookingId),
    }),
  );
  if (result === undefined) return "unknown";
  if (result instanceof Rejected || result.status === "failed") {
    await updatePaymentFrom(services.db, payment.id, ["authorised"], {
      status: "failed",
      failureReason: result instanceof Rejected ? result.code : result.reason,
    });
    return "failed";
  }
  await updatePaymentFrom(services.db, payment.id, ["authorised"], {
    status: "paid",
    stripeChargeId: result.chargeId,
    failureReason: null,
  });
  return "paid";
}

/**
 * Lets go of a request's hold without charging (declined, expired or
 * cancelled). A payment whose outcome is not known yet is left for
 * `resumePayment`, which releases it once it knows the PaymentIntent.
 */
export async function releaseHold(services: Services, payment: Payment): Promise<MoneyOutcome> {
  const intentId = payment.stripePaymentIntentId;
  if (payment.status !== "authorised" || intentId === null) return "unknown";
  const released = await attempt(services, { bookingId: payment.bookingId }, async () => {
    await services.payments.cancelAuthorisation({
      paymentIntentId: intentId,
      idempotencyKey: paymentKeys.release(payment.bookingId),
    });
    return true;
  });
  if (released === undefined) return "unknown";
  if (released instanceof Rejected) {
    // Nothing was charged; Stripe lets the hold lapse. Support may need to look.
    await updatePaymentFrom(services.db, payment.id, ["authorised"], {
      status: "failed",
      failureReason: `release_refused: ${released.code}`,
    });
    services.log.error(
      { bookingId: payment.bookingId },
      "a hold could not be released; needs support",
    );
    return "failed";
  }
  await updatePaymentFrom(services.db, payment.id, ["authorised"], { status: "cancelled" });
  return "cancelled";
}

/**
 * Sends a recorded refund to Stripe, reversing the host's share and the
 * application fee in proportion. Waits (does nothing) until the payment is
 * paid. A call that fails leaves the refund pending for `resumePayment`.
 */
export async function sendRefund(
  services: Services,
  payment: Payment,
  refund: Refund,
): Promise<Refund["status"]> {
  const intentId = payment.stripePaymentIntentId;
  if (refund.status !== "pending" || refund.stripeRefundId !== null) return refund.status;
  if (payment.status !== "paid" || intentId === null) return "pending";
  const result = await attempt(
    services,
    { bookingId: payment.bookingId, refundId: refund.id },
    () =>
      services.payments.refund({
        paymentIntentId: intentId,
        amountCents: refund.amountCents,
        metadata: { bookingId: payment.bookingId, refundId: refund.id, reason: refund.reason },
        idempotencyKey: paymentKeys.refund(refund.id),
      }),
  );
  if (result === undefined) return "pending";
  if (result instanceof Rejected) {
    await updatePendingRefund(services.db, refund.id, {
      status: "failed",
      failureReason: result.code,
    });
    refundFailed(services, payment, refund.id);
    return "failed";
  }
  await updatePendingRefund(services.db, refund.id, {
    status: result.status,
    stripeRefundId: result.id,
    ...(result.status === "failed" ? { failureReason: "refund_failed" } : {}),
  });
  if (result.status === "failed") refundFailed(services, payment, refund.id);
  return result.status;
}

/** Logs a refund Stripe could not make: support has to settle it with the driver. */
function refundFailed(services: Services, payment: Payment, refundId: string): void {
  services.log.error(
    { bookingId: payment.bookingId, refundId },
    "a refund failed at Stripe; needs support",
  );
}

/**
 * Asks Stripe for the outcome of each refund it has not settled yet, and
 * records it; a refund still pending is touched, so the sweep waits before
 * asking again.
 */
export async function checkPendingRefunds(services: Services, payment: Payment): Promise<void> {
  for (const refund of await refundsAwaitingStripe(services.db, payment.id)) {
    const stripeRefundId = refund.stripeRefundId ?? "";
    const found = await attempt(
      services,
      { bookingId: payment.bookingId, refundId: refund.id },
      () => services.payments.retrieveRefund(stripeRefundId),
    );
    if (found === undefined) continue;
    const status = found instanceof Rejected ? "failed" : found.status;
    await recordStripeRefund(services.db, {
      stripeRefundId,
      refundId: refund.id,
      status,
      ...(found instanceof Rejected ? { failureReason: found.code } : {}),
    });
    if (status === "failed") refundFailed(services, payment, refund.id);
  }
}

/** Sends every refund of a paid payment that has been recorded but not sent. */
export async function sendUnsentRefunds(services: Services, payment: Payment): Promise<void> {
  for (const refund of await unsentRefunds(services.db, payment.id)) {
    await sendRefund(services, payment, refund);
  }
}

/**
 * Records a refund and sends it. Undefined when it is more than is left to
 * refund. Prefer recording the refund in the same transaction as the booking
 * change that causes it (see `insertRefund`), then calling `sendRefund`.
 */
export async function refundPayment(
  services: Services,
  payment: Payment,
  input: {
    readonly amountCents: number;
    readonly reason: RefundReason;
    readonly issuedById?: string;
    readonly note?: string;
    readonly operationId?: string;
  },
): Promise<Refund | undefined> {
  const refund = await insertRefund(services.db, { paymentId: payment.id, ...input });
  if (refund === undefined) return undefined;
  const status = await sendRefund(services, payment, refund);
  return { ...refund, status };
}
