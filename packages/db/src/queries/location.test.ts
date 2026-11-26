import { describe, expect, it } from "vitest";

import { approximateDistanceM, approximateLocation } from "./location.ts";

const metresBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

describe("approximateLocation", () => {
  it("moves the point, but by no more than half a cell diagonal", () => {
    for (let i = 0; i < 200; i++) {
      const exact = { lat: 53.3 + i * 0.00037, lng: -6.3 + i * 0.00041 };
      const approximate = approximateLocation(exact);
      expect(metresBetween(exact, approximate)).toBeLessThanOrEqual(Math.SQRT2 * 75 + 1);
    }
  });

  it("is deterministic, so repeated searches cannot average it out", () => {
    const exact = { lat: 53.3262, lng: -6.2565 };
    expect(approximateLocation(exact)).toEqual(approximateLocation(exact));
  });

  it("maps nearby points to the same pin", () => {
    const pins = new Set(
      [0, 0.00001, 0.00002].map((offset) =>
        JSON.stringify(approximateLocation({ lat: 53.32625 + offset, lng: -6.2565 + offset })),
      ),
    );
    expect(pins.size).toBe(1);
  });

  it("supports other cell sizes", () => {
    const exact = { lat: 53.3262, lng: -6.2565 };
    expect(metresBetween(exact, approximateLocation(exact, 1_000))).toBeLessThan(710);
  });

  it.each([0, -1, Number.NaN])("rejects a cell size of %d", (cellM) => {
    expect(() => approximateLocation({ lat: 0, lng: 0 }, cellM)).toThrow(RangeError);
  });
});

describe("approximateDistanceM", () => {
  it.each([
    [0, 100],
    [49, 100],
    [151, 200],
    [1_249, 1_200],
    [1_250, 1_300],
  ])("rounds %d m to %d m", (distance, rounded) => {
    expect(approximateDistanceM(distance)).toBe(rounded);
  });
});
