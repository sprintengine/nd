import { createHash, randomBytes } from "node:crypto";

import {
  accountDeletions,
  authAccounts,
  authSessions,
  authVerifications,
  bookings,
  chargers,
  type Db,
  deviceTokens,
  type Executor,
  hosts,
  hostTaxDetails,
  payments,
  reviews,
  users,
} from "@nd/db";
import { TERMINAL_BOOKING_STATUSES } from "@nd/domain";
import { and, asc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";

// Account deletion (GDPR erasure). A request takes effect after an undo
// window: the user is signed out everywhere at once, and `processDueDeletions`
// anonymises the account once the window has passed. Bookings, sessions,
// payments and transfers are kept for accounting; they keep pointing at the
// user's row, which becomes a tombstone with no personal data in it.

/** How long the user has to change their mind. */
export const DELETION_UNDO_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Why an account cannot be deleted yet. */
export interface DeletionBlocker {
  readonly code: "open-booking" | "host-open-booking" | "unpaid-balance";
  readonly message: string;
}

/** A deletion request that is neither cancelled nor completed. */
const pending = and(isNull(accountDeletions.cancelledAt), isNull(accountDeletions.completedAt));

/** SHA-256 of an undo token; only the hash is stored. */
export const hashUndoToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new random undo token (256 bits, base64url). */
export const newUndoToken = () => randomBytes(32).toString("base64url");

const finishedStatuses = [...TERMINAL_BOOKING_STATUSES];

/**
 * What stops the user's account being deleted now: bookings that are not
 * finished, as the driver or on the user's chargers, and payments still owed
 * on finished bookings.
 */
export async function deletionBlockers(db: Executor, userId: string): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = [];
  const [asDriver] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.driverId, userId), notInArray(bookings.status, finishedStatuses)))
    .limit(1);
  if (asDriver !== undefined) {
    blockers.push({
      code: "open-booking",
      message: "You have a booking that is not finished. Cancel it or wait until it ends.",
    });
  }
  const [asHost] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(and(eq(hosts.userId, userId), notInArray(bookings.status, finishedStatuses)))
    .limit(1);
  if (asHost !== undefined) {
    blockers.push({
      code: "host-open-booking",
      message: "A driver has a booking on your charger that is not finished.",
    });
  }
  const [unpaid] = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(
      and(
        eq(bookings.driverId, userId),
        inArray(payments.status, ["pending_authorisation", "card_saved", "authorised", "failed"]),
        or(
          inArray(bookings.status, ["completed", "no_show"]),
          and(eq(bookings.status, "cancelled"), gt(bookings.cancellationFeeCents, 0)),
        ),
      ),
    )
    .limit(1);
  if (unpaid !== undefined) {
    blockers.push({
      code: "unpaid-balance",
      message: "A payment for a past booking has not been settled yet.",
    });
  }
  return blockers;
}

/** Whether the user has asked for deletion and not undone it. */
export async function hasPendingDeletion(db: Executor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accountDeletions.id })
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, userId), pending))
    .limit(1);
  return row !== undefined;
}

export type DeletionRequest =
  | { readonly status: "scheduled"; readonly id: string; readonly dueAt: Date }
  | { readonly status: "blocked"; readonly blockers: readonly DeletionBlocker[] };

/**
 * Schedules the account for deletion `DELETION_UNDO_DAYS` from `now`, unless
 * something blocks it, and takes the user's chargers off the listings so no
 * new booking arrives in the meantime. Does not sign the user out: the
 * caller does that once the confirmation email has gone.
 */
export function requestDeletion(
  db: Db,
  input: { userId: string; now: Date; undoTokenHash: string },
): Promise<DeletionRequest> {
  return db.transaction(async (tx) => {
    // Serialises concurrent requests for one user.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
    const existing = await tx
      .select({ id: accountDeletions.id, dueAt: accountDeletions.dueAt })
      .from(accountDeletions)
      .where(and(eq(accountDeletions.userId, input.userId), pending))
      .limit(1);
    const [already] = existing;
    if (already !== undefined) return { status: "scheduled", ...already };

    const blockers = await deletionBlockers(tx, input.userId);
    if (blockers.length > 0) return { status: "blocked", blockers };

    const paused = await tx
      .update(chargers)
      .set({ acceptingBookings: false })
      .where(
        and(
          eq(chargers.acceptingBookings, true),
          inArray(
            chargers.hostId,
            tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, input.userId)),
          ),
        ),
      )
      .returning({ id: chargers.id });
    const dueAt = new Date(input.now.getTime() + DELETION_UNDO_DAYS * DAY_MS);
    const [row] = await tx
      .insert(accountDeletions)
      .values({
        userId: input.userId,
        requestedAt: input.now,
        dueAt,
        undoTokenHash: input.undoTokenHash,
        pausedChargerIds: paused.map((charger) => charger.id),
      })
      .returning({ id: accountDeletions.id });
    if (row === undefined) throw new Error("deletion request not stored");
    return { status: "scheduled", id: row.id, dueAt };
  });
}

/**
 * Undoes a pending deletion before it falls due, and puts the chargers it
 * unlisted back on the listings. Returns false when the token matches no
 * pending request or the request has fallen due.
 */
export function cancelDeletion(
  db: Db,
  where: { undoTokenHash: string } | { id: string },
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: accountDeletions.id,
        userId: accountDeletions.userId,
        dueAt: accountDeletions.dueAt,
        pausedChargerIds: accountDeletions.pausedChargerIds,
      })
      .from(accountDeletions)
      .where(
        and(
          "id" in where
            ? eq(accountDeletions.id, where.id)
            : eq(accountDeletions.undoTokenHash, where.undoTokenHash),
          pending,
        ),
      )
      .for("update");
    if (row === undefined || row.dueAt.getTime() <= now.getTime()) return false;
    await tx
      .update(accountDeletions)
      .set({ cancelledAt: now })
      .where(eq(accountDeletions.id, row.id));
    if (row.pausedChargerIds.length > 0) {
      await tx
        .update(chargers)
        .set({ acceptingBookings: true })
        .where(
          and(
            inArray(chargers.id, row.pausedChargerIds),
            inArray(
              chargers.hostId,
              tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, row.userId)),
            ),
          ),
        );
    }
    return true;
  });
}

/** Signs the user out on every device. */
export async function revokeSessions(db: Executor, userId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

/** Charger positions are coarsened to this grid (degrees, about 11 km) on deletion. */
const COARSE_GRID_DEGREES = 0.1;

/**
 * Removes the personal data of one user, keeping their row as a tombstone
 * so bookings, payments, transfers, reviews and disputes still add up.
 */
async function anonymise(tx: Executor, userId: string, now: Date): Promise<void> {
  const [user] = await tx
    .select({ email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId));
  if (user === undefined) return;

  await tx
    .update(users)
    .set({
      name: "Deleted user",
      email: `deleted-${userId}@deleted.invalid`,
      emailVerified: false,
      image: null,
      phone: null,
      phoneVerified: false,
      stripeCustomerId: null,
      deletedAt: now,
    })
    .where(eq(users.id, userId));
  await revokeSessions(tx, userId);
  await tx.delete(authAccounts).where(eq(authAccounts.userId, userId));
  await tx.delete(deviceTokens).where(eq(deviceTokens.userId, userId));
  // Phone codes are keyed by the number; magic-link tokens hold the address.
  const identifiers = user.phone === null ? [user.email] : [user.email, user.phone];
  await tx
    .delete(authVerifications)
    .where(
      or(
        inArray(authVerifications.identifier, identifiers),
        sql`strpos(${authVerifications.value}, ${user.email}) > 0`,
      ),
    );

  await tx.update(bookings).set({ vehiclePlate: null }).where(eq(bookings.driverId, userId));
  await tx.update(reviews).set({ comment: null }).where(eq(reviews.reviewerId, userId));

  const [host] = await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, userId));
  if (host !== undefined) {
    await tx.delete(hostTaxDetails).where(eq(hostTaxDetails.hostId, host.id));
    await tx
      .update(hosts)
      .set({ taxDetailsComplete: false, nightRateStart: null, nightRateEnd: null })
      .where(eq(hosts.id, host.id));
    // The charger rows stay (sessions and the OCPP log point at them), but
    // they can no longer connect or be booked, and no longer say where the
    // host lives.
    await tx.execute(sql`
      update ${chargers}
         set accepting_bookings = false,
             ocpp_auth_hash = null,
             host_id_tag = null,
             address = '',
             location = ST_SnapToGrid(location::geometry, ${COARSE_GRID_DEGREES})::geography,
             updated_at = ${now}
       where host_id = ${host.id}`);
  }
}

export interface DeletionRun {
  /** Deletion requests carried out. */
  readonly completed: number;
  /** Requests that fell due but are blocked; they stay pending and are retried next run. */
  readonly skipped: readonly { userId: string; blockers: readonly DeletionBlocker[] }[];
}

/**
 * Scheduled step: anonymises every account whose deletion fell due at or
 * before `now`. Each account is handled in its own transaction; a request
 * that something now blocks (for example a payment still owed) is left
 * pending and retried on the next run. Safe to run concurrently and
 * repeatedly. The `account-deletions` job runs it daily.
 */
export async function processDueDeletions(db: Executor, now: Date): Promise<DeletionRun> {
  const due = await db
    .select({ id: accountDeletions.id })
    .from(accountDeletions)
    .where(and(pending, lte(accountDeletions.dueAt, now)))
    .orderBy(asc(accountDeletions.dueAt));
  let completed = 0;
  const skipped: { userId: string; blockers: readonly DeletionBlocker[] }[] = [];
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [request] = await tx
        .select({ userId: accountDeletions.userId })
        .from(accountDeletions)
        .where(and(eq(accountDeletions.id, id), pending))
        .for("update", { skipLocked: true });
      if (request === undefined) return;
      const blockers = await deletionBlockers(tx, request.userId);
      if (blockers.length > 0) {
        skipped.push({ userId: request.userId, blockers });
        return;
      }
      await anonymise(tx, request.userId, now);
      await tx
        .update(accountDeletions)
        .set({ completedAt: now })
        .where(eq(accountDeletions.id, id));
      completed += 1;
    });
  }
  return { completed, skipped };
}
