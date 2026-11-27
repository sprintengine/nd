import { describe, expect, it } from "vitest";

import {
  ConfigStore,
  DEFAULT_CONFIG_WRITE_LIMIT,
  DEFAULT_ZAPPI_CONFIG,
  OCPP_CHARGE_MODES,
} from "./config.ts";

describe("ConfigStore", () => {
  it("starts from the Zappi defaults, overridable", () => {
    expect(new ConfigStore().values).toEqual(DEFAULT_ZAPPI_CONFIG);
    expect(DEFAULT_ZAPPI_CONFIG.MeterValueSampleInterval).toBe(900);
    expect(new ConfigStore({ initial: { FreeCharging: false } }).get("FreeCharging")).toBe(false);
    expect(OCPP_CHARGE_MODES).toEqual(["Fast", "Eco", "Eco_Plus", "Stop"]);
  });

  it("matches keys case-insensitively but charge modes case-sensitively", () => {
    const store = new ConfigStore();
    expect(store.change("ocppchargemode", "Eco")).toEqual({
      status: "Accepted",
      key: "OCPPChargeMode",
    });
    expect(store.change("OCPPChargeMode", "eco")).toEqual({ status: "Rejected" });
    expect(store.get("OCPPChargeMode")).toBe("Eco");
  });

  it("parses booleans and bounded integers", () => {
    const store = new ConfigStore();
    expect(store.change("FreeCharging", "False").status).toBe("Accepted");
    expect(store.get("FreeCharging")).toBe(false);
    expect(store.change("StopTransactionOnInvalidId", "true").status).toBe("Accepted");
    expect(store.change("HeartbeatInterval", "86400").status).toBe("Accepted");
    expect(store.change("HeartbeatInterval", "86401").status).toBe("Rejected");
    expect(store.change("HeartbeatInterval", "1.5").status).toBe("Rejected");
    expect(store.get("HeartbeatInterval")).toBe(86_400);
  });

  it("allows 24 writes in any rolling hour", () => {
    const store = new ConfigStore();
    expect(store.writeLimit).toBe(DEFAULT_CONFIG_WRITE_LIMIT);
    for (let n = 0; n < 24; n += 1) {
      expect(store.change("HeartbeatInterval", String(n + 1), n * 1_000).status).toBe("Accepted");
    }
    expect(store.writesInWindow(23_000)).toBe(24);
    expect(store.change("HeartbeatInterval", "100", 30_000).status).toBe("Rejected");
    // Rejected and failed writes do not use up the budget.
    expect(store.change("HeartbeatInterval", "100", 3_600_000).status).toBe("Accepted");
    expect(store.change("HeartbeatInterval", "100", 3_600_001).status).toBe("Rejected");
    expect(store.writesInWindow(3_600_000 + 23_000)).toBe(1);
  });

  it("takes a custom limit and window, and does not count internal updates", () => {
    const store = new ConfigStore({ writeLimit: 1, writeWindowMs: 10 });
    store.setInternal("HeartbeatInterval", 42);
    expect(store.writesInWindow(0)).toBe(0);
    expect(store.change("HeartbeatInterval", "1", 0).status).toBe("Accepted");
    expect(store.change("HeartbeatInterval", "2", 5).status).toBe("Rejected");
    expect(store.change("HeartbeatInterval", "2", 10).status).toBe("Accepted");
  });

  it("reads all keys, chosen keys and unknown keys", () => {
    const store = new ConfigStore();
    expect(store.read().configurationKey).toHaveLength(8);
    expect(store.read([]).configurationKey).toHaveLength(8);
    expect(store.read(["NumberOfConnectors"])).toEqual({
      configurationKey: [{ key: "NumberOfConnectors", readonly: true, value: "1" }],
    });
    expect(store.read(["X"])).toEqual({ configurationKey: [], unknownKey: ["X"] });
  });
});
