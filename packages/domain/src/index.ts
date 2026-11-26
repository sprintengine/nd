/** Sessions are billed in whole blocks of this many minutes. */
export const BILLING_INCREMENT_MINUTES = 5;

/**
 * Rounds the minutes a driver actually used up to the next billing increment.
 *
 * The amount charged is these minutes at the host's hourly price, capped at
 * the amount quoted when the booking was confirmed.
 */
export function billableMinutes(actualMinutes: number): number {
  if (!Number.isFinite(actualMinutes) || actualMinutes < 0) {
    throw new RangeError(
      `actualMinutes must be a finite, non-negative number, got ${String(actualMinutes)}`,
    );
  }
  return Math.ceil(actualMinutes / BILLING_INCREMENT_MINUTES) * BILLING_INCREMENT_MINUTES;
}

export * from "./charger-control.ts";
export * from "./charger-events.ts";
export * from "./status.ts";
export * from "./transitions.ts";
