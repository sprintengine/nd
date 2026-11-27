import { type ChargerControl, START_TIMEOUT_SECONDS } from "@nd/domain";

import type { Services } from "../services.ts";

/** How long session control waits for the charger. Tests shorten them. */
export interface SessionTimings {
  /** A remote start with no StartTransaction after this long has failed. */
  readonly startTimeoutSeconds: number;
  /** After a soft reset, the remote start is retried this long later. */
  readonly resetRetryDelaySeconds: number;
}

export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
  startTimeoutSeconds: START_TIMEOUT_SECONDS,
  resetRetryDelaySeconds: 20,
};

/** Tells connected apps that something changed. Fire and forget: never throws. */
export interface RealtimeNotifier {
  /** The booking's status may have changed. */
  bookingChanged(bookingId: string): void;
  /** The booking's charging may have changed. */
  sessionChanged(bookingId: string): void;
}

/** What session control needs: the booking services plus the charger and the realtime feed. */
export interface SessionServices extends Services {
  readonly chargerControl: ChargerControl;
  readonly sessionTimings: SessionTimings;
  readonly realtime: RealtimeNotifier;
}
