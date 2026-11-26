import { randomBytes } from "node:crypto";

import {
  bookings,
  chargers,
  deviceTokens,
  notificationPreferences,
  notifications,
  payments,
  sessions,
  users,
} from "@nd/db";
import { CHARGER_EVENT_VERSION, CHARGER_EVENTS_CHANNEL } from "@nd/domain";
import { startZappiSim, type ZappiSim } from "@nd/ocpp-core/sim";
import { type Gateway, startGateway } from "@nd/ocpp-gateway/app";
import { eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { recordingPush } from "../../test/fakes.ts";
import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { notificationsPruneJob, notifyJob } from "./jobs.ts";

// Push notifications against Postgres: device registration and preferences
// through the routes, the `notify` job's ledger (each notification once),
// preferences and invalid tokens, the host's "session ended" with what
// settlement captured, offline alerts, and a fault from the Zappi simulator
// through the real gateway reaching the host's phone.

const SECRET = "integration-test-internal-secret-0123456789";
const HOUR = 3_600_000;

/** A clock the tests move; starts at the real time so Postgres and pg-boss agree. */
const clock = {
  current: new Date(),
  now() {
    return this.current;
  },
};

const recording = recordingPush();
let h: Harness;
let gateway: Gateway;
let zappi: ZappiSim | undefined;
let host: string;
let hostUserId: string;
let driver: string;
let driverId: string;
let charger: { chargerId: string; chargeboxId: string; secret: string };

const HOST_TOKEN = "fcm-host-token-0001";
const WEB_SUBSCRIPTION = {
  endpoint: "https://push.example.com/send/driver-subscription-0001",
  keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: "c2VjcmV0LWF1dGgtMTY" },
};

const call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string | undefined,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload }),
  });

async function userIdOf(email: string): Promise<string> {
  const [row] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

let bookingDays = 0;

/** A booking of the driver at the host's charger, on a day of its own, in `status`. */
async function newBooking(status: "requested" | "confirmed" | "completed"): Promise<string> {
  bookingDays += 1;
  const start = new Date(Math.floor(clock.now().getTime() / HOUR) * HOUR + bookingDays * 24 * HOUR);
  const slot = { start, end: new Date(start.getTime() + 8 * HOUR) };
  const [row] = await h.database.db
    .insert(bookings)
    .values({
      chargerId: charger.chargerId,
      driverId,
      slot,
      status,
      idTag: status === "requested" ? null : `T${randomBytes(9).toString("hex").toUpperCase()}`,
      quotedAmountCents: 2000,
      pricePerHourCents: 250,
      vehiclePlate: "251-D-4321",
    })
    .returning({ id: bookings.id });
  if (row === undefined) throw new Error("no booking");
  return row.id;
}

const sentTo = (token: string) => recording.sent.filter((push) => push.device.token === token);

beforeAll(async () => {
  h = await startHarness({ clock, push: recording.push });
  gateway = await startGateway({
    databaseUrl: h.database.url,
    host: "127.0.0.1",
    port: 0,
    internal: { host: "127.0.0.1", port: 0, secret: SECRET },
    logger: pino({ level: "silent" }),
    timings: { callTimeoutMs: 2_000 },
  });

  host = await h.user("niamh@example.com", "+353861240301");
  hostUserId = await userIdOf("niamh@example.com");
  expect((await call("POST", "/hosts", host, {})).statusCode).toBe(200);
  const created = await call("POST", "/hosts/chargers", host, {
    serial: "21240001",
    connectorType: "tethered",
    address: "5 Test Close, Dublin 6",
    location: { lat: 53.326, lng: -6.256 },
  });
  expect(created.statusCode).toBe(201);
  charger = created.json();

  driver = await h.user("cian@example.com", "+353861240302");
  driverId = await userIdOf("cian@example.com");
});

afterAll(async () => {
  await zappi?.stop();
  await gateway.close();
  await h.close();
});

describe("POST /me/devices and DELETE /me/devices/:id", () => {
  it("registers an FCM token once, refreshing it when it comes again", async () => {
    const first = await call("POST", "/me/devices", host, {
      platform: "android",
      token: HOST_TOKEN,
    });
    expect(first.statusCode).toBe(201);
    const again = await call("POST", "/me/devices", host, {
      platform: "android",
      token: HOST_TOKEN,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(first.json()).toMatchObject({ platform: "android" });
  });

  it("moves a token to whoever signs in on the device next", async () => {
    const token = "fcm-shared-tablet-token";
    expect((await call("POST", "/me/devices", host, { platform: "ios", token })).statusCode).toBe(
      201,
    );
    expect((await call("POST", "/me/devices", driver, { platform: "ios", token })).statusCode).toBe(
      200,
    );
    const [row] = await h.database.db
      .select({ userId: deviceTokens.userId })
      .from(deviceTokens)
      .where(eq(deviceTokens.token, token));
    expect(row?.userId).toBe(driverId);
    await h.database.db.delete(deviceTokens).where(eq(deviceTokens.token, token));
  });

  it("stores a web push subscription with its keys, and refuses one that is not https", async () => {
    const response = await call("POST", "/me/devices", driver, {
      platform: "web",
      subscription: WEB_SUBSCRIPTION,
    });
    expect(response.statusCode).toBe(201);
    const [row] = await h.database.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.token, WEB_SUBSCRIPTION.endpoint));
    expect(row).toMatchObject({
      platform: "web",
      webPushP256dh: WEB_SUBSCRIPTION.keys.p256dh,
      webPushAuth: WEB_SUBSCRIPTION.keys.auth,
    });
    const insecure = await call("POST", "/me/devices", driver, {
      platform: "web",
      subscription: { ...WEB_SUBSCRIPTION, endpoint: "http://push.example.com/x" },
    });
    expect(insecure.statusCode).toBe(400);
    // The database refuses a web device without its keys.
    await expect(
      h.database.db
        .insert(deviceTokens)
        .values({ userId: driverId, platform: "web", token: "https://push.example.com/no-keys" }),
    ).rejects.toThrow();
  });

  it("keeps an account's 10 most recently seen devices", async () => {
    const stranger = await h.user("sam@example.com");
    const start = clock.current;
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      clock.current = new Date(start.getTime() + index * 1000);
      const response = await call("POST", "/me/devices", stranger, {
        platform: "android",
        token: `fcm-many-${String(index)}`,
      });
      ids.push(response.json<{ id: string }>().id);
    }
    clock.current = new Date();
    const kept = await h.database.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, await userIdOf("sam@example.com")));
    expect(kept).toHaveLength(10);
    expect(kept.map((row) => row.token)).not.toContain("fcm-many-0");
    // Its own device is deleted; someone else's is 404.
    expect((await call("DELETE", `/me/devices/${ids[10] ?? ""}`, host)).statusCode).toBe(404);
    expect((await call("DELETE", `/me/devices/${ids[10] ?? ""}`, stranger)).statusCode).toBe(204);
    expect((await call("DELETE", `/me/devices/${ids[10] ?? ""}`, stranger)).statusCode).toBe(404);
  });

  it("needs a signed-in user", async () => {
    expect(
      (await call("POST", "/me/devices", undefined, { platform: "ios", token: "x" })).statusCode,
    ).toBe(401);
  });
});

describe("/me/notification-preferences", () => {
  it("has every switch on until the user turns one off, and saves only what is sent", async () => {
    const all = await call("GET", "/me/notification-preferences", driver);
    expect(all.json()).toEqual({
      bookingRequests: true,
      guestArrivals: true,
      sessionUpdates: true,
      chargerAlerts: true,
      bookingUpdates: true,
      chargingUpdates: true,
    });
    const off = await call("PATCH", "/me/notification-preferences", driver, {
      chargingUpdates: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ chargingUpdates: false, bookingUpdates: true });
    const back = await call("PATCH", "/me/notification-preferences", driver, {
      chargingUpdates: true,
    });
    expect(back.json()).toMatchObject({ chargingUpdates: true });
    expect((await call("PATCH", "/me/notification-preferences", driver, {})).statusCode).toBe(400);
    expect(
      (await call("PATCH", "/me/notification-preferences", driver, { marketing: false }))
        .statusCode,
    ).toBe(400);
  });
});

describe("the notify job", () => {
  beforeEach(() => {
    recording.sent.length = 0;
  });

  it("tells the host about a request once, however often it runs", async () => {
    const bookingId = await newBooking("requested");
    await h.jobs.runNow(notifyJob, { type: "booking_created", bookingId });
    await h.jobs.runNow(notifyJob, { type: "booking_created", bookingId });
    expect(sentTo(HOST_TOKEN)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          title: "New booking request",
          data: { kind: "booking_requested", bookingId, chargerId: charger.chargerId },
        }) as unknown,
      }),
    ]);
    const ledger = await h.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.eventKey, `booking:${bookingId}:booking_requested`));
    expect(ledger).toEqual([
      expect.objectContaining({ userId: hostUserId, deliveredAt: expect.any(Date) as unknown }),
    ]);
  });

  it("tells the driver when the host declines, through the decline route and the queue", async () => {
    const bookingId = await newBooking("requested");
    const declined = await call("POST", `/bookings/${bookingId}/decline`, host, {});
    expect(declined.statusCode, declined.body).toBe(200);
    await h.jobs.drain();
    expect(sentTo(WEB_SUBSCRIPTION.endpoint)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ title: "Request declined" }) as unknown,
      }),
    ]);
  });

  it("sends nothing a preference turns off", async () => {
    await call("PATCH", "/me/notification-preferences", driver, { bookingUpdates: false });
    const bookingId = await newBooking("confirmed");
    await h.jobs.runNow(notifyJob, { type: "booking_approved", bookingId });
    expect(recording.sent).toEqual([]);
    await call("PATCH", "/me/notification-preferences", driver, { bookingUpdates: true });
    const [row] = await h.database.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, driverId));
    expect(row?.bookingUpdates).toBe(true);
  });

  it("forgets a device whose token the provider reports invalid", async () => {
    const token = "fcm-host-old-phone";
    await call("POST", "/me/devices", host, { platform: "ios", token });
    recording.answer(token, { status: "invalid_token" });
    const bookingId = await newBooking("confirmed");
    await h.jobs.runNow(notifyJob, { type: "guest_arrived", bookingId });
    expect(sentTo(HOST_TOKEN)).toHaveLength(1);
    const left = await h.database.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.token, token));
    expect(left).toEqual([]);
  });

  it("tells the host what settlement billed, once for both the settlement and the fallback", async () => {
    const bookingId = await newBooking("completed");
    const [session] = await h.database.db
      .insert(sessions)
      .values({ bookingId, status: "reconciled", kwh: 8.43, startedAt: clock.now() })
      .returning({ id: sessions.id });
    const sessionId = session?.id ?? "";
    await h.database.db.insert(payments).values({
      bookingId,
      status: "captured",
      authorisedCents: 2000,
      capturedCents: 1875,
      platformFeeCents: 0,
    });
    await h.jobs.runNow(notifyJob, { type: "session_settled", bookingId, sessionId });
    await h.jobs.runNow(notifyJob, { type: "session_ended", bookingId, sessionId });
    expect(sentTo(HOST_TOKEN).map((push) => push.message.body)).toEqual([
      "Your guest was billed €18.75 for 8.4 kWh. You earn €18.75.",
    ]);
  });

  it("reports an offline charger only while the spell lasts", async () => {
    const lastHeartbeatAt = new Date(clock.now().getTime() - HOUR).toISOString();
    await h.database.db
      .update(chargers)
      .set({ status: "offline", lastHeartbeatAt: new Date(lastHeartbeatAt) })
      .where(eq(chargers.id, charger.chargerId));
    // The gateway's event queues the alert for 10 minutes later.
    const payload = JSON.stringify({
      v: CHARGER_EVENT_VERSION,
      at: clock.now().toISOString(),
      chargerId: charger.chargerId,
      chargeboxId: charger.chargeboxId,
      type: "offline",
      lastHeartbeatAt,
    });
    await h.database.db.execute(sql`select pg_notify(${CHARGER_EVENTS_CHANNEL}, ${payload})`);
    await eventually(async () => {
      const queued = await h.database.db.execute<{ start_after: Date }>(sql`
        select start_after from pgboss.job where name = 'notify'
          and data ->> 'type' = 'charger_offline' and data ->> 'chargerId' = ${charger.chargerId}`);
      expect(queued.rows).toHaveLength(1);
      expect(new Date(queued.rows[0]?.start_after ?? 0).getTime()).toBeGreaterThan(
        clock.now().getTime() + 9 * 60_000,
      );
    });

    // Back online before it ran: nothing to say.
    await h.database.db
      .update(chargers)
      .set({ status: "online", lastHeartbeatAt: clock.now() })
      .where(eq(chargers.id, charger.chargerId));
    const trigger = {
      type: "charger_offline" as const,
      chargerId: charger.chargerId,
      lastHeartbeatAt,
    };
    await h.jobs.runNow(notifyJob, trigger);
    expect(recording.sent).toEqual([]);

    // Still offline when it runs: the host hears, once.
    await h.database.db
      .update(chargers)
      .set({ status: "offline", lastHeartbeatAt: new Date(lastHeartbeatAt) })
      .where(eq(chargers.id, charger.chargerId));
    await h.jobs.runNow(notifyJob, trigger);
    await h.jobs.runNow(notifyJob, trigger);
    expect(sentTo(HOST_TOKEN).map((push) => push.message.title)).toEqual(["Charger offline"]);
    await h.database.db
      .update(chargers)
      .set({ status: "onboarding", lastHeartbeatAt: null })
      .where(eq(chargers.id, charger.chargerId));
  });

  it("prunes ledger entries older than 90 days", async () => {
    const old = new Date(clock.now().getTime() - 91 * 24 * HOUR);
    await h.database.db.insert(notifications).values({
      userId: hostUserId,
      kind: "guest_arrived",
      eventKey: "booking:old:x",
      createdAt: old,
    });
    await h.jobs.runNow(notificationsPruneJob, {});
    const left = await h.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.eventKey, "booking:old:x"));
    expect(left).toEqual([]);
  });
});

describe("a fault from the Zappi simulator", () => {
  beforeEach(() => {
    recording.sent.length = 0;
  });

  it("reaches the host's phone within 30 seconds, once per cooldown", async () => {
    zappi = await startZappiSim({
      url: gateway.ocppUrl,
      chargeboxId: charger.chargeboxId,
      secret: charger.secret,
    });
    await eventually(async () => {
      const [row] = await h.database.db
        .select({ status: chargers.status })
        .from(chargers)
        .where(eq(chargers.id, charger.chargerId));
      expect(row?.status).toBe("online");
    });

    const faultedAt = Date.now();
    zappi.fault("GroundFailure");
    await eventually(async () => {
      await h.jobs.drain();
      expect(sentTo(HOST_TOKEN).map((push) => push.message)).toEqual([
        {
          title: "Charger fault",
          body: "Your charger reported a fault (GroundFailure). It can't charge until it clears.",
          data: { kind: "charger_faulted", chargerId: charger.chargerId },
        },
      ]);
    }, 30_000);
    expect(Date.now() - faultedAt).toBeLessThan(30_000);

    // Clears and faults again within the cooldown: no second push.
    zappi.clearFault();
    zappi.fault("OverCurrentFailure");
    await eventually(async () => {
      const faults = await h.database.db.execute<{ n: number }>(sql`
        select count(*)::int as n from pgboss.job
        where name = 'notify' and data ->> 'type' = 'charger_faulted'`);
      expect(faults.rows[0]?.n).toBe(2);
    });
    await h.jobs.drain();
    expect(sentTo(HOST_TOKEN)).toHaveLength(1);
  }, 45_000);
});
