import { z } from "zod";

import { processDueDeletions } from "../accounts/deletion.ts";
import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import type { Services } from "../services.ts";
import { purgeExpiredTaxRecords, purgeExpiredTelemetry } from "./retention.ts";

// Daily compliance jobs. Both steps are safe to repeat, so a missed or
// doubled run does no harm; a failure is retried and the next day's run
// catches up anyway.

const nothing = z.object({});
const daily = { limit: 3, delaySeconds: 300, backoff: true, maxDelaySeconds: 3600 };

/** Anonymises accounts whose deletion undo window has passed. */
export const accountDeletionsJob = defineJob({
  name: "account-deletions",
  payload: nothing,
  retry: daily,
  cron: "15 3 * * *",
  timeoutSeconds: 15 * 60,
  run: async (_payload, services: Services) => {
    const run = await processDueDeletions(services.db, services.clock.now(), {
      payments: services.payments,
      taxRecordRetentionYears: services.taxRecordRetentionYears,
    });
    // Counts and reason codes only: never anything that identifies a person.
    services.log.info(
      {
        completed: run.completed,
        failed: run.failed,
        blocked: run.skipped.length,
        reasons: [...new Set(run.skipped.flatMap((skip) => skip.blockers.map((b) => b.code)))],
      },
      "account deletions processed",
    );
  },
});

/**
 * Deletes meter values and OCPP messages past their 24-month retention, and
 * deleted hosts' tax details past theirs.
 */
export const telemetryRetentionJob = defineJob({
  name: "telemetry-retention",
  payload: nothing,
  retry: daily,
  cron: "45 3 * * *",
  timeoutSeconds: 30 * 60,
  run: async (_payload, services: Services) => {
    const now = services.clock.now();
    const purged = await purgeExpiredTelemetry(services.db, now);
    const taxRecords = await purgeExpiredTaxRecords(services.db, now);
    services.log.info({ ...purged, taxRecords }, "expired telemetry and tax records purged");
  },
});

/** The compliance jobs the API runs, next to the booking jobs. */
export const COMPLIANCE_JOBS: readonly AnyJob<Services>[] = [
  accountDeletionsJob,
  telemetryRetentionJob,
];
