import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { defineJob } from "./jobs.ts";
import { createPgBossRunner } from "./pg-boss.ts";

interface Context {
  readonly seen: string[];
  readonly failuresLeft: Map<string, number>;
}

const record = defineJob({
  name: "record-it",
  payload: z.object({ value: z.string() }),
  retry: { limit: 2, delaySeconds: 0, backoff: false },
  run: ({ value }, context: Context, attempt) => {
    const left = context.failuresLeft.get(value) ?? 0;
    if (left > 0) {
      context.failuresLeft.set(value, left - 1);
      return Promise.reject(new Error(`failing ${value}`));
    }
    context.seen.push(`${value}@${String(attempt.retryCount)}`);
    return Promise.resolve();
  },
});

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

let database: TestDatabase;
const context: Context = { seen: [], failuresLeft: new Map() };
const runner = () =>
  createPgBossRunner({ connectionString: database.url, pollingIntervalSeconds: 60 });
let jobs: ReturnType<typeof runner>;

beforeAll(async () => {
  database = await createTestDatabase();
  jobs = runner();
  await jobs.start([record], context, quiet);
});

afterAll(async () => {
  await jobs.stop();
  await database.dispose();
});

describe("pg-boss runner", () => {
  it("keeps its tables in their own schema", async () => {
    const result = await database.pool.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_schema = 'pgboss'",
    );
    expect(result.rows[0]?.count).toBeGreaterThan(0);
  });

  it("runs queued jobs when drained, retrying failures", async () => {
    context.failuresLeft.set("flaky", 1);
    await jobs.send(record, { value: "flaky" });
    await jobs.send(record, { value: "steady" });
    await jobs.drain();
    expect(context.seen).toEqual(expect.arrayContaining(["steady@0", "flaky@1"]));
  });

  it("does not run a job before its start time", async () => {
    await jobs.send(record, { value: "later" }, { startAfter: new Date(Date.now() + 3_600_000) });
    await jobs.drain();
    expect(context.seen).not.toContain("later@0");
  });

  it("queues one job per singleton key", async () => {
    const at = new Date(Date.now() + 3_600_000);
    const first = await jobs.send(
      record,
      { value: "once" },
      { singletonKey: "k1", startAfter: at },
    );
    const second = await jobs.send(
      record,
      { value: "once" },
      { singletonKey: "k1", startAfter: at },
    );
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
  });

  it("keeps one schedule per job with a cron, and drops it with the cron", async () => {
    const nightly = defineJob({
      name: "nightly-thing",
      payload: z.object({}),
      retry: { limit: 0, delaySeconds: 0, backoff: false },
      cron: "15 3 * * *",
      run: () => Promise.resolve(),
    });
    const schedules = async () =>
      (
        await database.pool.query<{ cron: string; timezone: string | null }>(
          "select cron, timezone from pgboss.schedule where name = 'nightly-thing'",
        )
      ).rows;

    const first = runner();
    await first.start([nightly], context, quiet);
    await first.stop();
    const second = runner();
    await second.start([nightly], context, quiet);
    await second.stop();
    expect(await schedules()).toEqual([{ cron: "15 3 * * *", timezone: "UTC" }]);

    const third = runner();
    const unscheduled = defineJob({
      name: nightly.name,
      payload: nightly.payload,
      retry: nightly.retry,
      run: () => Promise.resolve(),
    });
    await third.start([unscheduled], context, quiet);
    await third.stop();
    expect(await schedules()).toEqual([]);
  });

  it("restarts on an installed schema", async () => {
    const again = runner();
    await again.start([record], context, quiet);
    await again.stop();
  });
});
