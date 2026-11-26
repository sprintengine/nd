import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { startZappiSim, type ZappiSim } from "@nd/ocpp-core/sim";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { type FakeStore, fakeStore } from "../test/fake-store.ts";
import { silentLogger } from "../test/silent-logger.ts";
import { ConfigWriteBudget } from "./boot-config.ts";
import { createGatewayServer } from "./index.ts";
import { attachOcppServer, type OcppServer, SHUTDOWN_CLOSE_CODE } from "./ocpp-server.ts";
import { REPLACED_CLOSE_CODE } from "./registry.ts";
import { hashChargerSecret } from "./secret.ts";

const SECRET = "the-charger-secret";
const CHARGEBOX = "21234567";

let server: Server;
let ocpp: OcppServer;
let store: FakeStore;
let baseUrl = "";
const sims: ZappiSim[] = [];

async function sim(options: { secret?: string; chargeboxId?: string } = {}) {
  const started = await startZappiSim({
    url: `${baseUrl}/v16/`,
    chargeboxId: options.chargeboxId ?? CHARGEBOX,
    secret: options.secret ?? SECRET,
    startDelayMs: 0,
  });
  sims.push(started);
  return started;
}

/** The HTTP status an upgrade is refused with (101 if it is accepted). */
function upgradeStatus(
  path: string,
  headers: Record<string, string>,
  protocols: string[] = ["ocpp1.6"],
) {
  return new Promise<number | undefined>((resolve) => {
    const ws = new WebSocket(`${baseUrl}${path}`, protocols, { headers });
    ws.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => undefined);
  });
}

const basic = (user: string, password: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});

beforeAll(async () => {
  store = fakeStore();
  store.credentials.set(CHARGEBOX, {
    id: "c-1",
    chargeboxId: CHARGEBOX,
    ocppAuthHash: await hashChargerSecret(SECRET),
  });
  store.credentials.set("NOHASH", { id: "c-2", chargeboxId: "NOHASH", ocppAuthHash: null });
  server = createGatewayServer();
  ocpp = attachOcppServer(server, {
    store,
    budget: new ConfigWriteBudget(store),
    logger: silentLogger,
    pingIntervalMs: 50,
    callTimeoutMs: 1_000,
    heartbeatIntervalSeconds: 300,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await Promise.all(sims.splice(0).map((started) => started.stop()));
});

afterAll(async () => {
  await ocpp.close();
  await new Promise((resolve) => server.close(resolve));
});

describe("upgrade", () => {
  it.each([
    ["an unknown path", "/v201/21234567", basic(CHARGEBOX, SECRET), ["ocpp1.6"], 404],
    ["no ocpp1.6 subprotocol", `/v16/${CHARGEBOX}`, basic(CHARGEBOX, SECRET), ["ocpp2.0.1"], 400],
    ["no credentials", `/v16/${CHARGEBOX}`, {}, ["ocpp1.6"], 401],
    [
      "another charger's username",
      `/v16/${CHARGEBOX}`,
      basic("29999999", SECRET),
      ["ocpp1.6"],
      401,
    ],
    ["an unknown ChargeboxID", "/v16/29999999", basic("29999999", SECRET), ["ocpp1.6"], 404],
    ["a charger without a password", "/v16/NOHASH", basic("NOHASH", SECRET), ["ocpp1.6"], 401],
    ["a wrong password", `/v16/${CHARGEBOX}`, basic(CHARGEBOX, "wrong"), ["ocpp1.6"], 401],
  ])("refuses %s", async (_name, path, headers, protocols, status) => {
    await expect(upgradeStatus(path, headers, protocols)).resolves.toBe(status);
  });

  it("answers 503 when credentials cannot be checked, and stores nothing on refusals", async () => {
    const before = store.messages.length;
    vi.mocked(store.findCredentials).mockRejectedValueOnce(new Error("db down"));
    await expect(upgradeStatus(`/v16/${CHARGEBOX}`, basic(CHARGEBOX, SECRET))).resolves.toBe(503);
    expect(store.messages.length).toBe(before);
  });
});

describe("connections", () => {
  it("boots a charger and answers it", async () => {
    const zappi = await sim();
    expect(zappi.state.registration).toBe("Accepted");
    expect(ocpp.registry.get(CHARGEBOX)?.open).toBe(true);
    await vi.waitFor(() => {
      expect(store.saveOcppConfig).toHaveBeenCalled();
    });
    expect(zappi.state.config.FreeCharging).toBe(false);
  });

  it("replaces the first socket with the second", async () => {
    const first = await sim();
    const closed = first.waitForDisconnect();
    await sim();
    expect((await closed).code).toBe(REPLACED_CLOSE_CODE);
    expect(ocpp.registry.size).toBe(1);
  });

  it("ignores binary frames and terminates a peer that stops answering pings", async () => {
    const ws = new WebSocket(`${baseUrl}/v16/${CHARGEBOX}`, ["ocpp1.6"], {
      headers: basic(CHARGEBOX, SECRET),
      autoPong: false,
    });
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));
    expect(code).toBe(1006);
    await vi.waitFor(() => {
      expect(ocpp.registry.get(CHARGEBOX)).toBeUndefined();
    });
  });
});

describe("close", () => {
  it("closes charger sockets with 1001", async () => {
    const otherServer = createGatewayServer();
    const otherStore = fakeStore();
    otherStore.credentials.set(
      CHARGEBOX,
      store.credentials.get(CHARGEBOX) ?? { id: "", chargeboxId: "", ocppAuthHash: null },
    );
    const other = attachOcppServer(otherServer, {
      store: otherStore,
      budget: new ConfigWriteBudget(otherStore),
      logger: silentLogger,
      pingIntervalMs: 30_000,
    });
    await new Promise<void>((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
    const port = (otherServer.address() as AddressInfo).port;
    const zappi = await startZappiSim({
      url: `ws://127.0.0.1:${String(port)}/v16/`,
      chargeboxId: CHARGEBOX,
      secret: SECRET,
    });
    sims.push(zappi);
    const closed = zappi.waitForDisconnect();
    await other.close();
    expect((await closed).code).toBe(SHUTDOWN_CLOSE_CODE);
    await new Promise((resolve) => otherServer.close(resolve));
  });
});
