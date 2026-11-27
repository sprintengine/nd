import type { CancelledBy } from "./status.ts";

// Pricing and payment policy: pure functions over integer cents. Money is
// never a float. The driver pays the whole booking upfront: the slot's
// minutes at the host's hourly price. Card fees are passed on to the host as
// the application fee of a destination charge.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Default cancellation cutoff: a driver cancelling before this long ahead of the start is refunded in full. */
export const DEFAULT_CANCELLATION_CUTOFF_MINUTES = 120;

/** Longest cutoff a host may set. */
export const MAX_CANCELLATION_CUTOFF_MINUTES = 24 * 60;

/** A confirmed booking with no arrival becomes a no-show this long after its slot ends. */
export const NO_SHOW_GRACE_MINUTES = 15;

/** A host has this long to answer a request (never past the slot start); the card hold lasts far longer. */
export const REQUEST_RESPONSE_HOURS = 24;

/** Default card fee estimate passed on to the host: 1.5 % of the charge … */
export const DEFAULT_CARD_FEE_BPS = 150;

/** … plus 25 cents. */
export const DEFAULT_CARD_FEE_FIXED_CENTS = 25;

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
 * The price of a slot: its length at the hourly price, prorated by the
 * minute. The driver pays exactly this, upfront; nothing is billed by
 * energy or by the minutes actually used.
 */
export function quote(slot: Window, pricePerHourCents: number): number {
  return minutesCost(slotMinutes(slot), pricePerHourCents);
}

/** `numerator / denominator` rounded up, in exact integer arithmetic. */
export function divideRoundUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError(`numerator must be a non-negative safe integer, got ${String(numerator)}`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`denominator must be a positive safe integer, got ${String(denominator)}`);
  }
  return Math.ceil(numerator / denominator);
}

/** The fees a charge carries, from configuration. */
export interface FeeSettings {
  /** The platform's own fee, in basis points (default 0). */
  readonly platformFeeBps: number;
  /** The card fee estimate passed on to the host, in basis points … */
  readonly cardFeeBps: number;
  /** … plus this many cents per charge. */
  readonly cardFeeFixedCents: number;
}

/** How one booking's price splits between the host and the fees taken from it. */
export interface ChargeSplit {
  /** What the driver pays: the booking's price. */
  readonly amountCents: number;
  readonly platformFeeCents: number;
  /** The estimate of what the card network and Stripe charge for the payment. */
  readonly cardFeeCents: number;
  /** The destination charge's `application_fee_amount`: the platform fee plus the card fee. */
  readonly applicationFeeCents: number;
  /** What the host receives: the price less the application fee. */
  readonly hostNetCents: number;
}

function assertBps(name: string, bps: number): void {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new RangeError(`${name} must be an integer from 0 to 10000, got ${String(bps)}`);
  }
}

/**
 * Splits a price into the fees kept back and the host's net. The card fee
 * (basis points of the price, rounded up, plus a fixed amount) is passed on
 * to the host, so the platform nets about zero; the platform fee is
 * configured separately and is 0 by default. Fees never exceed the price.
 */
export function chargeSplit(amountCents: number, fees: FeeSettings): ChargeSplit {
  assertCents("amountCents", amountCents);
  assertBps("platformFeeBps", fees.platformFeeBps);
  assertBps("cardFeeBps", fees.cardFeeBps);
  assertCents("cardFeeFixedCents", fees.cardFeeFixedCents);
  const platformFeeCents = divideRoundUp(amountCents * fees.platformFeeBps, BPS_DENOMINATOR);
  const cardFeeCents = Math.min(
    divideRoundUp(amountCents * fees.cardFeeBps, BPS_DENOMINATOR) + fees.cardFeeFixedCents,
    amountCents - platformFeeCents,
  );
  const applicationFeeCents = platformFeeCents + cardFeeCents;
  return {
    amountCents,
    platformFeeCents,
    cardFeeCents,
    applicationFeeCents,
    hostNetCents: amountCents - applicationFeeCents,
  };
}

/** What a host keeps of a paid booking once refunds are taken out. */
export interface HostEarnings {
  /** What the driver paid, less refunds. */
  readonly grossCents: number;
  readonly platformFeeCents: number;
  readonly cardFeeCents: number;
  /** What the host keeps: the gross less both fees. */
  readonly netCents: number;
}

/**
 * The host's share of a paid booking after `refundedCents` were refunded. A
 * refund reverses the host's share and the application fee in proportion, so
 * each fee shrinks with what is kept (rounded down; Stripe's own rounding may
 * differ by a cent).
 */
export function hostEarnings(
  payment: {
    readonly amountCents: number;
    readonly platformFeeCents: number;
    readonly cardFeeCents: number;
  },
  refundedCents: number,
): HostEarnings {
  assertCents("amountCents", payment.amountCents);
  assertCents("platformFeeCents", payment.platformFeeCents);
  assertCents("cardFeeCents", payment.cardFeeCents);
  assertCents("refundedCents", refundedCents);
  if (refundedCents > payment.amountCents) {
    throw new RangeError("refundedCents must not exceed amountCents");
  }
  const kept = payment.amountCents - refundedCents;
  const share = (fee: number) =>
    payment.amountCents === 0 ? 0 : Math.floor((fee * kept) / payment.amountCents);
  const platformFeeCents = share(payment.platformFeeCents);
  const cardFeeCents = share(payment.cardFeeCents);
  return {
    grossCents: kept,
    platformFeeCents,
    cardFeeCents,
    netCents: kept - platformFeeCents - cardFeeCents,
  };
}

/** What a cancellation gives back. */
export interface CancellationRefund {
  readonly refundCents: number;
  /** Whether the driver cancelled at or after the host's cutoff. */
  readonly afterCutoff: boolean;
}

/**
 * What a cancellation at `now` refunds of `paidCents`: everything when the
 * host or the platform cancels, or when the driver cancels before the host's
 * cutoff (default two hours before the start); nothing when the driver
 * cancels after it.
 */
export function cancellationRefund(
  policy: { readonly cutoffMinutes?: number; readonly paidCents: number },
  cancelledBy: CancelledBy,
  now: Date,
  slotStart: Date,
): CancellationRefund {
  const cutoffMinutes = policy.cutoffMinutes ?? DEFAULT_CANCELLATION_CUTOFF_MINUTES;
  if (!Number.isSafeInteger(cutoffMinutes) || cutoffMinutes < 0) {
    throw new RangeError(
      `cutoffMinutes must be a non-negative integer, got ${String(cutoffMinutes)}`,
    );
  }
  assertCents("paidCents", policy.paidCents);
  assertDate("now", now);
  assertDate("slotStart", slotStart);
  if (cancelledBy !== "driver") return { refundCents: policy.paidCents, afterCutoff: false };
  const afterCutoff = now.getTime() >= slotStart.getTime() - cutoffMinutes * MINUTE_MS;
  return { refundCents: afterCutoff ? 0 : policy.paidCents, afterCutoff };
}

/** When an unanswered request expires: 24 hours after it was made, and never after the slot starts. */
export function requestExpiresAt(requestedAt: Date, slotStart: Date): Date {
  assertDate("requestedAt", requestedAt);
  assertDate("slotStart", slotStart);
  return new Date(
    Math.min(requestedAt.getTime() + REQUEST_RESPONSE_HOURS * HOUR_MS, slotStart.getTime()),
  );
}

/** When the no-show check runs for a slot. */
export function noShowAt(slotEnd: Date): Date {
  assertDate("slotEnd", slotEnd);
  return new Date(slotEnd.getTime() + NO_SHOW_GRACE_MINUTES * MINUTE_MS);
}

/**
 * What the energy delivered cost per kWh, in cents rounded half to even, for
 * comparison only (the booking is priced by time). Undefined when nothing was delivered.
 */
export function centsPerKwh(amountCents: number, deliveredWh: number): number | undefined {
  assertCents("amountCents", amountCents);
  if (!Number.isSafeInteger(deliveredWh) || deliveredWh < 0) {
    throw new RangeError(`deliveredWh must be a non-negative integer, got ${String(deliveredWh)}`);
  }
  if (deliveredWh === 0) return undefined;
  return divideRoundHalfEven(amountCents * 1000, deliveredWh);
}
