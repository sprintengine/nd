import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { fakeStore } from "../test/fake-store.ts";
import { silentLogger } from "../test/silent-logger.ts";
import { ChargerConnection } from "./connection.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];
  send = vi.fn((text: string) => {
    this.sent.push(JSON.parse(text));
  });
  ping = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });
}

function setup(options: { callTimeoutMs?: number } = {}) {
  const ws = new FakeSocket();
  const store = fakeStore();
  const connection = new ChargerConnection({
    charger: { id: "c-1", chargeboxId: "21234567" },
    ws: ws as unknown as WebSocket,
    store,
    logger: silentLogger,
    ...options,
  });
  return { ws, store, connection };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChargerConnection inbound", () => {
  it("stores a CALL before answering it, and the answer after", async () => {
    const { ws, store, connection } = setup();
    connection.handle({ Heartbeat: () => ({ currentTime: "2027-01-13T22:00:00.000Z" }) });
    const after = vi.fn();
    connection.afterReply("m-1", after);
    await connection.receive(JSON.stringify([2, "m-1", "Heartbeat", {}]));
    expect(store.messages).toEqual([
      {
        chargerId: "c-1",
        direction: "in",
        messageType: "call",
        messageId: "m-1",
        action: "Heartbeat",
        payload: {},
      },
      {
        chargerId: "c-1",
        direction: "out",
        messageType: "call_result",
        messageId: "m-1",
        action: null,
        payload: { currentTime: "2027-01-13T22:00:00.000Z" },
      },
    ]);
    expect(ws.sent).toEqual([[3, "m-1", { currentTime: "2027-01-13T22:00:00.000Z" }]]);
    expect(after).toHaveBeenCalledOnce();
  });

  it("answers InternalError and runs no handler when the CALL cannot be stored", async () => {
    const { ws, store, connection } = setup();
    const handler = vi.fn(() => ({ currentTime: "2027-01-13T22:00:00.000Z" }));
    connection.handle({ Heartbeat: handler });
    store.failInboundCalls = true;
    await connection.receive(JSON.stringify([2, "m-2", "Heartbeat", {}]));
    expect(handler).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([[4, "m-2", "InternalError", "Message could not be stored", {}]]);
  });

  it("handles CALLs one at a time, in order", async () => {
    const { ws, connection } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    connection.handle({
      Heartbeat: async () => {
        order.push("heartbeat start");
        await new Promise<void>((resolve) => (release = resolve));
        order.push("heartbeat end");
        return { currentTime: "2027-01-13T22:00:00.000Z" };
      },
      StatusNotification: () => {
        order.push("status");
        return {};
      },
    });
    const first = connection.receive(JSON.stringify([2, "a", "Heartbeat", {}]));
    const second = connection.receive(
      JSON.stringify([
        2,
        "b",
        "StatusNotification",
        { connectorId: 1, errorCode: "NoError", status: "Available" },
      ]),
    );
    await vi.waitFor(() => {
      expect(order).toEqual(["heartbeat start"]);
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["heartbeat start", "heartbeat end", "status"]);
    expect(ws.sent.map((frame) => (frame as unknown[])[1])).toEqual(["a", "b"]);
  });

  it("stores malformed frames it can identify and answers them", async () => {
    const { ws, store, connection } = setup();
    await connection.receive(JSON.stringify([2, "m-3", "Heartbeat", "not-an-object"]));
    expect(store.messages[0]).toMatchObject({
      direction: "in",
      messageType: "call",
      messageId: "m-3",
      payload: { invalidFrame: '[2,"m-3","Heartbeat","not-an-object"]' },
    });
    expect(ws.sent[0]).toEqual([
      4,
      "m-3",
      "FormationViolation",
      "CALL payload must be a JSON object",
      {},
    ]);
    await connection.receive("not json");
    expect(store.messages).toHaveLength(2);
  });

  it("logs and continues when a reply cannot be stored", async () => {
    const { ws, store, connection } = setup();
    connection.handle({ Heartbeat: () => ({ currentTime: "2027-01-13T22:00:00.000Z" }) });
    store.recordMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db")) as typeof store.recordMessage;
    await connection.receive(JSON.stringify([2, "m-4", "Heartbeat", {}]));
    expect(ws.sent).toHaveLength(1);
  });
});

describe("ChargerConnection outbound", () => {
  it("stores the CALL and the charger's reply", async () => {
    const { ws, store, connection } = setup();
    const pending = connection.call("Reset", { type: "Soft" });
    await vi.waitFor(() => {
      expect(ws.sent).toHaveLength(1);
    });
    const [, messageId] = ws.sent[0] as [number, string];
    await connection.receive(JSON.stringify([3, messageId, { status: "Accepted" }]));
    await expect(pending).resolves.toEqual({ ok: true, response: { status: "Accepted" } });
    expect(
      store.messages.map((message) => [message.direction, message.messageType, message.messageId]),
    ).toEqual([
      ["out", "call", messageId],
      ["in", "call_result", messageId],
    ]);
  });

  it("reports a CALLERROR answer", async () => {
    const { ws, store, connection } = setup();
    const pending = connection.call("Reset", { type: "Soft" });
    await vi.waitFor(() => {
      expect(ws.sent).toHaveLength(1);
    });
    const [, messageId] = ws.sent[0] as [number, string];
    await connection.receive(JSON.stringify([4, messageId, "NotSupported", "no", {}]));
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: "call_error",
      errorCode: "NotSupported",
    });
    expect(store.messages[1]).toMatchObject({
      messageType: "call_error",
      payload: { errorCode: "NotSupported", errorDescription: "no", errorDetails: {} },
    });
  });

  it("reports no response after the timeout", async () => {
    vi.useFakeTimers();
    const { connection } = setup({ callTimeoutMs: 1_000 });
    const pending = connection.call("Reset", { type: "Soft" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "no_response" });
  });

  it("reports offline, and a failed send when the CALL cannot be stored", async () => {
    const { ws, store, connection } = setup();
    store.recordMessage = vi.fn(() => Promise.reject(new Error("db")));
    await expect(connection.call("Reset", { type: "Soft" })).resolves.toMatchObject({
      ok: false,
      reason: "send_failed",
    });
    expect(ws.sent).toHaveLength(0);
    ws.readyState = WebSocket.CLOSED;
    await expect(connection.call("Reset", { type: "Soft" })).resolves.toMatchObject({
      ok: false,
      reason: "offline",
    });
  });

  it("settles a reply that arrived before the close, and cancels the rest", async () => {
    const { ws, connection } = setup();
    const answered = connection.call("Reset", { type: "Soft" });
    const unanswered = connection.call("UnlockConnector", { connectorId: 1 });
    await vi.waitFor(() => {
      expect(ws.sent).toHaveLength(2);
    });
    const [, messageId] = ws.sent[0] as [number, string];
    const reply = connection.receive(JSON.stringify([3, messageId, { status: "Accepted" }]));
    ws.readyState = WebSocket.CLOSED;
    await connection.closed();
    await reply;
    await expect(answered).resolves.toMatchObject({ ok: true });
    await expect(unanswered).resolves.toMatchObject({ ok: false, reason: "send_failed" });
  });

  it("fails a call whose socket closed while it was being stored", async () => {
    const { ws, store, connection } = setup();
    store.recordMessage = vi.fn(() => {
      ws.readyState = WebSocket.CLOSED;
      return Promise.resolve();
    });
    await expect(connection.call("Reset", { type: "Soft" })).resolves.toMatchObject({
      ok: false,
      reason: "send_failed",
    });
  });
});

describe("ChargerConnection keep-alive", () => {
  it("pings, and terminates after a missed pong", () => {
    const { ws, connection } = setup();
    expect(connection.heartbeatTick()).toBe(true);
    expect(ws.ping).toHaveBeenCalledOnce();
    ws.emit("pong");
    expect(connection.heartbeatTick()).toBe(true);
    expect(connection.heartbeatTick()).toBe(false);
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it("closes and terminates the socket", () => {
    const { ws, connection } = setup();
    connection.close(1001, "bye");
    expect(ws.close).toHaveBeenCalledWith(1001, "bye");
    connection.close(1001, "again");
    expect(ws.close).toHaveBeenCalledOnce();
    connection.terminate();
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(connection.open).toBe(false);
  });
});
