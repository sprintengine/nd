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
 * Why a stopped session's energy figure needs a person to look at it:
 * `meter_mismatch` (the meter delta and the last MeterValue disagree),
 * `meter_invalid` (no usable stop reading) and `missing_stop` (no
 * StopTransaction and no meter value to close it from). The booking was paid
 * upfront, so nothing waits on this; support may refund by hand.
 */
export const SESSION_REVIEW_REASONS = ["meter_mismatch", "meter_invalid", "missing_stop"] as const;
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
 * The driver's payment for a booking: one destination charge to the host's
 * connected account, paid upfront. `pending` while the PaymentIntent's
 * outcome is not known; an instant booking is then `paid` (automatic
 * capture), a request `authorised` (manual capture) until the host approves
 * (`paid`) or declines or lets it expire (`cancelled`). `failed` when the
 * card is declined or the hold can no longer be captured.
 */
export const PAYMENT_STATUSES = ["pending", "authorised", "paid", "cancelled", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** A refund of a paid booking: `pending` until Stripe confirms it. */
export const REFUND_STATUSES = ["pending", "succeeded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const refundStatusSchema = z.enum(REFUND_STATUSES);

/**
 * Why a booking was refunded: the driver cancelled before the host's cutoff,
 * the host cancelled, the charger let the driver down, or support decided.
 */
export const REFUND_REASONS = [
  "driver_cancelled",
  "host_cancelled",
  "charger_fault",
  "support",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const refundReasonSchema = z.enum(REFUND_REASONS);

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

/** Countries a host can be paid out in (the country of their Stripe account). */
export const HOST_COUNTRIES = ["IE", "GB"] as const;
export type HostCountry = (typeof HOST_COUNTRIES)[number];
export const hostCountrySchema = z.enum(HOST_COUNTRIES);

/** The currency a host's listings are priced, charged and paid out in. */
export function currencyForCountry(country: HostCountry): Currency {
  return country === "GB" ? "GBP" : "EUR";
}

/** Whether a booking in `status` holds its charger for the slot. */
export function holdsSlot(status: BookingStatus): boolean {
  return (SLOT_HOLDING_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}

/** Whether a session in `status` still has an OCPP transaction running. */
export function isOpenSession(status: SessionStatus): boolean {
  return (OPEN_SESSION_STATUSES as readonly SessionStatus[]).includes(status);
}
