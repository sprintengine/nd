import {
  CHARGER_OFFLINE_ALERT_MINUTES,
  isSessionFailureReason,
  type NotificationKind,
  SESSION_FAILURE_MESSAGES,
} from "@nd/domain";

import type { PushMessage } from "../push/push.ts";
import { type NotificationTrigger, subjectKeyOf } from "./triggers.ts";

// Who hears about an event and what the notification says. Pure functions;
// `deliver.ts` loads the facts and sends. Notifications name no one and carry
// no address: the slot, amounts and kWh are shown, and the app fetches the
// rest by the ids in `data`.

/** A booking as the rules need it. */
export interface BookingFacts {
  readonly id: string;
  readonly chargerId: string;
  readonly status: string;
  readonly slot: { readonly start: Date; readonly end: Date };
  readonly cancelledBy: "driver" | "host" | "system" | null;
  readonly driverId: string;
  readonly hostUserId: string;
  readonly timezone: string;
}

/** What a notification's text can draw on, besides the booking. */
export interface NotificationFacts {
  readonly booking?: BookingFacts | undefined;
  /** The session's kWh, once it stopped. */
  readonly kwh?: number | null | undefined;
  /** Why a start failed (`sessions.stop_reason`). */
  readonly failureReason?: string | null | undefined;
  /** What settlement captured from the driver, and the host's share of it. */
  readonly settled?: SettledAmounts | undefined;
  /** The host of the charger, for charger alerts. */
  readonly chargerHostUserId?: string | undefined;
}

/** A captured payment: the amount billed to the driver and the host's share, in cents. */
export interface SettledAmounts {
  readonly billedCents: number;
  readonly earningsCents: number;
  readonly currency: string;
}

/** One notification to one user. */
export interface PlannedNotification {
  readonly userId: string;
  readonly kind: NotificationKind;
  /** Unique per subject and kind: the ledger key. */
  readonly eventKey: string;
  readonly message: PushMessage;
}

const dayFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-IE", { timeZone, weekday: "short", day: "numeric", month: "short" });

const timeFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-IE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/** `Wed 26 Nov, 22:00–07:00` in the charger's time zone. */
export function formatSlot(slot: { start: Date; end: Date }, timeZone: string): string {
  const time = timeFormat(timeZone);
  const day = dayFormat(timeZone).format(slot.start).replace(/,/g, "");
  return `${day}, ${time.format(slot.start)}–${time.format(slot.end)}`;
}

/** `€12.50`. */
export function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(amountCents / 100);
}

/** `8.4 kWh`, to one decimal place. */
export function formatKwh(kwh: number): string {
  return `${(Math.round(kwh * 10) / 10).toFixed(1)} kWh`;
}

/** The text of a notification of `kind`. */
export function messageFor(
  kind: NotificationKind,
  facts: NotificationFacts & { errorCode?: string; chargerId?: string },
): PushMessage {
  const booking = facts.booking;
  const slot = booking === undefined ? "your booking" : formatSlot(booking.slot, booking.timezone);
  const bookingData =
    booking === undefined
      ? { kind }
      : { kind, bookingId: booking.id, chargerId: booking.chargerId };
  const chargerData =
    facts.chargerId === undefined ? { kind } : { kind, chargerId: facts.chargerId };
  const kwh = facts.kwh ?? null;
  switch (kind) {
    case "booking_requested":
      return {
        title: "New booking request",
        body: `${slot}. Approve or decline it in the app.`,
        data: bookingData,
      };
    case "booking_received":
      return { title: "New booking", body: `${slot} is booked.`, data: bookingData };
    case "booking_cancelled_by_driver":
      return {
        title: "Booking cancelled",
        body: `The driver cancelled ${slot}.`,
        data: bookingData,
      };
    case "guest_arrived":
      return {
        title: "Your guest has arrived",
        body: `They're at your charger for ${slot}.`,
        data: bookingData,
      };
    case "session_started":
      return {
        title: "Charging started",
        body: "Your guest's car is charging.",
        data: bookingData,
      };
    case "session_ended": {
      const settled = facts.settled;
      if (settled === undefined) {
        const energy = kwh === null ? "" : ` (${formatKwh(kwh)})`;
        return {
          title: "Session ended",
          body: `Your guest's session has ended${energy}. Your earnings show once it is settled.`,
          data: bookingData,
        };
      }
      const billed = formatMoney(settled.billedCents, settled.currency);
      const earned = formatMoney(settled.earningsCents, settled.currency);
      return {
        title: "Session ended",
        body: `Your guest was billed ${billed}${kwh === null ? "" : ` for ${formatKwh(kwh)}`}. You earn ${earned}.`,
        data: bookingData,
      };
    }
    case "charger_offline":
      return {
        title: "Charger offline",
        body: `Your charger has been offline for over ${String(CHARGER_OFFLINE_ALERT_MINUTES)} minutes. Check its power and Wi-Fi.`,
        data: chargerData,
      };
    case "charger_faulted":
      return {
        title: "Charger fault",
        body: `Your charger reported a fault${facts.errorCode === undefined ? "" : ` (${facts.errorCode})`}. It can't charge until it clears.`,
        data: chargerData,
      };
    case "booking_approved":
      return { title: "Booking confirmed", body: `The host approved ${slot}.`, data: bookingData };
    case "booking_declined":
      return {
        title: "Request declined",
        body: `The host declined ${slot}. You haven't been charged.`,
        data: bookingData,
      };
    case "booking_expired":
      return {
        title: "Request expired",
        body: `The host didn't answer in time for ${slot}. You haven't been charged.`,
        data: bookingData,
      };
    case "booking_cancelled":
      return {
        title: "Booking cancelled",
        body:
          booking?.cancelledBy === "host"
            ? `The host cancelled ${slot}.`
            : `${slot} was cancelled because the payment could not be taken.`,
        data: bookingData,
      };
    case "charging_started":
      return { title: "Charging started", body: "Your car is charging.", data: bookingData };
    case "charging_stopped":
      return {
        title: "Charging stopped",
        body:
          kwh === null ? "Your session has ended." : `Your session has ended: ${formatKwh(kwh)}.`,
        data: bookingData,
      };
    case "start_failed": {
      const reason = facts.failureReason ?? null;
      return {
        title: "Charging didn't start",
        body: isSessionFailureReason(reason)
          ? SESSION_FAILURE_MESSAGES[reason]
          : SESSION_FAILURE_MESSAGES.no_response,
        data: bookingData,
      };
    }
  }
}

/** Who hears about a trigger, as which kind. */
function recipients(
  trigger: NotificationTrigger,
  facts: NotificationFacts,
): { userId: string; kind: NotificationKind }[] {
  if (trigger.type === "charger_faulted" || trigger.type === "charger_offline") {
    const host = facts.chargerHostUserId;
    if (host === undefined) return [];
    return [{ userId: host, kind: trigger.type }];
  }
  const booking = facts.booking;
  if (booking === undefined) return [];
  const host = booking.hostUserId;
  const driver = booking.driverId;
  switch (trigger.type) {
    case "booking_created":
      if (booking.status === "requested") return [{ userId: host, kind: "booking_requested" }];
      if (booking.status === "confirmed") return [{ userId: host, kind: "booking_received" }];
      return [];
    case "booking_approved":
      return [{ userId: driver, kind: "booking_approved" }];
    case "booking_declined":
      return [{ userId: driver, kind: "booking_declined" }];
    case "booking_expired":
      return [{ userId: driver, kind: "booking_expired" }];
    case "booking_cancelled":
      if (booking.status !== "cancelled" || booking.cancelledBy === null) return [];
      return booking.cancelledBy === "driver"
        ? [{ userId: host, kind: "booking_cancelled_by_driver" }]
        : [{ userId: driver, kind: "booking_cancelled" }];
    case "guest_arrived":
      return [{ userId: host, kind: "guest_arrived" }];
    case "session_started":
      return [
        { userId: driver, kind: "charging_started" },
        { userId: host, kind: "session_started" },
      ];
    case "session_stopped":
      return [{ userId: driver, kind: "charging_stopped" }];
    case "session_settled":
    case "session_ended":
      return [{ userId: host, kind: "session_ended" }];
    case "start_failed":
      return [{ userId: driver, kind: "start_failed" }];
  }
}

/** The notifications a trigger leads to, given what is known about it. */
export function planNotifications(
  trigger: NotificationTrigger,
  facts: NotificationFacts,
): PlannedNotification[] {
  const subject = subjectKeyOf(trigger);
  const extra =
    trigger.type === "charger_faulted"
      ? { chargerId: trigger.chargerId, errorCode: trigger.errorCode }
      : trigger.type === "charger_offline"
        ? { chargerId: trigger.chargerId }
        : {};
  return recipients(trigger, facts).map(({ userId, kind }) => ({
    userId,
    kind,
    eventKey: `${subject}:${kind}`,
    message: messageFor(kind, { ...facts, ...extra }),
  }));
}

/**
 * Whether an offline spell is still worth reporting: the charger is still
 * offline and has not heartbeated since the spell began.
 */
export function offlineSpellContinues(
  spellLastHeartbeatAt: string | null,
  charger: { status: string; lastHeartbeatAt: Date | null },
): boolean {
  if (charger.status !== "offline") return false;
  if (spellLastHeartbeatAt === null || charger.lastHeartbeatAt === null) return true;
  return charger.lastHeartbeatAt.getTime() <= Date.parse(spellLastHeartbeatAt);
}
