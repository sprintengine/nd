import type { ChargePointAction, InboundHandler } from "@nd/ocpp-core";
import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "../test/fake-store.ts";
import { silentLogger } from "../test/silent-logger.ts";
import { ConfigWriteBudget } from "./boot-config.ts";
import { chargePointHandlers } from "./handlers.ts";

const now = new Date("2027-01-13T22:00:00.000Z");
const charger = { id: "c-1", chargeboxId: "21234567" };

function setup() {
  const store = fakeStore();
  const afterReply = new Map<string, () => void>();
  const call = vi.fn((action: string) =>
    Promise.resolve(
      action === "GetConfiguration"
        ? { ok: true, response: { configurationKey: [] } }
        : { ok: true, response: { status: "Accepted" } },
    ),
  );
  const connection = {
    charger,
    afterReply: (messageId: string, run: () => void) => afterReply.set(messageId, run),
    call,
  };
  const handlers = chargePointHandlers({
    connection: connection as never,
    store,
    budget: new ConfigWriteBudget(store),
    logger: silentLogger,
    now: () => now,
  });
  const run = <A extends ChargePointAction>(action: A, request: unknown, messageId = "m-1") => {
    const handler: InboundHandler<A> | undefined = handlers[action];
    if (handler === undefined) {
      throw new Error(`no handler for ${action}`);
    }
    return handler(request as never, { action, messageId });
  };
  return { store, afterReply, call, run };
}

describe("charge point handlers", () => {
  it("accepts a boot, records it, and pushes configuration once the reply is out", async () => {
    const { store, afterReply, call, run } = setup();
    await expect(
      run("BootNotification", {
        chargePointVendor: "myenergi",
        chargePointModel: "Zappi",
        firmwareVersion: "5.794",
      }),
    ).resolves.toEqual({ status: "Accepted", currentTime: now.toISOString(), interval: 300 });
    expect(store.recordBoot).toHaveBeenCalledWith(charger, "5.794", now);
    expect(call).not.toHaveBeenCalled();
    afterReply.get("m-1")?.();
    afterReply.get("m-1")?.();
    await vi.waitFor(() => {
      expect(store.saveOcppConfig).toHaveBeenCalledOnce();
    });
    expect(call.mock.calls.filter(([action]) => action === "GetConfiguration")).toHaveLength(2);

    await run(
      "BootNotification",
      { chargePointVendor: "myenergi", chargePointModel: "Zappi" },
      "m-2",
    );
    expect(store.recordBoot).toHaveBeenLastCalledWith(charger, null, now);
  });

  it("logs a failed configuration push", async () => {
    const { store, afterReply, run } = setup();
    store.saveOcppConfig = vi.fn(() => Promise.reject(new Error("db")));
    await run("BootNotification", { chargePointVendor: "myenergi", chargePointModel: "Zappi" });
    afterReply.get("m-1")?.();
    await vi.waitFor(() => {
      expect(store.saveOcppConfig).toHaveBeenCalled();
    });
  });

  it("answers Heartbeat with the time", async () => {
    const { store, run } = setup();
    await expect(run("Heartbeat", {})).resolves.toEqual({ currentTime: now.toISOString() });
    expect(store.recordHeartbeat).toHaveBeenCalledWith(charger, now);
  });

  it("records StatusNotification", async () => {
    const { store, run } = setup();
    await expect(
      run("StatusNotification", {
        connectorId: 1,
        errorCode: "GroundFailure",
        status: "Faulted",
        info: "RCD",
      }),
    ).resolves.toEqual({});
    expect(store.recordStatus).toHaveBeenCalledWith(
      charger,
      {
        connectorId: 1,
        errorCode: "GroundFailure",
        status: "Faulted",
        info: "RCD",
        vendorErrorCode: undefined,
      },
      now,
    );
  });

  it("authorizes by the store's facts", async () => {
    const { store, run } = setup();
    await expect(run("Authorize", { idTag: "RANDOM" })).resolves.toEqual({
      idTagInfo: { status: "Invalid" },
    });
    store.facts = {
      booking: { id: "b-1", status: "arrived", slotOpen: true },
      hostIdTag: null,
      paidWindow: true,
    };
    await expect(run("Authorize", { idTag: "TAG" })).resolves.toEqual({
      idTagInfo: { status: "Accepted" },
    });
    expect(store.tagFacts).toHaveBeenCalledWith("c-1", "TAG", now);
  });

  it("starts a booking session with the store's transaction id", async () => {
    const { store, run } = setup();
    store.facts = {
      booking: { id: "b-1", status: "arrived", slotOpen: true },
      hostIdTag: null,
      paidWindow: true,
    };
    await expect(
      run("StartTransaction", {
        connectorId: 1,
        idTag: "TAG",
        meterStart: 1000,
        timestamp: now.toISOString(),
      }),
    ).resolves.toEqual({ idTagInfo: { status: "Accepted" }, transactionId: 42 });
    expect(store.startBookingSession).toHaveBeenCalledWith(charger, {
      bookingId: "b-1",
      meterStartWh: 1000,
      startedAt: now,
    });
  });

  it("blocks a host session in a paid window and stops it after the reply", async () => {
    const { store, afterReply, call, run } = setup();
    store.facts = { booking: undefined, hostIdTag: "HOST", paidWindow: true };
    const answer = await run("StartTransaction", {
      connectorId: 1,
      idTag: "HOST",
      meterStart: 1000,
      timestamp: now.toISOString(),
    });
    expect(answer.idTagInfo.status).toBe("Blocked");
    expect(store.startBookingSession).not.toHaveBeenCalled();
    afterReply.get("m-1")?.();
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith("RemoteStopTransaction", {
        transactionId: answer.transactionId,
      });
    });
  });

  it("accepts a host session outside paid windows and refuses unknown tags", async () => {
    const { store, afterReply, run } = setup();
    store.facts = { booking: undefined, hostIdTag: "HOST", paidWindow: false };
    const request = { connectorId: 1, meterStart: 1000, timestamp: now.toISOString() };
    await expect(run("StartTransaction", { ...request, idTag: "HOST" })).resolves.toMatchObject({
      idTagInfo: { status: "Accepted" },
    });
    await expect(
      run("StartTransaction", { ...request, idTag: "NOPE" }, "m-2"),
    ).resolves.toMatchObject({
      idTagInfo: { status: "Invalid" },
    });
    expect(afterReply.size).toBe(0);
  });

  it("stores meter values with and without a session", async () => {
    const { store, run } = setup();
    const meterValue = [{ timestamp: now.toISOString(), sampledValue: [{ value: "1000" }] }];
    await expect(
      run("MeterValues", { connectorId: 1, transactionId: 42, meterValue }),
    ).resolves.toEqual({});
    expect(store.recordMeterValues).toHaveBeenCalledWith(charger, 42, [
      { ts: now, energyWh: 1000, powerW: null, currentA: null },
    ]);
    store.recordMeterValues = vi.fn(() => Promise.resolve(undefined));
    await expect(run("MeterValues", { connectorId: 1, meterValue })).resolves.toEqual({});
  });

  it("closes the session on StopTransaction", async () => {
    const { store, run } = setup();
    const request = { meterStop: 2500, timestamp: now.toISOString(), transactionId: 42 };
    await expect(
      run("StopTransaction", { ...request, reason: "Remote", idTag: "TAG" }),
    ).resolves.toEqual({
      idTagInfo: { status: "Accepted" },
    });
    expect(store.stopSession).toHaveBeenCalledWith(charger, {
      transactionId: 42,
      meterStopWh: 2500,
      stoppedAt: now,
      reason: "Remote",
      samples: [],
    });
    store.stopSession = vi.fn(() => Promise.resolve(undefined));
    await expect(run("StopTransaction", request)).resolves.toEqual({});
    expect(store.stopSession).toHaveBeenCalledWith(
      charger,
      expect.objectContaining({ reason: "Local" }),
    );
  });

  it("answers DataTransfer with UnknownVendorId", async () => {
    const { run } = setup();
    expect(await run("DataTransfer", { vendorId: "myenergi" })).toEqual({
      status: "UnknownVendorId",
    });
  });
});
