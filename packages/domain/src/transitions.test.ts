import { describe, expect, it } from "vitest";

import { BOOKING_STATUSES, PAYMENT_STATUSES, REFUND_STATUSES, SESSION_STATUSES } from "./status.ts";
import {
  BOOKING_TRANSITIONS,
  canTransitionBooking,
  canTransitionPayment,
  canTransitionRefund,
  canTransitionSession,
  isCancellable,
  PAYMENT_TRANSITIONS,
  REFUND_TRANSITIONS,
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
    ["arrived", "completed"],
    ["arrived", "no_show"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionBooking(from, to)).toBe(true);
  });

  it.each([
    ["active", "cancelled"],
    ["completed", "active"],
    ["requested", "active"],
    ["arrived", "cancelled"],
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
    ["charging", "reconciled"],
    ["suspended_ev", "needs_review"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionSession(from, to)).toBe(true);
  });

  it.each([
    ["starting", "stopped"],
    ["stopped", "charging"],
    ["reconciled", "needs_review"],
    ["failed", "starting"],
    ["starting", "reconciled"],
    ["needs_review", "stopped"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionSession(from, to)).toBe(false);
  });
});

describe("payment transitions", () => {
  it("cover every status", () => {
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  it.each([
    ["pending", "paid"],
    ["pending", "authorised"],
    ["pending", "failed"],
    ["authorised", "paid"],
    ["authorised", "cancelled"],
    ["authorised", "failed"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(true);
  });

  it.each([
    ["paid", "cancelled"],
    ["cancelled", "authorised"],
    ["failed", "paid"],
    ["paid", "pending"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(false);
  });
});

describe("refund transitions", () => {
  it("cover every status", () => {
    expect(Object.keys(REFUND_TRANSITIONS).sort()).toEqual([...REFUND_STATUSES].sort());
  });

  it.each([
    ["pending", "succeeded"],
    ["pending", "failed"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionRefund(from, to)).toBe(true);
  });

  it.each([
    ["succeeded", "pending"],
    ["failed", "succeeded"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionRefund(from, to)).toBe(false);
  });
});

describe("cancellable bookings", () => {
  it("are requested or confirmed only", () => {
    expect(BOOKING_STATUSES.filter(isCancellable)).toEqual(["requested", "confirmed"]);
  });
});
