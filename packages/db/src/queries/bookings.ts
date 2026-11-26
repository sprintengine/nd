import { type BookingStatus, OPEN_SESSION_STATUSES } from "@nd/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.ts";
import { formatTimeRange, type TimeRange } from "../schema/columns.ts";
import { bookings, sessions } from "../schema/tables.ts";

export type Booking = typeof bookings.$inferSelect;
export type Session = typeof sessions.$inferSelect;

export interface BookingsInWindowInput {
  readonly chargerId: string;
  /** Bookings whose slot overlaps this half-open window are returned. */
  readonly window: TimeRange;
  /** Only bookings in these statuses; every status when omitted. */
  readonly statuses?: readonly BookingStatus[];
}

/** A charger's bookings that overlap a window, earliest first. */
export async function bookingsInWindow(
  db: Executor,
  { chargerId, window, statuses }: BookingsInWindowInput,
): Promise<Booking[]> {
  if (statuses?.length === 0) {
    return [];
  }
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.chargerId, chargerId),
        sql`${bookings.slot} && ${formatTimeRange(window)}::tstzrange`,
        statuses === undefined ? undefined : inArray(bookings.status, [...statuses]),
      ),
    )
    .orderBy(asc(sql`lower(${bookings.slot})`));
}

export interface OpenTransaction {
  readonly session: Session;
  readonly booking: Booking;
}

/**
 * The session on a charger whose OCPP transaction has not stopped, with its
 * booking. A charger has one connector, so there is at most one; if stale rows
 * ever disagree, the newest wins.
 */
export async function openTransactionForCharger(
  db: Executor,
  chargerId: string,
): Promise<OpenTransaction | undefined> {
  const [row] = await db
    .select({ session: sessions, booking: bookings })
    .from(sessions)
    .innerJoin(bookings, eq(sessions.bookingId, bookings.id))
    .where(and(eq(bookings.chargerId, chargerId), inArray(sessions.status, OPEN_SESSION_STATUSES)))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return row;
}
