import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";

import { verifyChargerSecret } from "@nd/db";
import { OCPP16_SUBPROTOCOL, selectSubprotocol } from "@nd/ocpp-core";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

import type { ConfigWriteBudget } from "./boot-config.ts";
import { ChargerConnection } from "./connection.ts";
import { chargePointHandlers } from "./handlers.ts";
import { chargeboxIdFromPath, parseBasicAuth } from "./http-auth.ts";
import type { Logger } from "./logger.ts";
import { ConnectionRegistry } from "./registry.ts";
import type { ChargerRef, GatewayStore } from "./store.ts";

/** Close code for sockets the gateway closes on shutdown ("going away"). */
export const SHUTDOWN_CLOSE_CODE = 1001;

/** Largest OCPP frame accepted, in bytes. Zappi frames are a few kB at most. */
const MAX_FRAME_BYTES = 256 * 1024;

export interface OcppServerOptions {
  readonly store: GatewayStore;
  readonly budget: ConfigWriteBudget;
  readonly logger: Logger;
  readonly registry?: ConnectionRegistry;
  /** WebSocket ping interval, in ms. */
  readonly pingIntervalMs: number;
  /** Reply timeout for calls to chargers, in ms. */
  readonly callTimeoutMs?: number;
  /** Heartbeat interval given to chargers on boot, in seconds. */
  readonly heartbeatIntervalSeconds?: number;
}

export interface OcppServer {
  readonly registry: ConnectionRegistry;
  /** Closes every charger socket with 1001 and stops accepting upgrades. */
  close(): Promise<void>;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return (Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data))).toString("utf8");
}

function refuse(socket: Duplex, status: number, headers: Record<string, string> = {}): void {
  if (socket.destroyed) {
    return;
  }
  const lines = [
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ""}`,
    "Connection: close",
    "Content-Length: 0",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join("\r\n")}\r\n\r\n`);
}

/**
 * Accepts OCPP 1.6J sockets on `/v16/<ChargeboxID>`: the `ocpp1.6`
 * subprotocol is required, and HTTP Basic Auth whose username is the
 * ChargeboxID and whose password matches the charger's argon2 hash. A wrong
 * password gets 401 and an unknown ChargeboxID 404, and nothing is stored for
 * either. A second socket for the same charger replaces the first.
 */
export function attachOcppServer(server: Server, options: OcppServerOptions): OcppServer {
  const { store, budget, logger } = options;
  const registry = options.registry ?? new ConnectionRegistry();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (offered) => selectSubprotocol(offered) ?? false,
  });

  async function authenticate(
    request: IncomingMessage,
    socket: Duplex,
  ): Promise<ChargerRef | undefined> {
    const chargeboxId = chargeboxIdFromPath(request.url);
    if (chargeboxId === undefined) {
      refuse(socket, 404);
      return undefined;
    }
    const log = logger.child({ chargeboxId });
    const offered = (request.headers["sec-websocket-protocol"] ?? "").split(",");
    if (selectSubprotocol(offered) === undefined) {
      log.warn("upgrade without the ocpp1.6 subprotocol");
      refuse(socket, 400);
      return undefined;
    }
    const credentials = parseBasicAuth(request.headers.authorization);
    if (credentials?.username !== chargeboxId) {
      log.warn("upgrade without valid Basic Auth credentials");
      refuse(socket, 401, { "WWW-Authenticate": 'Basic realm="ocpp", charset="UTF-8"' });
      return undefined;
    }
    const charger = await store.findCredentials(chargeboxId);
    if (charger === undefined) {
      log.warn("upgrade for an unknown ChargeboxID");
      refuse(socket, 404);
      return undefined;
    }
    const valid =
      charger.ocppAuthHash !== null &&
      (await verifyChargerSecret(credentials.password, charger.ocppAuthHash));
    if (!valid) {
      log.warn("upgrade with a wrong password");
      refuse(socket, 401, { "WWW-Authenticate": 'Basic realm="ocpp", charset="UTF-8"' });
      return undefined;
    }
    return { id: charger.id, chargeboxId: charger.chargeboxId };
  }

  function connected(ws: WebSocket, charger: ChargerRef): void {
    const log = logger.child({ chargeboxId: charger.chargeboxId });
    const connection = new ChargerConnection({
      charger,
      ws,
      store,
      logger: log,
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    });
    connection.handle(
      chargePointHandlers({
        connection,
        store,
        budget,
        logger: log,
        ...(options.heartbeatIntervalSeconds === undefined
          ? {}
          : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds }),
      }),
    );
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        log.warn("binary frame ignored");
        return;
      }
      void connection.receive(rawText(data));
    });
    ws.on("error", (error) => {
      log.warn({ err: error.message }, "socket error");
    });
    ws.on("close", (code) => {
      registry.remove(connection);
      void connection.closed();
      log.info({ code }, "charger disconnected");
    });
    if (registry.add(connection) !== undefined) {
      log.info("replaced the charger's previous socket");
    }
    log.info({ subprotocol: OCPP16_SUBPROTOCOL }, "charger connected");
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => undefined);
    authenticate(request, socket)
      .then((charger) => {
        if (charger === undefined || socket.destroyed) {
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          connected(ws, charger);
        });
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "upgrade failed",
        );
        refuse(socket, 503);
      });
  };
  server.on("upgrade", onUpgrade);

  const pinger = setInterval(() => {
    for (const connection of registry.all()) {
      connection.heartbeatTick();
    }
  }, options.pingIntervalMs);
  pinger.unref();

  return {
    registry,
    async close() {
      clearInterval(pinger);
      server.off("upgrade", onUpgrade);
      const sockets = [...wss.clients];
      const closed = Promise.all(
        sockets.map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === ws.CLOSED) {
                resolve();
                return;
              }
              ws.once("close", () => {
                resolve();
              });
            }),
        ),
      );
      for (const ws of sockets) {
        ws.close(SHUTDOWN_CLOSE_CODE, "Server shutting down");
      }
      // A peer that does not finish the closing handshake is cut off.
      const force = setTimeout(() => {
        for (const ws of sockets) {
          ws.terminate();
        }
      }, 2_000);
      await closed;
      clearTimeout(force);
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}
