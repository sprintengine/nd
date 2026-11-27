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
