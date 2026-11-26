import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "../test/fake-store.ts";
import { ConfigWriteBudget } from "./boot-config.ts";
import type { ChargerConnection } from "./connection.ts";
import { createChargerControl } from "./control.ts";
import { ConnectionRegistry } from "./registry.ts";

function setup() {
  const store = fakeStore();
  const registry = new ConnectionRegistry();
  const call = vi.fn((action: string) =>
    Promise.resolve(
      action === "GetConfiguration"
        ? { ok: true, response: { configurationKey: [{ key: "A", readonly: false, value: "1" }] } }
        : { ok: true, response: { status: "Accepted" } },
    ),
  );
  const connection = {
    charger: { id: "c-1", chargeboxId: "CB" },
    open: true,
    call,
    close: vi.fn(),
  };
  registry.add(connection as unknown as ChargerConnection);
  const control = createChargerControl({ registry, store, budget: new ConfigWriteBudget(store) });
  return { store, call, connection, control };
}

describe("createChargerControl", () => {
  it("sends each command as its OCPP call", async () => {
    const { call, control } = setup();
    await control.remoteStart({ chargeboxId: "CB", idTag: "TAG" });
    await control.remoteStart({ chargeboxId: "CB", idTag: "TAG", connectorId: 2 });
    await control.remoteStop({ chargeboxId: "CB", transactionId: 7 });
    await control.changeConfiguration({ chargeboxId: "CB", key: "K", value: "V" });
    await control.triggerMessage({ chargeboxId: "CB", requestedMessage: "StatusNotification" });
    await control.triggerMessage({
      chargeboxId: "CB",
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    await control.reset({ chargeboxId: "CB" });
    await control.unlockConnector({ chargeboxId: "CB" });
    await control.unlockConnector({ chargeboxId: "CB", connectorId: 1 });
    expect(call.mock.calls).toEqual([
      ["RemoteStartTransaction", { connectorId: 1, idTag: "TAG" }],
      ["RemoteStartTransaction", { connectorId: 2, idTag: "TAG" }],
      ["RemoteStopTransaction", { transactionId: 7 }],
      ["ChangeConfiguration", { key: "K", value: "V" }],
      ["TriggerMessage", { requestedMessage: "StatusNotification" }],
      ["TriggerMessage", { requestedMessage: "MeterValues", connectorId: 1 }],
      ["Reset", { type: "Soft" }],
      ["UnlockConnector", { connectorId: 1 }],
      ["UnlockConnector", { connectorId: 1 }],
    ]);
  });

  it("stores a full configuration read, but not a partial one", async () => {
    const { store, control } = setup();
    await control.getConfiguration({ chargeboxId: "CB", keys: ["A"] });
    expect(store.saveOcppConfig).not.toHaveBeenCalled();
    await expect(control.getConfiguration({ chargeboxId: "CB" })).resolves.toMatchObject({
      ok: true,
    });
    expect(store.saveOcppConfig).toHaveBeenCalledWith("c-1", { A: "1" });
  });

  it("answers offline for a charger without an open socket", async () => {
    const { connection, control } = setup();
    await expect(control.reset({ chargeboxId: "OTHER" })).resolves.toMatchObject({
      ok: false,
      reason: "offline",
    });
    connection.open = false;
    await expect(control.reset({ chargeboxId: "CB" })).resolves.toMatchObject({
      ok: false,
      reason: "offline",
    });
  });
});
