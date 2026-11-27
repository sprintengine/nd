import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ChargerControl } from "@nd/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../test/silent-logger.ts";
import { createControlServer } from "./control-server.ts";

const SECRET = "c".repeat(40);
const accepted = { ok: true, response: { status: "Accepted" } } as const;

const control = {
  remoteStart: vi.fn(() => Promise.resolve(accepted)),
  remoteStop: vi.fn(() => Promise.resolve(accepted)),
  changeConfiguration: vi.fn(() => Promise.resolve(accepted)),
  getConfiguration: vi.fn(() => Promise.resolve({ ok: true, response: {} })),
  triggerMessage: vi.fn(() => Promise.resolve(accepted)),
  reset: vi.fn(() => Promise.reject(new Error("boom"))),
  unlockConnector: vi.fn(() => Promise.resolve({ ok: false, reason: "offline", message: "x" })),
} as unknown as ChargerControl;

let server: Server;
let baseUrl = "";

const post = (path: string, body: unknown, secret = SECRET, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

beforeAll(async () => {
  server = createControlServer({ control, secret: SECRET, logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("control server", () => {
  it("runs a command and answers with its result", async () => {
    const response = await post("/v1/commands/remoteStart", { chargeboxId: "CB", idTag: "TAG" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(accepted);
    expect(control.remoteStart).toHaveBeenCalledWith({ chargeboxId: "CB", idTag: "TAG" });
    const offline = await post("/v1/commands/unlockConnector", { chargeboxId: "CB" });
    expect(await offline.json()).toMatchObject({ ok: false, reason: "offline" });
  });

  it("answers the health check without a secret", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses a missing or wrong secret with 401", async () => {
    expect((await post("/v1/commands/reset", { chargeboxId: "CB" }, "wrong")).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/commands/reset`, { method: "POST" })).status).toBe(401);
  });

  it("answers 404, 405, 400 and 413 for bad requests", async () => {
    expect((await post("/v1/commands/hardReset", {})).status).toBe(404);
    const get = await fetch(`${baseUrl}/v1/commands/reset`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await post("/v1/commands/reset", "{nope")).status).toBe(400);
    const invalid = await post("/v1/commands/remoteStart", {
      chargeboxId: "CB",
      idTag: "T".repeat(21),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "invalid request",
      issues: [{ path: ["idTag"] }],
    });
    expect((await post("/v1/commands/reset", { chargeboxId: "x".repeat(20_000) })).status).toBe(
      413,
    );
  });

  it("answers 500 when a command throws", async () => {
    const response = await post("/v1/commands/reset", { chargeboxId: "CB" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
  });
});
