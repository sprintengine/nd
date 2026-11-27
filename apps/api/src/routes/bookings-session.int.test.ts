import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  bookings,
  chargers,
  hosts,
  meterValues,
  ocppMessages,
  payments,
  sessions,
  users,
} from "@nd/db";
import {
  CHARGER_EVENT_VERSION,
  CHARGER_EVENTS_CHANNEL,
  type ChargerEvent,
  quote,
  type SessionState,
} from "@nd/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { scriptedChargerControl } from "../../test/fakes.ts";
import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { ofType, openRealtime, type RealtimeClient, upgradeStatus } from "../../test/ws.ts";
import { remoteStartJob, startTimeoutJob, windowEndStopJob } from "../sessions/jobs.ts";

const MINUTE = 60_000;
const CHARGER_LOCATION = { lat: 53.326, lng: -6.256 };

/** A clock the tests move; starts at the real time so Postgres and pg-boss agree. */
const clock = {
  current: new Date(),
  now() {
    return this.current;
  },
};

const control = scriptedChargerControl();
let h: Harness;
let wsUrl: string;
let driver: string;
let driverId: string;
let host: string;
let hostUserId: string;
let stranger: string;
const clients: RealtimeClient[] = [];

const call = (method: "GET" | "POST", url: string, cookie: string, payload?: object) =>
  h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, cookie },
    ...(payload === undefined ? {} : { payload }),
  });

async function userId(email: string): Promise<string> {
  const [row] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
}

interface Booking {
  readonly id: string;
  readonly chargerId: string;
  readonly chargeboxId: string;
  readonly idTag: string;
  readonly slot: { start: Date; end: Date };
}

/** A confirmed, paid booking of the driver at a new charger of the host, starting `startIn` from now. */
async function newBooking({
  startIn = -10 * MINUTE,
  hours = 2,
  paid = true,
} = {}): Promise<Booking> {
  const [hostRow] = await h.database.db
    .insert(hosts)
    .values({ userId: hostUserId, payoutStatus: "enabled" })
    .onConflictDoUpdate({ target: hosts.userId, set: { payoutStatus: "enabled" } })
    .returning({ id: hosts.id });
  if (hostRow === undefined) throw new Error("no host");
  const suffix = randomBytes(4).toString("hex");
  const chargeboxId = `ND${suffix.toUpperCase()}`;
  const [charger] = await h.database.db
    .insert(chargers)
    .values({
      hostId: hostRow.id,
      model: "zappi_v2_1",
      serial: `2${suffix}`,
      chargeboxId,
      maxKw: 7.4,
      connectorType: "tethered",
      location: CHARGER_LOCATION,
      address: "7 Test Row, Dublin 6",
      status: "online",
      acceptingBookings: true,
    })
    .returning({ id: chargers.id });
  if (charger === undefined) throw new Error("no charger");
  const start = new Date(Math.floor((clock.now().getTime() + startIn) / MINUTE) * MINUTE);
  const slot = { start, end: new Date(start.getTime() + hours * 60 * MINUTE) };
  const idTag = `T${randomBytes(9).toString("hex").toUpperCase()}`;
  const [booking] = await h.database.db
    .insert(bookings)
    .values({
      chargerId: charger.id,
      driverId,
      slot,
      status: "confirmed",
      idTag,
      quotedAmountCents: quote(slot, 250),
      pricePerHourCents: 250,
      vehiclePlate: "251-D-1234",
    })
    .returning({ id: bookings.id });
  if (booking === undefined) throw new Error("no booking");
  await h.database.db.insert(payments).values({
    bookingId: booking.id,
    amountCents: quote(slot, 250),
    status: paid ? "paid" : "authorised",
  });
  return { id: booking.id, chargerId: charger.id, chargeboxId, idTag, slot };
}

const sessionOf = async (bookingId: string, cookie = driver) => {
  const response = await call("GET", `/bookings/${bookingId}/session`, cookie);
  expect(response.statusCode).toBe(200);
  return response.json<SessionState>();
};

async function arrived(booking: Booking): Promise<void> {
  const response = await call("POST", `/bookings/${booking.id}/arrive`, driver, {});
  expect(response.statusCode).toBe(200);
}

async function start(booking: Booking, body: object = {}) {
  const response = await call("POST", `/bookings/${booking.id}/start`, driver, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SessionState>();
}

/** Publishes a charger event as the gateway does. */
async function publish(event: Record<string, unknown> & { type: ChargerEvent["type"] }) {
  const payload = JSON.stringify({
    v: CHARGER_EVENT_VERSION,
    at: new Date().toISOString(),
    ...event,
  });
  await h.database.db.execute(sql`select pg_notify(${CHARGER_EVENTS_CHANNEL}, ${payload})`);
}

async function connect(cookie: string): Promise<RealtimeClient> {
  const client = await openRealtime(wsUrl, { cookie, origin: APP_ORIGIN });
  clients.push(client);
  return client;
}

const jobRows = (name: string, bookingId: string) =>
  h.database.db.execute<{ start_after: Date; singleton_key: string }>(
    sql`select start_after, singleton_key from pgboss.job
        where name = ${name} and data->>'bookingId' = ${bookingId}`,
  );

beforeAll(async () => {
  h = await startHarness({
    clock,
    chargerControl: control.control,
    realtime: { maxConnectionsPerUser: 2 },
  });
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  wsUrl = `ws://127.0.0.1:${String((h.app.server.address() as AddressInfo).port)}/ws`;
  driver = await h.user("cian@example.com", "+353861230101");
  host = await h.user("niamh@example.com", "+353861230102");
  stranger = await h.user("sam@example.com", "+353861230103");
  driverId = await userId("cian@example.com");
  hostUserId = await userId("niamh@example.com");
});

beforeEach(async () => {
  clock.current = new Date();
  control.reset();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await h.close();
});

describe("POST /bookings/:id/arrive", () => {
  it("checks the driver in inside the window, records the distance and tells both sides", async () => {
    const booking = await newBooking();
    const driverSocket = await connect(driver);
    const hostSocket = await connect(host);
    const strangerSocket = await connect(stranger);

    expect((await call("POST", `/bookings/${booking.id}/arrive`, host, {})).statusCode).toBe(403);
    expect((await call("POST", `/bookings/${booking.id}/arrive`, stranger, {})).statusCode).toBe(
      404,
    );
    const response = await call("POST", `/bookings/${booking.id}/arrive`, driver, {
      lat: 53.3285,
      lng: -6.256,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      booking: { status: string; address: string };
      arrival: { distanceM: number; nearCharger: boolean; arrivedAt: string };
    }>();
    expect(body.booking).toMatchObject({ status: "arrived", address: "7 Test Row, Dublin 6" });
    expect(body.arrival).toMatchObject({ distanceM: 278, nearCharger: true });

    for (const socket of [driverSocket, hostSocket]) {
      await expect(socket.next(ofType("booking:update"))).resolves.toMatchObject({
        bookingId: booking.id,
        status: "arrived",
      });
    }
    const [row] = await h.database.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row).toMatchObject({ status: "arrived", arrivalDistanceM: 278 });

    // The window-end stop is queued for 5 minutes after the slot.
    const jobs = await jobRows(windowEndStopJob.name, booking.id);
    expect(new Date(jobs.rows[0]?.start_after ?? 0).toISOString()).toBe(
      new Date(booking.slot.end.getTime() + 5 * MINUTE).toISOString(),
    );

    // Again: nothing changes.
    const again = await call("POST", `/bookings/${booking.id}/arrive`, driver, {});
    expect(again.json<{ arrival: { distanceM: number } }>().arrival.distanceM).toBe(278);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(strangerSocket.messages.filter((message) => message.type !== "ready")).toEqual([]);
  });

  it("refuses an arrival too early, one after the slot, and one not paid for", async () => {
    // Drivers may arrive and plug in up to 4 hours ahead.
    const later = await newBooking({ startIn: 5 * 60 * MINUTE });
    const early = await call("POST", `/bookings/${later.id}/arrive`, driver, {});
    expect(early.statusCode).toBe(409);
    expect(early.json<{ code: string }>().code).toBe("too-early");
    clock.current = new Date(later.slot.start.getTime() - 4 * 60 * MINUTE);
    expect((await call("POST", `/bookings/${later.id}/arrive`, driver, {})).statusCode).toBe(200);

    const unpaid = await newBooking({ paid: false });
    const refused = await call("POST", `/bookings/${unpaid.id}/arrive`, driver, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe("payment-pending");

    const over = await newBooking({ startIn: -3 * 60 * MINUTE, hours: 1 });
    const late = await call("POST", `/bookings/${over.id}/arrive`, driver, {});
    expect(late.json<{ code: string }>().code).toBe("slot-ended");
    const half = await call("POST", `/bookings/${over.id}/arrive`, driver, { lat: 53 });
    expect(half.statusCode).toBe(400);
  });
});

describe("start, live updates and stop", () => {
  it("starts, pushes the charger's progress to driver and host, and stops", async () => {
    const booking = await newBooking();
    expect((await sessionOf(booking.id)).status).toBe("not_started");
    expect((await call("GET", `/bookings/${booking.id}/session`, stranger)).statusCode).toBe(404);
    const notArrived = await call("POST", `/bookings/${booking.id}/start`, driver, {});
    expect(notArrived.json<{ code: string }>().code).toBe("not-arrived");
    await arrived(booking);
    const driverSocket = await connect(driver);
    const hostSocket = await connect(host);

    const starting = await start(booking);
    expect(starting).toMatchObject({ status: "starting", kwh: null, elapsed: 0 });
    expect(control.callsTo("remoteStart")).toEqual([
      { chargeboxId: booking.chargeboxId, idTag: booking.idTag, connectorId: 1 },
    ]);
    // Starting again returns the same session and sends nothing.
    expect((await start(booking)).sessionId).toBe(starting.sessionId);
    expect(control.callsTo("remoteStart")).toHaveLength(1);
    const timeout = await jobRows(startTimeoutJob.name, booking.id);
    expect(timeout.rows[0]?.singleton_key).toBe(starting.sessionId);

    // The gateway takes the session over on StartTransaction and meters it.
    const sessionId = starting.sessionId ?? "";
    const startedAt = new Date(clock.now().getTime() - 20 * MINUTE);
    await h.database.db
      .update(sessions)
      .set({ status: "charging", ocppTransactionId: 4242, meterStartWh: 10_000, startedAt })
      .where(eq(sessions.id, sessionId));
    await h.database.db
      .update(bookings)
      .set({ status: "active" })
      .where(eq(bookings.id, booking.id));
    await publish({
      type: "session_started",
      chargerId: booking.chargerId,
      chargeboxId: booking.chargeboxId,
      sessionId,
      bookingId: booking.id,
      transactionId: 4242,
      meterStartWh: 10_000,
    });
    await expect(
      driverSocket.next((m) => m.type === "booking:update" && m.status === "active"),
    ).resolves.toBeDefined();
    const sampledAt = new Date(clock.now().getTime() - MINUTE);
    await h.database.db
      .insert(meterValues)
      .values({ sessionId, ts: sampledAt, energyWh: 12_345, powerW: 7_200 });
    await publish({
      type: "meter",
      chargerId: booking.chargerId,
      chargeboxId: booking.chargeboxId,
      sessionId,
      transactionId: 4242,
      ts: sampledAt.toISOString(),
      energyWh: 12_345,
      powerW: 7_200,
    });
    for (const socket of [driverSocket, hostSocket]) {
      const update = await socket.next(
        (m): m is Extract<typeof m, { type: "session:update" }> =>
          m.type === "session:update" && m.kwh === 2.345,
      );
      // 20 minutes at 250 cents an hour.
      expect(update).toMatchObject({
        bookingId: booking.id,
        status: "charging",
        kw: 7.2,
        lastSeenAt: sampledAt.toISOString(),
        startAt: startedAt.toISOString(),
      });
      expect(update.elapsed).toBeGreaterThanOrEqual(1200);
    }
    expect(await sessionOf(booking.id, host)).toMatchObject({ status: "charging", kwh: 2.345 });

    // Stop: the charger is told; it stays charging until StopTransaction.
    const stopping = await call("POST", `/bookings/${booking.id}/stop`, driver);
    expect(stopping.statusCode).toBe(200);
    expect(control.callsTo("remoteStop")).toEqual([
      { chargeboxId: booking.chargeboxId, transactionId: 4242 },
    ]);
    expect((await call("POST", `/bookings/${booking.id}/stop`, host)).statusCode).toBe(403);

    const stoppedAt = clock.now();
    await h.database.db
      .update(sessions)
      .set({ status: "stopped", meterStopWh: 12_500, kwh: 2.5, stoppedAt, stopReason: "Remote" })
      .where(eq(sessions.id, sessionId));
    await h.database.db
      .update(bookings)
      .set({ status: "completed" })
      .where(eq(bookings.id, booking.id));
    await publish({
      type: "session_stopped",
      chargerId: booking.chargerId,
      chargeboxId: booking.chargeboxId,
      sessionId,
      bookingId: booking.id,
      transactionId: 4242,
      sessionStatus: "stopped",
      meterStopWh: 12_500,
      kwh: 2.5,
      reason: "Remote",
    });
    for (const socket of [driverSocket, hostSocket]) {
      await expect(
        socket.next((m) => m.type === "booking:update" && m.status === "completed"),
      ).resolves.toBeDefined();
      await expect(
        socket.next((m) => m.type === "session:update" && m.status === "stopped"),
      ).resolves.toMatchObject({ kwh: 2.5, kw: null, stopReason: "Remote" });
    }
    // Stopping a stopped session changes nothing.
    expect((await call("POST", `/bookings/${booking.id}/stop`, driver)).statusCode).toBe(200);
    expect(control.callsTo("remoteStop")).toHaveLength(1);
  });

  it("fails an unanswered start with copy the app can show, and lets the driver retry", async () => {
    const booking = await newBooking();
    await arrived(booking);
    control.answer("remoteStart", { ok: false, reason: "offline", message: "offline" });
    const failed = await start(booking);
    expect(failed).toMatchObject({
      status: "failed",
      failure: {
        code: "charger_offline",
        message: "The charger didn't respond. Check the cable is plugged in, then try again.",
      },
    });
    const retried = await start(booking);
    expect(retried.status).toBe("starting");
    expect(retried.sessionId).not.toBe(failed.sessionId);
  });

  it("soft-resets a charger that refuses because a transaction is open, and retries once", async () => {
    const booking = await newBooking();
    await arrived(booking);
    // The charger last reported a running transaction (one the platform lost track of).
    await h.database.db.insert(ocppMessages).values({
      chargerId: booking.chargerId,
      direction: "in",
      messageType: "call",
      messageId: "m-1",
      action: "StatusNotification",
      payload: { connectorId: 1, status: "Charging", errorCode: "NoError" },
    });
    control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    const waiting = await start(booking);
    expect(waiting.status).toBe("starting");
    expect(control.callsTo("reset")).toEqual([{ chargeboxId: booking.chargeboxId }]);
    const retry = await jobRows(remoteStartJob.name, booking.id);
    expect(retry.rows[0]?.singleton_key).toBe(`${waiting.sessionId ?? ""}-retry`);

    // The retry is refused too: the start fails; no second reset.
    control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    await h.jobs.runNow(remoteStartJob, {
      bookingId: booking.id,
      sessionId: waiting.sessionId ?? "",
    });
    expect(await sessionOf(booking.id)).toMatchObject({
      status: "failed",
      failure: { code: "rejected" },
    });
    expect(control.callsTo("reset")).toHaveLength(1);

    // Started again, the retry after the reset is accepted.
    control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    const again = await start(booking);
    await h.jobs.runNow(remoteStartJob, {
      bookingId: booking.id,
      sessionId: again.sessionId ?? "",
    });
    expect(await sessionOf(booking.id)).toMatchObject({ status: "starting" });
    expect(control.callsTo("remoteStart")).toHaveLength(4);
  });

  it("fails a refused start when nothing is open on the charger", async () => {
    const booking = await newBooking();
    await arrived(booking);
    control.answer("remoteStart", { ok: true, response: { status: "Rejected" } });
    expect((await start(booking)).failure?.code).toBe("rejected");
    expect(control.callsTo("reset")).toEqual([]);
  });

  it("fails a start with no StartTransaction in time and asks the charger for its status", async () => {
    const booking = await newBooking();
    await arrived(booking);
    const driverSocket = await connect(driver);
    const starting = await start(booking);
    await h.jobs.runNow(startTimeoutJob, {
      bookingId: booking.id,
      sessionId: starting.sessionId ?? "",
    });
    await expect(
      driverSocket.next((m) => m.type === "session:update" && m.status === "failed"),
    ).resolves.toMatchObject({ failure: { code: "start_timeout" } });
    expect(control.callsTo("triggerMessage")).toEqual([
      { chargeboxId: booking.chargeboxId, requestedMessage: "StatusNotification", connectorId: 1 },
    ]);
    // Running it again does nothing.
    await h.jobs.runNow(startTimeoutJob, {
      bookingId: booking.id,
      sessionId: starting.sessionId ?? "",
    });
    expect(control.callsTo("triggerMessage")).toHaveLength(1);
  });

  it("stops a session still charging at the end of the window", async () => {
    const booking = await newBooking({ startIn: -30 * MINUTE, hours: 1 });
    await arrived(booking);
    const starting = await start(booking);
    await h.database.db
      .update(sessions)
      .set({ status: "charging", ocppTransactionId: 777, meterStartWh: 0, startedAt: clock.now() })
      .where(eq(sessions.id, starting.sessionId ?? ""));
    await h.jobs.runNow(windowEndStopJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStop")).toEqual([]);
    clock.current = new Date(booking.slot.end.getTime() + 5 * MINUTE);
    await h.jobs.runNow(windowEndStopJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStop")).toEqual([
      { chargeboxId: booking.chargeboxId, transactionId: 777 },
    ]);
  });
});

describe("scheduled start", () => {
  it("records the plug-in and sends the remote start at the chosen time", async () => {
    const booking = await newBooking({ hours: 6 });
    await arrived(booking);
    const startAt = new Date(booking.slot.start.getTime() + 3 * 60 * MINUTE);
    const outside = await call("POST", `/bookings/${booking.id}/start`, driver, {
      startAt: booking.slot.end.toISOString(),
    });
    expect(outside.statusCode).toBe(422);

    const scheduled = await start(booking, { startAt: startAt.toISOString() });
    expect(scheduled).toMatchObject({
      status: "scheduled",
      sessionId: null,
      startAt: startAt.toISOString(),
    });
    expect(control.callsTo("remoteStart")).toEqual([]);
    const jobs = await jobRows(remoteStartJob.name, booking.id);
    expect(new Date(jobs.rows[0]?.start_after ?? 0).toISOString()).toBe(startAt.toISOString());
    // Starting again keeps the schedule.
    expect((await start(booking)).status).toBe("scheduled");

    // Nothing is counted while charging waits: the booking was paid upfront.
    clock.current = new Date(clock.current.getTime() + 60 * MINUTE);
    expect(await sessionOf(booking.id)).toMatchObject({ status: "scheduled", elapsed: 0 });

    // Too early, the job does nothing; at the time it starts the session.
    await h.jobs.runNow(remoteStartJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStart")).toEqual([]);
    clock.current = startAt;
    await h.jobs.runNow(remoteStartJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStart")).toHaveLength(1);
    expect((await sessionOf(booking.id)).status).toBe("starting");
    await h.jobs.runNow(remoteStartJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStart")).toHaveLength(1);
  });

  it("starts at the slot start for a driver who plugged in early", async () => {
    const booking = await newBooking({ startIn: 2 * 60 * MINUTE });
    await arrived(booking);
    const scheduled = await start(booking);
    expect(scheduled).toMatchObject({
      status: "scheduled",
      startAt: booking.slot.start.toISOString(),
    });
    const jobs = await jobRows(remoteStartJob.name, booking.id);
    expect(new Date(jobs.rows[0]?.start_after ?? 0).toISOString()).toBe(
      booking.slot.start.toISOString(),
    );
    clock.current = booking.slot.start;
    await h.jobs.runNow(remoteStartJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStart")).toHaveLength(1);
  });

  it("cancels a scheduled start when the driver stops", async () => {
    const booking = await newBooking({ hours: 6 });
    await arrived(booking);
    const startAt = new Date(booking.slot.start.getTime() + 2 * 60 * MINUTE);
    await start(booking, { startAt: startAt.toISOString() });
    const stopped = await call("POST", `/bookings/${booking.id}/stop`, driver);
    expect(stopped.json<SessionState>().status).toBe("not_started");
    clock.current = startAt;
    await h.jobs.runNow(remoteStartJob, { bookingId: booking.id });
    expect(control.callsTo("remoteStart")).toEqual([]);
  });
});

describe("GET /ws", () => {
  it("needs a session and a trusted origin, and limits connections per user", async () => {
    expect(await upgradeStatus(wsUrl, { origin: APP_ORIGIN })).toBe(401);
    expect(await upgradeStatus(wsUrl, { origin: "https://evil.example", cookie: driver })).toBe(
      403,
    );
    // A native app sends no Origin.
    expect(await upgradeStatus(wsUrl, { cookie: driver })).toBe(101);
    await connect(driver);
    await connect(driver);
    expect(await upgradeStatus(wsUrl, { cookie: driver, origin: APP_ORIGIN })).toBe(429);
  });

  it("answers a ping and pushes charger status to the host only", async () => {
    const booking = await newBooking();
    const hostSocket = await connect(host);
    const driverSocket = await connect(driver);
    driverSocket.socket.send(JSON.stringify({ type: "ping" }));
    await expect(driverSocket.next(ofType("pong"))).resolves.toEqual({ type: "pong" });
    await publish({
      type: "status",
      chargerId: booking.chargerId,
      chargeboxId: booking.chargeboxId,
      connectorId: 1,
      status: "Preparing",
      errorCode: "NoError",
    });
    await expect(hostSocket.next(ofType("charger:status"))).resolves.toMatchObject({
      chargerId: booking.chargerId,
      status: "online",
      connectorStatus: "Preparing",
      errorCode: "NoError",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(driverSocket.messages.some((m) => m.type === "charger:status")).toBe(false);
  });
});
