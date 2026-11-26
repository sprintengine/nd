import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OcppError, OcppTimeoutError } from "./errors.ts";
import { callError, callResult, type Frame, parseFrame, serializeFrame } from "./framing.ts";
import {
  createCentralSystemPeer,
  createChargePointPeer,
  DEFAULT_CALL_TIMEOUT_MS,
  PendingCalls,
} from "./rpc.ts";

describe("PendingCalls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to a 30 s timeout", () => {
    expect(new PendingCalls().timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(30_000);
  });

  it("resolves a call by message id", async () => {
    const calls = new PendingCalls();
    const reply = calls.register("m1", "Heartbeat");
    expect(calls.has("m1")).toBe(true);
    expect(calls.settle(callResult("m1", { currentTime: "now" }))).toBe(true);
    await expect(reply).resolves.toEqual({ currentTime: "now" });
    expect(calls.size).toBe(0);
    expect(calls.settle(callResult("m1", {}))).toBe(false);
  });

  it("rejects a call answered with a CALLERROR", async () => {
    const calls = new PendingCalls();
    const reply = calls.register("m1", "Reset");
    calls.settle(callError("m1", "NotSupported", "no", { why: "x" }));
    await expect(reply).rejects.toMatchObject({
      name: "OcppError",
      code: "NotSupported",
      message: "no",
      details: { why: "x" },
      remote: true,
    });
  });

  it("times out after the default 30 s", async () => {
    const calls = new PendingCalls();
    const reply = calls.register("m1", "Reset");
    const assertion = expect(reply).rejects.toBeInstanceOf(OcppTimeoutError);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls.has("m1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(calls.size).toBe(0);
  });

  it("honours a per-call and a per-registry timeout", async () => {
    const calls = new PendingCalls({ timeoutMs: 100 });
    const a = calls.register("a", "Reset");
    const b = calls.register("b", "Reset", 50);
    const assertions = [expect(a).rejects.toThrow("100 ms"), expect(b).rejects.toThrow("50 ms")];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(assertions);
  });

  it("refuses a duplicate message id", async () => {
    const calls = new PendingCalls();
    void calls.register("m1", "Reset").catch(() => undefined);
    await expect(calls.register("m1", "Reset")).rejects.toThrow("already pending");
    calls.cancelAll(new Error("bye"));
  });

  it("cancels one or every call", async () => {
    const calls = new PendingCalls();
    const a = calls.register("a", "Reset");
    const b = calls.register("b", "Reset");
    expect(calls.cancel("a", new Error("one"))).toBe(true);
    expect(calls.cancel("a", new Error("again"))).toBe(false);
    calls.cancelAll(new Error("all"));
    await expect(a).rejects.toThrow("one");
    await expect(b).rejects.toThrow("all");
  });
});

/** A charge point peer wired to a central system peer, with a log of frames on the wire. */
function wiredPeers() {
  const wire: Frame[] = [];
  const errors: unknown[] = [];
  const pending: Promise<void>[] = [];
  const centralSystem = createCentralSystemPeer({
    send: (text, frame) => {
      wire.push(frame);
      pending.push(chargePoint.handleMessage(text));
    },
    onProtocolError: (error) => errors.push(error),
  });
  const chargePoint = createChargePointPeer({
    send: (text, frame) => {
      wire.push(frame);
      pending.push(centralSystem.handleMessage(text));
    },
    onProtocolError: (error) => errors.push(error),
  });
  return { centralSystem, chargePoint, wire, errors, flush: () => Promise.all(pending) };
}

describe("OcppPeer", () => {
  it("makes a typed call and gets the validated response", async () => {
    const { centralSystem, chargePoint, wire } = wiredPeers();
    centralSystem.handle("BootNotification", (request, context) => {
      expect(request.chargePointModel).toBe("Zappi");
      expect(context.action).toBe("BootNotification");
      return { status: "Accepted", currentTime: "2026-11-26T00:00:00Z", interval: 300 };
    });
    const response = await chargePoint.call("BootNotification", {
      chargePointVendor: "myenergi",
      chargePointModel: "Zappi",
    });
    expect(response).toEqual({
      status: "Accepted",
      currentTime: "2026-11-26T00:00:00Z",
      interval: 300,
    });
    expect(wire.map((frame) => frame.type)).toEqual([2, 3]);
    expect(wire[0]?.messageId).toHaveLength(36);
    expect(chargePoint.pendingCount).toBe(0);
  });

  it("takes handlers in the constructor and a caller-chosen message id", async () => {
    const sent: string[] = [];
    const chargePoint = createChargePointPeer({
      send: (text) => {
        sent.push(text);
      },
      handlers: { Reset: () => ({ status: "Accepted" }) },
    });
    await chargePoint.handleMessage('[2,"r1","Reset",{"type":"Soft"}]');
    expect(sent).toEqual(['[3,"r1",{"status":"Accepted"}]']);
    const reply = chargePoint.call("Heartbeat", {}, { messageId: "hb-1" });
    expect(sent[1]).toBe('[2,"hb-1","Heartbeat",{}]');
    await chargePoint.handleMessage('[3,"hb-1",{"currentTime":"2026-11-26T00:00:00Z"}]');
    await expect(reply).resolves.toEqual({ currentTime: "2026-11-26T00:00:00Z" });
  });

  it("refuses to send an invalid request", async () => {
    const send = vi.fn();
    const chargePoint = createChargePointPeer({ send });
    await expect(chargePoint.call("Authorize", { idTag: "x".repeat(21) })).rejects.toMatchObject({
      code: "PropertyConstraintViolation",
      remote: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a call when the response does not match the schema", async () => {
    const sent: string[] = [];
    const chargePoint = createChargePointPeer({ send: (text) => void sent.push(text) });
    const reply = chargePoint.call("Heartbeat", {});
    const [, messageId] = JSON.parse(sent[0] ?? "") as [number, string];
    await chargePoint.handleMessage(serializeFrame(callResult(messageId, { currentTime: "soon" })));
    await expect(reply).rejects.toMatchObject({ code: "PropertyConstraintViolation" });
  });

  it("rejects a call with the remote CALLERROR", async () => {
    const { centralSystem, chargePoint } = wiredPeers();
    centralSystem.handle("Authorize", () => {
      throw new OcppError("SecurityError", "not today", { details: { reason: "test" } });
    });
    await expect(chargePoint.call("Authorize", { idTag: "abc" })).rejects.toMatchObject({
      code: "SecurityError",
      message: "not today",
      details: { reason: "test" },
      remote: true,
    });
  });

  it("rejects a call when the transport fails to send", async () => {
    const chargePoint = createChargePointPeer({
      send: () => {
        throw new Error("socket closed");
      },
    });
    await expect(chargePoint.call("Heartbeat", {})).rejects.toThrow("socket closed");
    const failing = createChargePointPeer({
      // A transport might reject with something that is not an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      send: () => Promise.reject("nope"),
    });
    await expect(failing.call("Heartbeat", {})).rejects.toThrow("nope");
    expect(chargePoint.pendingCount).toBe(0);
  });

  it("times out an unanswered call", async () => {
    vi.useFakeTimers();
    try {
      const chargePoint = createChargePointPeer({ send: () => undefined, timeoutMs: 1_000 });
      const reply = chargePoint.call("Heartbeat", {});
      const assertion = expect(reply).rejects.toBeInstanceOf(OcppTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      const custom = chargePoint.call("Heartbeat", {}, { timeoutMs: 10 });
      const customAssertion = expect(custom).rejects.toThrow("10 ms");
      await vi.advanceTimersByTimeAsync(10);
      await customAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels outstanding calls", async () => {
    const chargePoint = createChargePointPeer({ send: () => undefined });
    const reply = chargePoint.call("Heartbeat", {});
    chargePoint.cancelAll(new Error("closed"));
    await expect(reply).rejects.toThrow("closed");
  });

  describe("inbound dispatch", () => {
    async function answer(text: string, register = true): Promise<unknown[]> {
      const sent: unknown[] = [];
      const chargePoint = createChargePointPeer({
        send: (raw) => void sent.push(JSON.parse(raw)),
      });
      if (register) {
        chargePoint.handle("ChangeConfiguration", (request) => {
          if (request.key === "Throw") {
            throw new Error("flash write failed");
          }
          if (request.key === "ThrowString") {
            throw "bare string" as unknown as Error;
          }
          if (request.key === "Bad") {
            return { status: "Maybe" } as unknown as { status: "Accepted" };
          }
          return { status: "Accepted" };
        });
      }
      await chargePoint.handleMessage(text);
      return sent[0] as unknown[];
    }

    async function answerHead(text: string, register = true): Promise<unknown[]> {
      return (await answer(text, register)).slice(0, 3);
    }

    it("answers a valid CALL with a CALLRESULT", async () => {
      expect(
        await answerHead('[2,"c1","ChangeConfiguration",{"key":"FreeCharging","value":"false"}]'),
      ).toEqual([3, "c1", { status: "Accepted" }]);
    });

    it("answers an unknown action with NotImplemented", async () => {
      expect(await answerHead('[2,"c1","ReserveNow",{}]')).toEqual([4, "c1", "NotImplemented"]);
      // BootNotification is an OCPP action, but not one a charge point receives.
      expect(await answerHead('[2,"c2","BootNotification",{}]')).toEqual([
        4,
        "c2",
        "NotImplemented",
      ]);
    });

    it("answers a known action without a handler with NotSupported", async () => {
      expect(await answerHead('[2,"c1","Reset",{"type":"Hard"}]', false)).toEqual([
        4,
        "c1",
        "NotSupported",
      ]);
    });

    it("maps schema failures to the right CALLERROR", async () => {
      expect(await answerHead('[2,"a","ChangeConfiguration",{"key":"FreeCharging"}]')).toEqual([
        4,
        "a",
        "OccurenceConstraintViolation",
      ]);
      expect(await answerHead('[2,"b","ChangeConfiguration",{"key":"k","value":5}]')).toEqual([
        4,
        "b",
        "TypeConstraintViolation",
      ]);
      expect(
        await answerHead(`[2,"c","ChangeConfiguration",{"key":"${"k".repeat(51)}","value":"v"}]`),
      ).toEqual([4, "c", "PropertyConstraintViolation"]);
      expect(
        await answerHead('[2,"d","ChangeConfiguration",{"key":"k","value":"v","x":1}]'),
      ).toEqual([4, "d", "FormationViolation"]);
      expect(await answerHead('[2,"e","ChangeConfiguration",[]]')).toEqual([
        4,
        "e",
        "FormationViolation",
      ]);
      expect(await answerHead('[2,"f","ChangeConfiguration"]')).toEqual([4, "f", "ProtocolError"]);
    });

    it("turns handler failures into InternalError", async () => {
      expect(await answer('[2,"a","ChangeConfiguration",{"key":"Throw","value":"v"}]')).toEqual([
        4,
        "a",
        "InternalError",
        "flash write failed",
        {},
      ]);
      expect(
        await answerHead('[2,"b","ChangeConfiguration",{"key":"ThrowString","value":"v"}]'),
      ).toEqual([4, "b", "InternalError"]);
      expect(
        (await answer('[2,"b","ChangeConfiguration",{"key":"ThrowString","value":"v"}]'))[3],
      ).toBe("bare string");
      expect(await answerHead('[2,"c","ChangeConfiguration",{"key":"Bad","value":"v"}]')).toEqual([
        4,
        "c",
        "InternalError",
      ]);
    });

    it("reports frames it cannot answer instead of replying", async () => {
      const errors: unknown[] = [];
      const send = vi.fn();
      const peer = createCentralSystemPeer({
        send,
        onProtocolError: (error) => errors.push(error),
      });
      await peer.handleMessage("not json");
      await peer.handleMessage('[3,"unknown",{}]');
      await peer.handleMessage('[4,"unknown","GenericError","",{}]');
      expect(send).not.toHaveBeenCalled();
      expect(errors).toHaveLength(3);
      // Without a listener these are silently dropped.
      await createCentralSystemPeer({ send }).handleMessage("[]");
    });

    it("reports a reply that could not be sent", async () => {
      const errors: unknown[] = [];
      const peer = createCentralSystemPeer({
        send: () => Promise.reject(new Error("gone")),
        handlers: {
          Heartbeat: () => ({ currentTime: "2026-11-26T00:00:00Z" }),
        },
        onProtocolError: (error) => errors.push(error),
      });
      await peer.handleMessage('[2,"h","Heartbeat",{}]');
      await createCentralSystemPeer({
        send: () => {
          throw "plain" as unknown as Error;
        },
        onProtocolError: (error) => errors.push(error),
      }).handleMessage('[2,"h","Heartbeat",{}]');
      expect(errors.map((error) => (error as Error).message)).toEqual(["gone", "plain"]);
    });
  });

  it("parses what it sends", async () => {
    const { centralSystem, chargePoint, wire, flush } = wiredPeers();
    chargePoint.handle("GetConfiguration", () => ({ configurationKey: [], unknownKey: ["X"] }));
    await expect(centralSystem.call("GetConfiguration", { key: ["X"] })).resolves.toEqual({
      configurationKey: [],
      unknownKey: ["X"],
    });
    await flush();
    for (const frame of wire) {
      expect(parseFrame(serializeFrame(frame))).toEqual({ ok: true, frame });
    }
  });
});
