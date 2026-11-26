import { describe, expect, it } from "vitest";

import {
  parseClientMessage,
  REALTIME_HEARTBEAT_SECONDS,
  REALTIME_PATH,
  serverMessageSchema,
  sessionStateSchema,
} from "./realtime.ts";

const state = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  status: "charging",
  kwh: 1.234,
  kw: 7.2,
  elapsed: 600,
  costSoFar: 42,
  currency: "EUR",
  lastSeenAt: "2027-01-12T22:10:00.000Z",
  startAt: "2027-01-12T22:00:00.000Z",
  stoppedAt: null,
  stopReason: null,
  failure: null,
};

describe("realtime contract", () => {
  it("serves /ws with a 30 s heartbeat", () => {
    expect(REALTIME_PATH).toBe("/ws");
    expect(REALTIME_HEARTBEAT_SECONDS).toBe(30);
  });

  it("describes a session's live state", () => {
    expect(sessionStateSchema.parse(state)).toEqual(state);
    expect(
      sessionStateSchema.safeParse({
        ...state,
        status: "failed",
        failure: { code: "start_timeout", message: "x" },
      }).success,
    ).toBe(true);
    expect(sessionStateSchema.safeParse({ ...state, costSoFar: 1.5 }).success).toBe(false);
  });

  it("parses every server message", () => {
    const messages = [
      { type: "ready", heartbeatSeconds: 30 },
      {
        type: "booking:update",
        bookingId: state.bookingId,
        status: "arrived",
        at: state.lastSeenAt,
      },
      { type: "session:update", ...state },
      {
        type: "charger:status",
        chargerId: state.sessionId,
        status: "online",
        connectorStatus: "Charging",
        errorCode: "NoError",
        at: state.lastSeenAt,
      },
      { type: "resync" },
      { type: "pong" },
    ];
    for (const message of messages) expect(serverMessageSchema.parse(message)).toEqual(message);
    expect(
      serverMessageSchema.safeParse({ type: "session:update", ...state, extra: 1 }).success,
    ).toBe(false);
  });

  it("parses a client's ping and ignores anything else", () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    expect(parseClientMessage('{"type":"subscribe"}')).toBeUndefined();
    expect(parseClientMessage("not json")).toBeUndefined();
  });
});
