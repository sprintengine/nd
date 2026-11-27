import { ARRIVAL_LEAD_MINUTES, STALE_SESSION_GRACE_MINUTES } from "@nd/domain";

import { MIN_BOOKING_MINUTES } from "./bookings/rules.ts";

/**
 * Durations a deployment may change through the environment. Production
 * keeps the defaults; end-to-end test stacks shorten them so a whole slot
 * fits in a test run.
 */
export interface Timings {
  /** Shortest booking a driver may make. */
  readonly minBookingMinutes: number;
  /** How long after its slot an open session with no StopTransaction is closed. */
  readonly staleSessionGraceMinutes: number;
  /** How long before the slot a driver may arrive and plug in. */
  readonly arrivalLeadMinutes: number;
}

export const DEFAULT_TIMINGS: Timings = {
  minBookingMinutes: MIN_BOOKING_MINUTES,
  staleSessionGraceMinutes: STALE_SESSION_GRACE_MINUTES,
  arrivalLeadMinutes: ARRIVAL_LEAD_MINUTES,
};
