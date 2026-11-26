import { describe, expect, it } from "vitest";

import { BOOKING_ID } from "../../test/booking-detail.ts";
import { IN_SLOT, SESSION_ID, sessionContext } from "../../test/session-context.ts";
import { scheduledStartPending, sessionState } from "./view.ts";

const scheduled = {
  scheduledStartAt: new Date("2027-01-13T00:00:00Z"),
  pluggedInAt: new Date("2027-01-12T22:01:00Z"),
};

describe("sessionState", () => {
  it("is not_started before any start", () => {
    expect(sessionState(sessionContext(), IN_SLOT)).toEqual({
      bookingId: BOOKING_ID,
      sessionId: null,
      status: "not_started",
      kwh: null,
      kw: null,
      elapsed: 0,
      costSoFar: 0,
      currency: "EUR",
      lastSeenAt: null,
      startAt: null,
      stoppedAt: null,
      stopReason: null,
      failure: null,
    });
  });

  it("shows a charging session's live figures", () => {
    const state = sessionState(
      sessionContext({
        session: {
          status: "charging",
          ocppTransactionId: 7,
          meterStartWh: 1_000,
          startedAt: new Date("2027-01-12T22:02:00Z"),
        },
        meter: { ts: new Date("2027-01-12T22:09:00Z"), energyWh: 1_840, powerW: 7_100 },
      }),
      IN_SLOT,
    );
    expect(state).toMatchObject({
      sessionId: SESSION_ID,
      status: "charging",
      kwh: 0.84,
      kw: 7.1,
      elapsed: 480,
      // 8 minutes bill as 10: 10 × 250 / 60 = 41.7 → 42 cents.
      costSoFar: 42,
      lastSeenAt: "2027-01-12T22:09:00.000Z",
      startAt: "2027-01-12T22:02:00.000Z",
    });
  });

  it("shows a stopped session's totals, without power", () => {
    const state = sessionState(
      sessionContext({
        booking: { status: "completed" },
        session: {
          status: "stopped",
          meterStartWh: 1_000,
          kwh: 5.5,
          startedAt: new Date("2027-01-12T22:00:00Z"),
          stoppedAt: new Date("2027-01-12T23:00:00Z"),
          stopReason: "EVDisconnected",
        },
        meter: { ts: new Date("2027-01-12T22:59:00Z"), energyWh: 6_400, powerW: 7_000 },
      }),
      new Date("2027-01-13T09:00:00Z"),
    );
    expect(state).toMatchObject({
      status: "stopped",
      kwh: 5.5,
      kw: null,
      elapsed: 3600,
      costSoFar: 250,
      lastSeenAt: "2027-01-12T23:00:00.000Z",
      stoppedAt: "2027-01-12T23:00:00.000Z",
      stopReason: "EVDisconnected",
    });
  });

  it("explains a failed start, and shows no cost for it", () => {
    expect(
      sessionState(
        sessionContext({ session: { status: "failed", stopReason: "start_timeout" } }),
        IN_SLOT,
      ),
    ).toMatchObject({
      status: "failed",
      costSoFar: 0,
      stopReason: null,
      failure: {
        code: "start_timeout",
        message: expect.stringMatching(/didn't respond/) as string,
      },
    });
    expect(
      sessionState(sessionContext({ session: { status: "failed", stopReason: "Other" } }), IN_SLOT)
        .failure,
    ).toBeNull();
  });

  it("bills a scheduled start from the plug-in while it waits", () => {
    const context = sessionContext({
      booking: scheduled,
      session: { status: "failed", stopReason: "rejected" },
    });
    expect(scheduledStartPending(context)).toBe(false);
    const waiting = sessionContext({
      booking: scheduled,
      session: { status: "failed", createdAt: new Date("2027-01-12T22:00:00Z") },
    });
    expect(scheduledStartPending(waiting)).toBe(true);
    expect(sessionState(waiting, IN_SLOT)).toMatchObject({
      status: "scheduled",
      sessionId: null,
      startAt: "2027-01-13T00:00:00.000Z",
      elapsed: 540,
      costSoFar: 42,
      failure: null,
      lastSeenAt: null,
    });
  });

  it("knows a scheduled start is no longer pending once the booking moves on", () => {
    expect(
      scheduledStartPending(sessionContext({ booking: { ...scheduled, status: "active" } })),
    ).toBe(false);
    expect(
      scheduledStartPending(
        sessionContext({ booking: { ...scheduled, pluggedInAt: null }, session: {} }),
      ),
    ).toBe(false);
    expect(scheduledStartPending(sessionContext({ booking: scheduled }))).toBe(true);
  });
});
