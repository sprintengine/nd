import {
  hostConfirmationDueAt,
  isOpenSession,
  OPEN_SESSION_STATUSES,
  staleSessionCloseAt,
  whToKwh,
} from "@nd/domain";

import { updateBookingFrom } from "../data/bookings.ts";
import {
  findSettlementSession,
  insertDispute,
  type SettlementSession,
  updateSessionFrom,
} from "../data/settlement.ts";
import { HttpProblem } from "../http/problem.ts";
import { closedSessionDriverEmail, closedSessionHostEmail } from "./emails.ts";
import { confirmationTimeoutJob, reconcileSessionJob } from "./jobs.ts";
import { billedFrom } from "./reconcile.ts";
import type { SettlementServices } from "./services.ts";

// Sessions whose StopTransaction never came (the host's internet dropped, or
// the charger lost power): closed from the last meter value 10 minutes after
// the slot, then billed once the host confirms or 72 hours pass. The host may
// dispute instead, which leaves it for support.

/** What closing a stale session did. */
export type CloseOutcome = "closed" | "needs_review" | "skipped";

/**
 * Closes a session still open 10 minutes after its slot ended, from its last
 * meter value: it becomes `needs_host_confirmation`, the booking `completed`,
 * both sides are emailed, and a job bills it in 72 hours unless the host
 * answers first. Without a meter value to close from, it goes to support.
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
    now < staleSessionCloseAt(found.booking.slot.end)
  ) {
    return "skipped";
  }
  const { session, booking } = found;
  const last = found.lastMeterValue;
  await updateBookingFrom(services.db, booking.id, ["active"], { status: "completed" });
  if (last === null || session.meterStartWh === null || last.energyWh < session.meterStartWh) {
    await updateSessionFrom(services.db, sessionId, OPEN_SESSION_STATUSES, {
      status: "needs_review",
      reviewReason: "missing_stop",
      stopReason: "NoStopTransaction",
      ...(last === null ? {} : { stoppedAt: last.ts }),
    });
    services.realtime.bookingChanged(booking.id);
    services.realtime.sessionChanged(booking.id);
    services.log.warn(
      { sessionId, bookingId: booking.id },
      "session closed without a stop or a usable meter value; needs review",
    );
    return "needs_review";
  }
  const confirmationDueAt = hostConfirmationDueAt(now);
  const kwh = whToKwh(last.energyWh - session.meterStartWh);
  const closed = await updateSessionFrom(services.db, sessionId, OPEN_SESSION_STATUSES, {
    status: "needs_host_confirmation",
    reviewReason: "missing_stop",
    stopReason: "NoStopTransaction",
    meterStopWh: last.energyWh,
    kwh,
    stoppedAt: last.ts,
    confirmationDueAt,
  });
  if (!closed) return "skipped";
  services.realtime.bookingChanged(booking.id);
  services.realtime.sessionChanged(booking.id);
  await services.jobs.send(
    confirmationTimeoutJob,
    { sessionId },
    { startAfter: confirmationDueAt, singletonKey: sessionId },
  );
  const notice = {
    bookingId: booking.id,
    driver: found.driver,
    host: { name: found.host.name, email: found.host.email },
    startedAt: billedFrom(found),
    stoppedAt: last.ts,
    kwh,
    timezone: found.charger.timezone,
    confirmationDueAt,
  };
  await services.email.send(closedSessionDriverEmail(notice));
  await services.email.send(closedSessionHostEmail(notice));
  return "closed";
}

/** The session, if the user hosts its charger and it waits for their confirmation. */
async function awaitingHost(
  services: SettlementServices,
  hostUserId: string,
  sessionId: string,
): Promise<SettlementSession> {
  const found = await findSettlementSession(services.db, sessionId);
  if (found?.host.userId !== hostUserId) {
    throw new HttpProblem(404, "session-not-found", "No such session");
  }
  if (
    found.session.status !== "needs_host_confirmation" ||
    found.session.hostConfirmedAt !== null
  ) {
    throw new HttpProblem(
      409,
      "session-not-awaiting-confirmation",
      "This session is not waiting for your confirmation",
    );
  }
  return found;
}

/** The host confirms a session closed from its last meter value; it is billed straight away. */
export async function confirmSession(
  services: SettlementServices,
  hostUserId: string,
  sessionId: string,
): Promise<void> {
  await awaitingHost(services, hostUserId, sessionId);
  const confirmed = await updateSessionFrom(services.db, sessionId, ["needs_host_confirmation"], {
    hostConfirmedAt: services.clock.now(),
  });
  if (!confirmed) {
    throw new HttpProblem(
      409,
      "session-not-awaiting-confirmation",
      "This session is not waiting for your confirmation",
    );
  }
  await services.jobs.send(reconcileSessionJob, { sessionId }, { singletonKey: sessionId });
}

/**
 * The host disputes a session closed from its last meter value: a dispute is
 * recorded, the session goes to support (`needs_review`), and nothing is
 * captured or paid out until support resolves it.
 */
export async function disputeSession(
  services: SettlementServices,
  hostUserId: string,
  sessionId: string,
  dispute: { reason: string; details: string | null },
): Promise<string> {
  const found = await awaitingHost(services, hostUserId, sessionId);
  const disputeId = await services.db.transaction(async (tx) => {
    const moved = await updateSessionFrom(tx, sessionId, ["needs_host_confirmation"], {
      status: "needs_review",
      reviewReason: "host_dispute",
    });
    if (!moved) {
      throw new HttpProblem(
        409,
        "session-not-awaiting-confirmation",
        "This session is not waiting for your confirmation",
      );
    }
    return insertDispute(tx, {
      bookingId: found.booking.id,
      raisedById: hostUserId,
      reason: dispute.reason,
      details: dispute.details,
    });
  });
  services.realtime.sessionChanged(found.booking.id);
  services.log.warn(
    { sessionId, bookingId: found.booking.id, disputeId },
    "host disputed a session closed without a stop; needs review",
  );
  return disputeId;
}
