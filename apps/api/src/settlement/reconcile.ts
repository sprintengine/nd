import { checkMeter, type SessionStatus, whToKwh } from "@nd/domain";

import { findSettlementSession, updateSessionFrom } from "../data/settlement.ts";
import { queueNotification } from "../notifications/queue.ts";
import type { SettlementServices } from "./services.ts";

// Reconciliation: after a session stops, check its meter and record the
// energy delivered for the receipt. The booking was paid upfront, so nothing
// is captured or billed here; a meter that does not add up is flagged for
// support, who may refund by hand.

/** What reconciling a session did. */
export type ReconcileOutcome =
  "reconciled" | "needs_review" | "waiting" | "already_reconciled" | "not_found";

/**
 * Reconciles a stopped session: the meter delta must agree with the last
 * MeterValue within 0.2 kWh; then its kWh is recorded and the session is
 * `reconciled`, and the host hears it ended. A disagreement sends it to
 * `needs_review`.
 */
export async function reconcileSession(
  services: SettlementServices,
  sessionId: string,
): Promise<ReconcileOutcome> {
  const found = await findSettlementSession(services.db, sessionId);
  if (found === undefined) return "not_found";
  const { session, booking } = found;
  if (session.status === "reconciled") return "already_reconciled";
  if (session.status === "needs_review") {
    // The gateway flags a stop reading below the start without a reason.
    if (session.reviewReason === null) {
      await flag(services, sessionId, booking.id, ["needs_review"], "meter_invalid");
    }
    return "needs_review";
  }
  if (session.status !== "stopped") return "waiting";

  const meter = checkMeter({
    meterStartWh: session.meterStartWh,
    meterStopWh: session.meterStopWh,
    lastMeterValueWh: found.lastMeterValue?.energyWh ?? null,
  });
  if (!meter.ok) {
    await flag(services, sessionId, booking.id, ["stopped"], meter.reason);
    return "needs_review";
  }
  const changed = await updateSessionFrom(services.db, sessionId, ["stopped"], {
    status: "reconciled",
    kwh: whToKwh(meter.deliveredWh),
    reconciledAt: services.clock.now(),
  });
  if (!changed) return "already_reconciled";
  services.realtime.sessionChanged(booking.id);
  // The host hears what they earned (once, whichever of this and the fallback comes first).
  await queueNotification(services, {
    type: "session_settled",
    bookingId: booking.id,
    sessionId,
  });
  return "reconciled";
}

async function flag(
  services: SettlementServices,
  sessionId: string,
  bookingId: string,
  from: readonly SessionStatus[],
  reason: "meter_invalid" | "meter_mismatch",
): Promise<void> {
  await updateSessionFrom(services.db, sessionId, from, {
    status: "needs_review",
    reviewReason: reason,
  });
  services.realtime.sessionChanged(bookingId);
  services.log.warn({ sessionId, bookingId, reason }, "session meter needs review");
}
