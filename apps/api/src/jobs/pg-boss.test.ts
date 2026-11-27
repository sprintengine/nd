import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineJob } from "./jobs.ts";
import { createPgBossRunner, JOBS_SCHEMA, JOBS_STOP_TIMEOUT_MS } from "./pg-boss.ts";

const boss = vi.hoisted(() => ({
  constructed: [] as unknown[],
  on: vi.fn(),
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
  createQueue: vi.fn(() => Promise.resolve()),
  updateQueue: vi.fn(() => Promise.resolve()),
  schedule: vi.fn(() => Promise.resolve()),
  unschedule: vi.fn(() => Promise.resolve()),
  work: vi.fn<(name: string, options: unknown, handler: unknown) => Promise<string>>(() =>
    Promise.resolve("worker"),
  ),
  send: vi.fn(() => Promise.resolve("job-1")),
  drain: vi.fn(() => Promise.resolve({ processed: 3, failed: 1, timedOut: false })),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: unknown) {
      boss.constructed.push(options);
    }
    on = boss.on;
    start = boss.start;
    stop = boss.stop;
    createQueue = boss.createQueue;
    updateQueue = boss.updateQueue;
    schedule = boss.schedule;
    unschedule = boss.unschedule;
    work = boss.work;
    send = boss.send;
    drain = boss.drain;
  },
}));

const run = vi.fn<(payload: { id: string }, context: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const job = defineJob({
  name: "ping",
  payload: z.object({ id: z.string() }),
  retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 60 },
  run,
});
const plain = defineJob({
  name: "plain",
  payload: z.object({}),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  timeoutSeconds: 30,
  cron: "0 4 * * *",
  run: () => Promise.resolve(),
});
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPgBossRunner", () => {
  it("uses its own schema and a small pool", () => {
    createPgBossRunner({ connectionString: "postgres://localhost/nd" });
    expect(boss.constructed.at(-1)).toMatchObject({
      connectionString: "postgres://localhost/nd",
      schema: JOBS_SCHEMA,
      max: 4,
    });
  });

  it("creates a stately queue per job with its retry policy, and works it", async () => {
    const runner = createPgBossRunner({ connectionString: "postgres://localhost/nd" });
    await runner.start([job, plain], "ctx", log);
    expect(boss.start).toHaveBeenCalled();
    expect(boss.unschedule).toHaveBeenCalledWith("ping");
    expect(boss.schedule).toHaveBeenCalledWith("plain", "0 4 * * *", {}, { tz: "UTC" });
    expect(boss.createQueue).toHaveBeenCalledWith("ping", {
      policy: "stately",
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 300,
    });
    expect(boss.updateQueue).toHaveBeenCalledWith("plain", {
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 30,
    });
    const handler = boss.work.mock.calls[0]?.[2] as (
      batch: { id: string; data: unknown; retryCount: number }[],
    ) => Promise<void>;
    await handler([{ id: "j1", data: { id: "x" }, retryCount: 3 }]);
    expect(run).toHaveBeenCalledWith({ id: "x" }, "ctx", {
      jobId: "j1",
      retryCount: 3,
      lastAttempt: true,
    });
  });

  it("leaves schedules alone when they are turned off", async () => {
    const minutely = defineJob({
      name: "minutely",
      payload: z.object({}),
      retry: { limit: 0, delaySeconds: 0, backoff: false },
      cron: "* * * * *",
      run: () => Promise.resolve(),
    });
    const runner = createPgBossRunner({
      connectionString: "postgres://localhost/nd",
      schedules: false,
    });
    await runner.start([job, minutely], "ctx", log);
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.unschedule).not.toHaveBeenCalled();
  });

  it("reports pg-boss errors to the log", async () => {
    const runner = createPgBossRunner({ connectionString: "postgres://localhost/nd" });
    await runner.start([job], "ctx", log);
    const onError = boss.on.mock.calls[0]?.[1] as (error: Error) => void;
    onError(new Error("lost connection"));
    expect(log.error).toHaveBeenCalledWith(expect.any(Object), "job runner error");
  });

  it("sends validated payloads with a start time and singleton key", async () => {
    const runner = createPgBossRunner({ connectionString: "postgres://localhost/nd" });
    await expect(runner.send(job, { id: "x" })).rejects.toThrow(/not started/);
    await runner.start([job], "ctx", log);
    const at = new Date("2027-01-01T00:00:00Z");
    await expect(
      runner.send(job, { id: "x" }, { startAfter: at, singletonKey: "k" }),
    ).resolves.toBe("job-1");
    expect(boss.send).toHaveBeenCalledWith(
      "ping",
      { id: "x" },
      { startAfter: at, singletonKey: "k" },
    );
    await runner.send(job, { id: "y" });
    expect(boss.send).toHaveBeenLastCalledWith(
      "ping",
      { id: "y" },
      { singletonKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown },
    );
    await expect(runner.send(plain, {})).rejects.toThrow(/unknown job/);
    await expect(runner.send(job, { id: 1 } as never)).rejects.toThrow();
  });

  it("drains, runs a job now as its last attempt, and stops gracefully once", async () => {
    const runner = createPgBossRunner({ connectionString: "postgres://localhost/nd" });
    await runner.stop();
    expect(boss.stop).not.toHaveBeenCalled();
    await expect(runner.runNow(job, { id: "x" })).rejects.toThrow(/not started/);
    await runner.start([job], "ctx", log);
    await expect(runner.drain()).resolves.toEqual({ processed: 3, failed: 1 });
    await runner.runNow(job, { id: "now" });
    expect(run).toHaveBeenCalledWith({ id: "now" }, "ctx", {
      jobId: "inline",
      retryCount: 3,
      lastAttempt: true,
    });
    await runner.stop();
    await runner.stop();
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(boss.stop).toHaveBeenCalledWith({
      graceful: true,
      close: true,
      timeout: JOBS_STOP_TIMEOUT_MS,
    });
  });
});
