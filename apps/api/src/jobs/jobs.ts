import type { z } from "zod";

// Typed background jobs. A job is a name, a Zod payload schema, a retry
// policy and a handler. The API process runs them with pg-boss on the same
// Postgres (src/jobs/pg-boss.ts); unit tests use an in-memory runner.

/** How a failed job is retried. */
export interface RetryPolicy {
  /** Retries after the first attempt; 0 runs a job once. */
  readonly limit: number;
  /** Seconds before the first retry. */
  readonly delaySeconds: number;
  /** Double the delay on each retry (with jitter), up to `maxDelaySeconds`. */
  readonly backoff: boolean;
  readonly maxDelaySeconds?: number;
}

/** Which attempt of a job a handler is running. */
export interface JobAttempt {
  readonly jobId: string;
  /** 0 on the first attempt. */
  readonly retryCount: number;
  /** No retry follows if this attempt throws. */
  readonly lastAttempt: boolean;
}

/** A kind of job. `C` is what the handler needs from the app (database, Stripe, clock…). */
export interface JobDefinition<S extends z.ZodType = z.ZodType, C = never> {
  /** Queue name: lower-case words joined by hyphens. */
  readonly name: string;
  readonly payload: S;
  readonly retry: RetryPolicy;
  /** Longest one attempt may run before it counts as failed. Default 5 minutes. */
  readonly timeoutSeconds?: number;
  /** Does the work. Throw to fail the attempt (and retry, unless it was the last). */
  run(payload: z.output<S>, context: C, attempt: JobAttempt): Promise<void>;
}

/** A job definition with its payload type erased, for lists of jobs. */
export type AnyJob<C = never> = JobDefinition<z.ZodType, C>;

/** Options for sending a job. */
export interface SendOptions {
  /** Run no earlier than this. Default now. */
  readonly startAfter?: Date;
  /**
   * Idempotency key: while a job with this key is queued, waiting to retry
   * or running, sending another with the same key does nothing.
   */
  readonly singletonKey?: string;
}

/** Sends jobs; what route handlers and other jobs depend on. */
export interface JobQueue {
  /** Validates the payload and queues the job. Resolves to its id, or null when a singleton already exists. */
  send<S extends z.ZodType>(
    job: JobDefinition<S>,
    payload: z.input<S>,
    options?: SendOptions,
  ): Promise<string | null>;
}

/** Where the runner reports jobs that failed or were dropped. Fastify's logger fits. */
export interface JobLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/** Runs jobs inside the API process; started and stopped with the app. */
export interface JobRunner extends JobQueue {
  /** Creates the queues and starts working them with `context`. */
  start<C>(jobs: readonly AnyJob<C>[], context: C, log: JobLogger): Promise<void>;
  /** Stops taking jobs and waits for running ones to finish (bounded by a timeout). */
  stop(): Promise<void>;
  /** Test helper: works every ready job, including ones they queue, until none is left. */
  drain(): Promise<{ processed: number; failed: number }>;
  /** Test helper: runs one job's handler now, in this call, as its last attempt. */
  runNow<S extends z.ZodType>(job: JobDefinition<S>, payload: z.input<S>): Promise<void>;
}

/** Queue names: lower-case letters and digits in hyphen-separated words. */
const JOB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Declares a job, checking its name and retry policy once at start-up. */
export function defineJob<S extends z.ZodType, C>(job: JobDefinition<S, C>): JobDefinition<S, C> {
  if (!JOB_NAME.test(job.name)) {
    throw new TypeError(`job name must be lower-case words joined by hyphens: ${job.name}`);
  }
  const { limit, delaySeconds, maxDelaySeconds } = job.retry;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`${job.name}: retry.limit must be a non-negative integer`);
  }
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
    throw new RangeError(`${job.name}: retry.delaySeconds must be a non-negative integer`);
  }
  if (
    maxDelaySeconds !== undefined &&
    (!Number.isInteger(maxDelaySeconds) || maxDelaySeconds < 1)
  ) {
    throw new RangeError(`${job.name}: retry.maxDelaySeconds must be a positive integer`);
  }
  return job;
}

/**
 * Runs one attempt of a job: validates the payload (an invalid one is logged
 * and dropped, since retrying cannot fix it), then calls the handler. A
 * handler's error is logged and rethrown so the runner retries the job.
 */
export async function runAttempt<C>(
  job: AnyJob<C>,
  data: unknown,
  context: C,
  attempt: { jobId: string; retryCount: number },
  log: JobLogger,
): Promise<void> {
  const parsed = job.payload.safeParse(data);
  if (!parsed.success) {
    log.error(
      { job: job.name, jobId: attempt.jobId, issues: parsed.error.issues.length },
      "job payload is invalid; dropped",
    );
    return;
  }
  const lastAttempt = attempt.retryCount >= job.retry.limit;
  try {
    await job.run(parsed.data, context, { ...attempt, lastAttempt });
  } catch (error) {
    log[lastAttempt ? "error" : "warn"](
      { job: job.name, jobId: attempt.jobId, retryCount: attempt.retryCount, err: error },
      lastAttempt ? "job failed" : "job attempt failed; will retry",
    );
    throw error;
  }
}
