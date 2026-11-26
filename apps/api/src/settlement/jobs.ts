import { z } from "zod";

import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import { closeArrivedBooking } from "./arrivals.ts";
import { closeStaleSession } from "./confirmation.ts";
import { queueWeeklyPayoutSummaries, sendHostPayoutSummary } from "./payout-summary.ts";
import { reconcileSession } from "./reconcile.ts";
import { releaseHeldTransfers } from "./release.ts";
import type { SettlementServices } from "./services.ts";
import { settlementSweep } from "./sweep.ts";

const sessionPayload = z.object({ sessionId: z.uuid() });

/**
 * After a session stops (or its host confirms one closed without a stop):
 * checks the meter, captures the billed amount and creates the host's
 * transfer. Queued by the session_stopped event and the sweep; keyed by the
 * session.
 */
export const reconcileSessionJob = defineJob({
  name: "reconcile-session",
  payload: sessionPayload,
  retry: { limit: 6, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ sessionId }, services: SettlementServices, attempt) => {
    await reconcileSession(services, sessionId, attempt);
  },
});

/** 72 hours after a session was closed without a stop: bills it if the host has not answered. */
export const confirmationTimeoutJob = defineJob({
  name: "session-confirmation-timeout",
  payload: sessionPayload,
  retry: { limit: 6, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ sessionId }, services: SettlementServices, attempt) => {
    await reconcileSession(services, sessionId, attempt);
  },
});

/** 10 minutes after the slot: closes a session whose StopTransaction never came. */
export const closeStaleSessionJob = defineJob({
  name: "close-stale-session",
  payload: sessionPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ sessionId }, services: SettlementServices) => {
    await closeStaleSession(services, sessionId);
  },
});

/** 10 minutes after the slot: closes a booking checked in at that never got a session. */
export const closeArrivedBookingJob = defineJob({
  name: "close-arrived-booking",
  payload: z.object({ bookingId: z.uuid() }),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ bookingId }, services: SettlementServices) => {
    await closeArrivedBooking(services, bookingId);
  },
});

/** Retries held transfers whose hold has cleared, for one host or all. */
export const releaseHeldTransfersJob = defineJob({
  name: "release-held-transfers",
  payload: z.object({ hostId: z.uuid().optional() }),
  retry: { limit: 8, delaySeconds: 60, backoff: true, maxDelaySeconds: 6 * 3600 },
  run: async ({ hostId }, services: SettlementServices) => {
    await releaseHeldTransfers(services, hostId);
  },
});

/** Every minute: queues whatever settlement work is due, in case an event was missed. */
export const settlementSweepJob = defineJob({
  name: "settlement-sweep",
  payload: z.object({}),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  timeoutSeconds: 120,
  cron: "* * * * *",
  run: async (_payload, services: SettlementServices) => {
    await settlementSweep(services);
  },
});

/** Fridays at 09:00 UTC (09:00 or 10:00 in Dublin): queues each host's payout summary for the week. */
export const weeklyPayoutSummaryJob = defineJob({
  name: "weekly-payout-summary",
  payload: z.object({}),
  retry: { limit: 3, delaySeconds: 300, backoff: true },
  cron: "0 9 * * 5",
  run: async (_payload, services: SettlementServices) => {
    await queueWeeklyPayoutSummaries(services);
  },
});

/** Emails one host their weekly payout summary. */
export const hostPayoutSummaryJob = defineJob({
  name: "host-payout-summary",
  payload: z.object({ hostId: z.uuid(), from: z.iso.datetime(), to: z.iso.datetime() }),
  retry: { limit: 5, delaySeconds: 300, backoff: true, maxDelaySeconds: 6 * 3600 },
  run: async ({ hostId, from, to }, services: SettlementServices) => {
    await sendHostPayoutSummary(services, { hostId, from: new Date(from), to: new Date(to) });
  },
});

/** Every settlement job the API runs. */
export const SETTLEMENT_JOBS: readonly AnyJob<SettlementServices>[] = [
  reconcileSessionJob,
  confirmationTimeoutJob,
  closeStaleSessionJob,
  closeArrivedBookingJob,
  releaseHeldTransfersJob,
  settlementSweepJob,
  weeklyPayoutSummaryJob,
  hostPayoutSummaryJob,
];
