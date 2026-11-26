import { isOpenSession, platformFee, type TransferHoldReason } from "@nd/domain";

import {
  findBookingDetail,
  findPayment,
  findTransfer,
  findTransferContext,
  type Payment,
  saveTransfer,
  type Transfer,
  type TransferContext,
  updatePaymentFrom,
} from "../data/bookings.ts";
import type { Services } from "../services.ts";

// Capture and transfer: the money side of a finished (or cancelled) booking.
// Both are safe to call again: Stripe calls carry idempotency keys derived
// from the booking, and the database rows are only moved forward from the
// state they are expected in.

/** A payment is not in a state that allows what was asked. */
export class PaymentStateError extends Error {
  override name = "PaymentStateError";
}

/** The outcome of a capture. */
export interface CaptureResult {
  readonly paymentId: string;
  readonly capturedCents: number;
  readonly chargeId: string | null;
}

/** Stripe idempotency keys for a booking's payment calls. */
export const paymentKeys = {
  authorise: (bookingId: string) => `booking-${bookingId}-authorise`,
  authoriseAttempt: (bookingId: string, retryCount: number) =>
    `booking-${bookingId}-authorise-${String(retryCount)}`,
  release: (bookingId: string) => `booking-${bookingId}-release`,
  capture: (bookingId: string) => `booking-${bookingId}-capture`,
  transfer: (bookingId: string) => `booking-${bookingId}-transfer`,
};

/**
 * Captures `amountCents` of a booking's authorisation; Stripe releases the
 * rest. Never more than was authorised. Capturing 0 releases the whole
 * authorisation instead. Calling it again with the same amount returns the
 * first result; with a different amount after a capture it throws.
 */
export async function captureForBooking(
  services: Services,
  bookingId: string,
  amountCents: number,
): Promise<CaptureResult> {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`amountCents must be a non-negative integer, got ${String(amountCents)}`);
  }
  const payment = (await findBookingDetail(services.db, bookingId))?.payment ?? null;
  if (payment === null) throw new PaymentStateError(`booking ${bookingId} has no payment`);
  if (payment.status === "captured") {
    if (payment.capturedCents === amountCents) {
      return {
        paymentId: payment.id,
        capturedCents: amountCents,
        chargeId: payment.stripeChargeId,
      };
    }
    throw new PaymentStateError(`booking ${bookingId} was already captured for another amount`);
  }
  if (payment.status !== "authorised" || payment.stripePaymentIntentId === null) {
    throw new PaymentStateError(`booking ${bookingId} has no authorisation to capture`);
  }
  if (amountCents > payment.authorisedCents) {
    throw new RangeError(
      `cannot capture ${String(amountCents)} cents: only ${String(payment.authorisedCents)} are authorised`,
    );
  }
  if (amountCents === 0) {
    await releaseAuthorisation(services, bookingId, payment);
    return { paymentId: payment.id, capturedCents: 0, chargeId: null };
  }
  const captured = await services.payments.capture({
    paymentIntentId: payment.stripePaymentIntentId,
    amountCents,
    idempotencyKey: paymentKeys.capture(bookingId),
  });
  await updatePaymentFrom(services.db, payment.id, ["authorised"], {
    status: "captured",
    capturedCents: amountCents,
    stripeChargeId: captured.chargeId,
    platformFeeCents: platformFee(amountCents, services.platformFeeBps),
  });
  return { paymentId: payment.id, capturedCents: amountCents, chargeId: captured.chargeId };
}

/**
 * Lets go of a booking's payment without charging: releases a held
 * authorisation, and marks a saved-card or pending payment cancelled.
 * Captured and failed payments are left alone.
 */
export async function releaseAuthorisation(
  services: Services,
  bookingId: string,
  payment: Pick<Payment, "id" | "status" | "stripePaymentIntentId"> | null,
): Promise<void> {
  if (payment === null) return;
  if (payment.status === "authorised" && payment.stripePaymentIntentId !== null) {
    await services.payments.cancelAuthorisation({
      paymentIntentId: payment.stripePaymentIntentId,
      idempotencyKey: paymentKeys.release(bookingId),
    });
  }
  await updatePaymentFrom(
    services.db,
    payment.id,
    ["pending_authorisation", "card_saved", "authorised"],
    { status: "cancelled" },
  );
}

/** Why the host's transfer must wait, or undefined when it can be sent now. */
export function transferHoldReason(context: TransferContext): TransferHoldReason | undefined {
  const status = context.sessionStatus;
  if (
    status === "needs_review" ||
    status === "needs_host_confirmation" ||
    (status !== null && isOpenSession(status))
  ) {
    return "session_needs_review";
  }
  if (context.disputeOpen) return "dispute_open";
  if (!context.taxDetailsComplete) return "tax_details_incomplete";
  if (context.payoutStatus !== "enabled" || context.stripeAccountId === null) {
    return "payouts_not_enabled";
  }
  return undefined;
}

/**
 * Sends the host their share of a captured payment (the capture less the
 * platform fee) as a separate transfer to their connected account, funded by
 * the charge (`source_transaction`) and grouped with the booking. While the
 * session needs review, a dispute is open, the host's tax details are
 * incomplete or payouts are not enabled, the transfer is recorded as held
 * instead; calling again later sends it once nothing holds it. A sent
 * transfer is returned as it is.
 */
export async function createHostTransfer(services: Services, paymentId: string): Promise<Transfer> {
  const payment = await findPayment(services.db, paymentId);
  if (payment === undefined) throw new PaymentStateError(`no payment ${paymentId}`);
  if (payment.status !== "captured") {
    throw new PaymentStateError(`payment ${paymentId} is not captured`);
  }
  const existing = await findTransfer(services.db, paymentId);
  if (existing !== undefined && (existing.status === "sent" || existing.status === "reversed")) {
    return existing;
  }
  const context = await findTransferContext(services.db, paymentId);
  if (context === undefined) throw new PaymentStateError(`payment ${paymentId} has no booking`);
  const amountCents = payment.capturedCents - payment.platformFeeCents;
  const base = { amountCents, currency: payment.currency };
  const holdReason = transferHoldReason(context);
  if (holdReason !== undefined) {
    return saveTransfer(services.db, paymentId, { ...base, status: "held", holdReason });
  }
  if (amountCents === 0) {
    return saveTransfer(services.db, paymentId, {
      ...base,
      status: "sent",
      holdReason: null,
      sentAt: services.clock.now(),
    });
  }
  if (payment.stripeChargeId === null || context.stripeAccountId === null) {
    throw new PaymentStateError(`payment ${paymentId} has no charge to transfer from`);
  }
  const transfer = await services.payments.transfer({
    amountCents,
    currency: payment.currency,
    destination: context.stripeAccountId,
    sourceTransaction: payment.stripeChargeId,
    transferGroup: context.bookingId,
    metadata: { bookingId: context.bookingId, paymentId },
    idempotencyKey: paymentKeys.transfer(context.bookingId),
  });
  return saveTransfer(services.db, paymentId, {
    ...base,
    status: "sent",
    holdReason: null,
    stripeTransferId: transfer.id,
    sentAt: services.clock.now(),
  });
}
