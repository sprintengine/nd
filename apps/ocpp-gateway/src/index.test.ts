import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGatewayServer, gatewayEnvSchema, PING_INTERVAL_MS } from "./index.ts";

describe("createGatewayServer", () => {
  const server = createGatewayServer();
  let baseUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it("answers the health check with the OCPP subprotocol", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", subprotocol: "ocpp1.6" });
  });

  it("returns 404 for anything else", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });
});

describe("gateway settings", () => {
  it("pings chargers every 30 seconds", () => {
    expect(PING_INTERVAL_MS).toBe(30_000);
  });

  it("defaults to port 9000 on all interfaces", () => {
    expect(gatewayEnvSchema.parse({})).toEqual({ HOST: "0.0.0.0", PORT: 9000 });
  });
});
