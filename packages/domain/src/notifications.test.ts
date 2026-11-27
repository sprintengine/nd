import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY,
  NOTIFICATION_KINDS,
  notificationAllowed,
  pushDataSchema,
} from "./notifications.ts";

describe("notification preferences", () => {
  it("turns every category on by default", () => {
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFERENCES).sort()).toEqual(
      [...NOTIFICATION_CATEGORIES].sort(),
    );
    for (const kind of NOTIFICATION_KINDS) {
      expect(notificationAllowed(kind, DEFAULT_NOTIFICATION_PREFERENCES)).toBe(true);
    }
  });

  it("gives every category at least one notification", () => {
    const used = new Set(Object.values(NOTIFICATION_CATEGORY));
    expect([...used].sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
  });

  it("suppresses only the notifications of a category turned off", () => {
    const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, chargerAlerts: false };
    expect(notificationAllowed("charger_faulted", preferences)).toBe(false);
    expect(notificationAllowed("charger_offline", preferences)).toBe(false);
    expect(notificationAllowed("booking_requested", preferences)).toBe(true);
  });
});

describe("push data", () => {
  it("carries the kind and ids, and nothing else", () => {
    const bookingId = "6f1c3f4e-2b1a-4c1d-9e8f-0a1b2c3d4e5f";
    expect(pushDataSchema.parse({ kind: "guest_arrived", bookingId })).toEqual({
      kind: "guest_arrived",
      bookingId,
    });
    expect(
      pushDataSchema.safeParse({ kind: "guest_arrived", bookingId, name: "Aoife" }).success,
    ).toBe(false);
    expect(pushDataSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });
});
