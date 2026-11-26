import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import type { z } from "zod";

import {
  type AnyJob,
  type JobDefinition,
  type JobRunner,
  runAttempt,
  type SendOptions,
} from "./jobs.ts";

/** Postgres schema pg-boss keeps its tables in, apart from the application's. */
export const JOBS_SCHEMA = "pgboss";

/** How long `stop` waits for running jobs. Below the process's own shutdown timeout. */
export const JOBS_STOP_TIMEOUT_MS = 8_000;

export interface PgBossRunnerOptions {
  readonly connectionString: string;
  readonly schema?: string;
  /** Seconds between polls for new jobs. */
  readonly pollingIntervalSeconds?: number;
  /** Connections pg-boss may open. */
  readonly maxConnections?: number;
}

/**
 * Jobs on pg-boss in the API's own Postgres: no Redis and no separate worker.
 * `start` installs or migrates pg-boss's schema, creates one queue per job
 * (policy `stately`, so a singleton key allows one queued, one retrying and
 * one running job) and works each queue one job at a time.
 */
export function createPgBossRunner(options: PgBossRunnerOptions): JobRunner {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? JOBS_SCHEMA,
    max: options.maxConnections ?? 4,
    application_name: "nd-api-jobs",
  });
  const known = new Map<string, AnyJob<unknown>>();
  let run: ((job: AnyJob<unknown>, payload: unknown) => Promise<void>) | undefined;
  let started = false;

  const nameOf = (job: { name: string }): string => {
    if (!started) throw new Error(`job runner is not started; cannot send ${job.name}`);
    if (!known.has(job.name)) throw new Error(`unknown job: ${job.name}`);
    return job.name;
  };

  return {
    async start(jobs, context, log) {
      boss.on("error", (error) => {
        log.error({ err: error }, "job runner error");
      });
      await boss.start();
      for (const job of jobs) {
        const queue = {
          retryLimit: job.retry.limit,
          retryDelay: job.retry.delaySeconds,
          retryBackoff: job.retry.backoff,
          expireInSeconds: job.timeoutSeconds ?? 300,
          ...(job.retry.maxDelaySeconds === undefined
            ? {}
            : { retryDelayMax: job.retry.maxDelaySeconds }),
        };
        await boss.createQueue(job.name, { policy: "stately", ...queue });
        // createQueue leaves an existing queue alone; apply changed settings.
        await boss.updateQueue(job.name, queue);
        known.set(job.name, job);
        await boss.work<unknown>(
          job.name,
          { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
          async (batch) => {
            for (const item of batch) {
              await runAttempt(
                job,
                item.data,
                context,
                { jobId: item.id, retryCount: item.retryCount },
                log,
              );
            }
          },
        );
      }
      run = (job, payload) =>
        runAttempt(job, payload, context, { jobId: "inline", retryCount: job.retry.limit }, log);
      started = true;
    },

    async stop() {
      if (!started) return;
      started = false;
      await boss.stop({ graceful: true, close: true, timeout: JOBS_STOP_TIMEOUT_MS });
    },

    async send<S extends z.ZodType>(
      job: JobDefinition<S>,
      payload: z.input<S>,
      sendOptions: SendOptions = {},
    ) {
      const name = nameOf(job);
      const data = job.payload.parse(payload) as object;
      return boss.send(name, data, {
        ...(sendOptions.startAfter === undefined ? {} : { startAfter: sendOptions.startAfter }),
        // A stately queue treats every job without a key as sharing one, so an
        // unkeyed job gets a key of its own.
        singletonKey: sendOptions.singletonKey ?? randomUUID(),
      });
    },

    async drain() {
      const result = await boss.drain();
      return { processed: result.processed, failed: result.failed };
    },

    async runNow(job, payload) {
      nameOf(job);
      if (run === undefined) throw new Error("job runner is not started");
      await run(job, payload);
    },
  };
}
