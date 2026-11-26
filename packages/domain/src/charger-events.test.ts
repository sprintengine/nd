import { describe, expect, it } from "vitest";

import {
  CHARGER_EVENT_TYPES,
  CHARGER_EVENT_VERSION,
  CHARGER_EVENTS_CHANNEL,
  type ChargerEvent,
  chargerEventSchema,
  parseChargerEvent,
} from "./charger-events.ts";

const base = {
  v: CHARGER_EVENT_VERSION,
  at: "2027-01-13T22:00:00.000Z",
  chargerId: "8f2b8a4e-3d0c-4c4e-9d55-2f3c1b7a9e10",
  chargeboxId: "21234567",
} as const;
const sessionId = "0d7c6a8e-1f8b-4b8e-8a3d-6f1d2c3b4a59";
const bookingId = "5b1e9c2d-7a4f-4e6b-9c8d-1a2b3c4d5e6f";

const examples: ChargerEvent[] = [
  { ...base, type: "boot", firmware: "5.794" },
  {
    ...base,
    type: "status",
    connectorId: 1,
    status: "SuspendedEV",
    errorCode: "NoError",
    sessionId,
    sessionStatus: "suspended_ev",
  },
  { ...base, type: "fault", connectorId: 1, errorCode: "GroundFailure", info: "RCD" },
  { ...base, type: "offline", lastHeartbeatAt: null },
  { ...base, type: "online" },
  { ...base, type: "session_started", sessionId, bookingId, transactionId: 42, meterStartWh: 1000 },
  {
    ...base,
    type: "meter",
    sessionId,
    transactionId: 42,
    ts: base.at,
    energyWh: 1500,
    powerW: 7200,
  },
  {
    ...base,
    type: "session_stopped",
    sessionId,
    bookingId,
    transactionId: 42,
    sessionStatus: "stopped",
    meterStopWh: 9000,
    kwh: 8,
    reason: "Remote",
  },
];

describe("charger events", () => {
  it("publish on charger_events", () => {
    expect(CHARGER_EVENTS_CHANNEL).toBe("charger_events");
  });

  it("have an example for every type", () => {
    expect(examples.map((event) => event.type)).toEqual([...CHARGER_EVENT_TYPES]);
  });

  it.each(examples)("round-trip $type through JSON", (event) => {
    expect(parseChargerEvent(JSON.stringify(event))).toEqual(event);
  });

  it("reject other versions, unknown types and extra fields", () => {
    expect(chargerEventSchema.safeParse({ ...base, v: 2, type: "online" }).success).toBe(false);
    expect(chargerEventSchema.safeParse({ ...base, type: "reboot" }).success).toBe(false);
    expect(chargerEventSchema.safeParse({ ...base, type: "online", idTag: "x" }).success).toBe(
      false,
    );
  });

  it("parse to undefined when the payload is missing, not JSON or invalid", () => {
    expect(parseChargerEvent(undefined)).toBeUndefined();
    expect(parseChargerEvent("{nope")).toBeUndefined();
    expect(parseChargerEvent(JSON.stringify({ type: "boot" }))).toBeUndefined();
  });
});
