import { customType } from "drizzle-orm/pg-core";

/** A WGS 84 point. */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** A half-open time range `[start, end)`. */
export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

const WGS84 = 4326;
const EWKB_POINT = 1;
const EWKB_SRID_FLAG = 0x20000000;

/**
 * Parses a PostGIS point in hex (E)WKB, the text form Postgres returns for a
 * `geography(Point, 4326)` column.
 */
export function parseEwkbPoint(hex: string): LatLng {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 21) {
    throw new TypeError(`Not a WKB point: ${hex}`);
  }
  const littleEndian = bytes.readUInt8(0) === 1;
  const type = littleEndian ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
  if ((type & 0xff) !== EWKB_POINT) {
    throw new TypeError(`Expected a point geometry, got WKB type ${String(type)}`);
  }
  const offset = type & EWKB_SRID_FLAG ? 9 : 5;
  if (bytes.length < offset + 16) {
    throw new TypeError(`Not a WKB point: ${hex}`);
  }
  const x = littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
  const y = littleEndian ? bytes.readDoubleLE(offset + 8) : bytes.readDoubleBE(offset + 8);
  return { lat: y, lng: x };
}

/** Writes a point as EWKT, which Postgres casts to geography on insert. */
export function toEwktPoint({ lat, lng }: LatLng): string {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`lat must be between -90 and 90, got ${String(lat)}`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError(`lng must be between -180 and 180, got ${String(lng)}`);
  }
  return `SRID=${String(WGS84)};POINT(${String(lng)} ${String(lat)})`;
}

/** `geography(Point, 4326)`, read and written as `{ lat, lng }`. */
export const geographyPoint = customType<{ data: LatLng; driverData: string }>({
  dataType: () => `geography(Point,${String(WGS84)})`,
  toDriver: toEwktPoint,
  fromDriver: parseEwkbPoint,
});

/** Writes a half-open range in Postgres range literal syntax. */
export function formatTimeRange({ start, end }: TimeRange): string {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RangeError("Time range bounds must be valid dates");
  }
  if (end.getTime() <= start.getTime()) {
    throw new RangeError(
      `Time range must end after it starts: ${start.toISOString()} to ${end.toISOString()}`,
    );
  }
  return `[${start.toISOString()},${end.toISOString()})`;
}

function parseTimestamp(text: string): Date {
  // Postgres writes `2026-11-26 22:00:00+00`; Date wants `T` and `+00:00`.
  const iso = text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Not a timestamp: ${text}`);
  }
  return date;
}

/** Parses a bounded `tstzrange` literal. Bounds are read as `[start, end)`. */
export function parseTimeRange(text: string): TimeRange {
  const match = /^[[(]"?([^",]+)"?,"?([^",]+)"?[\])]$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError(`Not a bounded time range: ${text}`);
  }
  return { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]) };
}

/** `tstzrange`, read and written as `{ start, end }` (half-open). */
export const timeRange = customType<{ data: TimeRange; driverData: string }>({
  dataType: () => "tstzrange",
  toDriver: formatTimeRange,
  fromDriver: parseTimeRange,
});
