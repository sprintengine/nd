import { bookings, type Executor, payments, refunds } from "@nd/db";
import type { BookingStatus, RefundReason, RefundStatus } from "@nd/domain";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { type BookingChange, updateBookingFrom } from "./bookings.ts";

// Reads and writes behind refunds and resuming payments that stopped half
// way. Integration tests cover them against Postgres; unit tests mock this
// module.

export type Refund = typeof refunds.$inferSelect;

/** Refunds that count against what was paid: every one that has not failed. */
const LIVE_REFUND = ne(refunds.status, "failed");

/**
 * Records a refund to send, unless it would take more than was paid. The
 * payment row is locked, so two refunds cannot both pass the check.
 * `"remainder"` refunds whatever is left (after earlier refunds, pending ones
 * included), and records nothing when nothing is. An automatic reason is
 * recorded at most once per payment, and a support refund once per
 * `operationId`: asking again returns the refund already recorded. Resolves
 * to undefined when the amount is more than is left.
 */
export function insertRefund(
  db: Executor,
  input: {
    readonly paymentId: string;
    readonly amountCents: number | "remainder";
    readonly reason: RefundReason;
    readonly issuedById?: string;
    readonly note?: string;
    /** The caller's id for this refund; a retry with the same id returns it. */
    readonly operationId?: string;
  },
): Promise<Refund | undefined> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select({ amountCents: payments.amountCents, currency: payments.currency })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .for("update");
    if (payment === undefined) throw new Error(`no payment ${input.paymentId}`);
    const same =
      input.operationId !== undefined
        ? eq(refunds.operationId, input.operationId)
        : input.reason !== "support"
          ? eq(refunds.reason, input.reason)
          : undefined;
    if (same !== undefined) {
      const [existing] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.paymentId, input.paymentId), same))
        .limit(1);
      if (existing !== undefined) return existing;
    }
    const left = payment.amountCents - (await refundedCents(tx, input.paymentId));
    const amountCents = input.amountCents === "remainder" ? left : input.amountCents;
    if (amountCents <= 0 || amountCents > left) return undefined;
    const [row] = await tx
      .insert(refunds)
      .values({
        paymentId: input.paymentId,
        amountCents,
        currency: payment.currency,
        reason: input.reason,
        issuedById: input.issuedById ?? null,
        note: input.note ?? null,
        operationId: input.operationId ?? null,
      })
      .returning();
    if (row === undefined) throw new Error("refund not inserted");
    return row;
  });
}

/**
 * Changes a booking still in one of `from` and, in the same transaction,
 * records the refund the change owes, so a crash cannot lose it. Resolves to
 * whether the booking changed, and the refund recorded (if one was asked for
 * and there was something left to refund).
 */
export function updateBookingWithRefund(
  db: Executor,
  bookingId: string,
  from: readonly BookingStatus[],
  change: BookingChange,
  refund:
    { paymentId: string; amountCents: number | "remainder"; reason: RefundReason } | undefined,
): Promise<{ changed: boolean; refund: Refund | undefined }> {
  return db.transaction(async (tx) => {
    if (!(await updateBookingFrom(tx, bookingId, from, change))) {
      return { changed: false, refund: undefined };
    }
    return {
      changed: true,
      refund: refund === undefined ? undefined : await insertRefund(tx, refund),
    };
  });
}

/** Cents refunded, or being refunded, of a payment. */
export async function refundedCents(db: Executor, paymentId: string): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), LIVE_REFUND));
  return row?.cents ?? 0;
}

/** A payment's refunds, oldest first. */
export function refundsOf(db: Executor, paymentId: string): Promise<Refund[]> {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, paymentId))
    .orderBy(asc(refunds.createdAt));
}

/** Records what Stripe said about a refund still pending. Resolves to whether it changed. */
export async function updatePendingRefund(
  db: Executor,
  refundId: string,
  change: {
    readonly status: RefundStatus;
    readonly stripeRefundId?: string;
    readonly failureReason?: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .update(refunds)
    .set(change)
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
    .returning({ id: refunds.id });
  return rows.length > 0;
}

/**
 * Records Stripe's status of a refund, found by its Stripe id or, before that
 * id is saved, by our refund id (its metadata). Only a pending refund
 * changes; staying pending still touches it, so the sweep looks again later.
 * Resolves to the refund it matched, if any.
 */
export async function recordStripeRefund(
  db: Executor,
  refund: {
    readonly stripeRefundId: string;
    readonly refundId: string | undefined;
    readonly status: RefundStatus;
    readonly failureReason?: string | null;
  },
): Promise<Refund | undefined> {
  const [row] = await db
    .update(refunds)
    .set({
      status: refund.status,
      stripeRefundId: refund.stripeRefundId,
      ...(refund.status === "failed"
        ? { failureReason: refund.failureReason ?? "refund_failed" }
        : {}),
    })
    .where(
      and(
        eq(refunds.status, "pending"),
        refund.refundId === undefined
          ? eq(refunds.stripeRefundId, refund.stripeRefundId)
          : sql`(${refunds.stripeRefundId} = ${refund.stripeRefundId} or (${refunds.id} = ${refund.refundId} and ${refunds.stripeRefundId} is null))`,
      ),
    )
    .returning();
  return row;
}

/** Refunds sent to Stripe whose outcome Stripe has not given yet. */
export async function refundsAwaitingStripe(db: Executor, paymentId: string): Promise<Refund[]> {
  return db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        eq(refunds.status, "pending"),
        sql`${refunds.stripeRefundId} is not null`,
      ),
    );
}

/**
 * Payments that stopped half way and need resuming: a charge whose outcome
 * is not known after `staleBefore`; a hold on a booking that was confirmed
 * (to capture) or cancelled (to release); a booking still holding its slot
 * with a payment that failed or was cancelled; and paid payments with a
 * refund recorded but not sent before `staleBefore`, or sent but still
 * pending at Stripe since `refundCheckBefore`.
 */
export async function paymentsToResume(
  db: Executor,
  before: { readonly staleBefore: Date; readonly refundCheckBefore: Date },
  limit: number,
): Promise<string[]> {
  const stale = sql`${before.staleBefore.toISOString()}::timestamptz`;
  const check = sql`${before.refundCheckBefore.toISOString()}::timestamptz`;
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(
      sql`(${payments.status} = 'pending' and ${payments.updatedAt} < ${stale})
        or (${payments.status} = 'authorised' and ${bookings.status} in ('confirmed', 'cancelled'))
        or (${payments.status} in ('failed', 'cancelled') and ${bookings.status} in ('requested', 'confirmed'))
        or (${payments.status} = 'paid' and exists (
          select 1 from ${refunds} r where r.payment_id = ${payments.id} and r.status = 'pending'
            and ((r.stripe_refund_id is null and r.created_at < ${stale})
              or (r.stripe_refund_id is not null and r.updated_at < ${check}))))`,
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Refunds recorded but not yet sent to Stripe, oldest first. */
export async function unsentRefunds(db: Executor, paymentId: string): Promise<Refund[]> {
  return db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        eq(refunds.status, "pending"),
        isNull(refunds.stripeRefundId),
      ),
    )
    .orderBy(asc(refunds.createdAt));
}

/** Whether a user has a refund still in flight, as a driver or as a host. */
export async function hasRefundInFlight(db: Executor, userId: string): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from refunds r
      join payments p on p.id = r.payment_id
      join bookings b on b.id = p.booking_id
      join chargers c on c.id = b.charger_id
      join hosts h on h.id = c.host_id
      where r.status = 'pending' and (b.driver_id = ${userId} or h.user_id = ${userId})
    ) as found
  `);
  return result.rows[0]?.found === true;
}

/** Booking ids whose lifecycle job is due: unanswered requests past expiry, and confirmed bookings past their no-show time. */
export async function dueLifecycleBookings(
  db: Executor,
  input: { now: Date; requestHours: number; noShowGraceMinutes: number; limit: number },
): Promise<{ expire: string[]; noShow: string[] }> {
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const expire = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "requested"),
        sql`least(${bookings.createdAt} + make_interval(hours => ${input.requestHours}), lower(${bookings.slot})) <= ${now}`,
      ),
    )
    .limit(input.limit);
  const noShow = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ["confirmed"]),
        sql`upper(${bookings.slot}) + make_interval(mins => ${input.noShowGraceMinutes}) <= ${now}`,
      ),
    )
    .limit(input.limit);
  return { expire: expire.map((row) => row.id), noShow: noShow.map((row) => row.id) };
}
