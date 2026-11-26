import type { ControlResult } from "@nd/domain";
import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "../test/fake-store.ts";
import { silentLogger } from "../test/silent-logger.ts";
import {
  applyBootConfig,
  bootConfiguration,
  CONFIG_WRITE_LIMIT,
  CONFIG_WRITE_WINDOW_MS,
  configDifferences,
  type ConfigTarget,
  configToRecord,
  ConfigWriteBudget,
} from "./boot-config.ts";

const keys = (config: Record<string, string>) =>
  Object.entries(config).map(([key, value]) => ({ key, readonly: false, value }));

/** A charger whose configuration answers like a Zappi's. */
function target(
  initial: Record<string, string>,
  overrides: Partial<Record<string, ControlResult<unknown>>> = {},
) {
  const config = { ...initial };
  const calls: { action: string; request: unknown }[] = [];
  const call = vi.fn((action: string, request: { key?: string | string[]; value?: string }) => {
    calls.push({ action, request });
    const override =
      overrides[`${action}${String(calls.filter((c) => c.action === action).length)}`];
    if (override !== undefined) return Promise.resolve(override);
    if (action === "ChangeConfiguration") {
      config[request.key as string] = request.value ?? "";
      return Promise.resolve({ ok: true, response: { status: "Accepted" } });
    }
    const wanted = request.key as string[] | undefined;
    const subset = Object.fromEntries(
      Object.entries(config).filter(([key]) => wanted === undefined || wanted.includes(key)),
    );
    return Promise.resolve({ ok: true, response: { configurationKey: keys(subset) } });
  });
  return { charger: { id: "c-1" }, call, calls, config } as unknown as ConfigTarget & {
    calls: typeof calls;
    config: Record<string, string>;
  };
}

const zappiDefaults = {
  FreeCharging: "true",
  LocalAuthListEnabled: "false",
  StopTransactionOnInvalidId: "false",
  OCPPChargeMode: "Eco",
  MeterValueSampleInterval: "900",
  HeartbeatInterval: "300",
};

describe("bootConfiguration", () => {
  it("is the six keys, with the heartbeat interval given", () => {
    expect(bootConfiguration()).toEqual([
      ["FreeCharging", "false"],
      ["LocalAuthListEnabled", "false"],
      ["StopTransactionOnInvalidId", "true"],
      ["OCPPChargeMode", "Fast"],
      ["MeterValueSampleInterval", "60"],
      ["HeartbeatInterval", "300"],
    ]);
    expect(bootConfiguration(30).at(-1)).toEqual(["HeartbeatInterval", "30"]);
  });
});

describe("configDifferences", () => {
  it("compares booleans without case, numbers by value and text exactly", () => {
    const desired = bootConfiguration();
    expect(
      configDifferences(
        {
          FreeCharging: "FALSE",
          LocalAuthListEnabled: "False",
          StopTransactionOnInvalidId: "true",
          OCPPChargeMode: "fast",
          MeterValueSampleInterval: "060",
          HeartbeatInterval: "",
        },
        desired,
      ),
    ).toEqual([
      { key: "OCPPChargeMode", value: "Fast" },
      { key: "HeartbeatInterval", value: "300" },
    ]);
    expect(configDifferences({}, desired)).toHaveLength(6);
  });
});

describe("configToRecord", () => {
  it("keeps keys with values", () => {
    expect(
      configToRecord({
        configurationKey: [
          { key: "A", readonly: false, value: "1" },
          { key: "B", readonly: true },
        ],
      }),
    ).toEqual({ A: "1" });
    expect(configToRecord({})).toEqual({});
  });
});

describe("ConfigWriteBudget", () => {
  it("counts writes over the last hour and refuses past the limit", async () => {
    const store = fakeStore();
    const now = new Date("2027-01-13T22:00:00.000Z");
    const budget = new ConfigWriteBudget(store, { now: () => now });
    const charger = target({});
    store.outboundCallCount = CONFIG_WRITE_LIMIT - 1;
    await expect(budget.write(charger, "FreeCharging", "false")).resolves.toEqual({
      ok: true,
      response: { status: "Accepted" },
    });
    expect(store.countOutboundCalls).toHaveBeenCalledWith(
      "c-1",
      "ChangeConfiguration",
      new Date(now.getTime() - CONFIG_WRITE_WINDOW_MS),
    );
    store.outboundCallCount = CONFIG_WRITE_LIMIT;
    await expect(budget.write(charger, "FreeCharging", "false")).resolves.toMatchObject({
      ok: false,
      reason: "budget_exhausted",
    });
    expect(charger.calls).toHaveLength(1);
  });

  it("serialises writes to one charger", async () => {
    const store = fakeStore();
    let used = 0;
    store.countOutboundCalls = vi.fn(() => Promise.resolve(used));
    const budget = new ConfigWriteBudget(store, { limit: 1 });
    const charger = target({});
    const call = charger.call.bind(charger);
    charger.call = vi.fn(async (...args: Parameters<typeof call>) => {
      used += 1;
      return call(...args);
    }) as typeof charger.call;
    const results = await Promise.all([
      budget.write(charger, "A", "1"),
      budget.write(charger, "B", "2"),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });

  it("keeps working after a failed write", async () => {
    const store = fakeStore();
    store.countOutboundCalls = vi
      .fn()
      .mockRejectedValueOnce(new Error("db"))
      .mockResolvedValue(0) as typeof store.countOutboundCalls;
    const budget = new ConfigWriteBudget(store);
    const charger = target({});
    await expect(budget.write(charger, "A", "1")).rejects.toThrow("db");
    await expect(budget.write(charger, "A", "1")).resolves.toMatchObject({ ok: true });
  });
});

describe("applyBootConfig", () => {
  it("writes only differing keys, then stores the whole configuration", async () => {
    const store = fakeStore();
    const charger = target({ ...zappiDefaults, Extra: "1" });
    const report = await applyBootConfig(charger, {
      store,
      budget: new ConfigWriteBudget(store),
      logger: silentLogger,
    });
    expect(report.written).toEqual([
      "FreeCharging",
      "StopTransactionOnInvalidId",
      "OCPPChargeMode",
      "MeterValueSampleInterval",
    ]);
    expect(report.skipped).toEqual([]);
    expect(store.configs.get("c-1")).toMatchObject({ FreeCharging: "false", Extra: "1" });
    expect(charger.calls.map((call) => call.action)).toEqual([
      "GetConfiguration",
      "ChangeConfiguration",
      "ChangeConfiguration",
      "ChangeConfiguration",
      "ChangeConfiguration",
      "GetConfiguration",
    ]);

    const again = await applyBootConfig(charger, {
      store,
      budget: new ConfigWriteBudget(store),
      logger: silentLogger,
    });
    expect(again.written).toEqual([]);
  });

  it("stops writing when the budget runs out", async () => {
    const store = fakeStore();
    let used = 22;
    store.countOutboundCalls = vi.fn(() => Promise.resolve(used++));
    const report = await applyBootConfig(target(zappiDefaults), {
      store,
      budget: new ConfigWriteBudget(store),
      logger: silentLogger,
    });
    expect(report.written).toEqual(["FreeCharging", "StopTransactionOnInvalidId"]);
    expect(report.skipped).toEqual(["OCPPChargeMode", "MeterValueSampleInterval"]);
  });

  it("carries on when the charger refuses a value", async () => {
    const store = fakeStore();
    const report = await applyBootConfig(
      target(zappiDefaults, {
        ChangeConfiguration1: { ok: true, response: { status: "Rejected" } },
        ChangeConfiguration2: { ok: false, reason: "no_response", message: "t" },
      }),
      { store, budget: new ConfigWriteBudget(store), logger: silentLogger },
    );
    expect(report.written).toHaveLength(4);
    expect(report.stored).toBeDefined();
  });

  it("pushes nothing when the configuration cannot be read", async () => {
    const store = fakeStore();
    const charger = target(zappiDefaults, {
      GetConfiguration1: { ok: false, reason: "no_response", message: "t" },
    });
    await expect(
      applyBootConfig(charger, {
        store,
        budget: new ConfigWriteBudget(store),
        logger: silentLogger,
      }),
    ).resolves.toEqual({ written: [], skipped: [], stored: undefined });
    expect(charger.calls).toHaveLength(1);
  });

  it("stores nothing when the read-back fails", async () => {
    const store = fakeStore();
    const report = await applyBootConfig(
      target(zappiDefaults, { GetConfiguration2: { ok: false, reason: "offline", message: "x" } }),
      {
        store,
        budget: new ConfigWriteBudget(store),
        logger: silentLogger,
        heartbeatIntervalSeconds: 300,
      },
    );
    expect(report.stored).toBeUndefined();
    expect(store.saveOcppConfig).not.toHaveBeenCalled();
  });
});
