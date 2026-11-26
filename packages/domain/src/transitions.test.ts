import { describe, expect, it } from "vitest";

import { BOOKING_STATUSES, SESSION_STATUSES } from "./status.ts";
import {
  BOOKING_TRANSITIONS,
  canTransitionBooking,
  canTransitionSession,
  SESSION_TRANSITIONS,
} from "./transitions.ts";

describe("booking transitions", () => {
  it("cover every status", () => {
    expect(Object.keys(BOOKING_TRANSITIONS).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it.each([
    ["requested", "confirmed"],
    ["confirmed", "arrived"],
    ["arrived", "active"],
    ["active", "completed"],
    ["confirmed", "no_show"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(true);
  });

  it.each([
    ["active", "cancelled"],
    ["completed", "active"],
    ["requested", "active"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(false);
  });
});

describe("session transitions", () => {
  it("cover every status", () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it.each([
    ["starting", "charging"],
    ["starting", "failed"],
    ["charging", "suspended_ev"],
    ["suspended_evse", "charging"],
    ["suspended_ev", "stopped"],
    ["stopped", "reconciled"],
    ["needs_review", "reconciled"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionSession(from, to)).toBe(true);
  });

  it.each([
    ["starting", "stopped"],
    ["stopped", "charging"],
    ["reconciled", "needs_review"],
    ["failed", "starting"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionSession(from, to)).toBe(false);
  });
});
