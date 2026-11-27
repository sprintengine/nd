import { describe, expect, it, vi } from "vitest";

import { memoryJobs } from "../../test/fakes.ts";
import { NOW, startUnitApp } from "../../test/unit-app.ts";
import * as deletion from "../accounts/deletion.ts";
import { defineJob } from "../jobs/jobs.ts";
import type { Services } from "../services.ts";
import { accountDeletionsJob, COMPLIANCE_JOBS, telemetryRetentionJob } from "./jobs.ts";
import * as retention from "./retention.ts";

vi.mock("../accounts/deletion.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof deletion>()),
  processDueDeletions: vi.fn(),
}));
vi.mock("./retention.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof retention>()),
  purgeExpiredTelemetry: vi.fn(),
  purgeExpiredTaxRecords: vi.fn(),
}));

function services() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    services: {
      db: { marker: "db" },
      clock: { now: () => NOW },
      payments: { marker: "payments" },
      taxRecordRetentionYears: 6,
      log,
    } as unknown as Services,
  };
}

describe("compliance jobs", () => {
  it("run daily in the small hours, UTC", () => {
    expect(COMPLIANCE_JOBS.map((job) => [job.name, job.cron])).toEqual([
      ["account-deletions", "15 3 * * *"],
      ["telemetry-retention", "45 3 * * *"],
    ]);
  });

  it("process due deletions as of now and log only counts and reason codes", async () => {
    vi.mocked(deletion.processDueDeletions).mockResolvedValueOnce({
      completed: 2,
      skipped: [
        { userId: "user-1", blockers: [{ code: "open-booking", message: "m" }] },
        { userId: "user-2", blockers: [{ code: "open-booking", message: "m" }] },
      ],
      failed: 1,
    });
    const { services: context, log } = services();
    const jobs = memoryJobs();
    await jobs.runner.start(COMPLIANCE_JOBS, context, log);
    await jobs.runner.runNow(accountDeletionsJob, {});
    expect(deletion.processDueDeletions).toHaveBeenCalledWith(context.db, NOW, {
      payments: context.payments,
      taxRecordRetentionYears: 6,
    });
    expect(log.info).toHaveBeenCalledWith(
      { completed: 2, failed: 1, blocked: 2, reasons: ["open-booking"] },
      "account deletions processed",
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("user-1");
  });

  it("purge expired telemetry and tax records as of now", async () => {
    vi.mocked(retention.purgeExpiredTelemetry).mockResolvedValueOnce({
      ocppMessages: 4,
      meterValues: 9,
    });
    vi.mocked(retention.purgeExpiredTaxRecords).mockResolvedValueOnce(2);
    const { services: context, log } = services();
    const jobs = memoryJobs();
    await jobs.runner.start(COMPLIANCE_JOBS, context, log);
    await jobs.runner.runNow(telemetryRetentionJob, {});
    expect(retention.purgeExpiredTelemetry).toHaveBeenCalledWith(context.db, NOW);
    expect(retention.purgeExpiredTaxRecords).toHaveBeenCalledWith(context.db, NOW);
    expect(log.info).toHaveBeenCalledWith(
      { ocppMessages: 4, meterValues: 9, taxRecords: 2 },
      "expired telemetry and tax records purged",
    );
  });

  it("are started with the app", async () => {
    const { app, jobs } = startUnitApp();
    await app.ready();
    expect(jobs.registered()).toEqual(
      expect.arrayContaining(["account-deletions", "telemetry-retention"]),
    );
    await app.close();
  });

  it("need a five-field cron expression", () => {
    expect(() =>
      defineJob({
        name: "bad-cron",
        payload: accountDeletionsJob.payload,
        retry: accountDeletionsJob.retry,
        cron: "* * *",
        run: () => Promise.resolve(),
      }),
    ).toThrow(/five fields/);
  });
});
