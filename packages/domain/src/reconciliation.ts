import type { SessionReviewReason } from "./status.ts";

// Rules for closing a session once it has stopped: checking the meter (the
// energy is shown on the receipt; the booking was paid upfront) and closing
// a session whose StopTransaction never came.

const MINUTE_MS = 60_000;

/** The meter delta and the last MeterValue may disagree by at most this many Wh (0.2 kWh). */
export const METER_TOLERANCE_WH = 200;

/** An open session is closed from its last MeterValue this long after its slot ends. */
export const STALE_SESSION_GRACE_MINUTES = 10;

/** What a session's meter readings say. */
export type MeterCheck =
  | { readonly ok: true; readonly deliveredWh: number }
  | {
      readonly ok: false;
      readonly reason: Extract<SessionReviewReason, "meter_invalid" | "meter_mismatch">;
      /** The meter delta, when there is a usable one. */
      readonly deliveredWh: number | null;
    };

/** Readings of one session, in Wh of the charger's cumulative energy register. */
export interface MeterReadings {
  readonly meterStartWh: number | null;
  readonly meterStopWh: number | null;
  /** Energy.Active.Import.Register of the session's last MeterValue, if any had one. */
  readonly lastMeterValueWh: number | null;
}

/**
 * Checks a stopped session's meter: the delivered energy is the meter delta,
 * which must agree with the last MeterValue within {@link METER_TOLERANCE_WH}.
 * Without a start or stop reading, or with a stop below the start, it is
 * `meter_invalid`. A session with no MeterValue at all is taken at its delta.
 */
export function checkMeter(readings: MeterReadings): MeterCheck {
  const { meterStartWh, meterStopWh, lastMeterValueWh } = readings;
  if (meterStartWh === null || meterStopWh === null || meterStopWh < meterStartWh) {
    return { ok: false, reason: "meter_invalid", deliveredWh: null };
  }
  const deliveredWh = meterStopWh - meterStartWh;
  if (lastMeterValueWh !== null && Math.abs(meterStopWh - lastMeterValueWh) > METER_TOLERANCE_WH) {
    return { ok: false, reason: "meter_mismatch", deliveredWh };
  }
  return { ok: true, deliveredWh };
}

/** Wh as kWh with three decimals, the precision `sessions.kwh` keeps. */
export function whToKwh(wh: number): number {
  return Math.round(wh) / 1000;
}

/**
 * When an open session of a slot ending at `slotEnd` is closed from its last
 * MeterValue: `graceMinutes` (by default {@link STALE_SESSION_GRACE_MINUTES}) later.
 */
export function staleSessionCloseAt(
  slotEnd: Date,
  graceMinutes: number = STALE_SESSION_GRACE_MINUTES,
): Date {
  return new Date(slotEnd.getTime() + graceMinutes * MINUTE_MS);
}
