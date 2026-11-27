import { disputes, type Executor } from "@nd/db";
import { sql } from "drizzle-orm";

/**
 * Records a dispute raised by a user on a booking, unless they already have
 * one open (or under review) on it. Resolves to its id, or undefined then.
 */
export async function insertDisputeOnce(
  db: Executor,
  input: { bookingId: string; raisedById: string; reason: string; details: string | null },
): Promise<string | undefined> {
  const result = await db.execute<{ id: string }>(sql`
    insert into ${disputes} (booking_id, raised_by_id, reason, details)
    select ${input.bookingId}, ${input.raisedById}, ${input.reason}, ${input.details}
    where not exists (
      select 1 from ${disputes}
      where booking_id = ${input.bookingId}
        and raised_by_id = ${input.raisedById}
        and status in ('open', 'under_review')
    )
    returning id
  `);
  return result.rows[0]?.id;
}

/**
 * Records a card dispute (chargeback) the driver's bank raised on a booking,
 * once per Stripe dispute. Resolves to whether it was new.
 */
export async function insertCardDispute(
  db: Executor,
  input: { bookingId: string; driverId: string; stripeDisputeId: string; reason: string },
): Promise<boolean> {
  const rows = await db
    .insert(disputes)
    .values({
      bookingId: input.bookingId,
      raisedById: input.driverId,
      reason: "card_dispute",
      details: input.reason,
      stripeDisputeId: input.stripeDisputeId,
    })
    .onConflictDoNothing({ target: disputes.stripeDisputeId })
    .returning({ id: disputes.id });
  return rows.length > 0;
}

/**
 * Records that a card dispute closed with Stripe's outcome, creating it when
 * the close arrives before the create (a later create then leaves it closed).
 */
export async function closeCardDispute(
  db: Executor,
  input: {
    bookingId: string;
    driverId: string;
    stripeDisputeId: string;
    reason: string;
    outcome: string;
    at: Date;
  },
): Promise<boolean> {
  const closed = {
    status: input.outcome === "won" ? ("rejected" as const) : ("resolved" as const),
    resolution: `card dispute ${input.outcome}`,
    resolvedAt: input.at,
  };
  const rows = await db
    .insert(disputes)
    .values({
      bookingId: input.bookingId,
      raisedById: input.driverId,
      reason: "card_dispute",
      details: input.reason,
      stripeDisputeId: input.stripeDisputeId,
      ...closed,
    })
    .onConflictDoUpdate({ target: disputes.stripeDisputeId, set: closed })
    .returning({ id: disputes.id });
  return rows.length > 0;
}
