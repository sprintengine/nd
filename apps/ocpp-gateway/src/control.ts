import type { ChargerControl, ControlResult } from "@nd/domain";

import { configToRecord, type ConfigWriteBudget } from "./boot-config.ts";
import type { ChargerConnection } from "./connection.ts";
import type { ConnectionRegistry } from "./registry.ts";
import type { GatewayStore } from "./store.ts";

/** Connector a Zappi has: there is only one. */
const DEFAULT_CONNECTOR_ID = 1;

export interface ChargerControlOptions {
  readonly registry: ConnectionRegistry;
  readonly store: GatewayStore;
  readonly budget: ConfigWriteBudget;
}

const offline = (chargeboxId: string) =>
  ({
    ok: false,
    reason: "offline",
    message: `Charger ${chargeboxId} is not connected`,
  }) as const;

/**
 * ChargerControl on the gateway's own socket map: each command becomes one
 * OCPP CALL to the charger, answered with its response, `offline` when it is
 * not connected or `no_response` after the 30 s reply timeout.
 */
export function createChargerControl(options: ChargerControlOptions): ChargerControl {
  const { registry, store, budget } = options;

  async function withConnection<R>(
    chargeboxId: string,
    run: (connection: ChargerConnection) => Promise<ControlResult<R>>,
  ): Promise<ControlResult<R>> {
    const connection = registry.get(chargeboxId);
    return connection?.open === true ? run(connection) : offline(chargeboxId);
  }

  return {
    remoteStart: ({ chargeboxId, idTag, connectorId }) =>
      withConnection(chargeboxId, (connection) =>
        connection.call("RemoteStartTransaction", {
          connectorId: connectorId ?? DEFAULT_CONNECTOR_ID,
          idTag,
        }),
      ),
    remoteStop: ({ chargeboxId, transactionId }) =>
      withConnection(chargeboxId, (connection) =>
        connection.call("RemoteStopTransaction", { transactionId }),
      ),
    changeConfiguration: ({ chargeboxId, key, value }) =>
      withConnection(chargeboxId, (connection) => budget.write(connection, key, value)),
    getConfiguration: ({ chargeboxId, keys }) =>
      withConnection(chargeboxId, async (connection) => {
        const result = await connection.call(
          "GetConfiguration",
          keys === undefined ? {} : { key: keys },
        );
        if (result.ok && keys === undefined) {
          await store.saveOcppConfig(connection.charger.id, configToRecord(result.response));
        }
        return result;
      }),
    triggerMessage: ({ chargeboxId, requestedMessage, connectorId }) =>
      withConnection(chargeboxId, (connection) =>
        connection.call("TriggerMessage", {
          requestedMessage,
          ...(connectorId === undefined ? {} : { connectorId }),
        }),
      ),
    reset: ({ chargeboxId }) =>
      withConnection(chargeboxId, (connection) => connection.call("Reset", { type: "Soft" })),
    unlockConnector: ({ chargeboxId, connectorId }) =>
      withConnection(chargeboxId, (connection) =>
        connection.call("UnlockConnector", { connectorId: connectorId ?? DEFAULT_CONNECTOR_ID }),
      ),
  };
}
