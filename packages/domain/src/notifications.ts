import { z } from "zod";

// Push notifications: what the platform tells hosts and drivers, and which
// preference turns each one off. The API decides when to send them; the apps
// read `kind` and the ids in a notification's data to open the right screen.

/** Every notification, by who receives it. */
export const NOTIFICATION_KINDS = [
  // To the host
  "booking_requested",
  "booking_received",
  "booking_cancelled_by_driver",
  "guest_arrived",
  "session_started",
  "session_ended",
  "charger_offline",
  "charger_faulted",
  // To the driver
  "booking_approved",
  "booking_declined",
  "booking_expired",
  "booking_cancelled",
  "charging_started",
  "charging_stopped",
  "start_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** The switches a user can turn off; every one is on until they do. */
export const NOTIFICATION_CATEGORIES = [
  "bookingRequests",
  "guestArrivals",
  "sessionUpdates",
  "chargerAlerts",
  "bookingUpdates",
  "chargingUpdates",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** The category (preference) each notification belongs to. */
export const NOTIFICATION_CATEGORY = {
  booking_requested: "bookingRequests",
  booking_received: "bookingRequests",
  booking_cancelled_by_driver: "bookingRequests",
  guest_arrived: "guestArrivals",
  session_started: "sessionUpdates",
  session_ended: "sessionUpdates",
  charger_offline: "chargerAlerts",
  charger_faulted: "chargerAlerts",
  booking_approved: "bookingUpdates",
  booking_declined: "bookingUpdates",
  booking_expired: "bookingUpdates",
  booking_cancelled: "bookingUpdates",
  charging_started: "chargingUpdates",
  charging_stopped: "chargingUpdates",
  start_failed: "chargingUpdates",
} as const satisfies Record<NotificationKind, NotificationCategory>;

/** A user's notification switches. */
export type NotificationPreferences = Readonly<Record<NotificationCategory, boolean>>;

/** Everything on: what a user who never changed a switch gets. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  bookingRequests: true,
  guestArrivals: true,
  sessionUpdates: true,
  chargerAlerts: true,
  bookingUpdates: true,
  chargingUpdates: true,
};

/** Whether `preferences` let a notification of `kind` through. */
export function notificationAllowed(
  kind: NotificationKind,
  preferences: NotificationPreferences,
): boolean {
  return preferences[NOTIFICATION_CATEGORY[kind]];
}

/** A charger offline for longer than this is reported to its host, once per offline spell. */
export const CHARGER_OFFLINE_ALERT_MINUTES = 10;

/** Repeated fault reports from one charger within this many minutes notify its host once. */
export const CHARGER_FAULT_ALERT_COOLDOWN_MINUTES = 30;

/**
 * The data a push carries next to its title and body: the kind and the ids
 * the app opens. Never personal details; those are fetched by id.
 */
export const pushDataSchema = z.strictObject({
  kind: notificationKindSchema,
  bookingId: z.uuid().optional(),
  chargerId: z.uuid().optional(),
});
export type PushData = z.infer<typeof pushDataSchema>;
