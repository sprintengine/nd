import { z } from "zod";

import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import { failStalledStart, runRemoteStart, stopAtWindowEnd } from "./control.ts";
import type { SessionServices } from "./services.ts";

/**
 * Sends a remote start later: a scheduled start (no session id) at its time,
 * or the one retry after a soft reset (with the session id). An unanswered
 * retry is tried again a few times before the start fails.
 */
export const remoteStartJob = defineJob({
  name: "session-remote-start",
  payload: z.object({ bookingId: z.uuid(), sessionId: z.uuid().optional() }),
  retry: { limit: 3, delaySeconds: 15, backoff: false },
  run: (payload, services: SessionServices, attempt) => runRemoteStart(services, payload, attempt),
});

/** 120 s after an accepted remote start: no StartTransaction means the start failed. */
export const startTimeoutJob = defineJob({
  name: "session-start-timeout",
  payload: z.object({ bookingId: z.uuid(), sessionId: z.uuid() }),
  retry: { limit: 3, delaySeconds: 10, backoff: true, maxDelaySeconds: 120 },
  run: (payload, services: SessionServices) => failStalledStart(services, payload),
});

/** At slot end + 5 minutes: a session still running is stopped remotely. */
export const windowEndStopJob = defineJob({
  name: "session-window-end-stop",
  payload: z.object({ bookingId: z.uuid() }),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 600 },
  run: ({ bookingId }, services: SessionServices, attempt) =>
    stopAtWindowEnd(services, bookingId, attempt),
});

/** Every session control job. */
export const SESSION_JOBS: readonly AnyJob<SessionServices>[] = [
  remoteStartJob,
  startTimeoutJob,
  windowEndStopJob,
];
