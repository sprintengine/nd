import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment } from "../../test/booking-detail.ts";
import {
  HOST_ID,
  SESSION_ID,
  settlementServices,
  settlementSession,
  SLOT,
} from "../../test/settlement-session.ts";
import * as bookingData from "../data/bookings.ts";
import * as data from "../data/settlement.ts";
import { settlementEventHandler } from "./events.ts";
import {
  closeArrivedBookingJob,
  closeStaleSessionJob,
  confirmationTimeoutJob,
  hostPayoutSummaryJob,
  reconcileSessionJob,
  releaseHeldTransfersJob,
  SETTLEMENT_JOBS,
  settlementSweepJob,
  weeklyPayoutSummaryJob,
} from "./jobs.ts";
import { queueWeeklyPayoutSummaries, sendHostPayoutSummary } from "./payout-summary.ts";
import { queueHeldTransferRelease, releaseHeldTransfers } from "./release.ts";
import { resolveSession } from "./resolve.ts";
import { settlementSweep } from "./sweep.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/settlement.ts");

const NOW = new Date("2027-01-15T09:00:00Z");
let env: ReturnType<typeof settlementServices>;
const PAYMENT_2 = "66666666-6666-4666-8666-666666666666";
const STALE_ID = "77777777-7777-4777-8777-777777777777";

beforeEach(() => {
  vi.resetAllMocks();
  env = settlementServices(NOW);
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
  vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
  vi.mocked(bookingData.updatePaymentFrom).mockResolvedValue(true);
});

describe("settlementSweep", () => {
  it("queues everything due, each keyed by what it is about", async () => {
    vi.mocked(data.sessionsToReconcile).mockResolvedValue([SESSION_ID]);
    vi.mocked(data.staleOpenSessions).mockResolvedValue([STALE_ID]);
    vi.mocked(data.arrivedWithoutSession).mockResolvedValue([BOOKING_ID]);
    vi.mocked(data.capturedWithoutTransfer).mockResolvedValue([PAYMENT_2]);
    vi.mocked(data.releasableHeldTransfers).mockResolvedValue([
      { paymentId: "p1", hostId: HOST_ID },
      { paymentId: "p2", hostId: HOST_ID },
    ]);
    await expect(settlementSweep(env.services)).resolves.toEqual({
      reconcile: 1,
      closeStale: 1,
      closeArrived: 1,
      transfer: 1,
      release: 1,
    });
    expect(vi.mocked(data.staleOpenSessions).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 10 * 60_000),
    );
    expect(env.jobs.sent.map((job) => [job.name, job.options.singletonKey])).toEqual([
      ["reconcile-session", SESSION_ID],
      ["close-stale-session", STALE_ID],
      ["close-arrived-booking", BOOKING_ID],
      ["host-transfer", PAYMENT_2],
      ["release-held-transfers", HOST_ID],
    ]);
  });
});

describe("settlementSweep with a shorter grace", () => {
  it("closes stale sessions after the configured minutes", async () => {
    const short = settlementServices(NOW, {
      timings: { minBookingMinutes: 30, staleSessionGraceMinutes: 1 },
    });
    for (const query of [
      data.sessionsToReconcile,
      data.staleOpenSessions,
      data.arrivedWithoutSession,
      data.capturedWithoutTransfer,
    ]) {
      vi.mocked(query).mockResolvedValue([]);
    }
    vi.mocked(data.releasableHeldTransfers).mockResolvedValue([]);
    await settlementSweep(short.services);
    expect(vi.mocked(data.staleOpenSessions).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
    expect(vi.mocked(data.arrivedWithoutSession).mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
  });
});

describe("releaseHeldTransfers", () => {
  it("retries each held transfer whose hold cleared and counts what went out", async () => {
    vi.mocked(data.releasableHeldTransfers).mockResolvedValue([
      { paymentId: "p1", hostId: HOST_ID },
      { paymentId: "p2", hostId: HOST_ID },
    ]);
    vi.mocked(bookingData.findPayment).mockImplementation((_db, id) =>
      Promise.resolve(
        payment({ id, status: "captured", capturedCents: 500, stripeChargeId: "ch" }),
      ),
    );
    vi.mocked(bookingData.findTransferContext).mockImplementation((_db, id) =>
      Promise.resolve({
        bookingId: BOOKING_ID,
        stripeAccountId: "acct_1",
        payoutStatus: id === "p1" ? "enabled" : "pending",
        taxDetailsComplete: true,
        sessionStatus: "reconciled",
        disputeOpen: false,
      }),
    );
    vi.mocked(bookingData.saveTransfer).mockImplementation((_db, _id, values) =>
      Promise.resolve(values as never),
    );
    await expect(releaseHeldTransfers(env.services, HOST_ID)).resolves.toEqual({
      sent: 1,
      stillHeld: 1,
    });
    expect(data.releasableHeldTransfers).toHaveBeenCalledWith(expect.anything(), {
      limit: 100,
      hostId: HOST_ID,
    });
  });

  it("goes on past a failure, then throws so the job retries", async () => {
    vi.mocked(data.releasableHeldTransfers).mockResolvedValue([
      { paymentId: "p1", hostId: HOST_ID },
    ]);
    vi.mocked(bookingData.findPayment).mockResolvedValue(undefined);
    await expect(releaseHeldTransfers(env.services)).rejects.toThrow(/1 held transfers/);
  });

  it("queues a release for one host or all", async () => {
    await queueHeldTransferRelease(env.services, HOST_ID);
    await queueHeldTransferRelease(env.services);
    expect(env.jobs.sent).toEqual([
      {
        name: "release-held-transfers",
        payload: { hostId: HOST_ID },
        options: { singletonKey: HOST_ID },
      },
      { name: "release-held-transfers", payload: {}, options: { singletonKey: "all-hosts" } },
    ]);
  });
});

describe("resolveSession", () => {
  const inReview = () =>
    vi
      .mocked(data.findSettlementSession)
      .mockResolvedValue(
        settlementSession({ session: { status: "needs_review", reviewReason: "meter_mismatch" } }),
      );

  it("captures the amount, resolves disputes and settles the session", async () => {
    inReview();
    vi.mocked(bookingData.findTransfer).mockResolvedValue({ id: "t1" } as never);
    await resolveSession(env.services, SESSION_ID, 800, "Checked");
    expect(env.payments.callsTo("capture")).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ amountCents: 800 }) as unknown }),
    ]);
    expect(data.resolveOpenDisputes).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      "Checked",
      NOW,
    );
    expect(vi.mocked(data.updateSessionFrom).mock.calls[0]?.[3]).toEqual({
      status: "reconciled",
      reconciledAt: NOW,
    });
  });

  it("answers 404, 409 and 422 for what cannot be resolved", async () => {
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    await expect(resolveSession(env.services, SESSION_ID, 1, "x")).rejects.toMatchObject({
      status: 404,
    });
    vi.mocked(data.findSettlementSession).mockResolvedValue(settlementSession());
    await expect(resolveSession(env.services, SESSION_ID, 1, "x")).rejects.toMatchObject({
      status: 409,
      code: "session-not-in-review",
    });
    inReview();
    await expect(resolveSession(env.services, SESSION_ID, 1001, "x")).rejects.toMatchObject({
      status: 422,
    });
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { payment: { status: "cancelled" } }),
    );
    await expect(resolveSession(env.services, SESSION_ID, 500, "x")).rejects.toMatchObject({
      status: 409,
      code: "payment-not-capturable",
    });
    vi.spyOn(env.payments.payments, "capture").mockRejectedValue(new Error("network down"));
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    await expect(resolveSession(env.services, SESSION_ID, 500, "x")).rejects.toThrow(
      "network down",
    );
    expect(data.updateSessionFrom).not.toHaveBeenCalled();
  });
});

describe("weekly payout summary", () => {
  it("queues one summary per host with activity in the past week", async () => {
    vi.mocked(data.hostsWithPayoutActivity).mockResolvedValue([HOST_ID]);
    await expect(queueWeeklyPayoutSummaries(env.services)).resolves.toBe(1);
    const from = new Date(NOW.getTime() - 7 * 24 * 3_600_000);
    expect(data.hostsWithPayoutActivity).toHaveBeenCalledWith(expect.anything(), {
      start: from,
      end: NOW,
    });
    expect(env.jobs.sent).toEqual([
      {
        name: "host-payout-summary",
        payload: { hostId: HOST_ID, from: from.toISOString(), to: NOW.toISOString() },
        options: { singletonKey: `${HOST_ID}:2027-01-15` },
      },
    ]);
  });

  const line = (overrides: Partial<data.PayoutLine>): data.PayoutLine => ({
    bookingId: BOOKING_ID,
    slot: SLOT,
    timezone: "Europe/Dublin",
    sessionStatus: "reconciled",
    startedAt: SLOT.start,
    stoppedAt: new Date("2027-01-13T01:39:00Z"),
    kwh: 22.5,
    capturedCents: 917,
    currency: "EUR",
    transferStatus: "sent",
    transferCents: 917,
    holdReason: null,
    ...overrides,
  });

  it("emails the week's sessions, what was paid out, and held transfers with why", async () => {
    vi.mocked(data.hostPayoutSummary).mockResolvedValue({
      host: { id: HOST_ID, name: "Niamh Byrne", email: "niamh@example.com" },
      lines: [
        line({}),
        line({
          transferStatus: "held",
          transferCents: 500,
          holdReason: "payouts_not_enabled",
          stoppedAt: new Date("2026-12-01T01:00:00Z"),
        }),
        line({ sessionStatus: "needs_review", transferStatus: null, transferCents: null }),
        line({
          sessionStatus: "needs_host_confirmation",
          transferStatus: null,
          transferCents: null,
          capturedCents: 0,
          kwh: null,
          startedAt: null,
          stoppedAt: new Date("2027-01-14T01:00:00Z"),
        }),
        line({ sessionStatus: "stopped", transferStatus: "pending", transferCents: null }),
      ],
    });
    const sent = await sendHostPayoutSummary(env.services, {
      hostId: HOST_ID,
      from: new Date("2027-01-08T09:00:00Z"),
      to: NOW,
    });
    expect(sent).toBe(true);
    const [mail] = env.mail.emails;
    expect(mail?.to).toBe("niamh@example.com");
    expect(mail?.subject).toBe("Your payouts for 8 Jan to 15 Jan");
    expect(mail?.text).toContain("Hi Niamh,");
    expect(mail?.text).toContain("Sessions (4):");
    expect(mail?.text).toContain("22.5 kWh · €9.17 · paid out");
    expect(mail?.text).toContain("being reviewed");
    expect(mail?.text).toContain("waiting for your confirmation");
    expect(mail?.text).toContain("payout pending");
    expect(mail?.text).toContain("Paid out: €9.17");
    expect(mail?.text).toContain("Held: €5.00");
    expect(mail?.text).toContain("payouts are not enabled on your Stripe account yet");
  });

  it("says when no session ended, and sends nothing for an unknown or idle host", async () => {
    vi.mocked(data.hostPayoutSummary).mockResolvedValue({
      host: { id: HOST_ID, name: "Niamh", email: "niamh@example.com" },
      lines: [
        line({
          transferStatus: "held",
          transferCents: 300,
          holdReason: null,
          stoppedAt: null,
        }),
      ],
    });
    const window = { hostId: HOST_ID, from: new Date("2027-01-08T09:00:00Z"), to: NOW };
    await sendHostPayoutSummary(env.services, window);
    expect(env.mail.emails[0]?.text).toContain("No sessions ended this week.");
    expect(env.mail.emails[0]?.text).toContain("€3.00 for");
    vi.mocked(data.hostPayoutSummary).mockResolvedValue(undefined);
    await expect(sendHostPayoutSummary(env.services, window)).resolves.toBe(false);
    vi.mocked(data.hostPayoutSummary).mockResolvedValue({
      host: { id: HOST_ID, name: "Niamh", email: "niamh@example.com" },
      lines: [],
    });
    await expect(sendHostPayoutSummary(env.services, window)).resolves.toBe(false);
    expect(env.mail.emails).toHaveLength(1);
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
  it("are all listed, with the sweep every minute and the summary on Fridays", () => {
    expect(SETTLEMENT_JOBS.map((job) => job.name)).toEqual([
      "reconcile-session",
      "session-confirmation-timeout",
      "close-stale-session",
      "close-arrived-booking",
      "release-held-transfers",
      "settlement-sweep",
      "weekly-payout-summary",
      "host-payout-summary",
    ]);
    expect(settlementSweepJob.cron).toBe("* * * * *");
    expect(weeklyPayoutSummaryJob.cron).toBe("0 9 * * 5");
  });

  it("run their work", async () => {
    await env.jobs.runner.start(SETTLEMENT_JOBS, env.services, env.services.log);
    vi.mocked(data.findSettlementSession).mockResolvedValue(undefined);
    vi.mocked(data.releasableHeldTransfers).mockResolvedValue([]);
    vi.mocked(data.sessionsToReconcile).mockResolvedValue([]);
    vi.mocked(data.staleOpenSessions).mockResolvedValue([]);
    vi.mocked(data.arrivedWithoutSession).mockResolvedValue([]);
    vi.mocked(data.capturedWithoutTransfer).mockResolvedValue([]);
    vi.mocked(data.hostsWithPayoutActivity).mockResolvedValue([]);
    vi.mocked(data.hostPayoutSummary).mockResolvedValue(undefined);
    await env.jobs.runner.runNow(reconcileSessionJob, { sessionId: SESSION_ID });
    await env.jobs.runner.runNow(confirmationTimeoutJob, { sessionId: SESSION_ID });
    await env.jobs.runner.runNow(closeStaleSessionJob, { sessionId: SESSION_ID });
    await env.jobs.runner.runNow(closeArrivedBookingJob, { bookingId: BOOKING_ID });
    await env.jobs.runner.runNow(releaseHeldTransfersJob, {});
    await env.jobs.runner.runNow(settlementSweepJob, {});
    await env.jobs.runner.runNow(weeklyPayoutSummaryJob, {});
    await env.jobs.runner.runNow(hostPayoutSummaryJob, {
      hostId: HOST_ID,
      from: NOW.toISOString(),
      to: NOW.toISOString(),
    });
    expect(data.findSettlementSession).toHaveBeenCalledTimes(3);
    expect(data.releasableHeldTransfers).toHaveBeenCalledTimes(2);
    expect(data.hostPayoutSummary).toHaveBeenCalledWith(expect.anything(), HOST_ID, {
      start: NOW,
      end: NOW,
    });
  });
});
