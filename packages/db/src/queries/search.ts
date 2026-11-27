import { type ConnectorType, type Currency, SLOT_HOLDING_BOOKING_STATUSES } from "@nd/domain";
import { type SQL, sql } from "drizzle-orm";

import type { Executor } from "../client.ts";
import { formatTimeRange, type LatLng, type TimeRange } from "../schema/columns.ts";
import { approximateDistanceM, approximateLocation } from "./location.ts";

/** Largest search radius accepted, in metres. */
export const MAX_SEARCH_RADIUS_M = 50_000;

/** Most results one search returns. */
export const MAX_SEARCH_RESULTS = 100;

export interface SearchChargersInput {
  /** Centre of the search. */
  readonly point: LatLng;
  /** Radius around `point`, in metres. */
  readonly radiusM: number;
  /** The slot the driver wants, half-open. */
  readonly window: TimeRange;
  /** At most this many results (default and maximum: 100). */
  readonly limit?: number;
}

/**
 * A bookable charger as search shows it to drivers. The location is snapped
 * to a grid of about 150 m and the distance rounded to 100 m; the exact
 * position and the address are never part of a search result.
 */
export interface ChargerSearchResult {
  readonly id: string;
  readonly brand: string;
  readonly model: string;
  readonly connectorType: ConnectorType;
  readonly maxKw: number;
  readonly approximateLocation: LatLng;
  readonly approximateDistanceM: number;
  readonly pricePerHourCents: number;
  readonly currency: Currency;
  readonly kwhCap: number | null;
  readonly instantBook: boolean;
  /** Mean rating of the host from drivers' reviews, or null with none yet. */
  readonly rating: number | null;
  readonly reviewCount: number;
}

/** A row as the search SQL returns it (numerics arrive as strings). */
export interface ChargerSearchRow extends Record<string, unknown> {
  id: string;
  brand: string;
  model: string;
  connector_type: ConnectorType;
  max_kw: string;
  lat: number;
  lng: number;
  distance_m: number;
  price_per_hour_cents: number;
  currency: Currency;
  kwh_cap: string | null;
  instant_book: boolean;
  rating: string | null;
  review_count: number | string;
}

function validateInput({ point, radiusM, window, limit }: SearchChargersInput): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > MAX_SEARCH_RADIUS_M) {
    throw new RangeError(
      `radiusM must be between 0 and ${String(MAX_SEARCH_RADIUS_M)}, got ${String(radiusM)}`,
    );
  }
  if (!Number.isFinite(point.lat) || Math.abs(point.lat) > 90) {
    throw new RangeError(`point.lat must be between -90 and 90, got ${String(point.lat)}`);
  }
  if (!Number.isFinite(point.lng) || Math.abs(point.lng) > 180) {
    throw new RangeError(`point.lng must be between -180 and 180, got ${String(point.lng)}`);
  }
  // Throws for an empty or invalid window.
  formatTimeRange(window);
  const resolved = limit ?? MAX_SEARCH_RESULTS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_SEARCH_RESULTS) {
    throw new RangeError(
      `limit must be an integer from 1 to ${String(MAX_SEARCH_RESULTS)}, got ${String(resolved)}`,
    );
  }
  return resolved;
}

/**
 * Builds the search query. A charger matches when it is online and accepting
 * bookings, lies within `radiusM` of `point`, has one availability rule that
 * covers the whole window in the charger's local time (a rule may run past
 * midnight, so the previous day's rule is considered too), and has no
 * slot-holding booking overlapping the window. Results are ordered by
 * distance, then rating.
 */
export function searchChargersQuery(input: SearchChargersInput): SQL {
  const limit = validateInput(input);
  const { point, radiusM, window } = input;
  const centre = sql`ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography`;
  const from = sql`${window.start.toISOString()}::timestamptz`;
  const to = sql`${window.end.toISOString()}::timestamptz`;
  const holding = sql.join(
    SLOT_HOLDING_BOOKING_STATUSES.map((status) => sql`${status}::booking_status`),
    sql`, `,
  );

  return sql`
    select
      c.id,
      c.brand,
      c.model,
      c.connector_type,
      c.max_kw,
      ST_Y(c.location::geometry) as lat,
      ST_X(c.location::geometry) as lng,
      ST_Distance(c.location, ${centre}) as distance_m,
      rule.price_per_hour_cents,
      rule.currency,
      rule.kwh_cap,
      rule.instant_book,
      rating.rating,
      rating.review_count
    from chargers c
    join hosts h on h.id = c.host_id
    cross join lateral (
      select ar.price_per_hour_cents, ar.currency, ar.kwh_cap, ar.instant_book
      from availability_rules ar
      cross join lateral (
        values
          ((${from} at time zone c.timezone)::date),
          ((${from} at time zone c.timezone)::date - 1)
      ) as day (d)
      where ar.charger_id = c.id
        and extract(isodow from day.d) = ar.weekday
        and day.d + ar.start_time <= (${from} at time zone c.timezone)
        and (${to} at time zone c.timezone) <= day.d + ar.end_time
          + case when ar.end_time <= ar.start_time then interval '1 day' else interval '0' end
      order by ar.price_per_hour_cents, ar.id
      limit 1
    ) rule
    cross join lateral (
      select avg(r.rating) as rating, count(r.id) as review_count
      from reviews r
      join bookings rb on rb.id = r.booking_id
      where rb.charger_id = c.id and r.reviewee_id = h.user_id
    ) rating
    where c.status = 'online'
      and c.accepting_bookings
      and ST_DWithin(c.location, ${centre}, ${radiusM}::float8)
      and not exists (
        select 1 from bookings b
        where b.charger_id = c.id
          and b.status in (${holding})
          and b.slot && tstzrange(${from}, ${to}, '[)')
      )
    order by distance_m, rating.rating desc nulls last, c.id
    limit ${limit}
  `;
}

/** Turns a search row into a public result, discarding the exact position. */
export function toSearchResult(row: ChargerSearchRow): ChargerSearchResult {
  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    connectorType: row.connector_type,
    maxKw: Number(row.max_kw),
    approximateLocation: approximateLocation({ lat: row.lat, lng: row.lng }),
    approximateDistanceM: approximateDistanceM(row.distance_m),
    pricePerHourCents: row.price_per_hour_cents,
    currency: row.currency,
    kwhCap: row.kwh_cap === null ? null : Number(row.kwh_cap),
    instantBook: row.instant_book,
    rating: row.rating === null ? null : Math.round(Number(row.rating) * 10) / 10,
    reviewCount: Number(row.review_count),
  };
}

/** Bookable chargers near a point for a window. See `searchChargersQuery`. */
export async function searchChargers(
  db: Executor,
  input: SearchChargersInput,
): Promise<ChargerSearchResult[]> {
  const result = await db.execute<ChargerSearchRow>(searchChargersQuery(input));
  return result.rows.map(toSearchResult);
}
