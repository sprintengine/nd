import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID } from "../../test/booking-detail.ts";
import {
  SESSION_ID,
  settlementServices,
  settlementSession,
  SLOT,
} from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";
import { reconcileSession } from "./reconcile.ts";
import { closeStaleSession } from "./stale.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");

let env: ReturnType<typeof settlementServices>;
const warn = vi.fn();
const NOW = new Date("2027-01-13T09:00:00Z");

function found(...args: Parameters<typeof settlementSession>) {
  const value = settlementSession(...args);
  vi.mocked(data.findSettlementSession).mockResolvedValue(value);
  return value;
}

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(NOW, { log: { info: vi.fn(), warn, error: vi.fn() } });
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
  vi.mocked(bookingData.updateBookingFrom).mockResolvedValue(true);
});

const sessionChanges = () => vi.mocked(data.updateSessionFrom).mock.calls.map((call) => call[3]);

describe("reconcileSession", () => {
  it("records the energy delivered, marks it reconciled and tells the host, moving no money", async () => {
    found();
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("reconciled");
    expect(data.updateSessionFrom).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      ["stopped"],
      {
        status: "reconciled",
        kwh: 22.5,
        reconciledAt: NOW,
      },
    );
    expect(env.payments.calls).toEqual([]);
    expect(env.pushed).toEqual([{ kind: "session", bookingId: BOOKING_ID }]);
    expect(env.jobs.sent[0]).toMatchObject({
      name: "notify",
      payload: { type: "session_settled", bookingId: BOOKING_ID, sessionId: SESSION_ID },
    });
  });

  it("does nothing more once reconciled, or when another run got there first", async () => {
    found({ session: { status: "reconciled" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("already_reconciled");
    found();
    vi.mocked(data.updateSessionFrom).mockResolvedValue(false);
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("already_reconciled");
    expect(env.jobs.sent).toEqual([]);
  });

  it("is not_found for an unknown session and waits for one still open", async () => {
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("not_found");
    found({ session: { status: "charging" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("waiting");
  });

  it("flags a meter disagreement of 0.5 kWh for review", async () => {
    found({ lastMeterValue: { ts: SLOT.start, energyWh: 23_000 } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()).toEqual([{ status: "needs_review", reviewReason: "meter_mismatch" }]);
    expect(warn).toHaveBeenCalled();
  });

  it("flags a session without a usable stop reading", async () => {
    found({ session: { meterStopWh: null } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()[0]).toMatchObject({ reviewReason: "meter_invalid" });
  });

  it("gives a session the gateway flagged a reason, once", async () => {
    found({ session: { status: "needs_review", reviewReason: null } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    found({ session: { status: "needs_review", reviewReason: "meter_invalid" } });
    await expect(reconcileSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(data.updateSessionFrom).toHaveBeenCalledTimes(1);
  });
});

describe("closeStaleSession", () => {
  const after = new Date(SLOT.end.getTime() + 10 * 60_000);

  it("closes an open session from its last meter value once the grace has passed", async () => {
    found({ session: { status: "charging", meterStopWh: null, stoppedAt: null } });
    env.clock.current = new Date(after.getTime() - 1);
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    env.clock.current = after;
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("closed");
    expect(bookingData.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["active"],
      { status: "completed" },
    );
    expect(sessionChanges()[0]).toEqual({
      status: "reconciled",
      stopReason: "NoStopTransaction",
      meterStopWh: 23_400,
      kwh: 22.4,
      stoppedAt: new Date(SLOT.start.getTime() + 218 * 60_000),
      reconciledAt: after,
    });
    expect(env.payments.calls).toEqual([]);
  });

  it("sends a session with no usable meter value to support", async () => {
    env.clock.current = after;
    found({ session: { status: "charging" }, lastMeterValue: null });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()[0]).toEqual({
      status: "needs_review",
      reviewReason: "missing_stop",
      stopReason: "NoStopTransaction",
    });
    found({ session: { status: "charging" }, lastMeterValue: { ts: SLOT.start, energyWh: 10 } });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("needs_review");
    expect(sessionChanges()[1]).toMatchObject({ stoppedAt: SLOT.start });
  });

  it("leaves sessions that are gone, starting, stopped, or closed by another run", async () => {
    env.clock.current = after;
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    found({ session: { status: "starting" } });
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    found();
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
    found({ session: { status: "charging" } });
    vi.mocked(data.updateSessionFrom).mockResolvedValue(false);
    await expect(closeStaleSession(env.services, SESSION_ID)).resolves.toBe("skipped");
  });
});
