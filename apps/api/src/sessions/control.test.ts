import { ChargerControlError } from "@nd/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, HOST_USER_ID } from "../../test/booking-detail.ts";
import {
  DRIVER_ID,
  IN_SLOT,
  SESSION_ID,
  sessionContext,
  sessionServices,
} from "../../test/session-context.ts";
import * as data from "../data/sessions.ts";
import type { JobAttempt } from "../jobs/jobs.ts";
import {
  arrive,
  contextFor,
  failStalledStart,
  runRemoteStart,
  startCharging,
  stopAtWindowEnd,
  stopCharging,
} from "./control.ts";

vi.mock("../data/sessions.ts");

const last: JobAttempt = { jobId: "j", retryCount: 3, lastAttempt: true };
const first: JobAttempt = { jobId: "j", retryCount: 0, lastAttempt: false };

let t: ReturnType<typeof sessionServices>;

const problem = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as { status: number; code: string; detail?: string },
  );

beforeEach(() => {
  vi.resetAllMocks();
  t = sessionServices();
  vi.mocked(data.findSessionContext).mockResolvedValue(sessionContext());
  vi.mocked(data.recordArrival).mockResolvedValue(true);
  vi.mocked(data.setScheduledStart).mockResolvedValue(true);
  vi.mocked(data.updateSessionFrom).mockResolvedValue(true);
  vi.mocked(data.chargerHasOpenTransaction).mockResolvedValue(false);
  vi.mocked(data.insertStartingSession).mockResolvedValue({ sessionId: SESSION_ID, created: true });
});

const failedWith = (reason: string) => {
  expect(data.updateSessionFrom).toHaveBeenCalledWith(expect.anything(), SESSION_ID, ["starting"], {
    status: "failed",
    stopReason: reason,
  });
};

describe("contextFor", () => {
  it("is 404 for a missing booking and for anyone but its driver and host", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(undefined);
    expect((await problem(contextFor(t.services, DRIVER_ID, BOOKING_ID)))?.status).toBe(404);
    expect((await problem(contextFor(t.services, "someone", BOOKING_ID)))?.status).toBe(404);
    await expect(contextFor(t.services, HOST_USER_ID, BOOKING_ID)).resolves.toBeDefined();
  });
});

describe("arrive", () => {
  const confirmed = (now = new Date("2027-01-12T21:50:00Z")) => {
    t.clock.current = now;
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ booking: { status: "confirmed", arrivedAt: null } }),
    );
  };

  it("checks a confirmed booking in, records the distance and queues the window-end stop", async () => {
    confirmed();
    const arrival = await arrive(t.services, DRIVER_ID, BOOKING_ID, { lat: 53.3285, lng: -6.256 });
    expect(arrival).toEqual({
      arrivedAt: new Date("2027-01-12T21:50:00Z"),
      distanceM: 278,
      nearCharger: true,
    });
    expect(data.recordArrival).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, {
      arrivedAt: new Date("2027-01-12T21:50:00Z"),
      distanceM: 278,
    });
    expect(t.jobs.sent).toEqual([
      {
        name: "session-window-end-stop",
        payload: { bookingId: BOOKING_ID },
        options: { startAfter: new Date("2027-01-13T02:05:00Z"), singletonKey: BOOKING_ID },
      },
    ]);
    expect(t.realtime.booking).toEqual([BOOKING_ID]);
  });

  it("records no distance without a position, and notes a far one", async () => {
    confirmed();
    expect(await arrive(t.services, DRIVER_ID, BOOKING_ID, undefined)).toMatchObject({
      distanceM: null,
      nearCharger: null,
    });
    confirmed();
    expect(
      (await arrive(t.services, DRIVER_ID, BOOKING_ID, { lat: 53.4, lng: -6.256 })).nearCharger,
    ).toBe(false);
  });

  it("returns the recorded arrival when already checked in", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ booking: { arrivalDistanceM: 12 } }),
    );
    expect(await arrive(t.services, DRIVER_ID, BOOKING_ID, undefined)).toEqual({
      arrivedAt: new Date("2027-01-12T21:55:00Z"),
      distanceM: 12,
      nearCharger: true,
    });
    expect(data.recordArrival).not.toHaveBeenCalled();
  });

  it("refuses the host, other statuses, and arrivals outside the window", async () => {
    expect((await problem(arrive(t.services, HOST_USER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "driver-only",
    );
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ booking: { status: "cancelled" } }),
    );
    expect((await problem(arrive(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "cannot-arrive",
    );
    confirmed(new Date("2027-01-12T21:44:00Z"));
    const early = await problem(arrive(t.services, DRIVER_ID, BOOKING_ID, undefined));
    expect(early).toMatchObject({ status: 409, code: "too-early" });
    confirmed(new Date("2027-01-13T02:00:00Z"));
    expect((await problem(arrive(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "slot-ended",
    );
    confirmed();
    vi.mocked(data.recordArrival).mockResolvedValueOnce(false);
    expect((await problem(arrive(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "cannot-arrive",
    );
  });
});

describe("startCharging", () => {
  it("sends the remote start and schedules the start timeout", async () => {
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    expect(t.control.callsTo("remoteStart")).toEqual([
      { chargeboxId: "NDTEST0001", idTag: "ABCDEFGHJKLMNPQRSTUV", connectorId: 1 },
    ]);
    expect(t.jobs.sent).toEqual([
      {
        name: "session-start-timeout",
        payload: { bookingId: BOOKING_ID, sessionId: SESSION_ID },
        options: { startAfter: new Date("2027-01-12T22:12:00Z"), singletonKey: SESSION_ID },
      },
    ]);
    expect(t.realtime.session).toEqual([BOOKING_ID]);
  });

  it("does nothing while a start is pending or a session runs", async () => {
    for (const context of [
      sessionContext({ session: { status: "charging" } }),
      sessionContext({ booking: { status: "active" } }),
      sessionContext({
        booking: {
          scheduledStartAt: new Date("2027-01-13T00:00:00Z"),
          pluggedInAt: new Date("2027-01-12T22:01:00Z"),
        },
      }),
    ]) {
      vi.mocked(data.findSessionContext).mockResolvedValueOnce(context);
      await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    }
    vi.mocked(data.insertStartingSession).mockResolvedValueOnce({
      sessionId: SESSION_ID,
      created: false,
    });
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    expect(t.control.calls).toEqual([]);
  });

  it("needs an arrival, an open slot and a start time inside it", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ booking: { status: "confirmed" } }),
    );
    const notArrived = await problem(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined));
    expect(notArrived).toMatchObject({
      code: "not-arrived",
      detail: expect.stringMatching(/here/) as string,
    });
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ booking: { status: "completed" } }),
    );
    expect(
      (await problem(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.detail,
    ).toBeUndefined();

    const late = new Date("2027-01-13T02:00:00Z");
    t.clock.current = late;
    expect((await problem(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "slot-ended",
    );
    t.clock.current = new Date("2027-01-12T21:50:00Z");
    expect((await problem(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined)))?.code).toBe(
      "slot-not-started",
    );
    expect(await problem(startCharging(t.services, DRIVER_ID, BOOKING_ID, late))).toMatchObject({
      status: 422,
      code: "invalid-start-time",
    });
    expect(t.control.calls).toEqual([]);
  });

  it("schedules a start in the future and starts at once for a time already passed", async () => {
    const startAt = new Date("2027-01-13T00:30:00Z");
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, startAt);
    expect(data.setScheduledStart).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, {
      scheduledStartAt: startAt,
      pluggedInAt: IN_SLOT,
    });
    expect(t.jobs.sent[0]).toEqual({
      name: "session-remote-start",
      payload: { bookingId: BOOKING_ID },
      options: { startAfter: startAt, singletonKey: `${BOOKING_ID}-scheduled` },
    });
    expect(t.control.calls).toEqual([]);

    await startCharging(t.services, DRIVER_ID, BOOKING_ID, new Date("2027-01-12T22:05:00Z"));
    expect(t.control.callsTo("remoteStart")).toHaveLength(1);
  });

  it("fails an unanswered start with the reason the app shows", async () => {
    t.control.answer(
      "remoteStart",
      { ok: false, reason: "offline", message: "offline" },
      { ok: false, reason: "no_response", message: "timeout" },
      new ChargerControlError("unreachable"),
    );
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    failedWith("charger_offline");
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    failedWith("no_response");
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    failedWith("gateway_unreachable");
    expect(t.jobs.sent).toEqual([]);
    expect(t.realtime.session).toEqual([BOOKING_ID, BOOKING_ID, BOOKING_ID]);
  });

  it("does not report a failure that lost a race", async () => {
    t.control.answer("remoteStart", { ok: false, reason: "offline", message: "offline" });
    vi.mocked(data.updateSessionFrom).mockResolvedValueOnce(false);
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    expect(t.realtime.session).toEqual([]);
  });

  it("rethrows anything but a gateway error, and needs an idTag", async () => {
    t.control.answer("remoteStart", new TypeError("bug"));
    await expect(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined)).rejects.toThrow(
      "bug",
    );
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ booking: { idTag: null } }),
    );
    await expect(startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined)).rejects.toThrow(
      /no idTag/,
    );
  });

  it("soft-resets a charger that refuses with a transaction open, and retries once later", async () => {
    vi.mocked(data.chargerHasOpenTransaction).mockResolvedValue(true);
    t.control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    expect(t.control.callsTo("reset")).toEqual([{ chargeboxId: "NDTEST0001" }]);
    expect(t.jobs.sent).toEqual([
      {
        name: "session-remote-start",
        payload: { bookingId: BOOKING_ID, sessionId: SESSION_ID },
        options: {
          startAfter: new Date("2027-01-12T22:10:20Z"),
          singletonKey: `${SESSION_ID}-retry`,
        },
      },
    ]);
    expect(data.updateSessionFrom).not.toHaveBeenCalled();
  });

  it("fails a refused start when the reset is refused or nothing is open", async () => {
    vi.mocked(data.chargerHasOpenTransaction).mockResolvedValue(true);
    t.control.answer(
      "remoteStart",
      { ok: true, response: { status: "Rejected" } },
      { ok: true, response: { status: "Rejected" } },
      { ok: true, response: { status: "Rejected" } },
    );
    t.control.answer(
      "reset",
      { ok: true, response: { status: "Rejected" } },
      new ChargerControlError("down"),
    );
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    vi.mocked(data.chargerHasOpenTransaction).mockResolvedValue(false);
    await startCharging(t.services, DRIVER_ID, BOOKING_ID, undefined);
    expect(t.control.callsTo("reset")).toHaveLength(2);
    expect(vi.mocked(data.updateSessionFrom).mock.calls.map((call) => call[3])).toEqual([
      { status: "failed", stopReason: "rejected" },
      { status: "failed", stopReason: "rejected" },
      { status: "failed", stopReason: "rejected" },
    ]);
  });
});

describe("stopCharging", () => {
  const charging = () =>
    vi
      .mocked(data.findSessionContext)
      .mockResolvedValue(
        sessionContext({ session: { status: "charging", ocppTransactionId: 42 } }),
      );

  it("sends a remote stop for a running session", async () => {
    charging();
    await stopCharging(t.services, DRIVER_ID, BOOKING_ID);
    expect(t.control.callsTo("remoteStop")).toEqual([
      { chargeboxId: "NDTEST0001", transactionId: 42 },
    ]);
  });

  it("is 503 when the charger does not answer and 409 when it has nothing to stop", async () => {
    charging();
    t.control.answer(
      "remoteStop",
      { ok: false, reason: "no_response", message: "timeout" },
      new ChargerControlError("down"),
      { ok: true, response: { status: "Rejected" } },
      new TypeError("bug"),
    );
    expect((await problem(stopCharging(t.services, DRIVER_ID, BOOKING_ID)))?.status).toBe(503);
    expect((await problem(stopCharging(t.services, DRIVER_ID, BOOKING_ID)))?.status).toBe(503);
    expect((await problem(stopCharging(t.services, DRIVER_ID, BOOKING_ID)))?.code).toBe(
      "stop-rejected",
    );
    await expect(stopCharging(t.services, DRIVER_ID, BOOKING_ID)).rejects.toThrow("bug");
  });

  it("abandons a start not yet begun and cancels a scheduled one", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "starting" } }),
    );
    await stopCharging(t.services, DRIVER_ID, BOOKING_ID);
    failedWith("stopped_before_start");
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({
        booking: {
          scheduledStartAt: new Date("2027-01-13T00:00:00Z"),
          pluggedInAt: new Date("2027-01-12T22:01:00Z"),
        },
      }),
    );
    await stopCharging(t.services, DRIVER_ID, BOOKING_ID);
    expect(data.setScheduledStart).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, null);
    expect(t.realtime.session).toEqual([BOOKING_ID, BOOKING_ID]);
  });

  it("does nothing with nothing running", async () => {
    await stopCharging(t.services, DRIVER_ID, BOOKING_ID);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "stopped", ocppTransactionId: 42 } }),
    );
    await stopCharging(t.services, DRIVER_ID, BOOKING_ID);
    expect(t.control.calls).toEqual([]);
  });
});

describe("runRemoteStart", () => {
  const scheduled = (overrides = {}) =>
    sessionContext({
      booking: {
        scheduledStartAt: new Date("2027-01-13T00:00:00Z"),
        pluggedInAt: new Date("2027-01-12T22:01:00Z"),
        ...overrides,
      },
    });

  it("sends a scheduled start at its time, and only then", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(scheduled());
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    expect(t.control.calls).toEqual([]);
    t.clock.current = new Date("2027-01-13T00:00:00Z");
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    expect(t.control.callsTo("remoteStart")).toHaveLength(1);
    t.clock.current = new Date("2027-01-13T02:00:00Z");
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    expect(t.control.callsTo("remoteStart")).toHaveLength(1);
  });

  it("does nothing for a missing booking or a start no longer pending", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(undefined);
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(sessionContext());
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({
        booking: { scheduledStartAt: new Date("2027-01-13T00:00:00Z"), pluggedInAt: null },
        session: { status: "failed" },
      }),
    );
    await runRemoteStart(t.services, { bookingId: BOOKING_ID }, last);
    expect(t.control.calls).toEqual([]);
  });

  it("retries a start after a reset, without another reset", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ session: { status: "starting" } }),
    );
    vi.mocked(data.chargerHasOpenTransaction).mockResolvedValue(true);
    t.control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    await runRemoteStart(t.services, { bookingId: BOOKING_ID, sessionId: SESSION_ID }, last);
    expect(t.control.callsTo("reset")).toEqual([]);
    failedWith("rejected");
  });

  it("tries an unanswered retry again until the last attempt", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ session: { status: "starting" } }),
    );
    t.control.answer(
      "remoteStart",
      { ok: false, reason: "offline", message: "offline" },
      new ChargerControlError("down"),
      { ok: false, reason: "call_error", message: "x" },
      { ok: false, reason: "offline", message: "offline" },
    );
    const payload = { bookingId: BOOKING_ID, sessionId: SESSION_ID };
    await expect(runRemoteStart(t.services, payload, first)).rejects.toThrow(/not answered/);
    await expect(runRemoteStart(t.services, payload, first)).rejects.toThrow("down");
    await runRemoteStart(t.services, payload, first);
    failedWith("no_response");
    await runRemoteStart(t.services, payload, last);
    failedWith("charger_offline");
  });

  it("ignores a retry for a session that moved on", async () => {
    for (const session of [
      { id: "other" },
      { status: "charging" as const },
      { ocppTransactionId: 1 },
    ]) {
      vi.mocked(data.findSessionContext).mockResolvedValueOnce(sessionContext({ session }));
      await runRemoteStart(t.services, { bookingId: BOOKING_ID, sessionId: SESSION_ID }, last);
    }
    expect(t.control.calls).toEqual([]);
  });
});

describe("failStalledStart", () => {
  const payload = { bookingId: BOOKING_ID, sessionId: SESSION_ID };

  it("fails a start still waiting and asks the charger for its status", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ session: { status: "starting" } }),
    );
    await failStalledStart(t.services, payload);
    failedWith("start_timeout");
    expect(t.control.callsTo("triggerMessage")).toEqual([
      { chargeboxId: "NDTEST0001", requestedMessage: "StatusNotification", connectorId: 1 },
    ]);
    t.control.answer("triggerMessage", new ChargerControlError("down"), {
      ok: false,
      reason: "offline",
      message: "offline",
    });
    await failStalledStart(t.services, payload);
    await failStalledStart(t.services, payload);
    expect(t.logged.filter((line) => line.level === "warn")).toHaveLength(2);
  });

  it("leaves a session that started, moved on or was already failed", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(undefined);
    await failStalledStart(t.services, payload);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { id: "x" } }),
    );
    await failStalledStart(t.services, payload);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "charging", ocppTransactionId: 3 } }),
    );
    await failStalledStart(t.services, payload);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "starting" } }),
    );
    vi.mocked(data.updateSessionFrom).mockResolvedValueOnce(false);
    await failStalledStart(t.services, payload);
    expect(t.control.calls).toEqual([]);
  });
});

describe("stopAtWindowEnd", () => {
  const afterWindow = new Date("2027-01-13T02:05:00Z");

  it("stops a session still running 5 minutes after the slot", async () => {
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ session: { status: "suspended_ev", ocppTransactionId: 9 } }),
    );
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    expect(t.control.calls).toEqual([]);
    t.clock.current = afterWindow;
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    expect(t.control.callsTo("remoteStop")).toEqual([
      { chargeboxId: "NDTEST0001", transactionId: 9 },
    ]);
  });

  it("retries a stop not accepted, and logs the last failure", async () => {
    t.clock.current = afterWindow;
    vi.mocked(data.findSessionContext).mockResolvedValue(
      sessionContext({ session: { status: "charging", ocppTransactionId: 9 } }),
    );
    t.control.answer(
      "remoteStop",
      { ok: true, response: { status: "Rejected" } },
      { ok: false, reason: "offline", message: "offline" },
    );
    await expect(stopAtWindowEnd(t.services, BOOKING_ID, first)).rejects.toThrow(/rejected/);
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    expect(t.logged.at(-1)).toMatchObject({ level: "error" });
  });

  it("gives up a pending start and leaves closed sessions alone", async () => {
    t.clock.current = afterWindow;
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(undefined);
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "starting" } }),
    );
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    failedWith("window_ended");
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({
        booking: {
          scheduledStartAt: new Date("2027-01-13T01:00:00Z"),
          pluggedInAt: new Date("2027-01-12T22:01:00Z"),
        },
      }),
    );
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    expect(data.setScheduledStart).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, null);
    vi.mocked(data.findSessionContext).mockResolvedValueOnce(
      sessionContext({ session: { status: "stopped", ocppTransactionId: 9 } }),
    );
    await stopAtWindowEnd(t.services, BOOKING_ID, last);
    expect(t.control.calls).toEqual([]);
  });
});
