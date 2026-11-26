import type { BookingStatus, PaymentStatus, SessionStatus, TransferStatus } from "./status.ts";

// The booking and session state machines (docs/ARCHITECTURE.md, section 5) as
// transition tables. The API and the gateway check a change against these
// before writing a status column.

/** The statuses a booking may move to from each status. */
export const BOOKING_TRANSITIONS = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["arrived", "cancelled", "no_show"],
  arrived: ["active"],
  active: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
} as const satisfies Record<BookingStatus, readonly BookingStatus[]>;

/**
 * The statuses a session may move to from each status. When StopTransaction
 * never arrives, a job closes an open session from its last meter value and
 * it waits for the host (`needs_host_confirmation`), or for support
 * (`needs_review`) when there is no meter value to close it from.
 */
export const SESSION_TRANSITIONS = {
  starting: ["charging", "failed"],
  charging: [
    "suspended_ev",
    "suspended_evse",
    "stopped",
    "needs_review",
    "needs_host_confirmation",
  ],
  suspended_ev: [
    "charging",
    "suspended_evse",
    "stopped",
    "needs_review",
    "needs_host_confirmation",
  ],
  suspended_evse: [
    "charging",
    "suspended_ev",
    "stopped",
    "needs_review",
    "needs_host_confirmation",
  ],
  stopped: ["reconciled", "needs_review", "needs_host_confirmation"],
  needs_host_confirmation: ["reconciled", "needs_review"],
  needs_review: ["reconciled"],
  reconciled: [],
  failed: [],
} as const satisfies Record<SessionStatus, readonly SessionStatus[]>;

/**
 * The statuses a driver's payment may move to. A slot starting soon is
 * authorised at once (`pending_authorisation` → `authorised`); a later one
 * keeps the saved card (`card_saved`) until the authorisation job. A capture
 * may be partial (a cancellation or no-show fee); the rest of the
 * authorisation is released by Stripe.
 */
export const PAYMENT_TRANSITIONS = {
  pending_authorisation: ["authorised", "card_saved", "failed", "cancelled"],
  card_saved: ["authorised", "failed", "cancelled"],
  authorised: ["captured", "cancelled"],
  captured: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<PaymentStatus, readonly PaymentStatus[]>;

/**
 * The statuses a transfer to the host may move to. A held transfer is sent
 * once its hold reasons clear; a sent one may later be reversed.
 */
export const TRANSFER_TRANSITIONS = {
  pending: ["held", "sent", "failed"],
  held: ["held", "sent", "failed"],
  sent: ["reversed"],
  failed: ["held", "sent"],
  reversed: [],
} as const satisfies Record<TransferStatus, readonly TransferStatus[]>;

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

/** Whether a transfer may move from `from` to `to`. */
export function canTransitionTransfer(from: TransferStatus, to: TransferStatus): boolean {
  return (TRANSFER_TRANSITIONS[from] as readonly TransferStatus[]).includes(to);
}

/** Whether a booking in `status` can still be cancelled. */
export function isCancellable(status: BookingStatus): boolean {
  return (CANCELLABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}
