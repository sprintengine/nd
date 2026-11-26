import { chargers, findChargerCredentials, hosts } from "@nd/db";
import { verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";

let h: Harness;
let host: string;

const charger = {
  serial: "21234567",
  connectorType: "tethered",
  address: "3 Test Terrace, Dublin 6",
  location: { lat: 53.326, lng: -6.256 },
};

beforeAll(async () => {
  h = await startHarness();
  host = await h.user("aoife@example.com", "+353861230001");
});

afterAll(async () => {
  await h.close();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, cookie: string, payload?: object) =>
  h.app.inject({
    method,
    url,
    headers: { cookie, origin: APP_ORIGIN },
    ...(payload === undefined ? {} : { payload }),
  });

async function becomeHost(cookie: string) {
  const response = await call("POST", "/hosts", cookie, {});
  expect(response.statusCode).toBe(200);
  return response.json<{ hostId: string; onboardingUrl: string }>();
}

async function connect(cookie: string, serial: string) {
  const response = await call("POST", "/hosts/chargers", cookie, { ...charger, serial });
  expect(response.statusCode).toBe(201);
  return response.json<{
    chargerId: string;
    chargeboxId: string;
    wssUrl: string;
    secret: string;
  }>();
}

async function setOnline(chargerId: string, firmware = "5.794") {
  await h.database.db
    .update(chargers)
    .set({ status: "online", firmware })
    .where(eq(chargers.id, chargerId));
}

describe("phone verification gate", () => {
  it("refuses hosting endpoints to a user without a verified phone", async () => {
    const cookie = await h.user("cian@example.com");
    for (const [method, url] of [
      ["POST", "/hosts"],
      ["POST", "/hosts/chargers"],
      ["PATCH", "/hosts/chargers/00000000-0000-4000-8000-000000000000"],
      ["GET", "/hosts/chargers/00000000-0000-4000-8000-000000000000/onboarding"],
    ] as const) {
      const response = await call(method, url, cookie, method === "GET" ? undefined : {});
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ code: "phone-verification-required" });
    }
  });

  it("is 401 without a session", async () => {
    const response = await h.app.inject({ method: "POST", url: "/hosts", payload: {} });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /hosts", () => {
  it("creates the host and its Stripe account once, with a fresh link each time", async () => {
    const first = await becomeHost(host);
    expect(first.onboardingUrl).toBe("https://connect.stripe.test/setup/acct_test_1");
    const second = await becomeHost(host);
    expect(second.hostId).toBe(first.hostId);
    const methods = h.stripe.calls.map((callMade) => callMade.method);
    expect(methods.filter((method) => method === "createExpressAccount")).toHaveLength(1);
    expect(methods.filter((method) => method === "createAccountLink")).toHaveLength(2);
    const me = await call("GET", "/me", host);
    expect(me.json()).toMatchObject({
      isHost: true,
      host: { payoutStatus: "pending", payoutsEnabled: false },
    });
  });
});

describe("POST /hosts/chargers", () => {
  it("needs a host profile first", async () => {
    const cookie = await h.user("orla@example.com", "+353861230002");
    const response = await call("POST", "/hosts/chargers", cookie, charger);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "host-required" });
  });

  it("rejects a Zappi v2.0 serial with a clear message", async () => {
    const response = await call("POST", "/hosts/chargers", host, {
      ...charger,
      serial: "11234567",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "charger-not-eligible" });
    expect(response.json<{ detail: string }>().detail).toMatch(/v2\.0/);
  });

  it("accepts a v2.1 serial and returns the secret once, stored only as an argon2 hash", async () => {
    const created = await connect(host, "21234567");
    expect(created.wssUrl).toBe("wss://ocpp.example.com/v16/");
    expect(created.wssUrl.endsWith("/")).toBe(true);
    expect(created.secret).toMatch(/^[A-Za-z0-9]{20}$/);

    const credentials = await findChargerCredentials(h.database.db, created.chargeboxId);
    expect(credentials?.ocppAuthHash).toMatch(/^\$argon2id\$/);
    expect(credentials?.ocppAuthHash).not.toContain(created.secret);
    await expect(verify(credentials?.ocppAuthHash ?? "", created.secret)).resolves.toBe(true);
    await expect(verify(credentials?.ocppAuthHash ?? "", "wrong-secret-value!!")).resolves.toBe(
      false,
    );

    const [row] = await h.database.db
      .select()
      .from(chargers)
      .where(eq(chargers.id, created.chargerId));
    expect(row).toMatchObject({
      status: "onboarding",
      acceptingBookings: false,
      model: "zappi_v2_1",
    });

    const later = await call("GET", `/hosts/chargers/${created.chargerId}/onboarding?wait=0`, host);
    expect(later.body).not.toContain(created.secret);
    const patched = await call("PATCH", `/hosts/chargers/${created.chargerId}`, host, {});
    expect(patched.body).not.toContain(created.secret);
    expect(patched.body).not.toContain("argon2");
  });

  it("issues a new secret for a charger still connecting, keeping its ChargeboxID", async () => {
    const first = await connect(host, "21230000");
    const again = await connect(host, "21230000");
    expect(again.chargerId).toBe(first.chargerId);
    expect(again.chargeboxId).toBe(first.chargeboxId);
    expect(again.secret).not.toBe(first.secret);
    const credentials = await findChargerCredentials(h.database.db, first.chargeboxId);
    await expect(verify(credentials?.ocppAuthHash ?? "", first.secret)).resolves.toBe(false);
  });

  it("accepts a Zappi GLO whatever the serial", async () => {
    const response = await call("POST", "/hosts/chargers", host, {
      ...charger,
      serial: "31234567",
      model: "zappi_glo",
    });
    expect(response.statusCode).toBe(201);
  });

  it("refuses a serial registered to another host, or already connected", async () => {
    const connected = await connect(host, "21239999");
    await setOnline(connected.chargerId);
    const again = await call("POST", "/hosts/chargers", host, { ...charger, serial: "21239999" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "charger-connected" });

    const other = await h.user("sam@example.com", "+353861230003");
    await becomeHost(other);
    const taken = await call("POST", "/hosts/chargers", other, { ...charger, serial: "21239999" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "charger-registered" });
  });
});

describe("GET /hosts/chargers/:id/onboarding", () => {
  it("resolves when the gateway notifies that the charger connected", async () => {
    const { chargerId } = await connect(host, "21231111");
    const started = Date.now();
    const pending = call("GET", `/hosts/chargers/${chargerId}/onboarding?wait=5`, host);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await setOnline(chargerId);
    await h.database.db.execute(
      sql`select pg_notify('charger_events', ${JSON.stringify({ type: "charger.booted", chargerId })})`,
    );
    const response = await pending;
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(response.json()).toMatchObject({
      chargerId,
      status: "online",
      connected: true,
      firmware: "5.794",
      firmwareSupported: true,
      maxKw: 7.4,
      notice: null,
    });
  });

  it("answers not connected yet when the wait runs out", async () => {
    const { chargerId } = await connect(host, "21232222");
    const response = await call("GET", `/hosts/chargers/${chargerId}/onboarding?wait=1`, host);
    expect(response.json()).toMatchObject({
      status: "onboarding",
      connected: false,
      firmwareSupported: null,
    });
  });

  it("warns about firmware below 5.794", async () => {
    const { chargerId } = await connect(host, "21233333");
    await setOnline(chargerId, "5.612");
    const response = await call("GET", `/hosts/chargers/${chargerId}/onboarding`, host);
    expect(response.json()).toMatchObject({ connected: true, firmwareSupported: false });
    expect(response.json<{ notice: string }>().notice).toMatch(/5\.794/);
  });

  it("is 404 for another host's charger", async () => {
    const { chargerId } = await connect(host, "21234444");
    const other = await h.user("niamh@example.com", "+353861230004");
    await becomeHost(other);
    const response = await call("GET", `/hosts/chargers/${chargerId}/onboarding?wait=0`, other);
    expect(response.statusCode).toBe(404);
  });
});

describe("PATCH /hosts/chargers/:id", () => {
  const availability = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    start: "20:00",
    end: "08:00",
  }));

  it("refuses to publish while the charger is still onboarding", async () => {
    const { chargerId } = await connect(host, "21235555");
    const response = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      pricePerHourCents: 250,
      availability,
      acceptingBookings: true,
    });
    expect(response.statusCode).toBe(409);
    const reasons = response
      .json<{ reasons: { code: string }[] }>()
      .reasons.map((reason) => reason.code);
    expect(reasons).toContain("charger-not-online");
  });

  it("refuses to publish without availability, then publishes once everything is in place", async () => {
    const { chargerId } = await connect(host, "21236666");
    await setOnline(chargerId);
    const [aoife] = await h.database.db
      .select({ id: hosts.id })
      .from(hosts)
      .innerJoin(chargers, eq(chargers.hostId, hosts.id))
      .where(eq(chargers.id, chargerId));
    await h.database.db
      .update(hosts)
      .set({ payoutStatus: "enabled" })
      .where(eq(hosts.id, aoife?.id ?? ""));

    const bare = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      acceptingBookings: true,
    });
    expect(bare.statusCode).toBe(409);
    expect(
      bare.json<{ reasons: { code: string }[] }>().reasons.map((reason) => reason.code),
    ).toEqual(["no-availability"]);

    const noPrice = await call("PATCH", `/hosts/chargers/${chargerId}`, host, { availability });
    expect(noPrice.statusCode).toBe(422);

    const published = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      pricePerHourCents: 300,
      kwhCap: 40,
      instantBook: true,
      availability,
      maxSessionsPerDay: 1,
      nightRateWindow: { start: "23:00", end: "08:00" },
      acceptingBookings: true,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      acceptingBookings: true,
      pricePerHourCents: 300,
      kwhCap: 40,
      instantBook: true,
      maxSessionsPerDay: 1,
      nightRateWindow: { start: "23:00", end: "08:00" },
      publishBlockers: [],
    });
    expect(published.json<{ availability: unknown[] }>().availability).toHaveLength(7);

    const repriced = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      pricePerHourCents: 275,
      nightRateWindow: null,
    });
    expect(repriced.json()).toMatchObject({
      pricePerHourCents: 275,
      kwhCap: 40,
      nightRateWindow: null,
    });

    const emptied = await call("PATCH", `/hosts/chargers/${chargerId}`, host, { availability: [] });
    expect(emptied.statusCode).toBe(409);

    const unpublished = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      acceptingBookings: false,
    });
    expect(unpublished.json()).toMatchObject({ acceptingBookings: false });
  });

  it("refuses to publish below firmware 5.794 or without payouts", async () => {
    const other = await h.user("eoin@example.com", "+353861230005");
    await becomeHost(other);
    const { chargerId } = await connect(other, "21237777");
    await setOnline(chargerId, "5.700");
    const response = await call("PATCH", `/hosts/chargers/${chargerId}`, other, {
      pricePerHourCents: 250,
      availability,
      acceptingBookings: true,
    });
    expect(response.statusCode).toBe(409);
    expect(
      response.json<{ reasons: { code: string }[] }>().reasons.map((reason) => reason.code),
    ).toEqual(["firmware-too-old", "payouts-not-enabled"]);
  });

  it("does not let another host change your charger", async () => {
    const { chargerId } = await connect(host, "21238888");
    const intruder = await h.user("ciara@example.com", "+353861230006");
    await becomeHost(intruder);
    const response = await call("PATCH", `/hosts/chargers/${chargerId}`, intruder, {
      pricePerHourCents: 1,
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects unknown fields", async () => {
    const { chargerId } = await connect(host, "21239990");
    const response = await call("PATCH", `/hosts/chargers/${chargerId}`, host, {
      status: "online",
    });
    expect(response.statusCode).toBe(400);
  });
});
