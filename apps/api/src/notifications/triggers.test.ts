import type { ChargerEvent } from "@nd/domain";
import { describe, expect, it } from "vitest";

import {
  eventKeyOf,
  notificationTriggerSchema,
  SESSION_ENDED_FALLBACK_MS,
  subjectKeyOf,
  triggersForChargerEvent,
} from "./triggers.ts";

const CHARGER_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const AT = "2027-01-12T22:00:00.000Z";
const base = { v: 1 as const, at: AT, chargerId: CHARGER_ID, chargeboxId: "zappi-1" };

describe("triggersForChargerEvent", () => {
  it("tells the driver and host when a session starts", () => {
    const event: ChargerEvent = {
      ...base,
      type: "session_started",
      sessionId: SESSION_ID,
      bookingId: BOOKING_ID,
      transactionId: 7,
      meterStartWh: 0,
    };
    expect(triggersForChargerEvent(event)).toEqual([
      { trigger: { type: "session_started", bookingId: BOOKING_ID, sessionId: SESSION_ID } },
    ]);
  });

  it("tells the driver at once on a stop and queues the host's fallback for later", () => {
    const event: ChargerEvent = {
      ...base,
      type: "session_stopped",
      sessionId: SESSION_ID,
      bookingId: BOOKING_ID,
      transactionId: 7,
      sessionStatus: "stopped",
      meterStopWh: 8000,
      kwh: 8,
      reason: null,
    };
    const [driver, host] = triggersForChargerEvent(event);
    expect(driver).toEqual({
      trigger: { type: "session_stopped", bookingId: BOOKING_ID, sessionId: SESSION_ID },
    });
    expect(host?.trigger.type).toBe("session_ended");
    expect(host?.startAfter?.getTime()).toBe(Date.parse(AT) + SESSION_ENDED_FALLBACK_MS);
  });

  it("reports a fault at once and an offline charger after 10 minutes", () => {
    const fault: ChargerEvent = {
      ...base,
      type: "fault",
      connectorId: 1,
      errorCode: "GroundFailure",
    };
    expect(triggersForChargerEvent(fault)).toEqual([
      {
        trigger: {
          type: "charger_faulted",
          chargerId: CHARGER_ID,
          errorCode: "GroundFailure",
          at: AT,
        },
      },
    ]);
    const offline: ChargerEvent = { ...base, type: "offline", lastHeartbeatAt: AT };
    expect(triggersForChargerEvent(offline)).toEqual([
      {
        trigger: { type: "charger_offline", chargerId: CHARGER_ID, lastHeartbeatAt: AT },
        startAfter: new Date("2027-01-12T22:10:00.000Z"),
      },
    ]);
  });

  it("ignores status, meter, boot and online events", () => {
    const events: ChargerEvent[] = [
      { ...base, type: "online" },
      { ...base, type: "boot", firmware: null },
      { ...base, type: "status", connectorId: 1, status: "Available", errorCode: "NoError" },
      {
        ...base,
        type: "meter",
        sessionId: SESSION_ID,
        transactionId: 7,
        ts: AT,
        energyWh: 10,
        powerW: 7000,
      },
    ];
    for (const event of events) expect(triggersForChargerEvent(event)).toEqual([]);
  });
});

describe("event keys", () => {
  it("key a trigger by its subject and type, and a charger alert by its spell or report", () => {
    expect(eventKeyOf({ type: "booking_approved", bookingId: BOOKING_ID })).toBe(
      `booking:${BOOKING_ID}:booking_approved`,
    );
    const settled = {
      type: "session_settled",
      bookingId: BOOKING_ID,
      sessionId: SESSION_ID,
    } as const;
    const ended = { ...settled, type: "session_ended" } as const;
    expect(subjectKeyOf(settled)).toBe(subjectKeyOf(ended));
    expect(eventKeyOf(settled)).not.toBe(eventKeyOf(ended));
    expect(
      eventKeyOf({ type: "charger_offline", chargerId: CHARGER_ID, lastHeartbeatAt: null }),
    ).toBe(`charger:${CHARGER_ID}:offline:never`);
    expect(
      eventKeyOf({ type: "charger_faulted", chargerId: CHARGER_ID, errorCode: "x", at: AT }),
    ).toBe(`charger:${CHARGER_ID}:fault:${AT}`);
  });

  it("validates trigger payloads", () => {
    expect(
      notificationTriggerSchema.safeParse({ type: "guest_arrived", bookingId: "x" }).success,
    ).toBe(false);
    expect(notificationTriggerSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
});
