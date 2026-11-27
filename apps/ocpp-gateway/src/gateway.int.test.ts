import { bookings, chargers, meterValues, ocppMessages, sessions } from "@nd/db";
import { type ChargerEvent, createChargerControlClient } from "@nd/domain";
import { MessageTypeId } from "@nd/ocpp-core";
import { startZappiSim, ZappiConnectError, type ZappiSim } from "@nd/ocpp-core/sim";
import { and, count, eq, gte } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  createTestDatabase,
  type EventListener,
  listenForEvents,
  newIdTag,
  seedCharger,
  seedConfigWrites,
  type SeededCharger,
  seedOpenBooking,
  type TestDatabase,
} from "../test/database.ts";
import { type Gateway, startGateway } from "./app.ts";
import { createLogger } from "./logger.ts";
import { REPLACED_CLOSE_CODE } from "./registry.ts";

const INTERNAL_SECRET = "integration-test-internal-secret-0123456789";

let database: TestDatabase;
let gateway: Gateway;
let listener: EventListener;
const sims: ZappiSim[] = [];

async function sim(
  charger: SeededCharger,
  options: Partial<Parameters<typeof startZappiSim>[0]> = {},
) {
  const started = await startZappiSim({
    url: gateway.ocppUrl,
    chargeboxId: charger.chargeboxId,
    secret: charger.secret,
    startDelayMs: 0,
    ...options,
  });
  sims.push(started);
  return started;
}

async function chargerRow(id: string) {
  const [row] = await database.db
    .select({
      status: chargers.status,
      ocppConfig: chargers.ocppConfig,
      firmware: chargers.firmware,
      lastHeartbeatAt: chargers.lastHeartbeatAt,
    })
    .from(chargers)
    .where(eq(chargers.id, id));
  return row;
}

async function messageCount(chargerId: string): Promise<number> {
  const [row] = await database.db
    .select({ n: count() })
    .from(ocppMessages)
    .where(eq(ocppMessages.chargerId, chargerId));
  return row?.n ?? 0;
}

/** Polls until `check` stops throwing. */
async function eventually(check: () => Promise<void> | void, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** Waits until the boot configuration has been stored for a charger. */
async function configured(chargerId: string): Promise<Record<string, string>> {
  let config: Record<string, string> = {};
  await eventually(async () => {
    config = (await chargerRow(chargerId))?.ocppConfig ?? {};
    expect(config.FreeCharging).toBe("false");
  });
  return config;
}

const eventsFor = (chargerId: string, type?: ChargerEvent["type"]) =>
  listener.events.filter(
    (event) => event.chargerId === chargerId && (type === undefined || event.type === type),
  );

beforeAll(async () => {
  database = await createTestDatabase();
  listener = await listenForEvents(database.url);
  gateway = await startGateway({
    databaseUrl: database.url,
    host: "127.0.0.1",
    port: 0,
    internal: { host: "127.0.0.1", port: 0, secret: INTERNAL_SECRET },
    logger: createLogger({ level: "silent" }),
    timings: { callTimeoutMs: 2_000 },
  });
});

afterEach(async () => {
  await Promise.all(sims.splice(0).map((started) => started.stop()));
});

afterAll(async () => {
  await gateway.close();
  await listener.close();
  await database.dispose();
});

describe("upgrade", () => {
  it("refuses a wrong password with 401 and stores nothing", async () => {
    const charger = await seedCharger(database.db);
    const error = await startZappiSim({
      url: gateway.ocppUrl,
      chargeboxId: charger.chargeboxId,
      secret: "not-the-secret",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZappiConnectError);
    expect((error as ZappiConnectError).statusCode).toBe(401);
    expect(await messageCount(charger.id)).toBe(0);
    expect(gateway.registry.get(charger.chargeboxId)).toBeUndefined();
    expect((await chargerRow(charger.id))?.status).toBe("onboarding");
  });

  it("refuses an unknown ChargeboxID with 404", async () => {
    const error = await startZappiSim({
      url: gateway.ocppUrl,
      chargeboxId: "29999999",
      secret: "whatever",
    }).catch((caught: unknown) => caught);
    expect((error as ZappiConnectError).statusCode).toBe(404);
  });

  it("refuses a charger without a password hash with 401", async () => {
    const charger = await seedCharger(database.db, { ocppAuthHash: null });
    const error = await startZappiSim({
      url: gateway.ocppUrl,
      chargeboxId: charger.chargeboxId,
      secret: charger.secret,
    }).catch((caught: unknown) => caught);
    expect((error as ZappiConnectError).statusCode).toBe(401);
  });

  it("refuses an upgrade without the ocpp1.6 subprotocol with 400", async () => {
    const charger = await seedCharger(database.db);
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`${gateway.ocppUrl}${charger.chargeboxId}`, ["ocpp2.0.1"], {
        headers: {
          authorization: `Basic ${Buffer.from(`${charger.chargeboxId}:${charger.secret}`).toString("base64")}`,
        },
      });
      ws.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("error", () => undefined);
    });
    expect(status).toBe(400);
  });
});

describe("boot", () => {
  it("accepts the charger, pushes the configuration and stores it", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger, { firmwareVersion: "5.794" });
    const config = await configured(charger.id);
    expect(config).toMatchObject({
      FreeCharging: "false",
      LocalAuthListEnabled: "false",
      StopTransactionOnInvalidId: "true",
      OCPPChargeMode: "Fast",
      MeterValueSampleInterval: "60",
      HeartbeatInterval: "300",
    });
    expect(zappi.state.config.FreeCharging).toBe(false);
    const row = await chargerRow(charger.id);
    expect(row).toMatchObject({ status: "online", firmware: "5.794" });
    expect(row?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(eventsFor(charger.id, "boot")).toHaveLength(1);

    // Every frame in both directions is in the log, with message ids.
    let rows: (typeof ocppMessages.$inferSelect)[] = [];
    await eventually(async () => {
      rows = await database.db
        .select()
        .from(ocppMessages)
        .where(eq(ocppMessages.chargerId, charger.id));
      expect(rows.length).toBe(zappi.frames.length);
    });
    const boot = rows.find((message) => message.action === "BootNotification");
    expect(boot).toMatchObject({ direction: "in", messageType: "call" });
    expect(
      rows.some(
        (message) => message.messageId === boot?.messageId && message.messageType === "call_result",
      ),
    ).toBe(true);
  });

  it("writes nothing on a second boot when the configuration already matches", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    await configured(charger.id);
    const writes = zappi.received("ChangeConfiguration").length;
    expect(writes).toBeGreaterThan(0);
    await zappi.reconnect();
    await eventually(() => {
      expect(zappi.received("GetConfiguration").length).toBe(4);
    });
    expect(zappi.received("ChangeConfiguration")).toHaveLength(writes);
  });

  it("answers Heartbeat with the time and records it", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    const before = (await chargerRow(charger.id))?.lastHeartbeatAt?.getTime() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = await zappi.heartbeat();
    expect(Number.isNaN(Date.parse(answer.currentTime))).toBe(false);
    expect((await chargerRow(charger.id))?.lastHeartbeatAt?.getTime()).toBeGreaterThan(before);
  });

  it("answers DataTransfer with UnknownVendorId", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    await expect(zappi.dataTransfer({ vendorId: "myenergi", data: "x" })).resolves.toEqual({
      status: "UnknownVendorId",
    });
  });
});

describe("connections", () => {
  it("keeps one online charger and one socket after a drop mid-heartbeat and a reconnect", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    await configured(charger.id);
    const first = gateway.registry.get(charger.chargeboxId);
    zappi.heartbeat().catch(() => undefined);
    zappi.disconnect();
    await zappi.reconnect();
    await eventually(() => {
      const current = gateway.registry.get(charger.chargeboxId);
      expect(current).toBeDefined();
      expect(current).not.toBe(first);
      expect(current?.open).toBe(true);
    });
    expect(gateway.registry.all().filter((c) => c.charger.id === charger.id)).toHaveLength(1);
    expect((await chargerRow(charger.id))?.status).toBe("online");
  });

  it("replaces the first socket when a second one connects for the same charger", async () => {
    const charger = await seedCharger(database.db);
    const first = await sim(charger);
    const closed = first.waitForDisconnect();
    const second = await sim(charger);
    expect((await closed).code).toBe(REPLACED_CLOSE_CODE);
    expect(second.state.connected).toBe(true);
    expect(gateway.registry.all().filter((c) => c.charger.id === charger.id)).toHaveLength(1);
    // Commands reach the newer socket.
    const result = await gateway.control.triggerMessage({
      chargeboxId: charger.chargeboxId,
      requestedMessage: "Heartbeat",
    });
    expect(result).toEqual({ ok: true, response: { status: "Accepted" } });
    expect(second.received("TriggerMessage")).toHaveLength(1);
    expect(first.received("TriggerMessage")).toHaveLength(0);
  });
});

describe("configuration write budget", () => {
  it("stops at 24 writes in the rolling hour", async () => {
    const charger = await seedCharger(database.db);
    // The simulator's defaults differ from the boot set in three keys.
    await seedConfigWrites(database.db, charger.id, 22);
    const zappi = await sim(charger);
    await eventually(async () => {
      expect(Object.keys((await chargerRow(charger.id))?.ocppConfig ?? {}).length).toBeGreaterThan(
        0,
      );
    });
    expect(zappi.received("ChangeConfiguration")).toHaveLength(2);
    expect((await chargerRow(charger.id))?.ocppConfig.MeterValueSampleInterval).not.toBe("60");

    const [row] = await database.db
      .select({ n: count() })
      .from(ocppMessages)
      .where(
        and(
          eq(ocppMessages.chargerId, charger.id),
          eq(ocppMessages.action, "ChangeConfiguration"),
          eq(ocppMessages.direction, "out"),
          gte(ocppMessages.ts, new Date(Date.now() - 3_600_000)),
        ),
      );
    expect(row?.n).toBe(24);

    const control = createChargerControlClient({
      baseUrl: gateway.internalUrl,
      secret: INTERNAL_SECRET,
    });
    await expect(
      control.changeConfiguration({
        chargeboxId: charger.chargeboxId,
        key: "HeartbeatInterval",
        value: "300",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "budget_exhausted" });
    expect(zappi.received("ChangeConfiguration")).toHaveLength(2);
  });
});

describe("sessions", () => {
  const control = () =>
    createChargerControlClient({ baseUrl: gateway.internalUrl, secret: INTERNAL_SECRET });

  it("runs a booking session from RemoteStart to StopTransaction", async () => {
    const charger = await seedCharger(database.db);
    const booking = await seedOpenBooking(database.db, charger.id, "arrived");
    const zappi = await sim(charger, { meterWh: 10_000, chargeRateKw: 3_600 });
    await configured(charger.id);
    zappi.plugIn();
    await zappi.waitForStatus("Preparing");

    const started = await control().remoteStart({
      chargeboxId: charger.chargeboxId,
      idTag: booking.idTag,
    });
    expect(started).toEqual({ ok: true, response: { status: "Accepted" } });
    const start = await zappi.waitForSent("StartTransaction");
    const sessionStarted = await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "session_started",
    );
    await zappi.waitForStatus("Charging");
    await eventually(() => {
      expect(zappi.state.transaction?.id).toBeDefined();
    });
    const transactionId = zappi.state.transaction?.id ?? 0;
    expect(sessionStarted).toMatchObject({
      bookingId: booking.id,
      transactionId,
      meterStartWh: start.meterStart,
    });

    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await zappi.sendMeterValues("Sample.Periodic");
    }
    await eventually(() => {
      expect(eventsFor(charger.id, "meter")).toHaveLength(3);
    });

    const stopped = await control().remoteStop({ chargeboxId: charger.chargeboxId, transactionId });
    expect(stopped).toEqual({ ok: true, response: { status: "Accepted" } });
    const stop = await zappi.waitForSent("StopTransaction");
    const sessionStopped = await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "session_stopped",
    );

    const [session] = await database.db
      .select()
      .from(sessions)
      .where(eq(sessions.bookingId, booking.id));
    expect(session).toMatchObject({
      status: "stopped",
      ocppTransactionId: transactionId,
      meterStartWh: start.meterStart,
      meterStopWh: stop.meterStop,
      stopReason: "Remote",
    });
    expect(stop.meterStop).toBeGreaterThan(start.meterStart);
    expect(session?.kwh).toBe((stop.meterStop - start.meterStart) / 1000);
    expect(sessionStopped).toMatchObject({
      sessionId: session?.id,
      bookingId: booking.id,
      sessionStatus: "stopped",
      kwh: session?.kwh,
      reason: "Remote",
    });
    const [bookingRow] = await database.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    expect(bookingRow?.status).toBe("completed");
    const meterRows = await database.db
      .select()
      .from(meterValues)
      .where(eq(meterValues.sessionId, session?.id ?? ""));
    expect(meterRows.length).toBeGreaterThanOrEqual(3);
    expect(meterRows.every((row) => row.energyWh !== null && row.powerW !== null)).toBe(true);

    const types = eventsFor(charger.id).map((event) => event.type);
    expect(types[0]).toBe("boot");
    expect(types.indexOf("session_started")).toBeLessThan(types.indexOf("meter"));
    expect(types.at(-1) === "session_stopped" || types.includes("session_stopped")).toBe(true);
    expect(types.lastIndexOf("meter")).toBeLessThan(types.indexOf("session_stopped"));
  });

  it("stops a session at its kWh cap once per socket, and again after a reconnect", async () => {
    const charger = await seedCharger(database.db);
    const booking = await seedOpenBooking(database.db, charger.id, "arrived");
    await database.db.update(bookings).set({ kwhCap: 2 }).where(eq(bookings.id, booking.id));
    // 3,600 kW: one kWh a second, so the 2 kWh cap is reached after two seconds. The first stop is never answered.
    const zappi = await sim(charger, {
      meterWh: 10_000,
      chargeRateKw: 3_600,
      faults: { ignoreCalls: ["RemoteStopTransaction"] },
    });
    await configured(charger.id);
    zappi.plugIn();
    await zappi.waitForStatus("Preparing");
    await control().remoteStart({ chargeboxId: charger.chargeboxId, idTag: booking.idTag });
    await zappi.waitForStatus("Charging");

    // Below the cap: nothing is stopped.
    await zappi.sendMeterValues("Sample.Periodic");
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(zappi.received("RemoteStopTransaction")).toHaveLength(0);

    // Over the cap: one stop, not repeated while it is outstanding.
    await zappi.sendMeterValues("Sample.Periodic");
    await eventually(() => {
      expect(zappi.received("RemoteStopTransaction")).toHaveLength(1);
    });
    await zappi.sendMeterValues("Sample.Periodic");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(zappi.received("RemoteStopTransaction")).toHaveLength(1);

    // After a reconnect the next MeterValues checks again, and this stop is obeyed.
    zappi.setFaults({ ignoreCalls: [] });
    await zappi.reconnect({ boot: false });
    await zappi.sendMeterValues("Sample.Periodic");
    await zappi.waitForSent("StopTransaction");
    expect(zappi.received("RemoteStopTransaction")).toHaveLength(2);
    await eventually(async () => {
      const [session] = await database.db
        .select()
        .from(sessions)
        .where(eq(sessions.bookingId, booking.id));
      expect(session).toMatchObject({ status: "stopped", stopReason: "Remote" });
      expect(session?.kwh).toBeGreaterThanOrEqual(2);
    });
  });

  it("answers Invalid to a random idTag, and the charger stops its transaction", async () => {
    const charger = await seedCharger(database.db);
    const booking = await seedOpenBooking(database.db, charger.id, "arrived");
    const zappi = await sim(charger);
    await configured(charger.id);
    zappi.plugIn();
    await control().remoteStart({ chargeboxId: charger.chargeboxId, idTag: booking.idTag });
    await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "session_started",
    );
    await eventually(() => {
      expect(zappi.state.transaction?.id).toBeDefined();
    });

    const answer = await zappi.enterPin(newIdTag());
    expect(answer.idTagInfo.status).toBe("Invalid");
    const stop = await zappi.waitForSent("StopTransaction");
    expect(stop.reason).toBe("DeAuthorized");
    await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "session_stopped",
    );
    const [session] = await database.db
      .select()
      .from(sessions)
      .where(eq(sessions.bookingId, booking.id));
    expect(session).toMatchObject({ status: "stopped", stopReason: "DeAuthorized" });
  });

  it("accepts the host's tag outside paid windows", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    await expect(zappi.enterPin(charger.hostIdTag)).resolves.toEqual({
      idTagInfo: { status: "Accepted" },
    });
  });

  it("blocks the host's tag during a paid window and stops its transaction", async () => {
    const charger = await seedCharger(database.db);
    await seedOpenBooking(database.db, charger.id, "confirmed");
    const zappi = await sim(charger);
    await configured(charger.id);
    await expect(zappi.enterPin(charger.hostIdTag)).resolves.toEqual({
      idTagInfo: { status: "Blocked" },
    });

    zappi.plugIn();
    await control().remoteStart({ chargeboxId: charger.chargeboxId, idTag: charger.hostIdTag });
    await zappi.waitForSent("StartTransaction");
    let status: string | undefined;
    await eventually(() => {
      const conf = zappi.frames.find(
        (entry) =>
          entry.direction === "in" &&
          entry.frame.type === MessageTypeId.CallResult &&
          "transactionId" in entry.frame.payload,
      );
      expect(conf).toBeDefined();
      const frame = conf?.frame as { payload: { idTagInfo: { status: string } } } | undefined;
      status = frame?.payload.idTagInfo.status;
    });
    expect(status).toBe("Blocked");
    await eventually(() => {
      expect(zappi.received("RemoteStopTransaction")).toHaveLength(1);
    });
    await zappi.waitForSent("StopTransaction");
    expect(
      await database.db
        .select()
        .from(sessions)
        .innerJoin(bookings, eq(sessions.bookingId, bookings.id))
        .where(eq(bookings.chargerId, charger.id)),
    ).toEqual([]);
  });

  it("surfaces a start that never sends StartTransaction through a triggered status", async () => {
    const charger = await seedCharger(database.db);
    const booking = await seedOpenBooking(database.db, charger.id, "arrived");
    const zappi = await sim(charger);
    await configured(charger.id);
    zappi.setFaults({ neverSendStartTransaction: true });
    zappi.plugIn();
    await expect(
      control().remoteStart({ chargeboxId: charger.chargeboxId, idTag: booking.idTag }),
    ).resolves.toEqual({ ok: true, response: { status: "Accepted" } });
    const since = listener.events.length;
    await expect(
      control().triggerMessage({
        chargeboxId: charger.chargeboxId,
        requestedMessage: "StatusNotification",
        connectorId: 1,
      }),
    ).resolves.toEqual({ ok: true, response: { status: "Accepted" } });
    const status = await listener.waitFor(
      (event) =>
        event.chargerId === charger.id &&
        event.type === "status" &&
        listener.events.indexOf(event) >= since,
    );
    expect(status).toMatchObject({ connectorId: 1, errorCode: "NoError" });
    expect(eventsFor(charger.id, "session_started")).toHaveLength(0);
    expect(
      await database.db.select().from(sessions).where(eq(sessions.bookingId, booking.id)),
    ).toEqual([]);
  });

  it("maps SuspendedEV onto the open session and a fault onto the charger", async () => {
    const charger = await seedCharger(database.db);
    const booking = await seedOpenBooking(database.db, charger.id, "arrived");
    const zappi = await sim(charger);
    await configured(charger.id);
    zappi.plugIn();
    await control().remoteStart({ chargeboxId: charger.chargeboxId, idTag: booking.idTag });
    await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "session_started",
    );
    await zappi.waitForStatus("Charging");

    zappi.suspendEv();
    const suspended = await listener.waitFor(
      (event) =>
        event.chargerId === charger.id && event.type === "status" && event.status === "SuspendedEV",
    );
    expect(suspended).toMatchObject({ sessionStatus: "suspended_ev" });
    zappi.resumeEv();
    await listener.waitFor(
      (event) =>
        event.chargerId === charger.id &&
        event.type === "status" &&
        event.sessionStatus === "charging",
    );

    zappi.fault("GroundFailure", "RCD tripped");
    const fault = await listener.waitFor(
      (event) => event.chargerId === charger.id && event.type === "fault",
    );
    expect(fault).toMatchObject({ errorCode: "GroundFailure", info: "RCD tripped" });
    expect((await chargerRow(charger.id))?.status).toBe("faulted");
    zappi.clearFault();
    await eventually(async () => {
      expect((await chargerRow(charger.id))?.status).toBe("online");
    });
  });
});

describe("ChargerControl", () => {
  it("answers offline for a charger without a socket, and 401 without the secret", async () => {
    const charger = await seedCharger(database.db);
    const control = createChargerControlClient({
      baseUrl: gateway.internalUrl,
      secret: INTERNAL_SECRET,
    });
    await expect(control.reset({ chargeboxId: charger.chargeboxId })).resolves.toMatchObject({
      ok: false,
      reason: "offline",
    });
    const wrong = createChargerControlClient({
      baseUrl: gateway.internalUrl,
      secret: "x".repeat(40),
    });
    await expect(wrong.reset({ chargeboxId: charger.chargeboxId })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("answers no_response when the charger ignores a command", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger, { faults: { ignoreCalls: ["UnlockConnector"] } });
    const control = createChargerControlClient({
      baseUrl: gateway.internalUrl,
      secret: INTERNAL_SECRET,
    });
    await expect(
      control.unlockConnector({ chargeboxId: charger.chargeboxId }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "no_response",
    });
    expect(zappi.received("UnlockConnector")).toHaveLength(1);
  });

  it("reads and stores the configuration, and resets softly", async () => {
    const charger = await seedCharger(database.db);
    const zappi = await sim(charger);
    await configured(charger.id);
    const control = createChargerControlClient({
      baseUrl: gateway.internalUrl,
      secret: INTERNAL_SECRET,
    });
    const read = await control.getConfiguration({
      chargeboxId: charger.chargeboxId,
      keys: ["OCPPChargeMode"],
    });
    expect(read).toMatchObject({
      ok: true,
      response: { configurationKey: [{ key: "OCPPChargeMode", value: "Fast" }] },
    });
    await expect(control.reset({ chargeboxId: charger.chargeboxId })).resolves.toEqual({
      ok: true,
      response: { status: "Accepted" },
    });
    expect(zappi.received("Reset")).toEqual([{ type: "Soft" }]);
  });
});

describe("offline detection", () => {
  it("marks a charger offline after three missed heartbeats", async () => {
    const offlineGateway = await startGateway({
      databaseUrl: database.url,
      host: "127.0.0.1",
      port: 0,
      internal: { host: "127.0.0.1", port: 0, secret: INTERNAL_SECRET },
      logger: createLogger({ level: (process.env.GW_LOG ?? "silent") as "silent" }),
      timings: { heartbeatIntervalSeconds: 1, offlineCheckMs: 100 },
    });
    try {
      const charger = await seedCharger(database.db);
      const zappi = await startZappiSim({
        url: offlineGateway.ocppUrl,
        chargeboxId: charger.chargeboxId,
        secret: charger.secret,
      });
      sims.push(zappi);
      expect((await chargerRow(charger.id))?.status).toBe("online");
      zappi.disconnect();
      const offline = await listener.waitFor(
        (event) => event.chargerId === charger.id && event.type === "offline",
        8_000,
      );
      expect(offline).toMatchObject({ type: "offline" });
      expect((await chargerRow(charger.id))?.status).toBe("offline");

      await zappi.connect({ boot: false });
      await zappi.heartbeat();
      await listener.waitFor((event) => event.chargerId === charger.id && event.type === "online");
      expect((await chargerRow(charger.id))?.status).toBe("online");
    } finally {
      await offlineGateway.close();
    }
  });
});
