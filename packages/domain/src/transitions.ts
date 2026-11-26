import type { BookingStatus, SessionStatus } from "./status.ts";

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
 * The statuses a session may move to from each status. An open session goes
 * to `needs_review` when its StopTransaction never arrives and a job closes it
 * from the last meter value.
 */
export const SESSION_TRANSITIONS = {
  starting: ["charging", "failed"],
  charging: ["suspended_ev", "suspended_evse", "stopped", "needs_review"],
  suspended_ev: ["charging", "suspended_evse", "stopped", "needs_review"],
  suspended_evse: ["charging", "suspended_ev", "stopped", "needs_review"],
  stopped: ["reconciled", "needs_review", "needs_host_confirmation"],
  needs_host_confirmation: ["reconciled", "needs_review"],
  needs_review: ["reconciled"],
  reconciled: [],
  failed: [],
} as const satisfies Record<SessionStatus, readonly SessionStatus[]>;

/** Whether a booking may move from `from` to `to`. */
export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return (BOOKING_TRANSITIONS[from] as readonly BookingStatus[]).includes(to);
}

/** Whether a session may move from `from` to `to`. */
export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return (SESSION_TRANSITIONS[from] as readonly SessionStatus[]).includes(to);
}
