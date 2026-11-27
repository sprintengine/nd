import {
  bookings,
  chargers,
  type Executor,
  hosts,
  meterValues,
  payments,
  reviews,
  sessions,
  users,
} from "@nd/db";
import type { SessionReviewReason, SessionStatus } from "@nd/domain";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// Reads and writes behind closing sessions, receipts and reviews.
// Integration tests cover them against Postgres; unit tests mock this module.

const hostUsers = alias(users, "host_users");

/** A session with its booking, charger, both parties, payment and last meter value. */
export async function findSettlementSession(db: Executor, sessionId: string) {
  const [row] = await db
    .select({
      session: sessions,
      booking: {
        id: bookings.id,
        status: bookings.status,
        slot: bookings.slot,
        driverId: bookings.driverId,
        quotedAmountCents: bookings.quotedAmountCents,
        pricePerHourCents: bookings.pricePerHourCents,
        currency: bookings.currency,
        pluggedInAt: bookings.pluggedInAt,
      },
      charger: { id: chargers.id, timezone: chargers.timezone },
      host: { id: hosts.id, userId: hosts.userId, name: hostUsers.name, email: hostUsers.email },
      driver: { name: users.name, email: users.email },
      payment: payments,
    })
    .from(sessions)
    .innerJoin(bookings, eq(bookings.id, sessions.bookingId))
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .innerJoin(hostUsers, eq(hostUsers.id, hosts.userId))
    .innerJoin(users, eq(users.id, bookings.driverId))
    .leftJoin(payments, eq(payments.bookingId, bookings.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (row === undefined) return undefined;
  return { ...row, lastMeterValue: (await lastMeterValue(db, sessionId)) ?? null };
}

export type SettlementSession = NonNullable<Awaited<ReturnType<typeof findSettlementSession>>>;

/** The latest meter sample of a session that carried an energy reading. */
export async function lastMeterValue(db: Executor, sessionId: string) {
  const [row] = await db
    .select({ ts: meterValues.ts, energyWh: meterValues.energyWh })
    .from(meterValues)
    .where(and(eq(meterValues.sessionId, sessionId), isNotNull(meterValues.energyWh)))
    .orderBy(desc(meterValues.ts), desc(meterValues.id))
    .limit(1);
  return row === undefined || row.energyWh === null
    ? undefined
    : { ...row, energyWh: row.energyWh };
}

export interface SessionChange {
  readonly status?: SessionStatus;
  readonly reviewReason?: SessionReviewReason | null;
  readonly meterStopWh?: number;
  readonly kwh?: number;
  readonly stoppedAt?: Date;
  readonly stopReason?: string;
  readonly reconciledAt?: Date;
}

/** Changes a session only while it is in one of `from`. Resolves to whether it changed. */
export async function updateSessionFrom(
  db: Executor,
  sessionId: string,
  from: readonly SessionStatus[],
  change: SessionChange,
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set(change)
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, [...from])))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Stopped sessions whose meter has not been checked yet, oldest stop first. */
export async function sessionsToReconcile(db: Executor, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.status, "stopped"))
    .orderBy(asc(sessions.stoppedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Sessions still charging (no StopTransaction) whose slot ended before `cutoff`. */
export async function staleOpenSessions(
  db: Executor,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(bookings, eq(bookings.id, sessions.bookingId))
    .where(
      and(
        inArray(sessions.status, ["charging", "suspended_ev", "suspended_evse"]),
        sql`upper(${bookings.slot}) <= ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Bookings still `arrived` whose slot ended before `cutoff` without a session
 * that started (a failed start does not count).
 */
export async function arrivedWithoutSession(
  db: Executor,
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "arrived"),
        sql`upper(${bookings.slot}) <= ${cutoff.toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${sessions} where ${sessions.bookingId} = ${bookings.id} and ${sessions.status} <> 'failed')`,
      ),
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Whether a start was ever attempted for the booking (any session, failed ones included). */
export async function hasAnySession(db: Executor, bookingId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.bookingId, bookingId))
    .limit(1);
  return rows.length > 0;
}

/** The session a booking charged in: its latest one that did not fail to start. */
export async function billedSessionOf(db: Executor, bookingId: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.bookingId, bookingId), ne(sessions.status, "failed")))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return row;
}

export type Session = typeof sessions.$inferSelect;

/** The review a user left on a booking, if any. */
export async function findReview(db: Executor, bookingId: string, reviewerId: string) {
  const [row] = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      comment: reviews.comment,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(eq(reviews.bookingId, bookingId), eq(reviews.reviewerId, reviewerId)))
    .limit(1);
  return row;
}

/** Saves a review unless the reviewer already left one on the booking; resolves to whether it did. */
export async function insertReview(
  db: Executor,
  values: {
    bookingId: string;
    reviewerId: string;
    revieweeId: string;
    rating: number;
    comment: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .insert(reviews)
    .values(values)
    .onConflictDoNothing({ target: [reviews.bookingId, reviews.reviewerId] })
    .returning({ id: reviews.id });
  return rows.length > 0;
}

/** A session's meter samples, oldest first, at most `limit`: evidence of what the charger did. */
export async function meterSamples(db: Executor, sessionId: string, limit: number) {
  return db
    .select({ ts: meterValues.ts, energyWh: meterValues.energyWh, powerW: meterValues.powerW })
    .from(meterValues)
    .where(eq(meterValues.sessionId, sessionId))
    .orderBy(asc(meterValues.ts), asc(meterValues.id))
    .limit(limit);
}
