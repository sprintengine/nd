import { describe, expect, it } from "vitest";

import {
  authorizationStatus,
  chargerStatusAfterNotification,
  decideIdTag,
  deliveredKwh,
  isFault,
  MAX_TRANSACTION_ID,
  PLUG_AND_CHARGE_ID_TAG,
  randomTransactionId,
  sessionStatusAfterNotification,
  type TagFacts,
} from "./rules.ts";

const none: TagFacts = { booking: undefined, hostIdTag: "HOST1", paidWindow: false };
const booking = (status: "confirmed" | "arrived" | "active" | "completed", slotOpen = true) => ({
  ...none,
  booking: { id: "b-1", status, slotOpen },
});

describe("decideIdTag", () => {
  it("accepts a booking that is arrived or active inside its slot", () => {
    expect(decideIdTag("TAG", booking("arrived"))).toEqual({ kind: "booking", bookingId: "b-1" });
    expect(decideIdTag("TAG", booking("active"))).toEqual({ kind: "booking", bookingId: "b-1" });
  });

  it("refuses a booking outside its slot or in another status", () => {
    expect(decideIdTag("TAG", booking("arrived", false))).toEqual({ kind: "invalid" });
    expect(decideIdTag("TAG", booking("confirmed"))).toEqual({ kind: "invalid" });
    expect(decideIdTag("TAG", booking("completed"))).toEqual({ kind: "invalid" });
  });

  it("starts a host session with the host's tag or plug and charge, blocked in a paid window", () => {
    expect(decideIdTag("host1", none)).toEqual({ kind: "host", blocked: false });
    expect(decideIdTag(PLUG_AND_CHARGE_ID_TAG, { ...none, hostIdTag: null })).toEqual({
      kind: "host",
      blocked: false,
    });
    expect(decideIdTag("HOST1", { ...none, paidWindow: true })).toEqual({
      kind: "host",
      blocked: true,
    });
  });

  it("refuses anything else", () => {
    expect(decideIdTag("RANDOM", none)).toEqual({ kind: "invalid" });
    expect(decideIdTag("RANDOM", { ...none, hostIdTag: null })).toEqual({ kind: "invalid" });
  });

  it("maps decisions to idTagInfo statuses", () => {
    expect(authorizationStatus({ kind: "booking", bookingId: "b" })).toBe("Accepted");
    expect(authorizationStatus({ kind: "host", blocked: false })).toBe("Accepted");
    expect(authorizationStatus({ kind: "host", blocked: true })).toBe("Blocked");
    expect(authorizationStatus({ kind: "invalid" })).toBe("Invalid");
  });
});

describe("charger status", () => {
  it("treats an error code or the Faulted status as a fault", () => {
    expect(isFault("NoError", "Available")).toBe(false);
    expect(isFault("GroundFailure", "Available")).toBe(true);
    expect(isFault("NoError", "Faulted")).toBe(true);
  });

  it.each([
    ["online", "GroundFailure", "Faulted", "faulted"],
    ["faulted", "NoError", "Available", "online"],
    ["offline", "NoError", "Available", "online"],
    ["online", "NoError", "Charging", "online"],
    ["onboarding", "GroundFailure", "Faulted", "onboarding"],
  ] as const)("%s + %s/%s -> %s", (current, errorCode, status, next) => {
    expect(chargerStatusAfterNotification(current, errorCode, status)).toBe(next);
  });
});

describe("session status", () => {
  it.each([
    ["charging", "SuspendedEV", "suspended_ev"],
    ["charging", "SuspendedEVSE", "suspended_evse"],
    ["suspended_ev", "Charging", "charging"],
    ["charging", "Charging", undefined],
    ["starting", "Charging", undefined],
    ["charging", "Finishing", undefined],
    ["stopped", "Charging", undefined],
  ] as const)("%s + %s -> %s", (current, status, next) => {
    expect(sessionStatusAfterNotification(current, status)).toBe(next);
  });
});

describe("deliveredKwh", () => {
  it("is the register delta in kWh, or null when it went backwards", () => {
    expect(deliveredKwh(1000, 8250)).toBe(7.25);
    expect(deliveredKwh(1000, 1000)).toBe(0);
    expect(deliveredKwh(1000, 999)).toBeNull();
  });
});

describe("randomTransactionId", () => {
  it("is a positive 32-bit integer", () => {
    for (let index = 0; index < 100; index += 1) {
      const id = randomTransactionId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThan(MAX_TRANSACTION_ID);
    }
  });
});
