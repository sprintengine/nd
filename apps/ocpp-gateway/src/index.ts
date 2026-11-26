import { createServer, type Server } from "node:http";

import { port } from "@nd/config";
import { OCPP16_SUBPROTOCOL } from "@nd/ocpp-core";
import { z } from "zod";

/**
 * Interval between WebSocket pings to each connected charger. Keeps the
 * vendor cloud's connection, and any proxy on the way, from idling out.
 */
export const PING_INTERVAL_MS = 30_000;

/** Environment the gateway reads at start-up. */
export const gatewayEnvSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: port.default(9000),
});

/** Creates the gateway's HTTP server. The OCPP WebSocket upgrade handler attaches to it. */
export function createGatewayServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", subprotocol: OCPP16_SUBPROTOCOL }));
      return;
    }
    response.writeHead(404).end();
  });
}
