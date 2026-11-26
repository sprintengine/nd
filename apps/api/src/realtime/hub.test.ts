import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeHubSocket } from "../../test/hub-socket.ts";
import { createRealtimeHub, type RealtimeHub, SESSION_ENDED_CLOSE_CODE } from "./hub.ts";

const warnings: string[] = [];
let hub: RealtimeHub;
const valid = () => Promise.resolve(true);

beforeEach(() => {
  vi.useFakeTimers();
  warnings.length = 0;
  hub = createRealtimeHub({
    maxConnectionsPerUser: 2,
    heartbeatMs: 1_000,
    maxBufferedBytes: 100,
    revalidateEveryBeats: 2,
    log: { warn: (_details, message) => warnings.push(message) },
  });
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

describe("realtime hub", () => {
  it("sends each user's messages to their connections only, once per user", () => {
    const [a1, a2, b] = [new FakeHubSocket(), new FakeHubSocket(), new FakeHubSocket()];
    expect(hub.add("aoife", a1, valid)).toBe(true);
    expect(hub.add("aoife", a2, valid)).toBe(true);
    expect(hub.add("aoife", new FakeHubSocket(), valid)).toBe(false);
    hub.add("cian", b, valid);
    expect(hub.count("aoife")).toBe(2);
    expect(hub.anyConnected(["niamh", "cian"])).toBe(true);
    expect(hub.anyConnected(["niamh"])).toBe(false);

    hub.send(["aoife", "aoife"], { type: "resync" });
    expect(a1.sent).toEqual([{ type: "resync" }]);
    expect(a2.sent).toEqual([{ type: "resync" }]);
    expect(b.sent).toEqual([]);
    hub.broadcast({ type: "pong" });
    expect(b.sent).toEqual([{ type: "pong" }]);

    a1.emit("close");
    expect(hub.count("aoife")).toBe(1);
    a2.close();
    expect(hub.count("aoife")).toBe(0);
    hub.sendTo(a2, { type: "pong" });
    expect(a2.sent).toEqual([{ type: "resync" }, { type: "pong" }]);
  });

  it("skips sockets that are not open and drops one that cannot keep up", () => {
    const slow = new FakeHubSocket();
    const closing = new FakeHubSocket();
    hub.add("aoife", slow, valid);
    hub.add("cian", closing, valid);
    closing.readyState = 2;
    slow.bufferedAmount = 101;
    hub.broadcast({ type: "resync" });
    expect(closing.sent).toEqual([]);
    expect(slow.terminated).toBe(true);
    expect(hub.count("aoife")).toBe(0);
    expect(warnings).toEqual(["realtime client is not keeping up; dropped"]);
  });

  it("pings every heartbeat and drops a connection that missed a pong", () => {
    const answering = new FakeHubSocket();
    const silent = new FakeHubSocket();
    hub.add("aoife", answering, valid);
    hub.add("cian", silent, valid);
    vi.advanceTimersByTime(1_000);
    expect([answering.pings, silent.pings]).toEqual([1, 1]);
    answering.emit("pong");
    vi.advanceTimersByTime(1_000);
    expect(silent.terminated).toBe(true);
    expect(answering.terminated).toBe(false);
    expect(hub.count("cian")).toBe(0);
  });

  it("closes a connection whose sign-in ended", async () => {
    const socket = new FakeHubSocket();
    const failing = new FakeHubSocket();
    let signedIn = true;
    hub.add("aoife", socket, () => Promise.resolve(signedIn));
    hub.add("cian", failing, () => Promise.reject(new Error("db down")));
    const keepAlive = () => {
      socket.emit("pong");
      failing.emit("pong");
    };
    vi.advanceTimersByTime(1_000);
    keepAlive();
    signedIn = false;
    vi.advanceTimersByTime(1_000);
    await vi.runOnlyPendingTimersAsync();
    expect(socket.closed).toEqual({ code: SESSION_ENDED_CLOSE_CODE, reason: "session ended" });
    expect(failing.closed).toBeUndefined();
  });

  it("closes everything when it closes", () => {
    const socket = new FakeHubSocket();
    hub.add("aoife", socket, valid);
    hub.close();
    expect(socket.closed?.code).toBe(1001);
    expect(hub.count("aoife")).toBe(0);
  });
});
