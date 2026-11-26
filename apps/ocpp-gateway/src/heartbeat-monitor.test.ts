import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeStore } from "../test/fake-store.ts";
import { silentLogger } from "../test/silent-logger.ts";
import { MISSED_HEARTBEATS, startHeartbeatMonitor } from "./heartbeat-monitor.ts";

describe("startHeartbeatMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2027-01-13T22:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at start and every interval for chargers silent for three heartbeats", async () => {
    const store = fakeStore();
    store.markStaleChargersOffline = vi.fn(() => Promise.resolve(2));
    const monitor = startHeartbeatMonitor({
      store,
      logger: silentLogger,
      heartbeatIntervalSeconds: 300,
      checkEveryMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.markStaleChargersOffline).toHaveBeenCalledTimes(1);
    const [cutoff, at] = vi.mocked(store.markStaleChargersOffline).mock.calls[0] ?? [];
    expect(at?.getTime()).toBe(Date.now());
    expect((at?.getTime() ?? 0) - (cutoff?.getTime() ?? 0)).toBe(MISSED_HEARTBEATS * 300_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.markStaleChargersOffline).toHaveBeenCalledTimes(2);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.markStaleChargersOffline).toHaveBeenCalledTimes(2);
  });

  it("does not overlap checks and survives a failing one", async () => {
    const store = fakeStore();
    let release: (count: number) => void = () => undefined;
    store.markStaleChargersOffline = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(0) as typeof store.markStaleChargersOffline;
    const monitor = startHeartbeatMonitor({
      store,
      logger: silentLogger,
      heartbeatIntervalSeconds: 1,
      checkEveryMs: 10_000,
      now: () => new Date(),
    });
    const pending = monitor.check();
    expect(store.markStaleChargersOffline).toHaveBeenCalledTimes(1);
    release(0);
    await expect(pending).resolves.toBe(0);
    await expect(monitor.check()).resolves.toBe(0);
    await expect(monitor.check()).resolves.toBe(0);
    expect(store.markStaleChargersOffline).toHaveBeenCalledTimes(3);
    monitor.stop();
  });
});
