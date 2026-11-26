import { describe, expect, it, vi } from "vitest";

import {
  CHARGER_CONTROL_COMMANDS,
  chargerControlCommands,
  ChargerControlError,
  controlCommandPath,
  controlResultSchema,
  createChargerControlClient,
} from "./charger-control.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ChargerControl contract", () => {
  it("lists the seven commands", () => {
    expect(CHARGER_CONTROL_COMMANDS).toEqual([
      "remoteStart",
      "remoteStop",
      "changeConfiguration",
      "getConfiguration",
      "triggerMessage",
      "reset",
      "unlockConnector",
    ]);
    expect(controlCommandPath("remoteStop")).toBe("/v1/commands/remoteStop");
  });

  it("validates requests", () => {
    const { remoteStart, triggerMessage } = chargerControlCommands;
    expect(
      remoteStart.request.safeParse({ chargeboxId: "cb", idTag: "T".repeat(20) }).success,
    ).toBe(true);
    expect(
      remoteStart.request.safeParse({ chargeboxId: "cb", idTag: "T".repeat(21) }).success,
    ).toBe(false);
    expect(
      triggerMessage.request.safeParse({ chargeboxId: "cb", requestedMessage: "Diagnostics" })
        .success,
    ).toBe(false);
  });

  it("describes results as a charger response or a failure", () => {
    const schema = controlResultSchema("reset");
    expect(schema.safeParse({ ok: true, response: { status: "Accepted" } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, reason: "offline", message: "x" }).success).toBe(true);
    expect(schema.safeParse({ ok: true, response: { status: "Maybe" } }).success).toBe(false);
  });
});

describe("createChargerControlClient", () => {
  it("posts each command with the bearer secret and returns the result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ ok: true, response: { status: "Accepted" } })),
    );
    const client = createChargerControlClient({
      baseUrl: "http://gateway.internal:9100/",
      secret: "s".repeat(32),
      fetch,
    });
    await expect(client.remoteStart({ chargeboxId: "cb", idTag: "TAG" })).resolves.toEqual({
      ok: true,
      response: { status: "Accepted" },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://gateway.internal:9100/v1/commands/remoteStart");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
    expect(JSON.parse(init?.body as string)).toEqual({ chargeboxId: "cb", idTag: "TAG" });
  });

  it("returns failures as results", async () => {
    const client = createChargerControlClient({
      baseUrl: "http://gw",
      secret: "x",
      fetch: () =>
        Promise.resolve(jsonResponse({ ok: false, reason: "no_response", message: "t" })),
    });
    await expect(client.reset({ chargeboxId: "cb" })).resolves.toEqual({
      ok: false,
      reason: "no_response",
      message: "t",
    });
  });

  it("throws ChargerControlError when the gateway is unreachable", async () => {
    const client = createChargerControlClient({
      baseUrl: "http://gw",
      secret: "x",
      timeoutMs: 10,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = await client.reset({ chargeboxId: "cb" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChargerControlError);
    expect((error as ChargerControlError).status).toBeUndefined();
  });

  it("throws on an HTTP error, invalid JSON or an unexpected body", async () => {
    const answers = [
      new Response("", { status: 401 }),
      new Response("not json", { status: 200 }),
      jsonResponse({ ok: "maybe" }),
    ];
    const client = createChargerControlClient({
      baseUrl: "http://gw",
      secret: "x",
      fetch: () => Promise.resolve(answers.shift() ?? jsonResponse({})),
    });
    await expect(client.unlockConnector({ chargeboxId: "cb" })).rejects.toMatchObject({
      status: 401,
    });
    await expect(client.unlockConnector({ chargeboxId: "cb" })).rejects.toThrow(/invalid JSON/);
    await expect(client.unlockConnector({ chargeboxId: "cb" })).rejects.toThrow(/unexpected body/);
  });

  it("uses the global fetch by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: false, reason: "offline", message: "offline" }));
    const client = createChargerControlClient({ baseUrl: "http://gw", secret: "x" });
    await expect(client.getConfiguration({ chargeboxId: "cb" })).resolves.toMatchObject({
      reason: "offline",
    });
    spy.mockRestore();
  });
});
