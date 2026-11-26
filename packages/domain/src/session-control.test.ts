import { describe, expect, it } from "vitest";

import {
  ARRIVAL_RADIUS_M,
  arrivalCheck,
  arrivalOpensAt,
  arrivalTiming,
  billingStart,
  distanceMeters,
  isSessionFailureReason,
  LIVE_SESSION_STATUSES,
  SESSION_FAILURE_MESSAGES,
  SESSION_FAILURE_REASONS,
  sessionMetrics,
  startAtProblem,
  windowEndStopAt,
} from "./session-control.ts";

const slot = { start: new Date("2027-01-12T22:00:00Z"), end: new Date("2027-01-13T02:00:00Z") };
const at = (iso: string) => new Date(iso);

describe("arrival", () => {
  it("opens 15 minutes before the slot and closes when it ends", () => {
    expect(arrivalOpensAt(slot.start)).toEqual(at("2027-01-12T21:45:00Z"));
    expect(arrivalTiming(slot, at("2027-01-12T21:44:59Z"))).toBe("early");
    expect(arrivalTiming(slot, at("2027-01-12T21:45:00Z"))).toBe("open");
    expect(arrivalTiming(slot, at("2027-01-13T01:59:59Z"))).toBe("open");
    expect(arrivalTiming(slot, at("2027-01-13T02:00:00Z"))).toBe("ended");
  });

  it("rejects invalid dates", () => {
    expect(() => arrivalOpensAt(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => arrivalTiming(slot, new Date(Number.NaN))).toThrow(RangeError);
    expect(() => windowEndStopAt(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("measures great-circle distance in metres", () => {
    const ranelagh = { lat: 53.326, lng: -6.256 };
    expect(distanceMeters(ranelagh, ranelagh)).toBe(0);
    // One thousandth of a degree of latitude is about 111 m.
    expect(distanceMeters(ranelagh, { lat: 53.327, lng: -6.256 })).toBe(111);
    // Dublin to Cork, roughly 220 km.
    const km =
      distanceMeters({ lat: 53.3498, lng: -6.2603 }, { lat: 51.8985, lng: -8.4756 }) / 1000;
    expect(km).toBeGreaterThan(215);
    expect(km).toBeLessThan(225);
  });

  it("counts a position within 300 m as near the charger", () => {
    const charger = { lat: 53.326, lng: -6.256 };
    expect(arrivalCheck(charger, { lat: 53.3285, lng: -6.256 })).toEqual({
      distanceM: 278,
      nearCharger: true,
    });
    const far = arrivalCheck(charger, { lat: 53.33, lng: -6.256 });
    expect(far.distanceM).toBeGreaterThan(ARRIVAL_RADIUS_M);
    expect(far.nearCharger).toBe(false);
  });
});

describe("scheduled starts and the window end", () => {
  it("stops 5 minutes after the slot ends", () => {
    expect(windowEndStopAt(slot.end)).toEqual(at("2027-01-13T02:05:00Z"));
  });

  it("accepts a start time inside the slot only", () => {
    expect(startAtProblem(slot, slot.start)).toBeUndefined();
    expect(startAtProblem(slot, at("2027-01-13T01:00:00Z"))).toBeUndefined();
    expect(startAtProblem(slot, slot.end)).toMatch(/inside the booked slot/);
    expect(startAtProblem(slot, at("2027-01-12T21:59:00Z"))).toMatch(/inside/);
    expect(startAtProblem(slot, new Date(Number.NaN))).toMatch(/valid date/);
  });

  it("bills from the plug-in of a scheduled start, otherwise from StartTransaction", () => {
    const plugged = at("2027-01-12T22:05:00Z");
    const started = at("2027-01-13T00:00:00Z");
    expect(billingStart({ pluggedInAt: plugged, startedAt: started })).toBe(plugged);
    expect(billingStart({ pluggedInAt: null, startedAt: started })).toBe(started);
    expect(billingStart({ pluggedInAt: null, startedAt: null })).toBeNull();
  });
});

describe("failure reasons", () => {
  it("has a message for every reason", () => {
    for (const reason of SESSION_FAILURE_REASONS) {
      expect(SESSION_FAILURE_MESSAGES[reason]).toMatch(/\.$/);
    }
    expect(SESSION_FAILURE_MESSAGES.no_response).toBe(
      "The charger didn't respond. Check the cable is plugged in, then try again.",
    );
    expect(isSessionFailureReason("start_timeout")).toBe(true);
    expect(isSessionFailureReason("Remote")).toBe(false);
    expect(isSessionFailureReason(null)).toBe(false);
  });

  it("lists the live statuses the app shows", () => {
    expect(LIVE_SESSION_STATUSES.slice(0, 3)).toEqual(["not_started", "scheduled", "starting"]);
  });
});

describe("sessionMetrics", () => {
  const base = {
    billingStart: at("2027-01-12T22:00:00Z"),
    until: at("2027-01-12T22:31:30Z"),
    meterStartWh: 10_000,
    latestEnergyWh: 13_612,
    finalKwh: null,
    powerW: 7_234,
    pricePerHourCents: 250,
    quoteCents: 1_000,
  };

  it("computes energy, power, elapsed time and the cost so far", () => {
    // 31.5 minutes bill as 35: 35 × 250 / 60 = 145.83 → 146 cents.
    expect(sessionMetrics(base)).toEqual({ kwh: 3.612, kw: 7.23, elapsed: 1890, costSoFar: 146 });
  });

  it("prefers the stored kWh of a stopped session and caps the cost at the quote", () => {
    expect(
      sessionMetrics({
        ...base,
        until: at("2027-01-13T06:00:00Z"),
        finalKwh: 20.5,
        powerW: null,
      }),
    ).toEqual({ kwh: 20.5, kw: null, elapsed: 28_800, costSoFar: 1_000 });
  });

  it("is zero before billing starts or without readings", () => {
    expect(
      sessionMetrics({ ...base, billingStart: null, latestEnergyWh: null, powerW: null }),
    ).toEqual({ kwh: null, kw: null, elapsed: 0, costSoFar: 0 });
    // A charger clock ahead of ours never produces negative time.
    expect(sessionMetrics({ ...base, until: at("2027-01-12T21:59:00Z") })).toMatchObject({
      elapsed: 0,
      costSoFar: 0,
    });
    // A meter that went backwards reads as nothing delivered.
    expect(sessionMetrics({ ...base, latestEnergyWh: 9_000, powerW: -5 })).toMatchObject({
      kwh: 0,
      kw: 0,
    });
  });
});
