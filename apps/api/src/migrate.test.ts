import { describe, expect, it, vi } from "vitest";

import { migrate } from "./migrate.ts";

describe("migrate", () => {
  it("runs the migrations against DATABASE_URL", async () => {
    const run = vi.fn(() => Promise.resolve());
    const log = vi.fn();
    await migrate({ DATABASE_URL: "postgres://nd:nd@db:5432/nd" }, run, log);
    expect(run).toHaveBeenCalledWith("postgres://nd:nd@db:5432/nd");
    expect(log).toHaveBeenLastCalledWith("database migrations applied");
  });

  it("logs to the console by default", async () => {
    await expect(
      migrate({ DATABASE_URL: "postgres://db/nd" }, () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it("refuses to run without a valid DATABASE_URL", async () => {
    const run = vi.fn(() => Promise.resolve());
    await expect(migrate({}, run, () => undefined)).rejects.toThrow(/DATABASE_URL/);
    expect(run).not.toHaveBeenCalled();
  });
});
