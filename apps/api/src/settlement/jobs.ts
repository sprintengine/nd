import { z } from "zod";

import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import { closeArrivedBooking } from "./arrivals.ts";
import { reconcileSession } from "./reconcile.ts";
import type { SettlementServices } from "./services.ts";
import { closeStaleSession } from "./stale.ts";
import { settlementSweep } from "./sweep.ts";

const sessionPayload = z.object({ sessionId: z.uuid() });

/**
 * After a session stops: checks the meter and records the energy for the
 * receipt. Queued by the session_stopped event and the sweep; keyed by the
 * session.
 */
export const reconcileSessionJob = defineJob({
  name: "reconcile-session",
  payload: sessionPayload,
  retry: { limit: 6, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ sessionId }, services: SettlementServices) => {
    await reconcileSession(services, sessionId);
  },
});

/** A few minutes after the slot: closes a session whose StopTransaction never came. */
export const closeStaleSessionJob = defineJob({
  name: "close-stale-session",
  payload: sessionPayload,
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ sessionId }, services: SettlementServices) => {
    await closeStaleSession(services, sessionId);
  },
});

/** A few minutes after the slot: closes a booking checked in at that never got a session. */
export const closeArrivedBookingJob = defineJob({
  name: "close-arrived-booking",
  payload: z.object({ bookingId: z.uuid() }),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  run: async ({ bookingId }, services: SettlementServices) => {
    await closeArrivedBooking(services, bookingId);
  },
});

/** Every minute: queues whatever is due, in case an event or a job was missed. */
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

/** Every settlement job the API runs. */
export const SETTLEMENT_JOBS: readonly AnyJob<SettlementServices>[] = [
  reconcileSessionJob,
  closeStaleSessionJob,
  closeArrivedBookingJob,
  settlementSweepJob,
];
