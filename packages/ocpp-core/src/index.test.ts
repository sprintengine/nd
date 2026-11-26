import { describe, expect, it } from "vitest";

import { MessageTypeId, OCPP16_SUBPROTOCOL, selectSubprotocol } from "./index.ts";

describe("selectSubprotocol", () => {
  it("accepts ocpp1.6 when it is offered", () => {
    expect(selectSubprotocol(["ocpp2.0.1", " ocpp1.6"])).toBe(OCPP16_SUBPROTOCOL);
  });

  it("refuses when ocpp1.6 is not offered", () => {
    expect(selectSubprotocol(["ocpp2.0.1"])).toBeUndefined();
    expect(selectSubprotocol([])).toBeUndefined();
  });
});

describe("MessageTypeId", () => {
  it("matches the OCPP-J framing", () => {
    expect(MessageTypeId).toEqual({ Call: 2, CallResult: 3, CallError: 4 });
  });
});
