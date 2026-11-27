import {
  availabilityRules,
  bookings,
  bookingsInWindow,
  chargers,
  type Executor,
  hosts,
  reviews,
  users,
} from "@nd/db";
import { SLOT_HOLDING_BOOKING_STATUSES } from "@nd/domain";
import { and, avg, count, eq, inArray } from "drizzle-orm";

import type { AvailabilityRule } from "../chargers/slots.ts";

// Reads behind GET /chargers/:id. Integration tests cover them against Postgres.

/** A charger with what its public listing needs from its host. */
export async function findListingCharger(db: Executor, chargerId: string) {
  const [row] = await db
    .select({
      id: chargers.id,
      brand: chargers.brand,
      model: chargers.model,
      connectorType: chargers.connectorType,
      maxKw: chargers.maxKw,
      timezone: chargers.timezone,
      location: chargers.location,
      address: chargers.address,
      status: chargers.status,
      acceptingBookings: chargers.acceptingBookings,
      hostId: hosts.id,
      hostUserId: hosts.userId,
      hostName: users.name,
      hostSince: users.createdAt,
    })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .innerJoin(users, eq(users.id, hosts.userId))
    .where(eq(chargers.id, chargerId))
    .limit(1);
  return row;
}

/** Whether a driver holds the charger with a confirmed, arrived or active booking. */
export async function hasSlotHoldingBooking(
  db: Executor,
  chargerId: string,
  driverId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.chargerId, chargerId),
        eq(bookings.driverId, driverId),
        inArray(bookings.status, [...SLOT_HOLDING_BOOKING_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** A charger's availability windows. */
export function chargerRules(db: Executor, chargerId: string): Promise<AvailabilityRule[]> {
  return db
    .select({
      weekday: availabilityRules.weekday,
      startTime: availabilityRules.startTime,
      endTime: availabilityRules.endTime,
      pricePerHourCents: availabilityRules.pricePerHourCents,
      currency: availabilityRules.currency,
      kwhCap: availabilityRules.kwhCap,
      instantBook: availabilityRules.instantBook,
    })
    .from(availabilityRules)
    .where(eq(availabilityRules.chargerId, chargerId));
}

/** Slots held by bookings on a charger in a window. */
export async function heldSlots(
  db: Executor,
  chargerId: string,
  window: { start: Date; end: Date },
): Promise<{ start: Date; end: Date }[]> {
  const rows = await bookingsInWindow(db, {
    chargerId,
    window,
    statuses: SLOT_HOLDING_BOOKING_STATUSES,
  });
  return rows.map((row) => row.slot);
}

export interface Rating {
  readonly rating: number | null;
  readonly reviewCount: number;
}

const toRating = (row: { rating: string | null; count: number } | undefined): Rating => ({
  rating:
    row === undefined || row.rating === null ? null : Math.round(Number(row.rating) * 10) / 10,
  reviewCount: row?.count ?? 0,
});

/** Drivers' rating of the host for bookings at one charger. */
export async function chargerRating(
  db: Executor,
  chargerId: string,
  hostUserId: string,
): Promise<Rating> {
  const [row] = await db
    .select({ rating: avg(reviews.rating), count: count(reviews.id) })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .where(and(eq(bookings.chargerId, chargerId), eq(reviews.revieweeId, hostUserId)));
  return toRating(row);
}

/** Drivers' rating of the host across all their chargers. */
export async function hostRating(
  db: Executor,
  hostId: string,
  hostUserId: string,
): Promise<Rating> {
  const [row] = await db
    .select({ rating: avg(reviews.rating), count: count(reviews.id) })
    .from(reviews)
    .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .where(and(eq(chargers.hostId, hostId), eq(reviews.revieweeId, hostUserId)));
  return toRating(row);
}
