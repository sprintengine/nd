import { isOpenSession, OPEN_SESSION_STATUSES, staleSessionCloseAt, whToKwh } from "@nd/domain";

import { updateBookingFrom } from "../data/bookings.ts";
import { findSettlementSession, updateSessionFrom } from "../data/settlement.ts";
import { refundChargerFault } from "./charger-fault.ts";
import type { SettlementServices } from "./services.ts";

// Sessions whose StopTransaction never came (the host's internet dropped, or
// the charger lost power) are closed from their last meter value a few
// minutes after the slot, so the booking completes and the receipt shows the
// energy. The booking was paid upfront: nothing is billed here. A session the
// charger dropped without delivering anything is refunded in full.

/** What closing a stale session did. */
export type CloseOutcome = "closed" | "needs_review" | "skipped";

/**
 * Closes a session still open after its slot (plus the grace) from its last
 * meter value: it becomes `reconciled` with that energy, and the booking
 * `completed`. Without a usable meter value it goes to `needs_review` so
 * support can look at it (and refund by hand if the charger let the driver down).
 */
export async function closeStaleSession(
  services: SettlementServices,
  sessionId: string,
): Promise<CloseOutcome> {
  const found = await findSettlementSession(services.db, sessionId);
  const now = services.clock.now();
  if (
    found === undefined ||
    found.session.status === "starting" ||
    !isOpenSession(found.session.status) ||
    now < staleSessionCloseAt(found.booking.slot.end, services.timings.staleSessionGraceMinutes)
  ) {
    return "skipped";
  }
  const { session, booking } = found;
  const last = found.lastMeterValue;
  await updateBookingFrom(services.db, booking.id, ["active"], { status: "completed" });
  const usable =
    last !== null && session.meterStartWh !== null && last.energyWh >= session.meterStartWh;
  // The charger stopped reporting: if it delivered nothing, that is its fault.
  // Refund before closing the session, so a run that stops half way is retried.
  if (usable && last.energyWh === session.meterStartWh) await refundChargerFault(services, found);
  const closed = await updateSessionFrom(
    services.db,
    sessionId,
    OPEN_SESSION_STATUSES,
    usable
      ? {
          status: "reconciled",
          stopReason: "NoStopTransaction",
          meterStopWh: last.energyWh,
          kwh: whToKwh(last.energyWh - (session.meterStartWh ?? 0)),
          stoppedAt: last.ts,
          reconciledAt: now,
        }
      : {
          status: "needs_review",
          reviewReason: "missing_stop",
          stopReason: "NoStopTransaction",
          ...(last === null ? {} : { stoppedAt: last.ts }),
        },
  );
  if (!closed) return "skipped";
  services.realtime.bookingChanged(booking.id);
  services.realtime.sessionChanged(booking.id);
  if (!usable) {
    services.log.warn(
      { sessionId, bookingId: booking.id },
      "session closed without a stop or a usable meter value; needs review",
    );
    return "needs_review";
  }
  return "closed";
}
