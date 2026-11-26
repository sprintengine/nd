import {
  ARRIVAL_RADIUS_M,
  arrivalCheck,
  arrivalTiming,
  ChargerControlError,
  type ControlResult,
  isOpenSession,
  type SessionFailureReason,
  startAtProblem,
  windowEndStopAt,
} from "@nd/domain";

import {
  chargerHasOpenTransaction,
  findSessionContext,
  insertStartingSession,
  recordArrival,
  type SessionContext,
  setScheduledStart,
  updateSessionFrom,
} from "../data/sessions.ts";
import { HttpProblem } from "../http/problem.ts";
import type { JobAttempt } from "../jobs/jobs.ts";
import { queueNotification } from "../notifications/queue.ts";
import { remoteStartJob, startTimeoutJob, windowEndStopJob } from "./jobs.ts";
import type { SessionServices } from "./services.ts";
import { scheduledStartPending } from "./view.ts";

// Session control: the driver arrives, starts and stops charging; jobs send
// a scheduled start, give up on a start that never began and stop a session
// still running after its window. The gateway turns StartTransaction and
// StopTransaction into session and booking changes; this side only sends
// commands and marks starts that failed. Every change is guarded by the
// status it expects, so a repeat or a race does nothing.

/** The Zappi has one connector. */
const CONNECTOR_ID = 1;

const notFound = () => new HttpProblem(404, "booking-not-found", "No such booking");

/** The booking's session context, if the user is its driver or host; otherwise 404. */
export async function contextFor(
  services: SessionServices,
  userId: string,
  bookingId: string,
): Promise<SessionContext> {
  const context = await findSessionContext(services.db, bookingId);
  if (context === undefined) throw notFound();
  if (context.booking.driverId !== userId && context.hostUserId !== userId) throw notFound();
  return context;
}

/** The context, if the user is the booking's driver: 404 to strangers, 403 to the host. */
async function driverContext(
  services: SessionServices,
  userId: string,
  bookingId: string,
): Promise<SessionContext> {
  const context = await contextFor(services, userId, bookingId);
  if (context.booking.driverId !== userId) {
    throw new HttpProblem(403, "driver-only", "Only the driver can do this");
  }
  return context;
}

/** What the driver's arrival recorded. */
export interface Arrival {
  readonly arrivedAt: Date | null;
  readonly distanceM: number | null;
  readonly nearCharger: boolean | null;
}

const arrivalOf = (distanceM: number | null, arrivedAt: Date | null): Arrival => ({
  arrivedAt,
  distanceM,
  nearCharger: distanceM === null ? null : distanceM <= ARRIVAL_RADIUS_M,
});

/**
 * The driver says they have arrived ("I'm here"), from 15 minutes before the
 * slot until it ends: a confirmed booking becomes arrived. A position, when
 * given, is compared with the charger's and the distance recorded, never
 * enforced. Arriving again changes nothing.
 */
export async function arrive(
  services: SessionServices,
  userId: string,
  bookingId: string,
  position: { lat: number; lng: number } | undefined,
): Promise<Arrival> {
  const { booking, charger } = await driverContext(services, userId, bookingId);
  if (booking.status === "arrived" || booking.status === "active") {
    return arrivalOf(booking.arrivalDistanceM, booking.arrivedAt);
  }
  if (booking.status !== "confirmed") {
    throw new HttpProblem(409, "cannot-arrive", "This booking is not waiting for you");
  }
  const now = services.clock.now();
  const timing = arrivalTiming(booking.slot, now);
  if (timing !== "open") {
    throw new HttpProblem(
      409,
      timing === "early" ? "too-early" : "slot-ended",
      timing === "early" ? "It is too early to arrive" : "This booking has ended",
      timing === "early" ? "You can check in from 15 minutes before your slot starts." : undefined,
    );
  }
  const distanceM =
    position === undefined ? null : arrivalCheck(charger.location, position).distanceM;
  const changed = await recordArrival(services.db, bookingId, { arrivedAt: now, distanceM });
  if (!changed) {
    throw new HttpProblem(409, "cannot-arrive", "This booking is not waiting for you");
  }
  // Stop a session still running after the window, however it was started.
  await services.jobs.send(
    windowEndStopJob,
    { bookingId },
    { startAfter: windowEndStopAt(booking.slot.end), singletonKey: bookingId },
  );
  services.realtime.bookingChanged(bookingId);
  await queueNotification(services, { type: "guest_arrived", bookingId });
  return arrivalOf(distanceM, now);
}

/** Marks a start as failed, if it is still starting, and tells the apps. */
async function failStart(
  services: SessionServices,
  bookingId: string,
  sessionId: string,
  reason: SessionFailureReason,
): Promise<boolean> {
  const changed = await updateSessionFrom(services.db, sessionId, ["starting"], {
    status: "failed",
    stopReason: reason,
  });
  if (changed) {
    services.realtime.sessionChanged(bookingId);
    // The driver stopped it themselves: nothing to tell them.
    if (reason !== "stopped_before_start") {
      await queueNotification(services, { type: "start_failed", bookingId, sessionId });
    }
  }
  return changed;
}

interface RemoteStartMode {
  /** Answer a rejection caused by an open transaction with a soft reset and one retry. */
  readonly resetAllowed: boolean;
  /** Throw on no answer, so the job retries, instead of failing the start. */
  readonly retryUnanswered: boolean;
}

/** Thrown inside a job to try again later. */
class ChargerUnansweredError extends Error {
  override name = "ChargerUnansweredError";
}

/**
 * Sends RemoteStartTransaction for a `starting` session. Accepted: the start
 * timeout is scheduled. Rejected while another transaction is open: a soft
 * reset, and the start is retried once by a job. Otherwise the session fails
 * with a reason the app can show.
 */
async function sendRemoteStart(
  services: SessionServices,
  context: SessionContext,
  sessionId: string,
  mode: RemoteStartMode,
): Promise<void> {
  const { booking, charger } = context;
  const bookingId = booking.id;
  if (booking.idTag === null) throw new Error(`booking ${bookingId} has no idTag`);
  let result: ControlResult<{ status: "Accepted" | "Rejected" }>;
  try {
    result = await services.chargerControl.remoteStart({
      chargeboxId: charger.chargeboxId,
      idTag: booking.idTag,
      connectorId: CONNECTOR_ID,
    });
  } catch (error) {
    if (!(error instanceof ChargerControlError)) throw error;
    if (mode.retryUnanswered) throw error;
    services.log.error({ bookingId, err: error }, "the gateway could not be reached");
    await failStart(services, bookingId, sessionId, "gateway_unreachable");
    return;
  }
  if (!result.ok) {
    if (mode.retryUnanswered && result.reason !== "call_error") {
      throw new ChargerUnansweredError(`remote start was not answered: ${result.reason}`);
    }
    services.log.warn({ bookingId, reason: result.reason }, "remote start was not answered");
    await failStart(
      services,
      bookingId,
      sessionId,
      result.reason === "offline" ? "charger_offline" : "no_response",
    );
    return;
  }
  if (result.response.status === "Accepted") {
    const due = new Date(
      services.clock.now().getTime() + services.sessionTimings.startTimeoutSeconds * 1000,
    );
    await services.jobs.send(
      startTimeoutJob,
      { bookingId, sessionId },
      { startAfter: due, singletonKey: sessionId },
    );
    services.realtime.sessionChanged(bookingId);
    return;
  }
  if (mode.resetAllowed && (await chargerHasOpenTransaction(services.db, charger.id, sessionId))) {
    const reset = await services.chargerControl
      .reset({ chargeboxId: charger.chargeboxId })
      .catch(() => undefined);
    if (reset?.ok === true && reset.response.status === "Accepted") {
      services.log.info({ bookingId }, "remote start rejected by an open transaction; reset sent");
      const retryAt = new Date(
        services.clock.now().getTime() + services.sessionTimings.resetRetryDelaySeconds * 1000,
      );
      await services.jobs.send(
        remoteStartJob,
        { bookingId, sessionId },
        { startAfter: retryAt, singletonKey: `${sessionId}-retry` },
      );
      services.realtime.sessionChanged(bookingId);
      return;
    }
  }
  await failStart(services, bookingId, sessionId, "rejected");
}

/** Creates a starting session (unless one is open) and sends the remote start. */
async function startNow(
  services: SessionServices,
  context: SessionContext,
  mode: RemoteStartMode,
): Promise<void> {
  const { sessionId, created } = await insertStartingSession(services.db, context.booking.id);
  if (!created) return;
  await sendRemoteStart(services, context, sessionId, mode);
}

/**
 * The driver starts charging. With `startAt` in the future (inside the slot)
 * the plug-in is recorded and a job sends the remote start then; otherwise it
 * is sent now. Starting while a start is pending or a session is running
 * changes nothing; after a failed start it tries again.
 */
export async function startCharging(
  services: SessionServices,
  userId: string,
  bookingId: string,
  startAt: Date | undefined,
): Promise<void> {
  const context = await driverContext(services, userId, bookingId);
  const { booking, session } = context;
  if (session !== null && isOpenSession(session.status)) return;
  if (booking.status === "active" || scheduledStartPending(context)) return;
  if (booking.status !== "arrived") {
    throw new HttpProblem(
      409,
      "not-arrived",
      "Check in first",
      booking.status === "confirmed" ? "Tap “I'm here” when you reach the charger." : undefined,
    );
  }
  const now = services.clock.now();
  if (now.getTime() >= booking.slot.end.getTime()) {
    throw new HttpProblem(409, "slot-ended", "This booking has ended");
  }
  if (startAt !== undefined) {
    const problem = startAtProblem(booking.slot, startAt);
    if (problem !== undefined) {
      throw new HttpProblem(
        422,
        "invalid-start-time",
        "Pick a start time inside your slot",
        problem,
      );
    }
    if (startAt.getTime() > now.getTime()) {
      await setScheduledStart(services.db, bookingId, {
        scheduledStartAt: startAt,
        pluggedInAt: now,
      });
      await services.jobs.send(
        remoteStartJob,
        { bookingId },
        { startAfter: startAt, singletonKey: `${bookingId}-scheduled` },
      );
      services.realtime.sessionChanged(bookingId);
      return;
    }
  }
  if (now.getTime() < booking.slot.start.getTime()) {
    throw new HttpProblem(
      409,
      "slot-not-started",
      "Your slot has not started yet",
      `Charging can start from ${booking.slot.start.toISOString()}, or choose a start time.`,
    );
  }
  await startNow(services, context, { resetAllowed: true, retryUnanswered: false });
}

/**
 * The driver stops charging. A running session gets RemoteStopTransaction;
 * the gateway closes it when StopTransaction arrives. A start not yet
 * begun is abandoned, and a scheduled start cancelled. Stopping again, or
 * with nothing running, changes nothing. No payment is taken here.
 */
export async function stopCharging(
  services: SessionServices,
  userId: string,
  bookingId: string,
): Promise<void> {
  const context = await driverContext(services, userId, bookingId);
  const { session, charger } = context;
  if (scheduledStartPending(context)) {
    await setScheduledStart(services.db, bookingId, null);
    services.realtime.sessionChanged(bookingId);
    return;
  }
  if (session === null || !isOpenSession(session.status)) return;
  if (session.ocppTransactionId === null) {
    await failStart(services, bookingId, session.id, "stopped_before_start");
    return;
  }
  const unanswered = new HttpProblem(
    503,
    "charger-unreachable",
    "The charger didn't respond",
    "Try again, or unplug the cable to stop charging.",
  );
  let result;
  try {
    result = await services.chargerControl.remoteStop({
      chargeboxId: charger.chargeboxId,
      transactionId: session.ocppTransactionId,
    });
  } catch (error) {
    if (!(error instanceof ChargerControlError)) throw error;
    throw unanswered;
  }
  if (!result.ok) throw unanswered;
  if (result.response.status === "Rejected") {
    throw new HttpProblem(
      409,
      "stop-rejected",
      "The charger has no session to stop",
      "Unplug the cable to finish; the session closes when the charger reports it.",
    );
  }
}

/**
 * The remote-start job. Without a session id it is a scheduled start: it
 * creates the session and sends the remote start, if the booking still
 * waits for it. With one it retries a start after a soft reset, once; an
 * unanswered retry is tried again until the job's last attempt.
 */
export async function runRemoteStart(
  services: SessionServices,
  payload: { bookingId: string; sessionId?: string | undefined },
  attempt: JobAttempt,
): Promise<void> {
  const context = await findSessionContext(services.db, payload.bookingId);
  if (context === undefined) return;
  const { booking, session } = context;
  if (payload.sessionId === undefined) {
    if (!scheduledStartPending(context)) return;
    const scheduledAt = booking.scheduledStartAt;
    const now = services.clock.now();
    if (scheduledAt === null || now.getTime() < scheduledAt.getTime()) return;
    if (now.getTime() >= booking.slot.end.getTime()) return;
    await startNow(services, context, { resetAllowed: true, retryUnanswered: false });
    return;
  }
  if (
    session?.id !== payload.sessionId ||
    session.status !== "starting" ||
    session.ocppTransactionId !== null
  ) {
    return;
  }
  await sendRemoteStart(services, context, session.id, {
    resetAllowed: false,
    retryUnanswered: !attempt.lastAttempt,
  });
}

/**
 * The start-timeout job: a session still starting has had no StartTransaction
 * in time. It fails, and the charger is asked for a StatusNotification so the
 * platform learns what it is doing (usually: no cable).
 */
export async function failStalledStart(
  services: SessionServices,
  payload: { bookingId: string; sessionId: string },
): Promise<void> {
  const context = await findSessionContext(services.db, payload.bookingId);
  const session = context?.session;
  if (context === undefined || session?.id !== payload.sessionId) return;
  if (session.status !== "starting" || session.ocppTransactionId !== null) return;
  if (!(await failStart(services, payload.bookingId, session.id, "start_timeout"))) return;
  const trigger = await services.chargerControl
    .triggerMessage({
      chargeboxId: context.charger.chargeboxId,
      requestedMessage: "StatusNotification",
      connectorId: CONNECTOR_ID,
    })
    .catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!trigger.ok) {
    services.log.warn(
      { bookingId: payload.bookingId, reason: trigger.reason },
      "status request after a failed start was not answered",
    );
  }
}

/**
 * The window-end job, 5 minutes after the slot: a session still running is
 * stopped remotely, and a start still pending is given up. An unanswered stop
 * is retried; the gateway closes the session when StopTransaction arrives.
 */
export async function stopAtWindowEnd(
  services: SessionServices,
  bookingId: string,
  attempt: JobAttempt,
): Promise<void> {
  const context = await findSessionContext(services.db, bookingId);
  if (context === undefined) return;
  const { booking, session, charger } = context;
  if (services.clock.now().getTime() < windowEndStopAt(booking.slot.end).getTime()) return;
  if (scheduledStartPending(context)) {
    await setScheduledStart(services.db, bookingId, null);
    services.realtime.sessionChanged(bookingId);
    return;
  }
  if (session === null || !isOpenSession(session.status)) return;
  if (session.ocppTransactionId === null) {
    await failStart(services, bookingId, session.id, "window_ended");
    return;
  }
  const result = await services.chargerControl.remoteStop({
    chargeboxId: charger.chargeboxId,
    transactionId: session.ocppTransactionId,
  });
  if (result.ok && result.response.status === "Accepted") {
    services.log.info({ bookingId }, "stopped a session at the end of its window");
    return;
  }
  const reason = result.ok ? "rejected" : result.reason;
  if (!attempt.lastAttempt) throw new Error(`window-end stop not accepted: ${reason}`);
  services.log.error({ bookingId, reason }, "could not stop a session at the end of its window");
}
