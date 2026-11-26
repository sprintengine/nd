// Pricing and payment policy: pure functions over integer cents. Money is
// never a float. Every division rounds half to even, so a long run of
// half-cent cases does not drift in either side's favour.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Sessions are billed in whole blocks of this many minutes. */
export const BILLING_INCREMENT_MINUTES = 5;

/** Default cancellation cutoff: cancelling is free until this long before the start. */
export const DEFAULT_CANCELLATION_CUTOFF_MINUTES = 120;

/** Longest cutoff a host may set; the card is authorised by then on every path. */
export const MAX_CANCELLATION_CUTOFF_MINUTES = 24 * 60;

/** A slot starting within this many days is authorised at once; later ones are authorised by a job. */
export const AUTHORISE_NOW_HORIZON_DAYS = 6;

/** A saved card is authorised this long before the slot starts. */
export const DEFERRED_AUTHORISATION_LEAD_HOURS = 24;

/** A confirmed booking with no arrival becomes a no-show this long after its slot ends. */
export const NO_SHOW_GRACE_MINUTES = 15;

/** Basis points in one whole. */
export const BPS_DENOMINATOR = 10_000;

/** A half-open time range `[start, end)`. */
export interface Window {
  readonly start: Date;
  readonly end: Date;
}

function assertCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer of cents, got ${String(value)}`);
  }
}

function assertDate(name: string, value: Date): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid date`);
}

/**
 * `numerator / denominator` rounded to the nearest integer, ties to even
 * (banker's rounding), in exact integer arithmetic.
 */
export function divideRoundHalfEven(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError(`numerator must be a non-negative safe integer, got ${String(numerator)}`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`denominator must be a positive safe integer, got ${String(denominator)}`);
  }
  const quotient = Math.floor(numerator / denominator);
  const twiceRemainder = 2 * (numerator - quotient * denominator);
  if (twiceRemainder > denominator) return quotient + 1;
  if (twiceRemainder < denominator) return quotient;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

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

/** The cost of `minutes` at an hourly price, in cents. */
export function minutesCost(minutes: number, pricePerHourCents: number): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a non-negative integer, got ${String(minutes)}`);
  }
  assertCents("pricePerHourCents", pricePerHourCents);
  return divideRoundHalfEven(minutes * pricePerHourCents, 60);
}

/** Whole minutes in a slot; the slot must be non-empty and start and end on a minute. */
export function slotMinutes(slot: Window): number {
  assertDate("slot.start", slot.start);
  assertDate("slot.end", slot.end);
  const ms = slot.end.getTime() - slot.start.getTime();
  if (ms <= 0) throw new RangeError("slot must end after it starts");
  if (ms % MINUTE_MS !== 0) throw new RangeError("slot must be a whole number of minutes");
  return ms / MINUTE_MS;
}

/**
 * The quote for a slot: its length at the hourly price, prorated by the
 * minute. This is the most the driver can be charged for the booking.
 */
export function quote(slot: Window, pricePerHourCents: number): number {
  return minutesCost(slotMinutes(slot), pricePerHourCents);
}

/**
 * What a session costs: the time from session start to stop, rounded up to
 * the billing increment, at the hourly price, capped at the quote. The
 * driver pays for occupying the slot, even while charging waits.
 */
export function billedAmount(
  start: Date,
  stop: Date,
  pricePerHourCents: number,
  quoteCents: number,
): number {
  assertDate("start", start);
  assertDate("stop", stop);
  assertCents("quoteCents", quoteCents);
  const ms = stop.getTime() - start.getTime();
  if (ms < 0) throw new RangeError("stop must not be before start");
  const minutes = billableMinutes(ms / MINUTE_MS);
  return Math.min(minutesCost(minutes, pricePerHourCents), quoteCents);
}

/** A host's cancellation terms for one booking. */
export interface CancellationPolicy {
  /** Cancelling is free until this many minutes before the start. */
  readonly cutoffMinutes?: number;
  readonly pricePerHourCents: number;
  readonly quoteCents: number;
}

/** The fee for cancelling, and whether the cutoff had passed. */
export interface CancellationCharge {
  readonly feeCents: number;
  readonly afterCutoff: boolean;
}

/**
 * The fee for cancelling at `now`: nothing until the host's cutoff (default
 * two hours before the start); after it, one hour at the hourly price, capped
 * at the quote. A no-show is charged as a cancellation after the cutoff.
 */
export function cancellationFee(
  policy: CancellationPolicy,
  now: Date,
  slotStart: Date,
): CancellationCharge {
  const cutoffMinutes = policy.cutoffMinutes ?? DEFAULT_CANCELLATION_CUTOFF_MINUTES;
  if (!Number.isSafeInteger(cutoffMinutes) || cutoffMinutes < 0) {
    throw new RangeError(
      `cutoffMinutes must be a non-negative integer, got ${String(cutoffMinutes)}`,
    );
  }
  assertCents("pricePerHourCents", policy.pricePerHourCents);
  assertCents("quoteCents", policy.quoteCents);
  assertDate("now", now);
  assertDate("slotStart", slotStart);
  const cutoff = slotStart.getTime() - cutoffMinutes * MINUTE_MS;
  if (now.getTime() < cutoff) return { feeCents: 0, afterCutoff: false };
  return {
    feeCents: Math.min(policy.pricePerHourCents, policy.quoteCents),
    afterCutoff: true,
  };
}

/** The fee for a no-show: the cancellation-after-cutoff rule. */
export function noShowFee(policy: Omit<CancellationPolicy, "cutoffMinutes">): number {
  assertCents("pricePerHourCents", policy.pricePerHourCents);
  assertCents("quoteCents", policy.quoteCents);
  return Math.min(policy.pricePerHourCents, policy.quoteCents);
}

/** The platform's share of a captured amount at `bps` basis points (default 0). */
export function platformFee(amountCents: number, bps = 0): number {
  assertCents("amountCents", amountCents);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new RangeError(`bps must be an integer from 0 to 10000, got ${String(bps)}`);
  }
  return divideRoundHalfEven(amountCents * bps, BPS_DENOMINATOR);
}

/** What the host is sent for a captured amount: the capture less the platform fee. */
export function hostShare(capturedCents: number, bps = 0): number {
  return capturedCents - platformFee(capturedCents, bps);
}

/** How a booking's payment is secured at confirmation. */
export type AuthorisationPlan =
  { readonly kind: "authorise_now" } | { readonly kind: "save_card"; readonly authoriseAt: Date };

/**
 * Authorise at once when the slot starts within the horizon (so capture stays
 * inside the card network's authorisation validity); otherwise keep the saved
 * card and authorise 24 hours before the start.
 */
export function authorisationPlan(now: Date, slotStart: Date): AuthorisationPlan {
  assertDate("now", now);
  assertDate("slotStart", slotStart);
  if (slotStart.getTime() - now.getTime() <= AUTHORISE_NOW_HORIZON_DAYS * DAY_MS) {
    return { kind: "authorise_now" };
  }
  return {
    kind: "save_card",
    authoriseAt: new Date(slotStart.getTime() - DEFERRED_AUTHORISATION_LEAD_HOURS * HOUR_MS),
  };
}

/** When the no-show check runs for a slot. */
export function noShowAt(slotEnd: Date): Date {
  assertDate("slotEnd", slotEnd);
  return new Date(slotEnd.getTime() + NO_SHOW_GRACE_MINUTES * MINUTE_MS);
}

/** How a session's amount was arrived at, for a receipt. */
export interface BillingBreakdown {
  /** Whole minutes from start to stop, rounded up. */
  readonly actualMinutes: number;
  /** Minutes billed: the actual minutes rounded up to the billing increment. */
  readonly billedMinutes: number;
  /** The billed minutes at the hourly price, before the cap. */
  readonly timeCostCents: number;
  /** Whether the quote capped the amount. */
  readonly capped: boolean;
  /** What the driver pays; equal to {@link billedAmount}. */
  readonly amountCents: number;
}

/** {@link billedAmount} with its working: the minutes billed, their cost and whether the quote capped it. */
export function billingBreakdown(
  start: Date,
  stop: Date,
  pricePerHourCents: number,
  quoteCents: number,
): BillingBreakdown {
  const amountCents = billedAmount(start, stop, pricePerHourCents, quoteCents);
  const ms = stop.getTime() - start.getTime();
  const billedMinutes = billableMinutes(ms / MINUTE_MS);
  const timeCostCents = minutesCost(billedMinutes, pricePerHourCents);
  return {
    actualMinutes: Math.ceil(ms / MINUTE_MS),
    billedMinutes,
    timeCostCents,
    capped: timeCostCents > amountCents,
    amountCents,
  };
}

/**
 * What the energy delivered cost per kWh, in cents rounded half to even, for
 * comparison only (billing is by time). Undefined when nothing was delivered.
 */
export function centsPerKwh(amountCents: number, deliveredWh: number): number | undefined {
  assertCents("amountCents", amountCents);
  if (!Number.isSafeInteger(deliveredWh) || deliveredWh < 0) {
    throw new RangeError(`deliveredWh must be a non-negative integer, got ${String(deliveredWh)}`);
  }
  if (deliveredWh === 0) return undefined;
  return divideRoundHalfEven(amountCents * 1000, deliveredWh);
}
