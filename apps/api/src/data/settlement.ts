import {
  bookings,
  chargers,
  disputes,
  type Executor,
  hosts,
  meterValues,
  payments,
  reviews,
  sessions,
  transfers,
  users,
} from "@nd/db";
import {
  OPEN_SESSION_STATUSES,
  type SessionReviewReason,
  type SessionStatus,
  type TransferHoldReason,
} from "@nd/domain";
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// Reads and writes behind reconciliation, host confirmation, receipts,
// reviews and payout summaries. Integration tests cover them against
// Postgres; unit tests mock this module.

const hostUsers = alias(users, "host_users");

/** Session statuses that keep a host's transfer held (see `transferHoldReason`). */
const UNSETTLED_SESSION_STATUSES = [
  ...OPEN_SESSION_STATUSES,
  "needs_review",
  "needs_host_confirmation",
] as const satisfies readonly SessionStatus[];

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
  readonly confirmationDueAt?: Date;
  readonly hostConfirmedAt?: Date;
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

/**
 * Sessions ready to bill: stopped, or closed without a stop and confirmed by
 * the host or past their confirmation deadline.
 */
export async function sessionsToReconcile(
  db: Executor,
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      or(
        eq(sessions.status, "stopped"),
        and(
          eq(sessions.status, "needs_host_confirmation"),
          or(
            isNotNull(sessions.hostConfirmedAt),
            sql`${sessions.confirmationDueAt} <= ${now.toISOString()}::timestamptz`,
          ),
        ),
      ),
    )
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

/** Captured payments of reconciled sessions that have no transfer row yet. */
export async function capturedWithoutTransfer(db: Executor, limit: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: payments.id })
    .from(payments)
    .innerJoin(sessions, eq(sessions.bookingId, payments.bookingId))
    .leftJoin(transfers, eq(transfers.paymentId, payments.id))
    .where(
      and(
        eq(payments.status, "captured"),
        sql`${payments.capturedCents} > 0`,
        eq(sessions.status, "reconciled"),
        sql`${transfers.id} is null`,
      ),
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Held transfers whose hold reason has cleared: payouts are now enabled, the
 * session is settled, or the dispute is closed. Optionally only one host's.
 * (Saving tax details re-sends transfers held for them; see tax-details.)
 */
export async function releasableHeldTransfers(
  db: Executor,
  options: { hostId?: string; limit: number },
): Promise<{ paymentId: string; hostId: string }[]> {
  const unsettledSession = sql`exists (select 1 from ${sessions} where ${sessions.bookingId} = ${bookings.id} and ${inArray(sessions.status, [...UNSETTLED_SESSION_STATUSES])})`;
  const openDispute = sql`exists (select 1 from ${disputes} where ${disputes.bookingId} = ${bookings.id} and ${inArray(disputes.status, ["open", "under_review"])})`;
  return db
    .select({ paymentId: transfers.paymentId, hostId: hosts.id })
    .from(transfers)
    .innerJoin(payments, eq(payments.id, transfers.paymentId))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(
      and(
        eq(transfers.status, "held"),
        options.hostId === undefined ? undefined : eq(hosts.id, options.hostId),
        or(
          and(
            eq(transfers.holdReason, "payouts_not_enabled"),
            eq(hosts.payoutStatus, "enabled"),
            isNotNull(hosts.stripeAccountId),
          ),
          and(eq(transfers.holdReason, "session_needs_review"), sql`not ${unsettledSession}`),
          and(eq(transfers.holdReason, "dispute_open"), sql`not ${openDispute}`),
        ),
      ),
    )
    .orderBy(asc(transfers.createdAt))
    .limit(options.limit);
}

/** Records a dispute on a booking. */
export async function insertDispute(
  db: Executor,
  values: { bookingId: string; raisedById: string; reason: string; details: string | null },
): Promise<string> {
  const [row] = await db.insert(disputes).values(values).returning({ id: disputes.id });
  if (row === undefined) throw new Error("dispute not inserted");
  return row.id;
}

/** Closes a booking's open disputes as resolved. Resolves to how many. */
export async function resolveOpenDisputes(
  db: Executor,
  bookingId: string,
  resolution: string,
  at: Date,
): Promise<number> {
  const rows = await db
    .update(disputes)
    .set({ status: "resolved", resolution, resolvedAt: at })
    .where(
      and(eq(disputes.bookingId, bookingId), inArray(disputes.status, ["open", "under_review"])),
    )
    .returning({ id: disputes.id });
  return rows.length;
}

/** The session a booking was billed for: its latest one that did not fail to start. */
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

/** Hosts with a session stopped in the window or a transfer still held. */
export async function hostsWithPayoutActivity(
  db: Executor,
  window: { start: Date; end: Date },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: hosts.id })
    .from(hosts)
    .innerJoin(chargers, eq(chargers.hostId, hosts.id))
    .innerJoin(bookings, eq(bookings.chargerId, chargers.id))
    .innerJoin(sessions, eq(sessions.bookingId, bookings.id))
    .leftJoin(payments, eq(payments.bookingId, bookings.id))
    .leftJoin(transfers, eq(transfers.paymentId, payments.id))
    .where(
      or(
        and(
          sql`${sessions.stoppedAt} >= ${window.start.toISOString()}::timestamptz`,
          sql`${sessions.stoppedAt} < ${window.end.toISOString()}::timestamptz`,
        ),
        eq(transfers.status, "held"),
      ),
    );
  return rows.map((row) => row.id);
}

/** One line of a host's payout summary. */
export interface PayoutLine {
  readonly bookingId: string;
  readonly slot: { start: Date; end: Date };
  readonly timezone: string;
  readonly sessionStatus: SessionStatus;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  readonly kwh: number | null;
  readonly capturedCents: number | null;
  readonly currency: "EUR" | "GBP";
  readonly transferStatus: "pending" | "held" | "sent" | "failed" | "reversed" | null;
  readonly transferCents: number | null;
  readonly holdReason: TransferHoldReason | null;
}

/**
 * A host's sessions stopped in the window and every transfer of theirs still
 * held, with the host's name and email.
 */
export async function hostPayoutSummary(
  db: Executor,
  hostId: string,
  window: { start: Date; end: Date },
) {
  const [host] = await db
    .select({ id: hosts.id, name: users.name, email: users.email })
    .from(hosts)
    .innerJoin(users, eq(users.id, hosts.userId))
    .where(eq(hosts.id, hostId))
    .limit(1);
  if (host === undefined) return undefined;
  const lines: PayoutLine[] = await db
    .select({
      bookingId: bookings.id,
      slot: bookings.slot,
      timezone: chargers.timezone,
      sessionStatus: sessions.status,
      startedAt: sessions.startedAt,
      stoppedAt: sessions.stoppedAt,
      kwh: sessions.kwh,
      capturedCents: payments.capturedCents,
      currency: bookings.currency,
      transferStatus: transfers.status,
      transferCents: transfers.amountCents,
      holdReason: transfers.holdReason,
    })
    .from(sessions)
    .innerJoin(bookings, eq(bookings.id, sessions.bookingId))
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .leftJoin(payments, eq(payments.bookingId, bookings.id))
    .leftJoin(transfers, eq(transfers.paymentId, payments.id))
    .where(
      and(
        eq(chargers.hostId, hostId),
        or(
          and(
            sql`${sessions.stoppedAt} >= ${window.start.toISOString()}::timestamptz`,
            sql`${sessions.stoppedAt} < ${window.end.toISOString()}::timestamptz`,
          ),
          eq(transfers.status, "held"),
        ),
      ),
    )
    .orderBy(asc(sql`lower(${bookings.slot})`));
  return { host, lines };
}
