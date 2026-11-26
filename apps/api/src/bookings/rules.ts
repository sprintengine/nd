import { type BookingStatus, divideRoundHalfEven, holdsSlot, slotMinutes } from "@nd/domain";
import { z } from "zod";

import {
  type AvailabilityRule,
  isoWeekday,
  localDate,
  minutesOf,
  zonedInstant,
} from "../chargers/slots.ts";
import { randomString } from "../hosts/rules.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Shortest booking a driver may make. */
export const MIN_BOOKING_MINUTES = 30;

/** Longest booking a driver may make. */
export const MAX_BOOKING_HOURS = 24;

/** Stripe's smallest charge in euro or sterling, in cents. */
export const MIN_CHARGE_CENTS = 50;

/** Characters of a booking idTag: upper case only, since OCPP compares idTags case-insensitively. */
const ID_TAG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of a booking idTag: the OCPP maximum (CiString20), about 100 random bits. */
export const ID_TAG_LENGTH = 20;

/** A new single-use OCPP idTag from the operating system's CSPRNG. */
export function newIdTag(): string {
  return randomString(ID_TAG_LENGTH, ID_TAG_ALPHABET);
}

/** A number plate as the host will read it: upper case, single spaces. */
export const vehiclePlateSchema = z
  .string()
  .transform((plate) => plate.trim().replace(/\s+/g, " ").toUpperCase())
  .pipe(
    z
      .string()
      .min(2)
      .max(12)
      .regex(/^[A-Z0-9][A-Z0-9 -]*$/, "letters, digits, spaces and hyphens only"),
  )
  .describe("Number plate of the car being charged; shown to the host");

/**
 * The availability rule whose window, in the charger's time zone, contains
 * the whole of `window`; undefined when none does. A window that ends at or
 * before its start runs past midnight.
 */
export function coveringRule<R extends AvailabilityRule>(
  rules: readonly R[],
  window: { readonly start: Date; readonly end: Date },
  timeZone: string,
): R | undefined {
  const today = localDate(window.start, timeZone);
  // The window may sit in an overnight rule that started the day before.
  for (const date of [today, today - DAY_MS]) {
    const weekday = isoWeekday(date);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      const startMinutes = minutesOf(rule.startTime);
      const endMinutes = minutesOf(rule.endTime);
      const start = zonedInstant(date, startMinutes, timeZone).getTime();
      const end = zonedInstant(
        endMinutes <= startMinutes ? date + DAY_MS : date,
        endMinutes,
        timeZone,
      ).getTime();
      if (start <= window.start.getTime() && window.end.getTime() <= end) return rule;
    }
  }
  return undefined;
}

/** The local calendar day, in a time zone, that an instant falls on, as a half-open range. */
export function localDay(instant: Date, timeZone: string): { start: Date; end: Date } {
  const date = localDate(instant, timeZone);
  return {
    start: zonedInstant(date, 0, timeZone),
    end: zonedInstant(date + DAY_MS, 0, timeZone),
  };
}

/**
 * Why a requested window cannot be booked, or undefined when its shape is
 * fine. `minMinutes` is the shortest booking ({@link MIN_BOOKING_MINUTES} unless configured).
 */
export function windowProblem(
  window: { readonly start: Date; readonly end: Date },
  now: Date,
  minMinutes: number = MIN_BOOKING_MINUTES,
): string | undefined {
  if (window.start.getTime() % MINUTE_MS !== 0 || window.end.getTime() % MINUTE_MS !== 0) {
    return "Start and end must be on a whole minute.";
  }
  if (window.start.getTime() <= now.getTime()) return "The slot must start in the future.";
  const minutes = (window.end.getTime() - window.start.getTime()) / MINUTE_MS;
  if (minutes < minMinutes) {
    return `A booking must be at least ${String(minMinutes)} minutes long.`;
  }
  if (minutes > MAX_BOOKING_HOURS * 60) {
    return `A booking may be at most ${String(MAX_BOOKING_HOURS)} hours long.`;
  }
  return undefined;
}

/** The hourly price a booking was quoted at; derived from the quote for rows that lack it. */
export function hourlyPriceOf(booking: {
  readonly pricePerHourCents: number | null;
  readonly quotedAmountCents: number;
  readonly slot: { readonly start: Date; readonly end: Date };
}): number {
  if (booking.pricePerHourCents !== null) return booking.pricePerHourCents;
  return divideRoundHalfEven(booking.quotedAmountCents * 60, slotMinutes(booking.slot));
}

/** Whether a driver may see the address and exact position: only while their booking holds the slot. */
export function driverSeesAddress(status: BookingStatus): boolean {
  return holdsSlot(status);
}

const EXCLUSION_VIOLATION = "23P01";

/** Whether an error is Postgres refusing an overlapping slot-holding booking. */
export function isSlotTaken(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === EXCLUSION_VIOLATION) return true;
  }
  return false;
}
