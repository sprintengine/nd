import { describe, expect, it } from "vitest";

import {
  type AvailabilityRule,
  freeSlots,
  isoWeekday,
  isTimeZone,
  localDate,
  minutesOf,
  zonedInstant,
} from "./slots.ts";

const DUBLIN = "Europe/Dublin";

const overnight = (weekday: number, extra: Partial<AvailabilityRule> = {}): AvailabilityRule => ({
  weekday,
  startTime: "20:00:00",
  endTime: "08:00:00",
  pricePerHourCents: 250,
  currency: "EUR",
  kwhCap: null,
  instantBook: true,
  ...extra,
});

const everyNight = [1, 2, 3, 4, 5, 6, 7].map((weekday) => overnight(weekday));

const iso = (slot: { start: Date; end: Date }) => [
  slot.start.toISOString(),
  slot.end.toISOString(),
];

describe("time zone helpers", () => {
  it("knows IANA zones", () => {
    expect(isTimeZone(DUBLIN)).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("reads Postgres times", () => {
    expect(minutesOf("20:30")).toBe(1230);
    expect(minutesOf("08:00:00")).toBe(480);
    expect(() => minutesOf("8pm")).toThrow(RangeError);
  });

  it("finds the local date and ISO weekday", () => {
    // 23:30 UTC on Saturday 27 June 2026 is 00:30 on Sunday in Dublin (IST).
    const date = localDate(new Date("2026-06-27T23:30:00Z"), DUBLIN);
    expect(new Date(date).toISOString()).toBe("2026-06-28T00:00:00.000Z");
    expect(isoWeekday(date)).toBe(7);
  });

  it("converts wall-clock times across daylight saving", () => {
    const winter = Date.UTC(2026, 0, 15);
    const summer = Date.UTC(2026, 6, 15);
    expect(zonedInstant(winter, 20 * 60, DUBLIN).toISOString()).toBe("2026-01-15T20:00:00.000Z");
    expect(zonedInstant(summer, 20 * 60, DUBLIN).toISOString()).toBe("2026-07-15T19:00:00.000Z");
  });
});

describe("freeSlots", () => {
  it("offers every overnight window in the next seven days", () => {
    const now = new Date("2027-01-11T12:00:00Z"); // a Monday, Dublin on GMT
    const slots = freeSlots({ rules: everyNight, taken: [], timeZone: DUBLIN, now });
    expect(slots).toHaveLength(7);
    expect(iso(slots[0] ?? { start: now, end: now })).toEqual([
      "2027-01-11T20:00:00.000Z",
      "2027-01-12T08:00:00.000Z",
    ]);
    expect(slots[0]).toMatchObject({ pricePerHourCents: 250, currency: "EUR", instantBook: true });
  });

  it("includes the rest of a window already running, starting now", () => {
    const now = new Date("2027-01-12T02:00:00Z");
    const [first] = freeSlots({ rules: everyNight, taken: [], timeZone: DUBLIN, now });
    expect(iso(first ?? { start: now, end: now })).toEqual([
      "2027-01-12T02:00:00.000Z",
      "2027-01-12T08:00:00.000Z",
    ]);
  });

  it("cuts held bookings out and drops gaps under 30 minutes", () => {
    const now = new Date("2027-01-11T12:00:00Z");
    const slots = freeSlots({
      rules: [overnight(1)],
      taken: [
        { start: new Date("2027-01-11T20:15:00Z"), end: new Date("2027-01-11T23:00:00Z") },
        { start: new Date("2027-01-12T01:00:00Z"), end: new Date("2027-01-12T03:00:00Z") },
      ],
      timeZone: DUBLIN,
      now,
    });
    expect(slots.map(iso)).toEqual([
      ["2027-01-11T23:00:00.000Z", "2027-01-12T01:00:00.000Z"],
      ["2027-01-12T03:00:00.000Z", "2027-01-12T08:00:00.000Z"],
    ]);
  });

  it("follows the charger's local time through the change to summer time", () => {
    // Clocks go forward in Dublin at 01:00 UTC on Sunday 29 March 2026.
    const now = new Date("2026-03-28T12:00:00Z");
    const slots = freeSlots({
      rules: [overnight(6), overnight(7)],
      taken: [],
      timeZone: DUBLIN,
      now,
      days: 2,
    });
    expect(slots.map(iso)).toEqual([
      ["2026-03-28T20:00:00.000Z", "2026-03-29T07:00:00.000Z"],
      ["2026-03-29T19:00:00.000Z", "2026-03-30T07:00:00.000Z"],
    ]);
  });

  it("supports daytime windows and stops at the horizon", () => {
    const now = new Date("2027-01-11T12:00:00Z");
    const daytime = overnight(1, {
      startTime: "09:00",
      endTime: "17:00",
      kwhCap: 20,
      instantBook: false,
    });
    const slots = freeSlots({ rules: [daytime], taken: [], timeZone: DUBLIN, now, days: 7 });
    expect(slots.map(iso)).toEqual([
      ["2027-01-11T12:00:00.000Z", "2027-01-11T17:00:00.000Z"],
      ["2027-01-18T09:00:00.000Z", "2027-01-18T12:00:00.000Z"],
    ]);
    expect(slots[0]).toMatchObject({ kwhCap: 20, instantBook: false });
  });
});
