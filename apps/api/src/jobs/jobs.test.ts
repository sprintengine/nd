import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineJob, type JobLogger, runAttempt } from "./jobs.ts";

const retry = { limit: 2, delaySeconds: 10, backoff: true };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies JobLogger;
}

describe("defineJob", () => {
  it("returns the definition", () => {
    const job = defineJob({ name: "send-thing", payload: z.object({}), retry, run: vi.fn() });
    expect(job.name).toBe("send-thing");
  });

  it.each(["Send", "send_thing", "-send", "send--thing", ""])("rejects the name %j", (name) => {
    expect(() => defineJob({ name, payload: z.object({}), retry, run: vi.fn() })).toThrow(
      TypeError,
    );
  });

  it.each([
    { ...retry, limit: -1 },
    { ...retry, limit: 1.5 },
    { ...retry, delaySeconds: -1 },
    { ...retry, maxDelaySeconds: 0 },
  ])("rejects the retry policy %j", (policy) => {
    expect(() =>
      defineJob({ name: "job", payload: z.object({}), retry: policy, run: vi.fn() }),
    ).toThrow(RangeError);
  });
});

describe("runAttempt", () => {
  const run = vi.fn<(payload: { id: string }, context: string) => Promise<void>>();
  const job = defineJob({ name: "job", payload: z.object({ id: z.string() }), retry, run });

  it("passes the parsed payload, the context and the attempt", async () => {
    run.mockResolvedValueOnce();
    await runAttempt(job, { id: "a" }, "ctx", { jobId: "j1", retryCount: 1 }, logger());
    expect(run).toHaveBeenCalledWith({ id: "a" }, "ctx", {
      jobId: "j1",
      retryCount: 1,
      lastAttempt: false,
    });
  });

  it("drops an invalid payload without running the job", async () => {
    run.mockClear();
    const log = logger();
    await runAttempt(job, { id: 1 }, "ctx", { jobId: "j1", retryCount: 0 }, log);
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "job", jobId: "j1" }),
      "job payload is invalid; dropped",
    );
  });

  it("warns and rethrows while retries remain", async () => {
    const log = logger();
    run.mockRejectedValueOnce(new Error("boom"));
    await expect(
      runAttempt(job, { id: "a" }, "ctx", { jobId: "j1", retryCount: 0 }, log),
    ).rejects.toThrow("boom");
    expect(log.warn).toHaveBeenCalledWith(expect.any(Object), "job attempt failed; will retry");
  });

  it("logs an error on the last attempt", async () => {
    const log = logger();
    run.mockRejectedValueOnce(new Error("boom"));
    await expect(
      runAttempt(job, { id: "a" }, "ctx", { jobId: "j1", retryCount: 2 }, log),
    ).rejects.toThrow("boom");
    expect(log.error).toHaveBeenCalledWith(expect.any(Object), "job failed");
  });
});
