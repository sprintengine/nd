import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { bookings, chargers, meterValues, payments, sessions, users } from "@nd/db";
import { type ChargerControl, createChargerControlClient, quote } from "@nd/domain";
import { startZappiSim, type ZappiSim } from "@nd/ocpp-core/sim";
import { type Gateway, startGateway } from "@nd/ocpp-gateway/app";
import { desc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { openRealtime, type RealtimeClient } from "../../test/ws.ts";

// End to end: the API, the real OCPP gateway and the Zappi simulator on
// ephemeral ports, over one Postgres. The charger connects with the
// credentials the API issued; the API commands it through the gateway's
// internal endpoint and hears back through LISTEN/NOTIFY.

const SECRET = "integration-test-internal-secret-0123456789";
const MINUTE = 60_000;

let h: Harness;
let gateway: Gateway;
let zappi: ZappiSim;
let driver: string;
let driverId: string;
let socket: RealtimeClient;
let charger: { chargerId: string; chargeboxId: string; secret: string };

/** Commands go to the gateway, which starts after the API (it needs the API's database). */
let target: ChargerControl | undefined;
const lazyControl = new Proxy({} as ChargerControl, {
  get: (_object, command: keyof ChargerControl) => (request: never) => {
    if (target === undefined) throw new Error("gateway not started");
    return target[command](request);
  },
});

const call = (method: "GET" | "POST", url: string, cookie: string, payload?: object) =>
  h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, cookie },
    ...(payload === undefined ? {} : { payload }),
  });

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

async function newBooking(): Promise<{ id: string; idTag: string }> {
  const start = new Date(Math.floor((Date.now() - 10 * MINUTE) / MINUTE) * MINUTE);
  const slot = { start, end: new Date(start.getTime() + 2 * 60 * MINUTE) };
  const idTag = `T${randomBytes(9).toString("hex").toUpperCase()}`;
  const [row] = await h.database.db
    .insert(bookings)
    .values({
      chargerId: charger.chargerId,
      driverId,
      slot,
      status: "confirmed",
      idTag,
      quotedAmountCents: quote(slot, 250),
      pricePerHourCents: 250,
      vehiclePlate: "251-D-1234",
    })
    .returning({ id: bookings.id });
  if (row === undefined) throw new Error("no booking");
  await h.database.db
    .insert(payments)
    .values({ bookingId: row.id, amountCents: quote(slot, 250), status: "paid" });
  return { id: row.id, idTag };
}

const bookingStatus = async (id: string) =>
  (await h.database.db.select().from(bookings).where(eq(bookings.id, id)))[0]?.status;

const latestSession = async (bookingId: string) =>
  (
    await h.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.bookingId, bookingId))
      .orderBy(desc(sessions.createdAt))
      .limit(1)
  )[0];

async function post(url: string, body: object = {}) {
  const response = await call("POST", url, driver, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ status: string; sessionId: string | null }>();
}

beforeAll(async () => {
  h = await startHarness({
    chargerControl: lazyControl,
    sessionTimings: { startTimeoutSeconds: 1, resetRetryDelaySeconds: 1 },
  });
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  gateway = await startGateway({
    databaseUrl: h.database.url,
    host: "127.0.0.1",
    port: 0,
    internal: { host: "127.0.0.1", port: 0, secret: SECRET },
    logger: pino({ level: "silent" }),
    timings: { callTimeoutMs: 2_000 },
  });
  target = createChargerControlClient({ baseUrl: gateway.internalUrl, secret: SECRET });

  // The host registers the charger and gets its OCPP credentials from the API.
  const host = await h.user("aoife@example.com", "+353861230201");
  expect((await call("POST", "/hosts", host, {})).statusCode).toBe(200);
  const created = await call("POST", "/hosts/chargers", host, {
    serial: "21230001",
    connectorType: "tethered",
    address: "3 Test Terrace, Dublin 6",
    location: { lat: 53.326, lng: -6.256 },
  });
  expect(created.statusCode).toBe(201);
  charger = created.json();

  zappi = await startZappiSim({
    url: gateway.ocppUrl,
    chargeboxId: charger.chargeboxId,
    secret: charger.secret,
    startDelayMs: 0,
    resetDelayMs: 200,
    // Fast enough that a few hundred milliseconds register as energy.
    chargeRateKw: 720,
    meterWh: 10_000,
  });
  // Online, with the boot configuration (FreeCharging off) applied.
  await eventually(async () => {
    const [row] = await h.database.db
      .select({ status: chargers.status, config: chargers.ocppConfig })
      .from(chargers)
      .where(eq(chargers.id, charger.chargerId));
    expect(row?.status).toBe("online");
    expect(row?.config.FreeCharging).toBe("false");
  });

  driver = await h.user("cian@example.com", "+353861230202");
  const [me] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "cian@example.com"));
  driverId = me?.id ?? "";
  socket = await openRealtime(
    `ws://127.0.0.1:${String((h.app.server.address() as AddressInfo).port)}/ws`,
    { cookie: driver, origin: APP_ORIGIN },
  );
});

afterAll(async () => {
  await socket.close();
  await zappi.stop();
  await gateway.close();
  await h.close();
});

describe("a session through the real gateway and the Zappi simulator", () => {
  it("arrives, starts, meters, pushes updates, stops and completes", async () => {
    const booking = await newBooking();
    await post(`/bookings/${booking.id}/arrive`);
    zappi.plugIn();
    const starting = await post(`/bookings/${booking.id}/start`);
    expect(["starting", "charging"]).toContain(starting.status);

    await expect(
      socket.next((m) => m.type === "session:update" && m.status === "charging", 10_000),
    ).resolves.toMatchObject({ bookingId: booking.id });
    await expect(
      socket.next((m) => m.type === "booking:update" && m.status === "active"),
    ).resolves.toBeDefined();
    expect(zappi.received("RemoteStartTransaction")).toEqual([
      { idTag: booking.idTag, connectorId: 1 },
    ]);

    const before = socket.messages.length;
    for (let sample = 0; sample < 3; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await zappi.sendMeterValues("Sample.Periodic");
    }
    const session = await latestSession(booking.id);
    await eventually(async () => {
      const rows = await h.database.db
        .select()
        .from(meterValues)
        .where(eq(meterValues.sessionId, session?.id ?? ""));
      expect(rows.length).toBeGreaterThanOrEqual(3);
    });
    const live = await socket.next(
      (m): m is Extract<typeof m, { type: "session:update" }> =>
        socket.messages.indexOf(m) >= before &&
        m.type === "session:update" &&
        m.kwh !== null &&
        m.kwh > 0,
    );
    expect(live).toMatchObject({ status: "charging", kw: 720 });
    expect(live.lastSeenAt).not.toBeNull();

    await post(`/bookings/${booking.id}/stop`);
    await expect(
      socket.next((m) => m.type === "booking:update" && m.status === "completed"),
    ).resolves.toMatchObject({ bookingId: booking.id });
    await expect(
      socket.next((m) => m.type === "session:update" && m.status === "stopped"),
    ).resolves.toMatchObject({ stopReason: "Remote" });
    const stopped = await latestSession(booking.id);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.kwh).toBe(((stopped?.meterStopWh ?? 0) - (stopped?.meterStartWh ?? 0)) / 1000);
    expect(await bookingStatus(booking.id)).toBe("completed");
    zappi.unplug();
  });

  it("refuses a random idTag", async () => {
    const response = await zappi.enterPin("RANDOMTAG0123456789");
    expect(response.idTagInfo.status).toBe("Invalid");
    expect(zappi.state.transaction).toBeUndefined();
  });

  it("fails a start that never sees StartTransaction and asks for the charger's status", async () => {
    const booking = await newBooking();
    await post(`/bookings/${booking.id}/arrive`);
    zappi.setFaults({ neverSendStartTransaction: true });
    zappi.plugIn();
    const triggersBefore = zappi.received("TriggerMessage").length;
    expect((await post(`/bookings/${booking.id}/start`)).status).toBe("starting");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await eventually(async () => {
      await h.jobs.drain();
      expect((await latestSession(booking.id))?.status).toBe("failed");
    });
    expect((await latestSession(booking.id))?.stopReason).toBe("start_timeout");
    await expect(
      socket.next((m) => m.type === "session:update" && m.failure?.code === "start_timeout"),
    ).resolves.toMatchObject({
      failure: {
        message: "The charger didn't respond. Check the cable is plugged in, then try again.",
      },
    });
    expect(zappi.received("TriggerMessage").slice(triggersBefore)).toEqual([
      { requestedMessage: "StatusNotification", connectorId: 1 },
    ]);

    // The charger still holds the transaction it never reported, so the next
    // start is rejected: the API soft-resets it and retries once.
    zappi.setFaults({ neverSendStartTransaction: false });
    const resetsBefore = zappi.received("Reset").length;
    expect((await post(`/bookings/${booking.id}/start`)).status).toBe("starting");
    expect(zappi.received("Reset").slice(resetsBefore)).toEqual([{ type: "Soft" }]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await eventually(async () => {
      await h.jobs.drain();
      expect((await latestSession(booking.id))?.status).toBe("charging");
    }, 15_000);
    expect(await bookingStatus(booking.id)).toBe("active");
    await post(`/bookings/${booking.id}/stop`);
    await eventually(async () => {
      expect(await bookingStatus(booking.id)).toBe("completed");
    });
    zappi.unplug();
  });
});
