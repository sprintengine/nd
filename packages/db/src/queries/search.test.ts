import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { fakeDb } from "../../test/fake-client.ts";
import {
  type ChargerSearchRow,
  MAX_SEARCH_RADIUS_M,
  searchChargers,
  type SearchChargersInput,
  searchChargersQuery,
  toSearchResult,
} from "./search.ts";

const input: SearchChargersInput = {
  point: { lat: 53.326, lng: -6.256 },
  radiusM: 2_000,
  window: {
    start: new Date("2027-01-13T22:00:00.000Z"),
    end: new Date("2027-01-14T06:00:00.000Z"),
  },
};

const row: ChargerSearchRow = {
  id: "10000000-0000-4000-8000-000000000001",
  brand: "myenergi",
  model: "zappi_v2_1",
  connector_type: "tethered",
  max_kw: "7.40",
  lat: 53.3262,
  lng: -6.2565,
  distance_m: 41.7,
  price_per_hour_cents: 250,
  currency: "EUR",
  kwh_cap: "40.00",
  instant_book: true,
  rating: "4.6666666666666667",
  review_count: "3",
};

const dialect = new PgDialect();

describe("searchChargersQuery", () => {
  it("filters by distance, status, availability and slot-holding bookings", () => {
    const { sql, params } = dialect.sqlToQuery(searchChargersQuery(input));
    expect(sql).toContain("ST_DWithin(c.location");
    expect(sql).toContain("c.status = 'online'");
    expect(sql).toContain("c.accepting_bookings");
    expect(sql).toContain("not exists");
    expect(sql).toContain("b.slot && tstzrange(");
    expect(params).toEqual(
      expect.arrayContaining([
        -6.256,
        53.326,
        2_000,
        "2027-01-13T22:00:00.000Z",
        "2027-01-14T06:00:00.000Z",
        "confirmed",
        "arrived",
        "active",
        100,
      ]),
    );
    expect(params).not.toContain("requested");
    expect(params).not.toContain("cancelled");
  });

  it("never selects the address", () => {
    const { sql } = dialect.sqlToQuery(searchChargersQuery(input));
    expect(sql).not.toMatch(/address/);
  });

  it.each([
    ["a zero radius", { radiusM: 0 }],
    ["a negative radius", { radiusM: -5 }],
    ["a radius over the maximum", { radiusM: MAX_SEARCH_RADIUS_M + 1 }],
    ["a NaN radius", { radiusM: Number.NaN }],
    ["an invalid latitude", { point: { lat: 95, lng: 0 } }],
    ["an invalid longitude", { point: { lat: 0, lng: 200 } }],
    ["an empty window", { window: { start: input.window.start, end: input.window.start } }],
    ["a zero limit", { limit: 0 }],
    ["a fractional limit", { limit: 2.5 }],
    ["a limit over the maximum", { limit: 101 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => searchChargersQuery({ ...input, ...overrides })).toThrow(RangeError);
  });
});

describe("toSearchResult", () => {
  it("approximates the position and converts numerics", () => {
    const result = toSearchResult(row);
    expect(result).toEqual({
      id: row.id,
      brand: "myenergi",
      model: "zappi_v2_1",
      connectorType: "tethered",
      maxKw: 7.4,
      approximateLocation: expect.any(Object) as unknown,
      approximateDistanceM: 100,
      pricePerHourCents: 250,
      currency: "EUR",
      kwhCap: 40,
      instantBook: true,
      rating: 4.7,
      reviewCount: 3,
    });
    expect(result.approximateLocation).not.toEqual({ lat: row.lat, lng: row.lng });
  });

  it("keeps a missing kWh cap and rating as null", () => {
    const result = toSearchResult({ ...row, kwh_cap: null, rating: null, review_count: 0 });
    expect(result.kwhCap).toBeNull();
    expect(result.rating).toBeNull();
    expect(result.reviewCount).toBe(0);
  });
});

describe("searchChargers", () => {
  it("runs the query and maps each row", async () => {
    const { db, queries } = fakeDb(() => [row]);
    const results = await searchChargers(db, input);
    expect(queries).toHaveLength(1);
    expect(results.map((result) => result.id)).toEqual([row.id]);
  });
});
