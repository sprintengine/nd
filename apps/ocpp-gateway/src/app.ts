import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createDb } from "@nd/db";
import type { ChargerControl } from "@nd/domain";
import { DEFAULT_CALL_TIMEOUT_MS } from "@nd/ocpp-core";

import { ConfigWriteBudget, HEARTBEAT_INTERVAL_SECONDS } from "./boot-config.ts";
import { createChargerControl } from "./control.ts";
import { createControlServer } from "./control-server.ts";
import { startHeartbeatMonitor } from "./heartbeat-monitor.ts";
import { createGatewayServer, PING_INTERVAL_MS } from "./index.ts";
import { createLogger, type Logger } from "./logger.ts";
import { attachOcppServer } from "./ocpp-server.ts";
import { probeFor } from "./readiness.ts";
import type { ConnectionRegistry } from "./registry.ts";
import { createPgStore, type GatewayStore } from "./store.ts";

/** How often the gateway looks for chargers that stopped heartbeating, in ms. */
export const OFFLINE_CHECK_INTERVAL_MS = 60_000;

export interface GatewayOptions {
  readonly databaseUrl: string;
  /** Public OCPP listener. Port 0 picks a free port. */
  readonly host: string;
  readonly port: number;
  /** Internal ChargerControl listener, on its own port. */
  readonly internal: { readonly host: string; readonly port: number; readonly secret: string };
  readonly logger?: Logger;
  /** Overrides for tests: ping, reply timeout, heartbeat interval and offline check. */
  readonly timings?: {
    readonly pingIntervalMs?: number;
    readonly callTimeoutMs?: number;
    readonly heartbeatIntervalSeconds?: number;
    readonly offlineCheckMs?: number;
  };
}

export interface Gateway {
  readonly ocppServer: Server;
  readonly controlServer: Server;
  readonly registry: ConnectionRegistry;
  readonly store: GatewayStore;
  readonly control: ChargerControl;
  /** Base URL of the internal endpoint, for the ChargerControl client. */
  readonly internalUrl: string;
  /** `ws://` URL chargers append their ChargeboxID to. */
  readonly ocppUrl: string;
  /** Closes charger sockets with 1001, both servers and the database pool. */
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeIdleConnections();
  });
}

function urlFor(scheme: string, address: AddressInfo): string {
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `${scheme}://${host}:${String(address.port)}`;
}

/** Starts the OCPP listener, the internal ChargerControl endpoint and the offline monitor. */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const logger = options.logger ?? createLogger();
  const timings = options.timings ?? {};
  const heartbeatIntervalSeconds = timings.heartbeatIntervalSeconds ?? HEARTBEAT_INTERVAL_SECONDS;
  const database = createDb(options.databaseUrl);
  // A dropped idle connection must not crash the process; the next query reports it.
  database.pool.on("error", (error) => {
    logger.error({ err: error.message }, "database pool error");
  });
  const store = createPgStore(database.db);
  const budget = new ConfigWriteBudget(store);

  const ocppServer = createGatewayServer({
    readiness: { check: () => probeFor(database.pool).check(), close: () => Promise.resolve() },
  });
  const ocpp = attachOcppServer(ocppServer, {
    store,
    budget,
    logger,
    pingIntervalMs: timings.pingIntervalMs ?? PING_INTERVAL_MS,
    callTimeoutMs: timings.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    heartbeatIntervalSeconds,
  });
  const control = createChargerControl({ registry: ocpp.registry, store, budget });
  const controlServer = createControlServer({
    control,
    secret: options.internal.secret,
    logger: logger.child({ component: "control" }),
  });
  const monitor = startHeartbeatMonitor({
    store,
    logger,
    heartbeatIntervalSeconds,
    checkEveryMs: timings.offlineCheckMs ?? OFFLINE_CHECK_INTERVAL_MS,
  });

  let ocppAddress: AddressInfo;
  let internalAddress: AddressInfo;
  try {
    ocppAddress = await listen(ocppServer, options.port, options.host);
    internalAddress = await listen(controlServer, options.internal.port, options.internal.host);
  } catch (error) {
    monitor.stop();
    await ocpp.close();
    for (const server of [ocppServer, controlServer]) {
      if (server.listening) {
        await closeServer(server);
      }
    }
    await database.close();
    throw error;
  }

  return {
    ocppServer,
    controlServer,
    registry: ocpp.registry,
    store,
    control,
    ocppUrl: `${urlFor("ws", ocppAddress)}/v16/`,
    internalUrl: urlFor("http", internalAddress),
    async close() {
      monitor.stop();
      await ocpp.close();
      await Promise.all([closeServer(ocppServer), closeServer(controlServer)]);
      await database.close();
    },
  };
}
