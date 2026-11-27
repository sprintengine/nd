import { CHARGER_OFFLINE_ALERT_MINUTES, type ChargerEvent } from "@nd/domain";
import { z } from "zod";

// What can cause a notification. A trigger names the event (booking, session
// or charger) and is the payload of the `notify` job; its event key makes the
// job a singleton and, per recipient, the ledger entry unique.

const bookingTrigger = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), bookingId: z.uuid() });

const sessionTrigger = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), bookingId: z.uuid(), sessionId: z.uuid() });

const isoDateTime = z.iso.datetime({ offset: true });

export const notificationTriggerSchema = z.discriminatedUnion("type", [
  /** POST /bookings: a request (or an instant booking) for the host. */
  bookingTrigger("booking_created"),
  bookingTrigger("booking_approved"),
  bookingTrigger("booking_declined"),
  /** A request the host never answered, cancelled at slot start. */
  bookingTrigger("booking_expired"),
  /** Cancelled by the driver, the host or the system; the booking row says which. */
  bookingTrigger("booking_cancelled"),
  bookingTrigger("guest_arrived"),
  sessionTrigger("session_started"),
  /** StopTransaction: the driver hears at once. */
  sessionTrigger("session_stopped"),
  /** Reconciliation recorded the session's energy: the host hears what they earned. */
  sessionTrigger("session_settled"),
  /**
   * The host's fallback, a while after the stop: "ended" without an amount
   * when reconciliation has not settled the session by then (under review).
   * Shares its ledger entry with `session_settled`, so the host hears once.
   */
  sessionTrigger("session_ended"),
  sessionTrigger("start_failed"),
  z.object({
    type: z.literal("charger_faulted"),
    chargerId: z.uuid(),
    errorCode: z.string().min(1).max(64),
    at: isoDateTime,
  }),
  z.object({
    type: z.literal("charger_offline"),
    chargerId: z.uuid(),
    /** Identifies the offline spell: the heartbeat before it went quiet. */
    lastHeartbeatAt: isoDateTime.nullable(),
  }),
]);
export type NotificationTrigger = z.infer<typeof notificationTriggerSchema>;
/**
 * What the trigger is about: a booking, a session, one fault report or one
 * offline spell. A recipient's ledger key is this plus the notification kind,
 * so two triggers that lead to the same notification send it once.
 */
export function subjectKeyOf(trigger: NotificationTrigger): string {
  switch (trigger.type) {
    case "charger_faulted":
      return `${faultKeyPrefix(trigger.chargerId)}${trigger.at}`;
    case "charger_offline":
      return `charger:${trigger.chargerId}:offline:${trigger.lastHeartbeatAt ?? "never"}`;
    case "session_started":
    case "session_stopped":
    case "session_settled":
    case "session_ended":
    case "start_failed":
      return `session:${trigger.sessionId}`;
    case "booking_created":
    case "booking_approved":
    case "booking_declined":
    case "booking_expired":
    case "booking_cancelled":
    case "guest_arrived":
      return `booking:${trigger.bookingId}`;
  }
}

/** Unique per trigger: the `notify` job's singleton key. */
export function eventKeyOf(trigger: NotificationTrigger): string {
  return trigger.type === "charger_faulted" || trigger.type === "charger_offline"
    ? subjectKeyOf(trigger)
    : `${subjectKeyOf(trigger)}:${trigger.type}`;
}

/** The start of every fault notification's key for a charger, for the cooldown. */
export function faultKeyPrefix(chargerId: string): string {
  return `charger:${chargerId}:fault:`;
}

/** Unless reconciliation settled it sooner, the host hears a session ended this long after it stopped. */
export const SESSION_ENDED_FALLBACK_MS = 15 * 60_000;

const MINUTE_MS = 60_000;

/** A trigger and when to act on it. */
export interface ScheduledTrigger {
  readonly trigger: NotificationTrigger;
  readonly startAfter?: Date;
}

/** When an offline spell that began at `lastHeartbeatAt` (or was seen at `seenAt`) is worth reporting. */
export function offlineAlertAt(seenAt: Date): Date {
  return new Date(seenAt.getTime() + CHARGER_OFFLINE_ALERT_MINUTES * MINUTE_MS);
}

/** The notifications a charger event leads to. */
export function triggersForChargerEvent(event: ChargerEvent): ScheduledTrigger[] {
  const at = new Date(event.at);
  switch (event.type) {
    case "session_started":
      return [
        {
          trigger: {
            type: "session_started",
            bookingId: event.bookingId,
            sessionId: event.sessionId,
          },
        },
      ];
    case "session_stopped": {
      const ids = { bookingId: event.bookingId, sessionId: event.sessionId };
      return [
        { trigger: { type: "session_stopped", ...ids } },
        {
          trigger: { type: "session_ended", ...ids },
          startAfter: new Date(at.getTime() + SESSION_ENDED_FALLBACK_MS),
        },
      ];
    }
    case "fault":
      return [
        {
          trigger: {
            type: "charger_faulted",
            chargerId: event.chargerId,
            errorCode: event.errorCode.slice(0, 64),
            at: event.at,
          },
        },
      ];
    case "offline":
      // Checked again when it runs: a charger back by then is not reported.
      return [
        {
          trigger: {
            type: "charger_offline",
            chargerId: event.chargerId,
            lastHeartbeatAt: event.lastHeartbeatAt,
          },
          startAfter: offlineAlertAt(at),
        },
      ];
    case "boot":
    case "status":
    case "online":
    case "meter":
      return [];
  }
}
