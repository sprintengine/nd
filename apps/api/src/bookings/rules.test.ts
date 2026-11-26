import { describe, expect, it } from "vitest";

import {
  coveringRule,
  driverSeesAddress,
  hourlyPriceOf,
  ID_TAG_LENGTH,
  isSlotTaken,
  localDay,
  newIdTag,
  vehiclePlateSchema,
  windowProblem,
} from "./rules.ts";

const rule = (weekday: number, startTime: string, endTime: string) => ({
  weekday,
  startTime,
  endTime,
  pricePerHourCents: 250,
  currency: "EUR" as const,
  kwhCap: null,
  instantBook: true,
});
const window = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

describe("newIdTag", () => {
  it("is 20 upper-case characters and different every time", () => {
    const tags = new Set(Array.from({ length: 50 }, newIdTag));
    expect(tags.size).toBe(50);
    for (const tag of tags) expect(tag).toMatch(new RegExp(`^[A-Z2-9]{${String(ID_TAG_LENGTH)}}$`));
  });
});

describe("vehiclePlateSchema", () => {
  it("normalises case and spaces", () => {
    expect(vehiclePlateSchema.parse("  251 d   1234 ")).toBe("251 D 1234");
  });

  it.each(["A", "TOO-LONG-PLATE-1", "AB_12", " -12"])("rejects %j", (plate) => {
    expect(vehiclePlateSchema.safeParse(plate).success).toBe(false);
  });
});

describe("coveringRule", () => {
  // Tuesday 12 January 2027; Dublin is on UTC in winter.
  const overnight = rule(2, "20:00:00", "08:00:00");

  it("finds a window inside an overnight rule, on either side of midnight", () => {
    expect(
      coveringRule([overnight], window("2027-01-12T22:00Z", "2027-01-13T02:00Z"), "Europe/Dublin"),
    ).toBe(overnight);
    expect(
      coveringRule([overnight], window("2027-01-13T01:00Z", "2027-01-13T08:00Z"), "Europe/Dublin"),
    ).toBe(overnight);
  });

  it("refuses a window that runs past the end or starts before the start", () => {
    expect(
      coveringRule([overnight], window("2027-01-13T07:00Z", "2027-01-13T09:00Z"), "Europe/Dublin"),
    ).toBeUndefined();
    expect(
      coveringRule([overnight], window("2027-01-12T19:00Z", "2027-01-12T21:00Z"), "Europe/Dublin"),
    ).toBeUndefined();
    expect(
      coveringRule(
        [rule(3, "20:00", "08:00")],
        window("2027-01-12T22:00Z", "2027-01-13T02:00Z"),
        "Europe/Dublin",
      ),
    ).toBeUndefined();
  });

  it("reads rules in the charger's time zone", () => {
    const daytime = rule(2, "09:00", "17:00");
    // 09:00 in Dublin is 09:00 UTC in January but 08:00 UTC in July.
    expect(
      coveringRule([daytime], window("2027-01-12T09:00Z", "2027-01-12T10:00Z"), "Europe/Dublin"),
    ).toBe(daytime);
    expect(
      coveringRule(
        [rule(2, "09:00", "17:00")],
        window("2027-07-13T08:00Z", "2027-07-13T09:00Z"),
        "Europe/Dublin",
      ),
    ).toBeDefined();
  });
});

describe("localDay", () => {
  it("is the calendar day in the time zone", () => {
    expect(localDay(new Date("2027-07-13T23:30:00Z"), "Europe/Dublin")).toEqual({
      start: new Date("2027-07-13T23:00:00Z"),
      end: new Date("2027-07-14T23:00:00Z"),
    });
  });
});

describe("windowProblem", () => {
  const now = new Date("2027-01-11T12:00:00Z");

  it("accepts a whole-minute future window of 30 minutes to 24 hours", () => {
    expect(windowProblem(window("2027-01-12T22:00Z", "2027-01-12T22:30Z"), now)).toBeUndefined();
    expect(windowProblem(window("2027-01-12T22:00Z", "2027-01-13T22:00Z"), now)).toBeUndefined();
  });

  it("takes a configured shortest booking", () => {
    const short = window("2027-01-12T22:00Z", "2027-01-12T22:02Z");
    expect(windowProblem(short, now, 2)).toBeUndefined();
    expect(windowProblem(short, now, 3)).toMatch(/at least 3 minutes/);
  });

  it.each([
    [window("2027-01-12T22:00:30Z", "2027-01-12T23:00Z"), /whole minute/],
    [window("2027-01-11T12:00Z", "2027-01-11T13:00Z"), /future/],
    [window("2027-01-12T22:00Z", "2027-01-12T22:29Z"), /at least 30/],
    [window("2027-01-12T22:00Z", "2027-01-13T22:01Z"), /at most 24/],
  ])("explains what is wrong with %j", (slot, message) => {
    expect(windowProblem(slot, now)).toMatch(message);
  });
});

describe("hourlyPriceOf", () => {
  const slot = window("2027-01-12T22:00Z", "2027-01-13T02:00Z");

  it("uses the stored price, or derives it from the quote", () => {
    expect(hourlyPriceOf({ pricePerHourCents: 300, quotedAmountCents: 1000, slot })).toBe(300);
    expect(hourlyPriceOf({ pricePerHourCents: null, quotedAmountCents: 1000, slot })).toBe(250);
  });
});

describe("driverSeesAddress", () => {
  it("only while the booking holds the slot", () => {
    expect(driverSeesAddress("confirmed")).toBe(true);
    expect(driverSeesAddress("active")).toBe(true);
    expect(driverSeesAddress("requested")).toBe(false);
    expect(driverSeesAddress("cancelled")).toBe(false);
  });
});

describe("isSlotTaken", () => {
  it("finds the exclusion violation, also as a cause", () => {
    const violation = Object.assign(new Error("conflict"), { code: "23P01" });
    expect(isSlotTaken(violation)).toBe(true);
    expect(isSlotTaken(new Error("query failed", { cause: violation }))).toBe(true);
    expect(isSlotTaken(new Error("other"))).toBe(false);
    expect(isSlotTaken("23P01")).toBe(false);
  });
});
