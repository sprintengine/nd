import {
  billingStart,
  isOpenSession,
  isSessionFailureReason,
  type LiveSessionStatus,
  SESSION_FAILURE_MESSAGES,
  sessionMetrics,
  type SessionState,
} from "@nd/domain";

import type { SessionContext } from "../data/sessions.ts";

/**
 * Whether a scheduled start is still waiting: the booking has one, and no
 * session has been created since the driver plugged in for it.
 */
export function scheduledStartPending(context: SessionContext): boolean {
  const { booking, session } = context;
  if (booking.status !== "arrived" || booking.scheduledStartAt === null) return false;
  if (session === null) return true;
  const pluggedInAt = booking.pluggedInAt;
  return pluggedInAt !== null && session.createdAt.getTime() < pluggedInAt.getTime();
}

const latest = (dates: readonly (Date | null | undefined)[]): Date | null => {
  let best: Date | null = null;
  for (const date of dates) {
    if (date !== null && date !== undefined && (best === null || date.getTime() > best.getTime()))
      best = date;
  }
  return best;
};

/** The booking's charging as its driver or host sees it, at `now`. */
export function sessionState(context: SessionContext, now: Date): SessionState {
  const { booking, session, meter } = context;
  const pending = scheduledStartPending(context);
  const status: LiveSessionStatus = pending ? "scheduled" : (session?.status ?? "not_started");
  const counting = status !== "not_started" && status !== "failed";
  const charging = session !== null && isOpenSession(session.status) && !pending;
  const metrics = sessionMetrics({
    billingStart: counting
      ? billingStart({ pluggedInAt: booking.pluggedInAt, startedAt: session?.startedAt ?? null })
      : null,
    until: (!pending ? session?.stoppedAt : null) ?? now,
    meterStartWh: session?.meterStartWh ?? null,
    latestEnergyWh: pending ? null : (meter?.energyWh ?? null),
    finalKwh: pending ? null : (session?.kwh ?? null),
    powerW: charging ? (meter?.powerW ?? null) : null,
    pricePerHourCents: booking.pricePerHourCents ?? 0,
    quoteCents: booking.quotedAmountCents,
  });
  const reason = session?.stopReason ?? null;
  const failed = status === "failed";
  return {
    bookingId: booking.id,
    sessionId: pending ? null : (session?.id ?? null),
    status,
    ...metrics,
    currency: booking.currency,
    lastSeenAt: pending
      ? null
      : (latest([meter?.ts, session?.startedAt, session?.stoppedAt])?.toISOString() ?? null),
    startAt: pending
      ? (booking.scheduledStartAt?.toISOString() ?? null)
      : (session?.startedAt?.toISOString() ?? null),
    stoppedAt: pending ? null : (session?.stoppedAt?.toISOString() ?? null),
    stopReason: failed || pending ? null : reason,
    failure:
      failed && isSessionFailureReason(reason)
        ? { code: reason, message: SESSION_FAILURE_MESSAGES[reason] }
        : null,
  };
}
