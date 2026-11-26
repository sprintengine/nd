import { describe, expect, it } from "vitest";

import { formatTimeRange, parseEwkbPoint, parseTimeRange, toEwktPoint } from "./columns.ts";

// SELECT 'SRID=4326;POINT(-6.256 53.326)'::geography, as Postgres returns it.
const EWKB_LE_WITH_SRID = "0101000020E6100000A01A2FDD240619C07D3F355EBAA94A40";

function wkbBigEndian(x: number, y: number): string {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt8(0, 0);
  buffer.writeUInt32BE(1, 1);
  buffer.writeDoubleBE(x, 5);
  buffer.writeDoubleBE(y, 13);
  return buffer.toString("hex");
}

describe("parseEwkbPoint", () => {
  it("reads a little-endian EWKB point with an SRID", () => {
    const point = parseEwkbPoint(EWKB_LE_WITH_SRID);
    expect(point.lat).toBeCloseTo(53.326, 10);
    expect(point.lng).toBeCloseTo(-6.256, 10);
  });

  it("reads a big-endian WKB point without an SRID", () => {
    expect(parseEwkbPoint(wkbBigEndian(-6.25, 53.5))).toEqual({ lat: 53.5, lng: -6.25 });
  });

  it("rejects input that is too short", () => {
    expect(() => parseEwkbPoint("0101")).toThrow(TypeError);
    // Claims an SRID but stops before the coordinates end.
    expect(() => parseEwkbPoint(EWKB_LE_WITH_SRID.slice(0, 44))).toThrow(TypeError);
  });

  it("rejects geometries other than points", () => {
    const lineString = `0102000020E6100000${"00".repeat(16)}`;
    expect(() => parseEwkbPoint(lineString)).toThrow(/Expected a point/);
  });
});

describe("toEwktPoint", () => {
  it("writes longitude first", () => {
    expect(toEwktPoint({ lat: 53.326, lng: -6.256 })).toBe("SRID=4326;POINT(-6.256 53.326)");
  });

  it.each([
    { lat: 91, lng: 0 },
    { lat: Number.NaN, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: 0, lng: Number.POSITIVE_INFINITY },
  ])("rejects %j", (point) => {
    expect(() => toEwktPoint(point)).toThrow(RangeError);
  });
});

describe("time ranges", () => {
  const start = new Date("2027-01-13T22:00:00.000Z");
  const end = new Date("2027-01-14T06:00:00.000Z");

  it("formats a half-open range", () => {
    expect(formatTimeRange({ start, end })).toBe(
      "[2027-01-13T22:00:00.000Z,2027-01-14T06:00:00.000Z)",
    );
  });

  it("rejects empty, inverted and invalid ranges", () => {
    expect(() => formatTimeRange({ start, end: start })).toThrow(RangeError);
    expect(() => formatTimeRange({ start: end, end: start })).toThrow(RangeError);
    expect(() => formatTimeRange({ start: new Date(Number.NaN), end })).toThrow(RangeError);
  });

  it.each([
    ['["2027-01-13 22:00:00+00","2027-01-14 06:00:00+00")', start, end],
    ['["2027-01-13 23:00:00+01","2027-01-14 07:00:00+01")', start, end],
    ['["2027-01-14 03:30:00+05:30","2027-01-14 11:30:00+05:30")', start, end],
    [
      '["2027-01-13 22:00:00.25+00","2027-01-14 06:00:00+00")',
      new Date("2027-01-13T22:00:00.250Z"),
      end,
    ],
  ])("parses %s", (text, expectedStart, expectedEnd) => {
    expect(parseTimeRange(text)).toEqual({ start: expectedStart, end: expectedEnd });
  });

  it("round-trips its own output", () => {
    expect(parseTimeRange(formatTimeRange({ start, end }))).toEqual({ start, end });
  });

  it.each(["empty", '["2027-01-13 22:00:00+00",)', '["nonsense","2027-01-14 06:00:00+00")'])(
    "rejects %s",
    (text) => {
      expect(() => parseTimeRange(text)).toThrow(TypeError);
    },
  );
});
