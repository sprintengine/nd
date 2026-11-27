import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID } from "../../test/booking-detail.ts";
import { SESSION_ID, settlementServices } from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as paymentData from "../data/payments.ts";
import * as data from "../data/settlement.ts";
import { settlementEventHandler } from "./events.ts";
import {
  closeArrivedBookingJob,
  closeStaleSessionJob,
  reconcileSessionJob,
  SETTLEMENT_JOBS,
  settlementSweepJob,
} from "./jobs.ts";
import { settlementSweep } from "./sweep.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");
vi.mock("../data/payments.ts");

const NOW = new Date("2027-01-15T09:00:00Z");
let env: ReturnType<typeof settlementServices>;
const PAYMENT_2 = "66666666-6666-4666-8666-666666666666";
const STALE_ID = "77777777-7777-4777-8777-777777777777";
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";
const NO_SHOW_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(NOW);
  for (const query of [
    data.sessionsToReconcile,
    data.staleOpenSessions,
    data.arrivedWithoutSession,
    paymentData.paymentsToResume,
  ]) {
    vi.mocked(query).mockResolvedValue([]);
  }
  vi.mocked(paymentData.dueLifecycleBookings).mockResolvedValue({ expire: [], noShow: [] });
});

describe("settlementSweep", () => {
  it("queues everything due, each keyed by what it is about", async () => {
    vi.mocked(data.sessionsToReconcile).mockResolvedValue([SESSION_ID]);
    vi.mocked(data.staleOpenSessions).mockResolvedValue([STALE_ID]);
    vi.mocked(data.arrivedWithoutSession).mockResolvedValue([BOOKING_ID]);
    vi.mocked(paymentData.dueLifecycleBookings).mockResolvedValue({
      expire: [REQUEST_ID],
      noShow: [NO_SHOW_ID],
    });
    vi.mocked(paymentData.paymentsToResume).mockResolvedValue([PAYMENT_2]);
    await expect(settlementSweep(env.services)).resolves.toEqual({
      reconcile: 1,
      closeStale: 1,
      closeArrived: 1,
      expire: 1,
      noShow: 1,
      resume: 1,
    });
    expect(vi.mocked(data.staleOpenSessions).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 10 * 60_000),
    );
    expect(vi.mocked(paymentData.dueLifecycleBookings).mock.calls[0]?.[1]).toEqual({
      now: NOW,
      requestHours: 24,
      noShowGraceMinutes: 15,
      limit: 200,
    });
    expect(vi.mocked(paymentData.paymentsToResume).mock.calls[0]?.[1]).toEqual({
      staleBefore: new Date(NOW.getTime() - 2 * 60_000),
      refundCheckBefore: new Date(NOW.getTime() - 60 * 60_000),
    });
    expect(env.jobs.sent.map((job) => [job.name, job.options.singletonKey])).toEqual([
      ["reconcile-session", SESSION_ID],
      ["close-stale-session", STALE_ID],
      ["close-arrived-booking", BOOKING_ID],
      ["booking-expire-request", REQUEST_ID],
      ["booking-no-show", NO_SHOW_ID],
      ["resume-payment", PAYMENT_2],
    ]);
  });

  it("closes stale sessions after the configured minutes", async () => {
    const short = settlementServices(NOW, {
      timings: { minBookingMinutes: 30, staleSessionGraceMinutes: 1, arrivalLeadMinutes: 240 },
    });
    await settlementSweep(short.services);
    expect(vi.mocked(data.staleOpenSessions).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
    expect(vi.mocked(data.arrivedWithoutSession).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
  });
});

describe("settlement events", () => {
  it("queues reconciliation on session_stopped and a sweep on resync, and ignores the rest", async () => {
    const handler = settlementEventHandler(env.services);
    const base = {
      v: 1 as const,
      at: NOW.toISOString(),
      chargerId: "c1",
      chargeboxId: "ND1",
    };
    await handler.handle({
      kind: "event",
      event: {
        ...base,
        type: "session_stopped",
        sessionId: SESSION_ID,
        bookingId: BOOKING_ID,
        transactionId: 1,
        sessionStatus: "stopped",
        meterStopWh: 23_500,
        kwh: 22.5,
        reason: null,
      },
    });
    await handler.handle({ kind: "event", event: { ...base, type: "online" } });
    await handler.handle({ kind: "resync" });
    expect(env.jobs.sent.map((job) => [job.name, job.options.singletonKey])).toEqual([
      ["reconcile-session", SESSION_ID],
      ["settlement-sweep", undefined],
    ]);
  });
});

describe("settlement jobs", () => {
  it("are all listed, with the sweep every minute", () => {
    expect(SETTLEMENT_JOBS.map((job) => job.name)).toEqual([
      "reconcile-session",
      "close-stale-session",
      "close-arrived-booking",
      "settlement-sweep",
    ]);
    expect(settlementSweepJob.cron).toBe("* * * * *");
  });

  it("run their work", async () => {
    await env.jobs.runner.start(SETTLEMENT_JOBS, env.services, env.services.log);
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(undefined);
    await env.jobs.runner.runNow(reconcileSessionJob, { sessionId: SESSION_ID });
    await env.jobs.runner.runNow(closeStaleSessionJob, { sessionId: SESSION_ID });
    await env.jobs.runner.runNow(closeArrivedBookingJob, { bookingId: BOOKING_ID });
    await env.jobs.runner.runNow(settlementSweepJob, {});
    expect(data.findSettlementSession).toHaveBeenCalledTimes(2);
    expect(bookingData.findBookingDetail).toHaveBeenCalledTimes(1);
    expect(data.sessionsToReconcile).toHaveBeenCalledTimes(1);
  });
});
