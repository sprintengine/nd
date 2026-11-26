import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, HOST_USER_ID } from "../../test/booking-detail.ts";
import {
  SESSION_ID,
  settlementServices,
  settlementSession,
  SLOT,
} from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";
import { closeStaleSession, confirmSession, disputeSession } from "./confirmation.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");

const AFTER_GRACE = new Date(SLOT.end.getTime() + 11 * 60_000);
const LAST = { ts: new Date(SLOT.start.getTime() + 210 * 60_000), energyWh: 22_000 };
let env: ReturnType<typeof settlementServices>;

function open(overrides: Parameters<typeof settlementSession>[0] = {}) {
  vi.mocked(data.findSettlementSession).mockResolvedValue(
    settlementSession({
      session: { status: "charging", stoppedAt: null, meterStopWh: null, kwh: null },
      lastMeterValue: LAST,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(AFTER_GRACE);
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
  vi.mocked(bookingData.updateBookingFrom).mockResolvedValue(true);
});

describe("closeStaleSession", () => {
  it("closes from the last meter value, completes the booking, emails both sides and schedules the deadline", async () => {
    open();
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("closed");
    const due = new Date(AFTER_GRACE.getTime() + 72 * 3_600_000);
    expect(vi.mocked(data.updateSessionFrom).mock.calls[0]?.[3]).toEqual({
      status: "needs_host_confirmation",
      reviewReason: "missing_stop",
      stopReason: "NoStopTransaction",
      meterStopWh: 22_000,
      kwh: 21,
      stoppedAt: LAST.ts,
      confirmationDueAt: due,
    });
    expect(bookingData.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["active"],
      { status: "completed" },
    );
    expect(env.jobs.sent).toEqual([
      {
        name: "session-confirmation-timeout",
        payload: { sessionId: SESSION_ID },
        options: { startAfter: due, singletonKey: SESSION_ID },
      },
    ]);
    expect(env.mail.emails.map((mail) => mail.to)).toEqual([
      "cian@example.com",
      "niamh@example.com",
    ]);
    expect(env.mail.emails[1]?.text).toContain("21.0 kWh");
    expect(env.pushed).toEqual([
      { kind: "booking", bookingId: BOOKING_ID },
      { kind: "session", bookingId: BOOKING_ID },
    ]);
  });

  it("skips a session that is not open, still starting, unknown, or not stale yet", async () => {
    open({ session: { status: "stopped" } });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    open({ session: { status: "starting" } });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    env.clock.current = new Date(SLOT.end.getTime() + 9 * 60_000);
    open();
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    expect(data.updateSessionFrom).not.toHaveBeenCalled();
  });

  it("skips when the session stopped in the meantime", async () => {
    open();
    vi.mocked(data.updateSessionFrom).mockResolvedValue(false);
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    expect(env.mail.emails).toEqual([]);
  });

  it("sends a session with no usable meter value to support", async () => {
    open({ lastMeterValue: null });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    open({ lastMeterValue: { ts: LAST.ts, energyWh: 10 } });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(vi.mocked(data.updateSessionFrom).mock.calls.map((call) => call[3])).toEqual([
      { status: "needs_review", reviewReason: "missing_stop", stopReason: "NoStopTransaction" },
      {
        status: "needs_review",
        reviewReason: "missing_stop",
        stopReason: "NoStopTransaction",
        stoppedAt: LAST.ts,
      },
    ]);
    expect(env.mail.emails).toEqual([]);
  });
});

describe("host confirmation", () => {
  const awaiting = () => {
    open({ session: { status: "needs_host_confirmation", confirmationDueAt: new Date() } });
  };

  it("records the confirmation and queues reconciliation", async () => {
    awaiting();
    await confirmSession(env.services, HOST_USER_ID, SESSION_ID);
    expect(vi.mocked(data.updateSessionFrom).mock.calls[0]?.[3]).toEqual({
      hostConfirmedAt: AFTER_GRACE,
    });
    expect(env.jobs.sent).toEqual([
      {
        name: "reconcile-session",
        payload: { sessionId: SESSION_ID },
        options: { singletonKey: SESSION_ID },
      },
    ]);
  });

  it("is 404 for anyone but the host and 409 unless the session waits for them", async () => {
    awaiting();
    await expect(confirmSession(env.services, "user-cian", SESSION_ID)).rejects.toMatchObject({
      status: 404,
    });
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(confirmSession(env.services, HOST_USER_ID, SESSION_ID)).rejects.toMatchObject({
      status: 404,
    });
    open({ session: { status: "reconciled" } });
    await expect(confirmSession(env.services, HOST_USER_ID, SESSION_ID)).rejects.toMatchObject({
      status: 409,
    });
    open({ session: { status: "needs_host_confirmation", hostConfirmedAt: new Date() } });
    await expect(confirmSession(env.services, HOST_USER_ID, SESSION_ID)).rejects.toMatchObject({
      status: 409,
    });
    awaiting();
    vi.mocked(data.updateSessionFrom).mockResolvedValue(false);
    await expect(confirmSession(env.services, HOST_USER_ID, SESSION_ID)).rejects.toMatchObject({
      code: "session-not-awaiting-confirmation",
    });
    expect(env.jobs.sent).toEqual([]);
  });

  it("records a dispute and sends the session to support", async () => {
    awaiting();
    vi.mocked(data.insertDispute).mockResolvedValue("dispute-1");
    await expect(
      disputeSession(env.services, HOST_USER_ID, SESSION_ID, {
        reason: "Wrong times",
        details: null,
      }),
    ).resolves.toBe("dispute-1");
    expect(vi.mocked(data.updateSessionFrom).mock.calls[0]?.[3]).toEqual({
      status: "needs_review",
      reviewReason: "host_dispute",
    });
    expect(data.insertDispute).toHaveBeenCalledWith(expect.anything(), {
      bookingId: BOOKING_ID,
      raisedById: HOST_USER_ID,
      reason: "Wrong times",
      details: null,
    });
  });

  it("refuses a dispute when the session moved on", async () => {
    awaiting();
    vi.mocked(data.updateSessionFrom).mockResolvedValue(false);
    await expect(
      disputeSession(env.services, HOST_USER_ID, SESSION_ID, { reason: "x", details: null }),
    ).rejects.toMatchObject({ status: 409 });
    expect(data.insertDispute).not.toHaveBeenCalled();
  });
});
