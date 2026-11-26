import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OcppTimeoutError } from "../errors.ts";
import { MiniCsms } from "../testing/mini-csms.ts";
import { startZappiSim } from "./index.ts";
import {
  rawDataToString,
  type ZappiSim,
  ZappiSim as ZappiSimClass,
  type ZappiSimOptions,
} from "./zappi.ts";

const ID = "21234567";
const SECRET = "test-secret-not-real";

let csms: MiniCsms;
let sims: ZappiSim[] = [];

async function startCsms(options: Parameters<typeof MiniCsms.start>[0] = {}): Promise<MiniCsms> {
  csms = await MiniCsms.start({ secrets: { [ID]: SECRET }, ...options });
  return csms;
}

async function sim(
  options: Partial<ZappiSimOptions> & { connect?: boolean } = {},
): Promise<ZappiSim> {
  const started = await startZappiSim({
    url: csms.url,
    chargeboxId: ID,
    secret: SECRET,
    startDelayMs: 0,
    ...options,
  });
  sims.push(started);
  return started;
}

/** Fakes timers and Date, but leaves the event loop (and so the sockets) running. */
function fakeTime(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

/** Lets in-flight socket traffic settle for `ms` of real time, whether or not timers are faked. */
function settle(ms = 20): Promise<void> {
  const until = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (performance.now() >= until) {
        resolve();
      } else {
        setImmediate(tick);
      }
    };
    setImmediate(tick);
  });
}

beforeEach(async () => {
  await startCsms();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sims.map((started) => started.stop()));
  sims = [];
  await csms.close();
});

/** Plugs in, starts a transaction remotely and waits until it is Charging with a transaction id. */
async function startCharging(started: ZappiSim, idTag = "booking-1"): Promise<number> {
  started.plugIn();
  const since = started.frames.length;
  await expect(csms.call(ID, "RemoteStartTransaction", { connectorId: 1, idTag })).resolves.toEqual(
    {
      status: "Accepted",
    },
  );
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  }
  const start = await started.waitForSent("StartTransaction", { since });
  expect(start.idTag).toBe(idTag);
  await started.waitForStatus("Charging");
  await vi.waitFor(() => {
    expect(started.state.transaction?.id).toBeDefined();
  });
  return started.state.transaction?.id ?? -1;
}

describe("connecting", () => {
  it("connects to <url><chargeboxId> with Basic Auth and ocpp1.6, then boots", async () => {
    const started = await sim();
    expect(csms.upgrades[0]).toEqual({
      url: `/v16/${ID}`,
      authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`,
      protocols: "ocpp1.6",
    });
    expect(csms.connection(ID).protocol).toBe("ocpp1.6");
    expect(await csms.waitForCall("BootNotification")).toEqual({
      chargePointVendor: "myenergi",
      chargePointModel: "Zappi",
      chargePointSerialNumber: ID,
      firmwareVersion: "5.794",
    });
    await csms.waitForCall("StatusNotification", {
      predicate: (status) => status.status === "Available",
    });
    expect(started.state).toMatchObject({
      connected: true,
      registration: "Accepted",
      status: "Available",
    });
    expect(started.sent("BootNotification")).toHaveLength(1);
  });

  it("is refused with 401 for a wrong secret and 404 for an unknown chargebox", async () => {
    await expect(sim({ secret: "wrong" })).rejects.toMatchObject({
      name: "ZappiConnectError",
      statusCode: 401,
    });
    await expect(sim({ chargeboxId: "29999999" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("sends no credentials when no secret is given", async () => {
    await csms.close();
    csms = await MiniCsms.start();
    const started = new ZappiSimClass({ url: csms.url, chargeboxId: ID });
    sims.push(started);
    await started.connect();
    expect(csms.upgrades[0]?.authorization).toBeUndefined();
  });

  it("refuses a server that does not select ocpp1.6", async () => {
    await csms.close();
    await startCsms({ withoutSubprotocol: true });
    await expect(sim()).rejects.toMatchObject({ name: "ZappiConnectError", statusCode: undefined });
  });

  it("can be created unconnected and refuses to connect twice", async () => {
    const started = await sim({ connect: false });
    expect(started.state.connected).toBe(false);
    await started.connect();
    await expect(started.connect()).rejects.toThrow("already connected");
  });

  it("retries a Pending boot after the interval", async () => {
    fakeTime();
    csms.bootStatus = "Pending";
    await csms.close();
    await startCsms({ bootStatus: "Pending", heartbeatInterval: 30 });
    const started = await sim();
    expect(started.state.registration).toBe("Pending");
    expect(() => {
      started.unplug();
    }).not.toThrow();
    csms.bootStatus = "Accepted";
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(started.state.registration).toBe("Accepted");
    });
    expect(csms.callsOf("BootNotification")).toHaveLength(2);
  });

  it("retries a boot rejected with interval 0 after 60 s", async () => {
    fakeTime();
    await csms.close();
    await startCsms({ bootStatus: "Rejected", heartbeatInterval: 0 });
    const started = await sim();
    expect(started.state.registration).toBe("Rejected");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(csms.callsOf("BootNotification")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await csms.waitForCall("BootNotification", { since: 1 });
  });
});

describe("heartbeats", () => {
  it("heartbeats at the interval the boot accepted, and follows HeartbeatInterval changes", async () => {
    fakeTime();
    await csms.close();
    await startCsms({ heartbeatInterval: 60 });
    const started = await sim();
    expect(started.config.get("HeartbeatInterval")).toBe(60);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(csms.callsOf("Heartbeat")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await csms.waitForCall("Heartbeat");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(csms.callsOf("Heartbeat")).toHaveLength(2);
    });

    await expect(
      csms.call(ID, "ChangeConfiguration", { key: "HeartbeatInterval", value: "10" }),
    ).resolves.toEqual({
      status: "Accepted",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => {
      expect(csms.callsOf("Heartbeat")).toHaveLength(3);
    });

    await csms.call(ID, "ChangeConfiguration", { key: "HeartbeatInterval", value: "0" });
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    expect(csms.callsOf("Heartbeat")).toHaveLength(3);
  });

  it("sends a Heartbeat on demand", async () => {
    const started = await sim();
    await expect(started.heartbeat()).resolves.toMatchObject({
      currentTime: expect.any(String) as unknown,
    });
  });
});

describe("remote start and stop", () => {
  it("answers RemoteStart with Accepted, then sends StartTransaction(meterStart) after the delay", async () => {
    fakeTime();
    const started = await sim({
      startDelayMs: 2_000,
      meterWh: 12_345,
      config: { FreeCharging: false },
    });
    started.plugIn();
    await csms.waitForCall("StatusNotification", {
      predicate: (status) => status.status === "Preparing",
    });
    expect(started.state.chargeMode).toBe("Stop");
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "booking-1" })).resolves.toEqual({
      status: "Accepted",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(csms.callsOf("StartTransaction")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await csms.waitForCall("StartTransaction")).toMatchObject({
      connectorId: 1,
      idTag: "booking-1",
      meterStart: 12_345,
    });
    await csms.waitForCall("StatusNotification", {
      predicate: (status) => status.status === "Charging",
    });
    await vi.waitFor(() => {
      expect(started.state.transaction).toMatchObject({
        id: 1,
        idTag: "booking-1",
        meterStart: 12_345,
      });
    });
    expect(started.state.chargeMode).toBe("Fast");
  });

  it("starts when the car is plugged in after the RemoteStart", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    await csms.call(ID, "RemoteStartTransaction", { idTag: "early" });
    expect(started.state.chargeMode).toBe("Fast");
    started.plugIn();
    expect((await csms.waitForCall("StartTransaction")).idTag).toBe("early");
  });

  it("rejects RemoteStart while a transaction is open", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    await startCharging(started);
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "second" })).resolves.toEqual({
      status: "Rejected",
    });
    expect(csms.callsOf("StartTransaction")).toHaveLength(1);
  });

  it("rejects RemoteStart while a start is pending or for another connector", async () => {
    const started = await sim({ startDelayMs: 60_000, config: { FreeCharging: false } });
    started.plugIn();
    await expect(
      csms.call(ID, "RemoteStartTransaction", { connectorId: 2, idTag: "x" }),
    ).resolves.toEqual({
      status: "Rejected",
    });
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "x" })).resolves.toEqual({
      status: "Accepted",
    });
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "y" })).resolves.toEqual({
      status: "Rejected",
    });
  });

  it("rejects RemoteStart while Faulted, and resumes after the fault clears", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    started.plugIn();
    started.fault("GroundFailure", "earth leakage");
    expect(
      await csms.waitForCall("StatusNotification", {
        predicate: (status) => status.status === "Faulted",
      }),
    ).toMatchObject({ errorCode: "GroundFailure", info: "earth leakage" });
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "x" })).resolves.toEqual({
      status: "Rejected",
    });
    started.clearFault();
    await started.waitForStatus("Preparing");
    expect(started.state.errorCode).toBe("NoError");
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "x" })).resolves.toEqual({
      status: "Accepted",
    });
    await csms.waitForCall("StartTransaction");
  });

  it("with FreeCharging=false, unplug emits StopTransaction and returns to Available, locked again", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    const transactionId = await startCharging(started);
    const since = csms.received.length;
    started.unplug();
    const stop = await csms.waitForCall("StopTransaction", { since });
    expect(stop).toMatchObject({ transactionId, reason: "EVDisconnected", idTag: "booking-1" });
    expect(stop.meterStop).toBeGreaterThanOrEqual(0);
    const available = await csms.waitForCall("StatusNotification", {
      since,
      predicate: (status) => status.status === "Available",
    });
    const order = csms.received.slice(since).map((call) => call.action);
    expect(order.indexOf("StopTransaction")).toBeLessThan(
      csms.received.slice(since).findIndex((call) => call.payload === available),
    );
    expect(started.state).toMatchObject({
      status: "Available",
      chargeMode: "Stop",
      transaction: undefined,
    });

    started.plugIn();
    await started.waitForStatus("Preparing");
    await settle();
    expect(csms.callsOf("StartTransaction")).toHaveLength(1);
  });

  it("with FreeCharging=true, starts on plug-in with the free-charging tag", async () => {
    const started = await sim({ freeChargingIdTag: "free" });
    started.plugIn();
    expect((await csms.waitForCall("StartTransaction")).idTag).toBe("free");
    await started.waitForStatus("Charging");
    started.unplug();
    await csms.waitForCall("StopTransaction");
    await started.waitForStatus("Available");
    expect(started.state.chargeMode).toBe("Fast");
  });

  it("stops on RemoteStopTransaction, stays Finishing while plugged, then Available on unplug", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    const transactionId = await startCharging(started);
    await expect(
      csms.call(ID, "RemoteStopTransaction", { transactionId: transactionId + 1 }),
    ).resolves.toEqual({
      status: "Rejected",
    });
    await expect(csms.call(ID, "RemoteStopTransaction", { transactionId })).resolves.toEqual({
      status: "Accepted",
    });
    expect(await csms.waitForCall("StopTransaction")).toMatchObject({
      transactionId,
      reason: "Remote",
    });
    await started.waitForStatus("Finishing");
    started.unplug();
    await started.waitForStatus("Available");
    await settle();
    expect(csms.callsOf("StopTransaction")).toHaveLength(1);
  });

  it("unlocks the connector, ending the transaction", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    await startCharging(started);
    await expect(csms.call(ID, "UnlockConnector", { connectorId: 2 })).resolves.toEqual({
      status: "UnlockFailed",
    });
    await expect(csms.call(ID, "UnlockConnector", { connectorId: 1 })).resolves.toEqual({
      status: "Unlocked",
    });
    expect((await csms.waitForCall("StopTransaction")).reason).toBe("UnlockCommand");
  });

  it("cannot unlock a tethered connector", async () => {
    await sim({ tethered: true });
    await expect(csms.call(ID, "UnlockConnector", { connectorId: 1 })).resolves.toEqual({
      status: "NotSupported",
    });
  });
});

describe("Authorize", () => {
  it("unlocks a locked charger for an accepted PIN", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    started.plugIn();
    await expect(started.enterPin("1234")).resolves.toEqual({ idTagInfo: { status: "Accepted" } });
    expect(await csms.waitForCall("Authorize")).toEqual({ idTag: "1234" });
    expect((await csms.waitForCall("StartTransaction")).idTag).toBe("1234");
  });

  it("stays locked for an invalid PIN", async () => {
    csms.invalidIdTags.add("0000");
    const started = await sim({ config: { FreeCharging: false } });
    started.plugIn();
    await expect(started.enterPin("0000")).resolves.toEqual({ idTagInfo: { status: "Invalid" } });
    await settle();
    expect(csms.callsOf("StartTransaction")).toHaveLength(0);
    expect(started.state.chargeMode).toBe("Stop");
  });

  it("stops the transaction for an invalid tag when StopTransactionOnInvalidId=true", async () => {
    csms.invalidIdTags.add("stolen");
    const started = await sim({ config: { StopTransactionOnInvalidId: true } });
    started.plugIn();
    await started.waitForStatus("Charging");
    await vi.waitFor(() => {
      expect(started.state.transaction?.id).toBeDefined();
    });
    await started.enterPin("stolen");
    expect((await csms.waitForCall("StopTransaction")).reason).toBe("DeAuthorized");
    await started.waitForStatus("Finishing");
  });

  it("suspends instead when StopTransactionOnInvalidId=false", async () => {
    csms.invalidIdTags.add("stolen");
    const started = await sim({ config: { StopTransactionOnInvalidId: false } });
    started.plugIn();
    await started.waitForStatus("Charging");
    await started.enterPin("stolen");
    await started.waitForStatus("SuspendedEVSE");
    expect(csms.callsOf("StopTransaction")).toHaveLength(0);
    expect(started.state.powerW).toBe(0);
  });

  it("keeps charging when a valid PIN is entered mid-transaction", async () => {
    const started = await sim();
    started.plugIn();
    await started.waitForStatus("Charging");
    await started.enterPin("1234");
    expect(started.state.status).toBe("Charging");
  });

  it("honours StopTransactionOnInvalidId for a StartTransaction answered Invalid", async () => {
    csms.invalidIdTags.add("expired");
    const started = await sim({
      config: { FreeCharging: false, StopTransactionOnInvalidId: true },
    });
    started.plugIn();
    await csms.call(ID, "RemoteStartTransaction", { idTag: "expired" });
    expect((await csms.waitForCall("StopTransaction")).reason).toBe("DeAuthorized");
    await started.waitForStatus("Finishing");
  });

  it("cannot authorize while offline", async () => {
    const started = await sim();
    started.disconnect();
    await started.waitForDisconnect();
    await expect(started.enterPin("1234")).rejects.toMatchObject({ name: "SimDisconnectedError" });
  });
});

describe("metering", () => {
  it("sends Energy.Active.Import.Register and Power.Active.Import every MeterValueSampleInterval", async () => {
    fakeTime();
    const started = await sim({
      chargeRateKw: 7.2,
      meterWh: 1_000,
      config: { FreeCharging: false },
    });
    await csms.call(ID, "ChangeConfiguration", { key: "MeterValueSampleInterval", value: "60" });
    const transactionId = await startCharging(started);
    await vi.advanceTimersByTimeAsync(60_000);
    const first = await csms.waitForCall("MeterValues");
    expect(first).toEqual({
      connectorId: 1,
      transactionId,
      meterValue: [
        {
          timestamp: expect.any(String) as unknown,
          sampledValue: [
            {
              value: "1120",
              context: "Sample.Periodic",
              measurand: "Energy.Active.Import.Register",
              location: "Outlet",
              unit: "Wh",
            },
            {
              value: "7200",
              context: "Sample.Periodic",
              measurand: "Power.Active.Import",
              location: "Outlet",
              unit: "W",
            },
          ],
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(csms.callsOf("MeterValues")).toHaveLength(2);
    });
    expect(csms.callsOf("MeterValues")[1]?.meterValue[0]?.sampledValue[0]?.value).toBe("1240");
    expect(started.state.meterWh).toBe(1_240);

    started.unplug();
    expect((await csms.waitForCall("StopTransaction")).meterStop).toBe(1_240);
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    expect(csms.callsOf("MeterValues")).toHaveLength(2);
  });

  it("defaults to a 900 s sample interval", async () => {
    fakeTime();
    const started = await sim();
    expect(started.config.get("MeterValueSampleInterval")).toBe(900);
    started.plugIn();
    await vi.advanceTimersByTimeAsync(0);
    await started.waitForStatus("Charging");
    await vi.advanceTimersByTimeAsync(899_000);
    expect(csms.callsOf("MeterValues")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await csms.waitForCall("MeterValues");
  });

  it("stops counting energy while the car or the charger suspends", async () => {
    fakeTime();
    const started = await sim({ chargeRateKw: 3.6 });
    started.plugIn();
    await vi.advanceTimersByTimeAsync(0);
    await started.waitForStatus("Charging");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(started.state.meterWh).toBe(3_600);
    started.suspendEv();
    expect(started.state.status).toBe("SuspendedEV");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(started.state.meterWh).toBe(3_600);
    started.resumeEv();
    await csms.call(ID, "ChangeConfiguration", { key: "OCPPChargeMode", value: "Stop" });
    expect(started.state.status).toBe("SuspendedEVSE");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(started.state.meterWh).toBe(3_600);
    await csms.call(ID, "ChangeConfiguration", { key: "OCPPChargeMode", value: "Eco_Plus" });
    expect(started.state.status).toBe("Charging");
    await csms.call(ID, "ChangeConfiguration", { key: "MeterValueSampleInterval", value: "0" });
    await settle();
    const sampled = csms.callsOf("MeterValues").length;
    expect(sampled).toBe(12);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await settle();
    expect(started.state.meterWh).toBe(7_200);
    expect(csms.callsOf("MeterValues")).toHaveLength(sampled);
  });

  it("sends MeterValues on demand, without a transaction id when idle", async () => {
    const started = await sim();
    await started.sendMeterValues();
    const values = await csms.waitForCall("MeterValues");
    expect(values.transactionId).toBeUndefined();
    expect(values.meterValue[0]?.sampledValue[0]?.context).toBe("Trigger");
  });
});

describe("configuration", () => {
  it("answers GetConfiguration for every key, some keys and unknown keys", async () => {
    await sim();
    const all = await csms.call(ID, "GetConfiguration", {});
    expect(all.configurationKey?.map((entry) => entry.key)).toEqual([
      "FreeCharging",
      "LocalAuthListEnabled",
      "StopTransactionOnInvalidId",
      "OCPPChargeMode",
      "MeterValueSampleInterval",
      "HeartbeatInterval",
      "NumberOfConnectors",
      "SupportedFeatureProfiles",
    ]);
    expect(await csms.call(ID, "GetConfiguration", { key: ["freecharging", "Nope"] })).toEqual({
      configurationKey: [{ key: "FreeCharging", readonly: false, value: "true" }],
      unknownKey: ["Nope"],
    });
  });

  it("applies the boot configuration set and reports it back", async () => {
    await sim();
    const set = {
      FreeCharging: "false",
      LocalAuthListEnabled: "false",
      StopTransactionOnInvalidId: "true",
      OCPPChargeMode: "Fast",
      MeterValueSampleInterval: "60",
      HeartbeatInterval: "300",
    };
    for (const [key, value] of Object.entries(set)) {
      await expect(csms.call(ID, "ChangeConfiguration", { key, value })).resolves.toEqual({
        status: "Accepted",
      });
    }
    const read = await csms.call(ID, "GetConfiguration", { key: Object.keys(set) });
    expect(
      Object.fromEntries((read.configurationKey ?? []).map((entry) => [entry.key, entry.value])),
    ).toEqual(set);
  });

  it("rejects wrong-case charge modes, read-only keys and bad values; unknown keys are NotSupported", async () => {
    await sim();
    const change = (key: string, value: string) =>
      csms.call(ID, "ChangeConfiguration", { key, value });
    await expect(change("OCPPChargeMode", "fast")).resolves.toEqual({ status: "Rejected" });
    await expect(change("OCPPChargeMode", "FAST")).resolves.toEqual({ status: "Rejected" });
    await expect(change("NumberOfConnectors", "2")).resolves.toEqual({ status: "Rejected" });
    await expect(change("FreeCharging", "maybe")).resolves.toEqual({ status: "Rejected" });
    await expect(change("HeartbeatInterval", "-5")).resolves.toEqual({ status: "Rejected" });
    await expect(change("ConnectionTimeOut", "60")).resolves.toEqual({ status: "NotSupported" });
  });

  it("rejects writes beyond 24 per rolling hour", async () => {
    fakeTime();
    const started = await sim();
    const write = (n: number) =>
      csms.call(ID, "ChangeConfiguration", {
        key: "MeterValueSampleInterval",
        value: String(60 + n),
      });
    for (let n = 0; n < 24; n += 1) {
      await expect(write(n)).resolves.toEqual({ status: "Accepted" });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await expect(write(24)).resolves.toEqual({ status: "Rejected" });
    expect(started.config.get("MeterValueSampleInterval")).toBe(83);
    // The first write leaves the window an hour after it was made.
    await vi.advanceTimersByTimeAsync(36 * 60_000);
    await expect(write(25)).resolves.toEqual({ status: "Accepted" });
    await expect(write(26)).resolves.toEqual({ status: "Rejected" });
  });

  it("turning FreeCharging on starts a waiting car", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    started.plugIn();
    await started.waitForStatus("Preparing");
    await csms.call(ID, "ChangeConfiguration", { key: "FreeCharging", value: "TRUE" });
    await csms.waitForCall("StartTransaction");
    await csms.call(ID, "ChangeConfiguration", { key: "LocalAuthListEnabled", value: "false" });
  });
});

describe("other central system calls", () => {
  it("answers TriggerMessage and sends the requested message", async () => {
    const started = await sim();
    const trigger = (
      requestedMessage: "BootNotification" | "Heartbeat" | "MeterValues" | "StatusNotification",
    ) => csms.call(ID, "TriggerMessage", { requestedMessage, connectorId: 1 });
    await expect(trigger("Heartbeat")).resolves.toEqual({ status: "Accepted" });
    await csms.waitForCall("Heartbeat");
    await expect(trigger("MeterValues")).resolves.toEqual({ status: "Accepted" });
    await csms.waitForCall("MeterValues");
    const statuses = csms.callsOf("StatusNotification").length;
    await expect(trigger("StatusNotification")).resolves.toEqual({ status: "Accepted" });
    await vi.waitFor(() => {
      expect(csms.callsOf("StatusNotification")).toHaveLength(statuses + 1);
    });
    await expect(trigger("BootNotification")).resolves.toEqual({ status: "Accepted" });
    await csms.waitForCall("BootNotification", { since: 1 });
    await vi.waitFor(() => {
      expect(started.sent("BootNotification")).toHaveLength(2);
    });
    await expect(
      csms.call(ID, "TriggerMessage", { requestedMessage: "FirmwareStatusNotification" }),
    ).resolves.toEqual({ status: "NotImplemented" });
    await expect(
      csms.call(ID, "TriggerMessage", { requestedMessage: "DiagnosticsStatusNotification" }),
    ).resolves.toEqual({ status: "NotImplemented" });
    await expect(
      csms.call(ID, "TriggerMessage", { requestedMessage: "Heartbeat", connectorId: 3 }),
    ).resolves.toEqual({ status: "Rejected" });
  });

  it("resets: stops the transaction, drops the socket and boots again", async () => {
    const started = await sim({ resetDelayMs: 10, config: { FreeCharging: false } });
    await startCharging(started);
    await expect(csms.call(ID, "Reset", { type: "Soft" })).resolves.toEqual({ status: "Accepted" });
    expect((await csms.waitForCall("StopTransaction")).reason).toBe("SoftReset");
    await started.waitForDisconnect();
    await csms.waitForCall("BootNotification", { since: 1 });
    await vi.waitFor(() => {
      expect(started.state.registration).toBe("Accepted");
    });
    expect(started.state).toMatchObject({ status: "Finishing", chargeMode: "Stop" });
  });

  it("hard resets with the HardReset reason", async () => {
    const started = await sim({ resetDelayMs: 10 });
    started.plugIn();
    await started.waitForStatus("Charging");
    await csms.call(ID, "Reset", { type: "Hard" });
    expect((await csms.waitForCall("StopTransaction")).reason).toBe("HardReset");
  });

  it("sends DataTransfer", async () => {
    const started = await sim();
    await expect(
      started.dataTransfer({ vendorId: "myenergi", messageId: "x", data: "{}" }),
    ).resolves.toEqual({
      status: "UnknownVendorId",
    });
  });
});

describe("fault scripts", () => {
  it("drops the socket without reconnecting", async () => {
    const started = await sim();
    started.disconnect();
    expect(await started.waitForDisconnect()).toMatchObject({ code: 1006 });
    await vi.waitFor(() => {
      expect(csms.connections.size).toBe(0);
    });
    expect(started.state.connected).toBe(false);
    started.plugIn();
    expect(started.state.status).toBe("Preparing");
  });

  it("reconnects with or without a new BootNotification", async () => {
    const started = await sim();
    await expect(started.reconnect()).resolves.toMatchObject({ status: "Accepted" });
    await csms.waitForConnection(ID);
    expect(csms.callsOf("BootNotification")).toHaveLength(2);
    started.disconnect();
    await started.waitForDisconnect();
    await expect(started.reconnect({ boot: false })).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(csms.upgrades).toHaveLength(3);
    });
    expect(csms.callsOf("BootNotification")).toHaveLength(2);
    expect(started.state.registration).toBe("Accepted");
  });

  it("reconnects on its own after the server drops it, retrying while refused", async () => {
    const problems: Error[] = [];
    const started = await sim({ autoReconnectMs: 20 });
    started.on("problem", (error) => problems.push(error));
    csms.secrets = { [ID]: "rotated" };
    csms.connection(ID).close();
    await started.waitForDisconnect();
    await vi.waitFor(() => {
      expect(problems.some((error) => error.message.includes("401"))).toBe(true);
    });
    csms.secrets = { [ID]: SECRET };
    await vi.waitFor(() => {
      expect(csms.callsOf("BootNotification")).toHaveLength(2);
    });
  });

  it("queues transaction messages while offline and delivers them after reconnecting", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    const transactionId = await startCharging(started);
    started.disconnect();
    await started.waitForDisconnect();
    started.unplug();
    expect(started.state.status).toBe("Available");
    await started.reconnect();
    expect(await csms.waitForCall("StopTransaction")).toMatchObject({
      transactionId,
      reason: "EVDisconnected",
    });
  });

  it("delays replies", async () => {
    fakeTime();
    const started = await sim({ faults: { replyDelayMs: 5_000 } });
    let answered = false;
    const reply = csms.call(ID, "GetConfiguration", { key: ["FreeCharging"] }).then((response) => {
      answered = true;
      return response;
    });
    await settle();
    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(reply).resolves.toMatchObject({ configurationKey: [{ key: "FreeCharging" }] });
    started.setFaults({ replyDelayMs: 0 });
  });

  it("never answers ignored calls", async () => {
    fakeTime();
    const started = await sim({ faults: { ignoreCalls: ["ChangeConfiguration"] } });
    const ignored: string[] = [];
    started.on("ignored", ({ action }) => ignored.push(action));
    const reply = csms.call(ID, "ChangeConfiguration", { key: "FreeCharging", value: "false" });
    const assertion = expect(reply).rejects.toBeInstanceOf(OcppTimeoutError);
    await vi.waitFor(() => {
      expect(ignored).toEqual(["ChangeConfiguration"]);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(started.config.get("FreeCharging")).toBe(true);
    expect(started.received("ChangeConfiguration")).toHaveLength(1);
  });

  it("ignores calls chosen by a predicate", async () => {
    const started = await sim({
      faults: {
        ignoreCalls: (action, payload) =>
          action === "ChangeConfiguration" && payload.key === "OCPPChargeMode",
      },
    });
    const ignored = new Promise((resolve) => started.once("ignored", resolve));
    void csms
      .call(ID, "ChangeConfiguration", { key: "OCPPChargeMode", value: "Eco" })
      .catch(() => undefined);
    await ignored;
    await expect(
      csms.call(ID, "ChangeConfiguration", { key: "FreeCharging", value: "false" }),
    ).resolves.toEqual({
      status: "Accepted",
    });
  });

  it("can charge without ever sending StartTransaction (or StopTransaction for it)", async () => {
    const started = await sim({
      config: { FreeCharging: false },
      faults: { neverSendStartTransaction: true },
    });
    started.plugIn();
    await csms.call(ID, "RemoteStartTransaction", { idTag: "booking-1" });
    await started.waitForStatus("Charging");
    expect(started.state.transaction).toMatchObject({ id: undefined, idTag: "booking-1" });
    await started.sendMeterValues();
    expect((await csms.waitForCall("MeterValues")).transactionId).toBeUndefined();
    started.unplug();
    await started.waitForStatus("Available");
    await settle();
    expect(csms.callsOf("StartTransaction")).toHaveLength(0);
    expect(csms.callsOf("StopTransaction")).toHaveLength(0);
  });

  it("can end a transaction without sending StopTransaction", async () => {
    const started = await sim({ config: { FreeCharging: false } });
    const transactionId = await startCharging(started);
    started.setFaults({ neverSendStopTransaction: true });
    const stopped = new Promise((resolve) => started.once("transactionStopped", resolve));
    await csms.call(ID, "RemoteStopTransaction", { transactionId });
    await expect(stopped).resolves.toMatchObject({ reason: "Remote" });
    await started.waitForStatus("Finishing");
    await settle();
    expect(csms.callsOf("StopTransaction")).toHaveLength(0);
  });
});

describe("lifecycle and hooks", () => {
  it("records frames and exposes waiting helpers", async () => {
    const started = await sim();
    expect(started.frames[0]?.direction).toBe("out");
    expect(started.sent("BootNotification")[0]?.chargePointModel).toBe("Zappi");
    await expect(started.waitForSent("BootNotification")).resolves.toMatchObject({
      chargePointVendor: "myenergi",
    });
    await expect(started.waitForSent("Heartbeat", { timeoutMs: 20 })).rejects.toThrow(
      "Timed out waiting for Heartbeat to be sent",
    );
    await expect(started.waitForStatus("Charging", 20)).rejects.toThrow(
      "Timed out waiting for status Charging",
    );
    await expect(started.waitForStatus("Available")).resolves.toBeUndefined();
    const next = started.waitForSent("Heartbeat", {
      since: started.frames.length,
      predicate: () => true,
    });
    await started.heartbeat();
    await expect(next).resolves.toEqual({});
  });

  it("stops cleanly, once, and cannot be reused", async () => {
    const started = await sim();
    await started.stop();
    await started.stop();
    expect(started.state.connected).toBe(false);
    await expect(started.connect()).rejects.toMatchObject({ name: "SimStoppedError" });
    await expect(started.heartbeat()).rejects.toMatchObject({ name: "SimStoppedError" });
  });

  it("stops while connecting or offline with queued messages", async () => {
    const offline = await sim({ config: { FreeCharging: false } });
    await startCharging(offline);
    offline.disconnect();
    await offline.waitForDisconnect();
    offline.unplug();
    await offline.stop();

    const connecting = new ZappiSimClass({ url: csms.url, chargeboxId: ID, secret: SECRET });
    const attempt = connecting.connect();
    await connecting.stop();
    await expect(attempt).rejects.toBeInstanceOf(Error);
  });

  it("logs what it does", async () => {
    const lines: string[] = [];
    const started = await sim({ log: (line) => lines.push(line) });
    started.plugIn();
    await started.waitForStatus("Charging");
    expect(lines.some((line) => line.startsWith(`[${ID}] connected to`))).toBe(true);
    expect(lines.some((line) => line.includes("status Charging"))).toBe(true);
  });

  it("reports protocol problems from the central system", async () => {
    const started = await sim();
    const problem = new Promise<Error>((resolve) => started.once("problem", resolve));
    csms.connection(ID).send('[3,"nobody-asked",{}]');
    await expect(problem).resolves.toMatchObject({
      message: expect.stringContaining("nobody-asked") as unknown,
    });
    const unparseable = new Promise<Error>((resolve) => started.once("problem", resolve));
    csms.connection(ID).send("not json");
    await expect(unparseable).resolves.toMatchObject({ message: "Message is not valid JSON" });
  });

  it("decodes every ws message shape", () => {
    expect(rawDataToString(Buffer.from("a"))).toBe("a");
    expect(rawDataToString([Buffer.from("a"), Buffer.from("b")])).toBe("ab");
    expect(rawDataToString(new TextEncoder().encode("c").buffer)).toBe("c");
  });
});
