import type { BookingStatus, PaymentStatus, RefundStatus, SessionStatus } from "./status.ts";

// The booking and session state machines (docs/ARCHITECTURE.md, section 5) as
// transition tables. The API and the gateway check a change against these
// before writing a status column.

/** The statuses a booking may move to from each status. */
export const BOOKING_TRANSITIONS = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["arrived", "cancelled", "no_show"],
  // An arrival that never became a session is closed after the slot: completed
  // when a start was attempted or the car plugged in, otherwise a no-show.
  arrived: ["active", "completed", "no_show"],
  active: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
} as const satisfies Record<BookingStatus, readonly BookingStatus[]>;

/**
 * The statuses a session may move to from each status. When StopTransaction
 * never arrives, a job closes an open session from its last meter value
 * (`reconciled`), or for support (`needs_review`) when there is no meter
 * value to close it from. Nothing is billed from a session: the booking was
 * paid upfront.
 */
export const SESSION_TRANSITIONS = {
  starting: ["charging", "failed"],
  charging: ["suspended_ev", "suspended_evse", "stopped", "needs_review", "reconciled"],
  suspended_ev: ["charging", "suspended_evse", "stopped", "needs_review", "reconciled"],
  suspended_evse: ["charging", "suspended_ev", "stopped", "needs_review", "reconciled"],
  stopped: ["reconciled", "needs_review"],
  needs_review: ["reconciled"],
  reconciled: [],
  failed: [],
} as const satisfies Record<SessionStatus, readonly SessionStatus[]>;

/**
 * The statuses a driver's payment may move to. An instant booking's charge
 * goes `pending` → `paid`; a request's hold goes `pending` → `authorised`,
 * then `paid` when the host approves or `cancelled` when they decline or the
 * request expires. A refund does not change the payment's status.
 */
export const PAYMENT_TRANSITIONS = {
  pending: ["authorised", "paid", "failed", "cancelled"],
  authorised: ["paid", "cancelled", "failed"],
  paid: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<PaymentStatus, readonly PaymentStatus[]>;

/** The statuses a refund may move to: Stripe confirms it, or it fails. */
export const REFUND_TRANSITIONS = {
  pending: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
} as const satisfies Record<RefundStatus, readonly RefundStatus[]>;

/** Booking statuses a driver or host may still cancel from. Never once the driver has arrived. */
export const CANCELLABLE_BOOKING_STATUSES = [
  "requested",
  "confirmed",
] as const satisfies readonly BookingStatus[];

/** Whether a booking may move from `from` to `to`. */
export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return (BOOKING_TRANSITIONS[from] as readonly BookingStatus[]).includes(to);
}

/** Whether a session may move from `from` to `to`. */
export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return (SESSION_TRANSITIONS[from] as readonly SessionStatus[]).includes(to);
}

/** Whether a payment may move from `from` to `to`. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return (PAYMENT_TRANSITIONS[from] as readonly PaymentStatus[]).includes(to);
}

/** Whether a refund may move from `from` to `to`. */
export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return (REFUND_TRANSITIONS[from] as readonly RefundStatus[]).includes(to);
}

/** Whether a booking in `status` can still be cancelled. */
export function isCancellable(status: BookingStatus): boolean {
  return (CANCELLABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}
