import { describe, expect, it } from "vitest";

import {
  BOOKING_STATUSES,
  PAYMENT_STATUSES,
  SESSION_STATUSES,
  TRANSFER_STATUSES,
} from "./status.ts";
import {
  BOOKING_TRANSITIONS,
  canTransitionBooking,
  canTransitionPayment,
  canTransitionSession,
  canTransitionTransfer,
  isCancellable,
  PAYMENT_TRANSITIONS,
  SESSION_TRANSITIONS,
  TRANSFER_TRANSITIONS,
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
    ["charging", "needs_host_confirmation"],
    ["suspended_ev", "needs_host_confirmation"],
    ["needs_host_confirmation", "reconciled"],
    ["needs_host_confirmation", "needs_review"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionSession(from, to)).toBe(true);
  });

  it.each([
    ["starting", "stopped"],
    ["stopped", "charging"],
    ["reconciled", "needs_review"],
    ["failed", "starting"],
    ["starting", "needs_host_confirmation"],
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
    ["pending_authorisation", "authorised"],
    ["pending_authorisation", "card_saved"],
    ["card_saved", "authorised"],
    ["card_saved", "failed"],
    ["authorised", "captured"],
    ["authorised", "cancelled"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(true);
  });

  it.each([
    ["captured", "cancelled"],
    ["cancelled", "authorised"],
    ["card_saved", "captured"],
    ["failed", "authorised"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(false);
  });
});

describe("transfer transitions", () => {
  it("cover every status", () => {
    expect(Object.keys(TRANSFER_TRANSITIONS).sort()).toEqual([...TRANSFER_STATUSES].sort());
  });

  it.each([
    ["pending", "held"],
    ["pending", "sent"],
    ["held", "sent"],
    ["sent", "reversed"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransitionTransfer(from, to)).toBe(true);
  });

  it.each([
    ["sent", "held"],
    ["reversed", "sent"],
  ] as const)("refuse %s -> %s", (from, to) => {
    expect(canTransitionTransfer(from, to)).toBe(false);
  });
});

describe("cancellable bookings", () => {
  it("are requested or confirmed only", () => {
    expect(BOOKING_STATUSES.filter(isCancellable)).toEqual(["requested", "confirmed"]);
  });
});
