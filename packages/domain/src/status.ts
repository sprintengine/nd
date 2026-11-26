import { z } from "zod";

// Status vocabularies shared by the database enums, the API and the gateway.
// Each is an `as const` list (the source of truth), its union type and a Zod
// schema. The database builds its Postgres enums from these lists, so adding a
// value here needs a migration in @nd/db.

/** Lifecycle of a booking, from request to a terminal state. */
export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "active",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

/**
 * Booking statuses that hold the charger for the slot. Two bookings in these
 * statuses can never overlap on one charger (a database exclusion constraint),
 * and search treats the charger as taken.
 */
export const SLOT_HOLDING_BOOKING_STATUSES = [
  "confirmed",
  "arrived",
  "active",
] as const satisfies readonly BookingStatus[];

/** Booking statuses after which nothing more happens. */
export const TERMINAL_BOOKING_STATUSES = [
  "completed",
  "cancelled",
  "no_show",
] as const satisfies readonly BookingStatus[];

/** Lifecycle of one charging session (one OCPP transaction) for a booking. */
export const SESSION_STATUSES = [
  "starting",
  "charging",
  "suspended_ev",
  "suspended_evse",
  "stopped",
  "needs_review",
  "needs_host_confirmation",
  "reconciled",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const sessionStatusSchema = z.enum(SESSION_STATUSES);

/** Session statuses with an OCPP transaction that has not stopped yet. */
export const OPEN_SESSION_STATUSES = [
  "starting",
  "charging",
  "suspended_ev",
  "suspended_evse",
] as const satisfies readonly SessionStatus[];

/**
 * Why a stopped session waits for a person before it is billed:
 * `meter_mismatch` (the meter delta and the last MeterValue disagree),
 * `meter_invalid` (no usable stop reading), `missing_stop` (no
 * StopTransaction; closed from the last MeterValue), `no_authorisation` (no
 * card authorisation to capture), `capture_failed` (the capture kept failing)
 * and `host_dispute` (the host disputed a session closed without a stop).
 */
export const SESSION_REVIEW_REASONS = [
  "meter_mismatch",
  "meter_invalid",
  "missing_stop",
  "no_authorisation",
  "capture_failed",
  "host_dispute",
] as const;
export type SessionReviewReason = (typeof SESSION_REVIEW_REASONS)[number];
export const sessionReviewReasonSchema = z.enum(SESSION_REVIEW_REASONS);

/** Connection state of a charger as the gateway last saw it. */
export const CHARGER_STATUSES = ["onboarding", "online", "offline", "faulted"] as const;
export type ChargerStatus = (typeof CHARGER_STATUSES)[number];
export const chargerStatusSchema = z.enum(CHARGER_STATUSES);

/** Whether the charger has its own cable or the driver brings one. */
export const CONNECTOR_TYPES = ["tethered", "untethered"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);

/**
 * The driver's payment for a booking, charged on the platform account.
 *
 * `pending_authorisation` → `authorised` when the slot starts within the
 * authorisation horizon; otherwise `card_saved` (SetupIntent) until a job
 * authorises it before the slot. `captured` after the session is reconciled.
 */
export const PAYMENT_STATUSES = [
  "pending_authorisation",
  "card_saved",
  "authorised",
  "captured",
  "cancelled",
  "failed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * The host's share, sent as a transfer to their connected account once the
 * payment is captured. `held` while a release condition is unmet.
 */
export const TRANSFER_STATUSES = ["pending", "held", "sent", "failed", "reversed"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const transferStatusSchema = z.enum(TRANSFER_STATUSES);

/** Why a transfer to the host is being held. */
export const TRANSFER_HOLD_REASONS = [
  "session_needs_review",
  "dispute_open",
  "tax_details_incomplete",
  "payouts_not_enabled",
] as const;
export type TransferHoldReason = (typeof TRANSFER_HOLD_REASONS)[number];
export const transferHoldReasonSchema = z.enum(TRANSFER_HOLD_REASONS);

/** State of the host's connected payments account. */
export const HOST_PAYOUT_STATUSES = ["not_started", "pending", "enabled", "restricted"] as const;
export type HostPayoutStatus = (typeof HOST_PAYOUT_STATUSES)[number];
export const hostPayoutStatusSchema = z.enum(HOST_PAYOUT_STATUSES);

/** Who cancelled a booking. */
export const CANCELLED_BY = ["driver", "host", "system"] as const;
export type CancelledBy = (typeof CANCELLED_BY)[number];
export const cancelledBySchema = z.enum(CANCELLED_BY);

/** Progress of a dispute raised on a booking. */
export const DISPUTE_STATUSES = ["open", "under_review", "resolved", "rejected"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const disputeStatusSchema = z.enum(DISPUTE_STATUSES);

/** Direction of an OCPP frame relative to the platform. */
export const OCPP_MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type OcppMessageDirection = (typeof OCPP_MESSAGE_DIRECTIONS)[number];
export const ocppMessageDirectionSchema = z.enum(OCPP_MESSAGE_DIRECTIONS);

/** OCPP-J frame kind: CALL (2), CALLRESULT (3) or CALLERROR (4). */
export const OCPP_MESSAGE_TYPES = ["call", "call_result", "call_error"] as const;
export type OcppMessageType = (typeof OCPP_MESSAGE_TYPES)[number];
export const ocppMessageTypeSchema = z.enum(OCPP_MESSAGE_TYPES);

/** Platform a push token belongs to. */
export const DEVICE_PLATFORMS = ["ios", "android", "web"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);

/** Currencies the platform charges in. */
export const CURRENCIES = ["EUR", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencySchema = z.enum(CURRENCIES);

/** Whether a booking in `status` holds its charger for the slot. */
export function holdsSlot(status: BookingStatus): boolean {
  return (SLOT_HOLDING_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}

/** Whether a session in `status` still has an OCPP transaction running. */
export function isOpenSession(status: SessionStatus): boolean {
  return (OPEN_SESSION_STATUSES as readonly SessionStatus[]).includes(status);
}
