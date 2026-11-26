import { describe, expect, it } from "vitest";

import {
  call,
  callError,
  callResult,
  createMessageId,
  isOcppErrorCode,
  MAX_MESSAGE_ID_LENGTH,
  MessageTypeId,
  OCPP_ERROR_CODES,
  parseFrame,
  parseFrameValue,
  serializeFrame,
} from "./framing.ts";

describe("createMessageId", () => {
  it("returns distinct UUIDs that fit the 36-character limit", () => {
    const a = createMessageId();
    const b = createMessageId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.length).toBeLessThanOrEqual(MAX_MESSAGE_ID_LENGTH);
  });
});

describe("OCPP_ERROR_CODES", () => {
  it("lists the ten OCPP-J 1.6 codes, with the specification's spelling", () => {
    expect(OCPP_ERROR_CODES).toHaveLength(10);
    expect(OCPP_ERROR_CODES).toContain("OccurenceConstraintViolation");
    expect(isOcppErrorCode("FormationViolation")).toBe(true);
    expect(isOcppErrorCode("OccurrenceConstraintViolation")).toBe(false);
    expect(isOcppErrorCode(42)).toBe(false);
  });
});

describe("serializeFrame and parseFrame", () => {
  it("round-trips a CALL", () => {
    const frame = call("Heartbeat", {}, "m1");
    const text = serializeFrame(frame);
    expect(text).toBe('[2,"m1","Heartbeat",{}]');
    expect(parseFrame(text)).toEqual({ ok: true, frame });
  });

  it("generates a message id for a CALL when none is given", () => {
    expect(call("Heartbeat", {}).messageId).toHaveLength(36);
  });

  it("round-trips a CALLRESULT", () => {
    const frame = callResult("m2", { currentTime: "2026-11-26T01:00:00Z" });
    const text = serializeFrame(frame);
    expect(text).toBe('[3,"m2",{"currentTime":"2026-11-26T01:00:00Z"}]');
    expect(parseFrame(text)).toEqual({ ok: true, frame });
  });

  it("round-trips a CALLERROR, defaulting description and details", () => {
    const frame = callError("m3", "NotSupported");
    const text = serializeFrame(frame);
    expect(text).toBe('[4,"m3","NotSupported","",{}]');
    expect(parseFrame(text)).toEqual({ ok: true, frame });
  });

  it("keeps a CALLERROR with a non-standard code as a GenericError", () => {
    expect(parseFrame('[4,"m4","VendorBoom","oops",{"a":1}]')).toEqual({
      ok: true,
      frame: {
        type: MessageTypeId.CallError,
        messageId: "m4",
        errorCode: "GenericError",
        errorDescription: "oops",
        errorDetails: { a: 1, originalErrorCode: "VendorBoom" },
      },
    });
  });
});

describe("parseFrame errors", () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ["not JSON", "[2,", { code: "ProtocolError" }],
    ["not an array", '{"a":1}', { code: "ProtocolError" }],
    ["an empty array", "[]", { code: "ProtocolError" }],
    ["an unknown type id", '[9,"m","X",{}]', { code: "ProtocolError" }],
    ["a numeric id", '[2,5,"Heartbeat",{}]', { code: "ProtocolError", messageTypeId: 2 }],
    ["an empty id", '[2,"","Heartbeat",{}]', { code: "ProtocolError" }],
    ["an overlong id", `[2,"${"x".repeat(37)}","Heartbeat",{}]`, { code: "ProtocolError" }],
    ["a short CALL", '[2,"m","Heartbeat"]', { code: "ProtocolError", messageId: "m" }],
    ["a CALL without action", '[2,"m","",{}]', { code: "ProtocolError", messageId: "m" }],
    ["a CALL with an array payload", '[2,"m","Heartbeat",[]]', { code: "FormationViolation" }],
    ["a CALL with a null payload", '[2,"m","Heartbeat",null]', { code: "FormationViolation" }],
    ["a long CALLRESULT", '[3,"m",{},{}]', { code: "ProtocolError", messageTypeId: 3 }],
    ["a CALLRESULT with a string payload", '[3,"m","x"]', { code: "FormationViolation" }],
    ["a short CALLERROR", '[4,"m","GenericError",""]', { code: "ProtocolError" }],
    [
      "a CALLERROR with bad details",
      '[4,"m","GenericError","",[]]',
      { code: "FormationViolation" },
    ],
  ];

  it.each(cases)("rejects %s", (_name, text, expected) => {
    const result = parseFrame(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(expected);
      expect(result.error.description).not.toBe("");
    }
  });

  it("parses already-decoded values", () => {
    expect(parseFrameValue([3, "m", {}]).ok).toBe(true);
    expect(parseFrameValue("nope").ok).toBe(false);
  });
});
