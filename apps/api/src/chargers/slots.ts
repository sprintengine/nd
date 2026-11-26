import type { Currency } from "@nd/domain";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How far ahead a listing shows free slots. */
export const SLOT_HORIZON_DAYS = 7;

/** Free gaps shorter than this are not offered. */
export const MIN_SLOT_MINUTES = 30;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA time zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a time zone. */
function wallClock(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const p = wallClock(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** A calendar date, carried as midnight UTC of that date. */
type CivilDate = number;

/** The local calendar date of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): CivilDate {
  const p = wallClock(instant.getTime(), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: CivilDate): number {
  const day = new Date(date).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Minutes after midnight of a Postgres `time` (`HH:MM` or `HH:MM:SS`). */
export function minutesOf(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new RangeError(`Not a time of day: ${time}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The instant a wall-clock time on a date has in a time zone. In a daylight
 * saving gap the time is read with the offset from before the change.
 */
export function zonedInstant(date: CivilDate, minutes: number, timeZone: string): Date {
  const wall = date + minutes * MINUTE_MS;
  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  return new Date(second);
}

/** A weekly availability window, as stored. */
export interface AvailabilityRule {
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly pricePerHourCents: number;
  readonly currency: Currency;
  readonly kwhCap: number | null;
  readonly instantBook: boolean;
}

/** A bookable stretch of time. */
export interface Slot {
  readonly start: Date;
  readonly end: Date;
  readonly pricePerHourCents: number;
  readonly currency: Currency;
  readonly kwhCap: number | null;
  readonly instantBook: boolean;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

/** `interval` minus every one of `taken`, as the gaps left over. */
function subtract(interval: Interval, taken: readonly Interval[]): Interval[] {
  let pieces = [interval];
  for (const block of taken) {
    pieces = pieces.flatMap((piece) => {
      if (block.end <= piece.start || block.start >= piece.end) return [piece];
      const left = { start: piece.start, end: Math.min(block.start, piece.end) };
      const right = { start: Math.max(block.end, piece.start), end: piece.end };
      return [left, right].filter((part) => part.end > part.start);
    });
  }
  return pieces;
}

/**
 * Free slots from `now` to the horizon: each availability window in the
 * charger's time zone (one that ends at or before its start runs past
 * midnight), minus the bookings that hold the charger, dropping gaps shorter
 * than `MIN_SLOT_MINUTES`. Earliest first.
 */
export function freeSlots(input: {
  readonly rules: readonly AvailabilityRule[];
  readonly taken: readonly { readonly start: Date; readonly end: Date }[];
  readonly timeZone: string;
  readonly now: Date;
  readonly days?: number;
}): Slot[] {
  const { rules, timeZone, now, days = SLOT_HORIZON_DAYS } = input;
  const from = now.getTime();
  const until = from + days * DAY_MS;
  const taken = input.taken.map((block) => ({
    start: block.start.getTime(),
    end: block.end.getTime(),
  }));
  const today = localDate(now, timeZone);
  const slots: Slot[] = [];
  // Start a day early: yesterday's overnight window may still be running.
  for (let offset = -1; offset <= days; offset++) {
    const date = today + offset * DAY_MS;
    const weekday = isoWeekday(date);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      const startMinutes = minutesOf(rule.startTime);
      const endMinutes = minutesOf(rule.endTime);
      const endDate = endMinutes <= startMinutes ? date + DAY_MS : date;
      const window = {
        start: Math.max(zonedInstant(date, startMinutes, timeZone).getTime(), from),
        end: Math.min(zonedInstant(endDate, endMinutes, timeZone).getTime(), until),
      };
      if (window.end <= window.start) continue;
      for (const gap of subtract(window, taken)) {
        if (gap.end - gap.start < MIN_SLOT_MINUTES * MINUTE_MS) continue;
        slots.push({
          start: new Date(gap.start),
          end: new Date(gap.end),
          pricePerHourCents: rule.pricePerHourCents,
          currency: rule.currency,
          kwhCap: rule.kwhCap,
          instantBook: rule.instantBook,
        });
      }
    }
  }
  return slots.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );
}
