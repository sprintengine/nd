import { type Executor, meterValues } from "@nd/db";
import { inArray, lt, sql } from "drizzle-orm";

/** Meter values and OCPP messages are kept this many months, then purged. */
export const TELEMETRY_RETENTION_MONTHS = 24;

/** Meter values deleted per statement, so one run never holds a long lock. */
const BATCH_SIZE = 10_000;

/** `now` minus the retention period, in UTC calendar months. */
export function telemetryCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - TELEMETRY_RETENTION_MONTHS);
  return cutoff;
}

export interface TelemetryPurge {
  readonly ocppMessages: number;
  readonly meterValues: number;
}

/**
 * Scheduled step: deletes telemetry past its 24-month retention. OCPP
 * messages go through `purge_ocpp_messages()`, the only way past their
 * append-only triggers; it measures 24 months from the database's clock and
 * runs as its owner, so the role running this needs EXECUTE on it. Meter
 * values older than 24 months before `now` are deleted in batches. Sessions
 * and accounting rows are kept. The `telemetry-retention` job runs it daily.
 */
export async function purgeExpiredTelemetry(db: Executor, now: Date): Promise<TelemetryPurge> {
  const purged = await db.execute<{ deleted: string | number }>(
    sql`select purge_ocpp_messages() as deleted`,
  );
  const ocppMessages = Number(purged.rows[0]?.deleted ?? 0);

  const cutoff = telemetryCutoff(now);
  let meterValueCount = 0;
  for (;;) {
    const batch = db
      .select({ id: meterValues.id })
      .from(meterValues)
      .where(lt(meterValues.ts, cutoff))
      .limit(BATCH_SIZE);
    const deleted = await db
      .delete(meterValues)
      .where(inArray(meterValues.id, batch))
      .returning({ id: meterValues.id });
    meterValueCount += deleted.length;
    if (deleted.length < BATCH_SIZE) break;
  }
  return { ocppMessages, meterValues: meterValueCount };
}
