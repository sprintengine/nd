import {
  billedAmount,
  billingStart,
  checkMeter,
  type SessionReviewReason,
  type SessionStatus,
  whToKwh,
} from "@nd/domain";

import { findTransfer } from "../data/bookings.ts";
import {
  findSettlementSession,
  type SettlementSession,
  updateSessionFrom,
} from "../data/settlement.ts";
import type { JobAttempt } from "../jobs/jobs.ts";
import {
  captureForBooking,
  type CaptureResult,
  createHostTransfer,
  PaymentStateError,
} from "../payments/settlement.ts";
import type { SettlementServices } from "./services.ts";

// Reconciliation: after a session stops, check its meter, capture what it
// cost and pay the host. Every step only moves rows forward from the state
// it expects and Stripe calls carry idempotency keys, so running it again
// (a retry, a sweep, a repeated event) never captures or transfers twice.

/** What reconciling a session did. */
export type ReconcileOutcome =
  "reconciled" | "needs_review" | "waiting" | "already_reconciled" | "not_found";

/** Statuses a session is flagged for review from. */
const FLAGGABLE: readonly SessionStatus[] = ["stopped", "needs_host_confirmation", "needs_review"];

/** Moves a session to `needs_review` for support, with the reason, and logs it for ops. */
export async function flagForReview(
  services: SettlementServices,
  found: SettlementSession,
  reason: SessionReviewReason,
): Promise<void> {
  await updateSessionFrom(services.db, found.session.id, FLAGGABLE, {
    status: "needs_review",
    reviewReason: reason,
  });
  services.realtime.sessionChanged(found.booking.id);
  services.log.warn(
    { sessionId: found.session.id, bookingId: found.booking.id, reason },
    "session needs review; nothing captured and the host transfer is held",
  );
}

/** Sends (or holds) the host's transfer for a captured payment that has none yet. */
async function ensureHostTransfer(
  services: SettlementServices,
  found: SettlementSession,
): Promise<void> {
  const payment = found.payment;
  if (payment?.status !== "captured" || payment.capturedCents === 0) return;
  if ((await findTransfer(services.db, payment.id)) !== undefined) return;
  await createHostTransfer(services, payment.id);
}

/** When billing starts: plug-in for a scheduled start, otherwise StartTransaction. */
export function billedFrom(found: Pick<SettlementSession, "session" | "booking">): Date {
  return (
    billingStart({ pluggedInAt: found.booking.pluggedInAt, startedAt: found.session.startedAt }) ??
    found.session.createdAt
  );
}

/** Whether a session closed without a stop may be billed: the host confirmed, or the deadline passed. */
function confirmationSettled(found: SettlementSession, now: Date): boolean {
  const { hostConfirmedAt, confirmationDueAt } = found.session;
  return (
    hostConfirmedAt !== null ||
    (confirmationDueAt !== null && confirmationDueAt.getTime() <= now.getTime())
  );
}

/**
 * Captures `amountCents` of a session's authorisation; Stripe releases the
 * rest. Capturing 0 releases it all. Nothing is called for 0 cents when
 * there is no authorisation to release.
 */
export async function captureSession(
  services: SettlementServices,
  found: SettlementSession,
  amountCents: number,
): Promise<CaptureResult | undefined> {
  if (amountCents === 0 && found.payment?.status !== "authorised") return undefined;
  return captureForBooking(services, found.booking.id, amountCents);
}

/**
 * Marks a captured session reconciled, then sends the host's transfer (held
 * while tax details are incomplete or payouts are off).
 */
export async function completeSettlement(
  services: SettlementServices,
  found: SettlementSession,
  extra: { kwh?: number } = {},
): Promise<void> {
  await updateSessionFrom(services.db, found.session.id, FLAGGABLE, {
    status: "reconciled",
    reconciledAt: services.clock.now(),
    ...extra,
  });
  services.realtime.sessionChanged(found.booking.id);
  const reloaded = await findSettlementSession(services.db, found.session.id);
  if (reloaded !== undefined) await ensureHostTransfer(services, reloaded);
}

/**
 * Reconciles a stopped session: the meter delta must agree with the last
 * MeterValue within 0.2 kWh, then the billed amount (time from start to stop,
 * rounded up to 5 minutes, capped at the quote) is captured and the host's
 * transfer created. A disagreement, a missing authorisation or a capture that
 * keeps failing sends the session to `needs_review` with nothing captured.
 * A session closed without a StopTransaction waits for the host's
 * confirmation or its 72-hour deadline.
 */
export async function reconcileSession(
  services: SettlementServices,
  sessionId: string,
  attempt: Pick<JobAttempt, "lastAttempt"> = { lastAttempt: true },
): Promise<ReconcileOutcome> {
  const found = await findSettlementSession(services.db, sessionId);
  if (found === undefined) return "not_found";
  const { session, booking, payment } = found;
  switch (session.status) {
    case "reconciled":
      await ensureHostTransfer(services, found);
      return "already_reconciled";
    case "needs_review":
      // The gateway flags a stop reading below the start without a reason.
      if (session.reviewReason === null) await flagForReview(services, found, "meter_invalid");
      return "needs_review";
    case "needs_host_confirmation":
      if (!confirmationSettled(found, services.clock.now())) return "waiting";
      break;
    case "stopped":
      break;
    case "starting":
    case "charging":
    case "suspended_ev":
    case "suspended_evse":
    case "failed":
      return "waiting";
  }

  const meter = checkMeter({
    meterStartWh: session.meterStartWh,
    meterStopWh: session.meterStopWh,
    lastMeterValueWh: found.lastMeterValue?.energyWh ?? null,
  });
  const startedAt = billedFrom(found);
  if (!meter.ok || session.stoppedAt === null || session.stoppedAt < startedAt) {
    await flagForReview(services, found, meter.ok ? "meter_invalid" : meter.reason);
    return "needs_review";
  }
  if (payment === null || (payment.status !== "authorised" && payment.status !== "captured")) {
    await flagForReview(services, found, "no_authorisation");
    return "needs_review";
  }

  const amountCents = billedAmount(
    startedAt,
    session.stoppedAt,
    booking.pricePerHourCents ?? 0,
    booking.quotedAmountCents,
  );
  try {
    await captureSession(services, found, amountCents);
  } catch (error) {
    if (error instanceof PaymentStateError || error instanceof RangeError) {
      services.log.error(
        { sessionId, bookingId: booking.id, err: error },
        "session cannot be captured",
      );
      await flagForReview(services, found, "no_authorisation");
      return "needs_review";
    }
    if (attempt.lastAttempt) {
      services.log.error({ sessionId, bookingId: booking.id, err: error }, "capture kept failing");
      await flagForReview(services, found, "capture_failed");
      return "needs_review";
    }
    throw error;
  }
  await completeSettlement(services, found, { kwh: whToKwh(meter.deliveredWh) });
  return "reconciled";
}
