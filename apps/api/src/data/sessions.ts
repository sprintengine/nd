import {
  bookings,
  chargers,
  type Executor,
  hosts,
  meterValues,
  ocppMessages,
  payments,
  sessions,
} from "@nd/db";
import { OPEN_SESSION_STATUSES, type SessionStatus } from "@nd/domain";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

// Reads and writes behind arrival, remote start and stop, the session jobs
// and the realtime feed. Integration tests cover them against Postgres; unit
// tests mock this module.

/**
 * A booking with what session control needs: its charger, the host's user,
 * whether it is paid, the latest session and that session's latest meter
 * readings.
 */
export async function findSessionContext(db: Executor, bookingId: string) {
  const [row] = await db
    .select({
      booking: bookings,
      charger: {
        id: chargers.id,
        chargeboxId: chargers.chargeboxId,
        location: chargers.location,
      },
      hostUserId: hosts.userId,
      paymentStatus: payments.status,
    })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .leftJoin(payments, eq(payments.bookingId, bookings.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (row === undefined) return undefined;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.bookingId, bookingId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  let meter: { ts: Date; energyWh: number | null; powerW: number | null } | undefined;
  if (session !== undefined) {
    const [latest] = await db
      .select({
        ts: meterValues.ts,
        energyWh: sql<number | null>`(
          select ${meterValues.energyWh} from ${meterValues}
          where ${meterValues.sessionId} = ${session.id} and ${meterValues.energyWh} is not null
          order by ${meterValues.ts} desc limit 1
        )`.mapWith(Number),
        powerW: meterValues.powerW,
      })
      .from(meterValues)
      .where(eq(meterValues.sessionId, session.id))
      .orderBy(desc(meterValues.ts))
      .limit(1);
    meter = latest;
  }
  return { ...row, session: session ?? null, meter: meter ?? null };
}

export type SessionContext = NonNullable<Awaited<ReturnType<typeof findSessionContext>>>;

/**
 * Moves a confirmed booking to arrived, recording when and how far from the
 * charger. Resolves to whether it changed.
 */
export async function recordArrival(
  db: Executor,
  bookingId: string,
  arrival: { arrivedAt: Date; distanceM: number | null },
): Promise<boolean> {
  const rows = await db
    .update(bookings)
    .set({ status: "arrived", arrivedAt: arrival.arrivedAt, arrivalDistanceM: arrival.distanceM })
    .where(and(eq(bookings.id, bookingId), eq(bookings.status, "confirmed")))
    .returning({ id: bookings.id });
  return rows.length > 0;
}

/**
 * Records a scheduled start on an arrived booking: when the remote start will
 * be sent and when the driver plugged in. `null` clears a scheduled start.
 */
export async function setScheduledStart(
  db: Executor,
  bookingId: string,
  schedule: { scheduledStartAt: Date; pluggedInAt: Date } | null,
): Promise<boolean> {
  const rows = await db
    .update(bookings)
    .set(schedule ?? { scheduledStartAt: null })
    .where(and(eq(bookings.id, bookingId), eq(bookings.status, "arrived")))
    .returning({ id: bookings.id });
  return rows.length > 0;
}

/**
 * Creates a `starting` session for a booking unless one is already open.
 * The booking row is locked, so two racing starts make one session.
 */
export function insertStartingSession(
  db: Executor,
  bookingId: string,
): Promise<{ sessionId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update");
    const [open] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.bookingId, bookingId), inArray(sessions.status, OPEN_SESSION_STATUSES)),
      )
      .limit(1);
    if (open !== undefined) return { sessionId: open.id, created: false };
    const [inserted] = await tx
      .insert(sessions)
      .values({ bookingId, status: "starting" })
      .returning({ id: sessions.id });
    if (inserted === undefined) throw new Error("session not inserted");
    return { sessionId: inserted.id, created: true };
  });
}

/** Changes a session only while it is in one of `from`. Resolves to whether it changed. */
export async function updateSessionFrom(
  db: Executor,
  sessionId: string,
  from: readonly SessionStatus[],
  change: { status: SessionStatus; stopReason?: string | null },
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set(change)
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, [...from])))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Connector statuses that mean a transaction is running on the charger. */
const TRANSACTION_STATUSES = ["Charging", "SuspendedEV", "SuspendedEVSE"];

/**
 * Whether the charger has a transaction open other than `exceptSessionId`'s:
 * its latest StatusNotification for the connector says so, or a session on
 * it still has an OCPP transaction running.
 */
export async function chargerHasOpenTransaction(
  db: Executor,
  chargerId: string,
  exceptSessionId: string,
): Promise<boolean> {
  const [status] = await db
    .select({ status: sql<string | null>`${ocppMessages.payload} ->> 'status'` })
    .from(ocppMessages)
    .where(
      and(
        eq(ocppMessages.chargerId, chargerId),
        eq(ocppMessages.direction, "in"),
        eq(ocppMessages.messageType, "call"),
        eq(ocppMessages.action, "StatusNotification"),
        sql`(${ocppMessages.payload} ->> 'connectorId')::int > 0`,
      ),
    )
    .orderBy(desc(ocppMessages.ts))
    .limit(1);
  const connector = status?.status ?? null;
  if (connector !== null && TRANSACTION_STATUSES.includes(connector)) return true;
  const [open] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(bookings, eq(bookings.id, sessions.bookingId))
    .where(
      and(
        eq(bookings.chargerId, chargerId),
        ne(sessions.id, exceptSessionId),
        isNotNull(sessions.ocppTransactionId),
        inArray(sessions.status, OPEN_SESSION_STATUSES),
      ),
    )
    .limit(1);
  return open !== undefined;
}

/** Who may see a booking's updates (its driver and the host), and its status. */
export async function bookingAudience(db: Executor, bookingId: string) {
  const [row] = await db
    .select({ driverId: bookings.driverId, hostUserId: hosts.userId, status: bookings.status })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return row;
}

/** The booking a session belongs to. */
export async function bookingOfSession(
  db: Executor,
  sessionId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ bookingId: sessions.bookingId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.bookingId;
}

/** A charger's state and its host's user, for `charger:status`. */
export async function chargerAudience(db: Executor, chargerId: string) {
  const [row] = await db
    .select({ hostUserId: hosts.userId, status: chargers.status })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(chargers.id, chargerId))
    .limit(1);
  return row;
}
