import { verifyChargerSecret } from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { fakeChargerEvents, fakeStripe } from "../../test/fakes.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as data from "../data/hosts.ts";

vi.mock("../data/hosts.ts");

const CHARGER_ID = "22222222-2222-4222-8222-222222222222";

let app: FastifyInstance;
let events: ReturnType<typeof fakeChargerEvents>;
let stripe: ReturnType<typeof fakeStripe>;

const host = {
  id: "33333333-3333-4333-8333-333333333333",
  userId: USER_ID,
  stripeAccountId: null,
  payoutStatus: "not_started",
} as unknown as Awaited<ReturnType<typeof data.ensureHost>>;

const owned = {
  id: CHARGER_ID,
  status: "online",
  firmware: "5.794",
  maxKw: 7.4,
  acceptingBookings: false,
  hostId: host.id,
  payoutStatus: "enabled",
  currency: "GBP",
} satisfies data.OwnedCharger;

const view = {
  id: CHARGER_ID,
  chargeboxId: "NDABCDEFGHJK",
  serial: "21234567",
  model: "zappi_v2_1",
  status: "online",
  firmware: "5.794",
  maxKw: 7.4,
  connectorType: "tethered",
  address: "3 Test Terrace",
  location: { lat: 53.3, lng: -6.2 },
  timezone: "Europe/Dublin",
  acceptingBookings: true,
  payoutStatus: "enabled",
  currency: "EUR",
  maxSessionsPerDay: 2,
  nightRateStart: "23:00:00",
  nightRateEnd: "08:00:00",
} satisfies data.HostChargerRow;

const rule = {
  weekday: 1,
  startTime: "20:00:00",
  endTime: "08:00:00",
  pricePerHourCents: 250,
  currency: "EUR",
  kwhCap: 30,
  instantBook: true,
} satisfies data.StoredRule;

const send = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  ({ app, events, stripe } = startUnitApp());
  signInAs(app);
  vi.mocked(data.ensureHost).mockResolvedValue(host);
  vi.mocked(data.findHost).mockResolvedValue(host);
  vi.mocked(data.chargersWithSerial).mockResolvedValue([]);
  vi.mocked(data.insertCharger).mockResolvedValue(CHARGER_ID);
  vi.mocked(data.findOwnedCharger).mockResolvedValue(owned);
  vi.mocked(data.rulesOf).mockResolvedValue([rule]);
  vi.mocked(data.findHostChargerView).mockResolvedValue(view);
  vi.mocked(data.inTransaction).mockImplementation((db, work) => work(db));
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("guards", () => {
  it("are 403 without a verified phone, before the body is even validated", async () => {
    await app.close();
    ({ app } = startUnitApp());
    signInAs(app, { phoneVerified: false });
    const response = await send("POST", "/hosts/chargers", { serial: "nonsense" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "phone-verification-required" });
  });

  it("are 401 without a session", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/hosts/chargers/${CHARGER_ID}`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /hosts", () => {
  it("creates the Stripe account once and returns an onboarding link", async () => {
    const response = await send("POST", "/hosts", { country: "GB" });
    expect(response.json()).toEqual({
      hostId: host.id,
      payoutStatus: "pending",
      onboardingUrl: "https://connect.stripe.test/setup/acct_test_1",
      onboardingUrlExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(stripe.calls[0]).toEqual({
      method: "createExpressAccount",
      input: { hostId: host.id, email: "aoife@example.com", country: "GB" },
    });
    expect(stripe.calls[1]?.input).toEqual({
      accountId: "acct_test_1",
      refreshUrl: "http://localhost:5173/host/payouts?stripe=refresh",
      returnUrl: "http://localhost:5173/host/payouts?stripe=return",
    });
    expect(data.saveStripeAccount).toHaveBeenCalledWith(expect.anything(), host.id, {
      stripeAccountId: "acct_test_1",
      payoutStatus: "pending",
      currency: "GBP",
    });
  });

  it("reuses an existing account and keeps its payout status", async () => {
    vi.mocked(data.ensureHost).mockResolvedValue({
      ...host,
      stripeAccountId: "acct_old",
      payoutStatus: "enabled",
    });
    const response = await app.inject({ method: "POST", url: "/hosts", headers: SESSION_COOKIE });
    expect(response.json()).toMatchObject({ payoutStatus: "enabled" });
    expect(stripe.calls.map((call) => call.method)).toEqual(["createAccountLink"]);
  });

  it("keeps a restricted status when creating the account", async () => {
    vi.mocked(data.ensureHost).mockResolvedValue({ ...host, payoutStatus: "restricted" });
    const response = await send("POST", "/hosts", {});
    expect(response.json()).toMatchObject({ payoutStatus: "restricted" });
  });
});

describe("POST /hosts/chargers", () => {
  const body = {
    serial: "21234567",
    connectorType: "untethered",
    address: "3 Test Terrace",
    location: { lat: 53.3, lng: -6.2 },
  };

  it("creates the charger and returns credentials once, without caching", async () => {
    const response = await send("POST", "/hosts/chargers", body);
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const created = response.json<{
      chargerId: string;
      chargeboxId: string;
      wssUrl: string;
      secret: string;
    }>();
    expect(created).toMatchObject({ chargerId: CHARGER_ID, wssUrl: "wss://ocpp.example.com/v16/" });
    const inserted = vi.mocked(data.insertCharger).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      hostId: host.id,
      serial: "21234567",
      chargeboxId: created.chargeboxId,
      model: "zappi_v2_1",
      maxKw: 7.4,
      timezone: "Europe/Dublin",
    });
    expect(JSON.stringify(inserted)).not.toContain(created.secret);
    await expect(verifyChargerSecret(created.secret, inserted?.ocppAuthHash ?? "")).resolves.toBe(
      true,
    );
  });

  it("rejects an ineligible serial with 422 and a bad one with 400", async () => {
    const v20 = await send("POST", "/hosts/chargers", { ...body, serial: "11234567" });
    expect(v20.statusCode).toBe(422);
    const malformed = await send("POST", "/hosts/chargers", { ...body, serial: "2123" });
    expect(malformed.statusCode).toBe(400);
    const zone = await send("POST", "/hosts/chargers", { ...body, timezone: "Nowhere/Land" });
    expect(zone.statusCode).toBe(400);
  });

  it("needs a host profile", async () => {
    vi.mocked(data.findHost).mockResolvedValue(undefined);
    const response = await send("POST", "/hosts/chargers", body);
    expect(response.json()).toMatchObject({ status: 403, code: "host-required" });
  });

  it("replaces the secret of the host's own charger still onboarding", async () => {
    vi.mocked(data.chargersWithSerial).mockResolvedValue([
      { id: CHARGER_ID, hostId: host.id, status: "onboarding", chargeboxId: "NDEXISTING00" },
    ]);
    const response = await send("POST", "/hosts/chargers", body);
    expect(response.json()).toMatchObject({ chargerId: CHARGER_ID, chargeboxId: "NDEXISTING00" });
    expect(data.updateChargerDetails).toHaveBeenCalledOnce();
    expect(data.insertCharger).not.toHaveBeenCalled();
  });

  it("refuses a serial that is connected or belongs to someone else", async () => {
    vi.mocked(data.chargersWithSerial).mockResolvedValueOnce([
      { id: CHARGER_ID, hostId: host.id, status: "online", chargeboxId: "NDEXISTING00" },
    ]);
    expect((await send("POST", "/hosts/chargers", body)).json()).toMatchObject({
      code: "charger-connected",
    });
    vi.mocked(data.chargersWithSerial).mockResolvedValueOnce([
      { id: CHARGER_ID, hostId: "someone-else", status: "onboarding", chargeboxId: "NDEXISTING00" },
    ]);
    expect((await send("POST", "/hosts/chargers", body)).json()).toMatchObject({
      code: "charger-registered",
    });
  });
});

describe("GET /hosts/chargers/:id/onboarding", () => {
  it("returns at once for a connected charger", async () => {
    const response = await send("GET", `/hosts/chargers/${CHARGER_ID}/onboarding`);
    expect(response.json()).toEqual({
      chargerId: CHARGER_ID,
      status: "online",
      connected: true,
      firmware: "5.794",
      firmwareSupported: true,
      maxKw: 7.4,
      notice: null,
    });
    expect(events.subscribers(CHARGER_ID)).toBe(0);
  });

  it("waits for the charger's event, then re-reads it", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValue({
      ...owned,
      status: "onboarding",
      firmware: null,
    });
    const pending = send("GET", `/hosts/chargers/${CHARGER_ID}/onboarding?wait=5`);
    await vi.waitFor(() => {
      expect(events.subscribers(CHARGER_ID)).toBe(1);
    });
    vi.mocked(data.findOwnedCharger).mockResolvedValue({ ...owned, firmware: "5.612" });
    events.emit(CHARGER_ID);
    const response = await pending;
    expect(response.json()).toMatchObject({ connected: true, firmwareSupported: false });
    expect(response.json<{ notice: string }>().notice).toMatch(/5\.794/);
    expect(events.subscribers(CHARGER_ID)).toBe(0);
  });

  it("does not wait when asked not to", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValue({ ...owned, status: "onboarding" });
    const response = await send("GET", `/hosts/chargers/${CHARGER_ID}/onboarding?wait=0`);
    expect(response.json()).toMatchObject({
      connected: false,
      firmwareSupported: null,
      notice: null,
    });
  });

  it("is 404 for a charger the user does not own", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValue(undefined);
    const response = await send("GET", `/hosts/chargers/${CHARGER_ID}/onboarding`);
    expect(response.statusCode).toBe(404);
  });
});

describe("PATCH /hosts/chargers/:id", () => {
  const url = `/hosts/chargers/${CHARGER_ID}`;

  it("replaces availability, carrying over the current terms", async () => {
    const response = await send("PATCH", url, {
      availability: [{ weekday: 3, start: "21:00", end: "07:00" }],
    });
    expect(response.statusCode).toBe(200);
    expect(data.replaceRules).toHaveBeenCalledWith(expect.anything(), CHARGER_ID, "GBP", [
      {
        weekday: 3,
        startTime: "21:00",
        endTime: "07:00",
        pricePerHourCents: 250,
        kwhCap: 30,
        instantBook: true,
      },
    ]);
    expect(response.json()).toMatchObject({
      pricePerHourCents: 250,
      availability: [{ weekday: 1, start: "20:00", end: "08:00" }],
      nightRateWindow: { start: "23:00", end: "08:00" },
      publishBlockers: [],
    });
  });

  it("applies new terms to every window", async () => {
    await send("PATCH", url, { pricePerHourCents: 300, kwhCap: null, instantBook: false });
    expect(data.updateRuleTerms).toHaveBeenCalledWith(expect.anything(), CHARGER_ID, {
      pricePerHourCents: 300,
      kwhCap: null,
      instantBook: false,
    });
    expect(data.replaceRules).not.toHaveBeenCalled();
  });

  it("skips rule updates when there are no windows or no terms", async () => {
    vi.mocked(data.rulesOf).mockResolvedValue([]);
    await send("PATCH", url, { pricePerHourCents: 300 });
    await send("PATCH", url, {});
    expect(data.updateRuleTerms).not.toHaveBeenCalled();
  });

  it("needs a price for the first windows", async () => {
    vi.mocked(data.rulesOf).mockResolvedValue([]);
    const response = await send("PATCH", url, {
      availability: [{ weekday: 1, start: "20:00", end: "08:00" }],
    });
    expect(response.statusCode).toBe(422);
    const priced = await send("PATCH", url, {
      pricePerHourCents: 200,
      availability: [{ weekday: 1, start: "20:00", end: "08:00" }],
    });
    expect(priced.statusCode).toBe(200);
    expect(vi.mocked(data.replaceRules).mock.calls[0]?.[3]).toEqual([
      {
        weekday: 1,
        startTime: "20:00",
        endTime: "08:00",
        pricePerHourCents: 200,
        kwhCap: null,
        instantBook: false,
      },
    ]);
  });

  it("publishes when everything is in place", async () => {
    const response = await send("PATCH", url, { acceptingBookings: true });
    expect(response.statusCode).toBe(200);
    expect(data.setAcceptingBookings).toHaveBeenCalledWith(expect.anything(), CHARGER_ID, true);
  });

  it("refuses to publish while onboarding, listing every reason", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValue({
      ...owned,
      status: "onboarding",
      payoutStatus: "pending",
    });
    vi.mocked(data.rulesOf).mockResolvedValue([]);
    const response = await send("PATCH", url, { acceptingBookings: true });
    expect(response.statusCode).toBe(409);
    expect(
      response.json<{ reasons: { code: string }[] }>().reasons.map((reason) => reason.code),
    ).toEqual(["charger-not-online", "payouts-not-enabled", "no-availability"]);
    expect(data.setAcceptingBookings).not.toHaveBeenCalled();
  });

  it("refuses to remove every window from a published listing", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValue({ ...owned, acceptingBookings: true });
    const response = await send("PATCH", url, { availability: [] });
    expect(response.statusCode).toBe(409);
  });

  it("updates the host's session cap and night-rate window", async () => {
    await send("PATCH", url, {
      maxSessionsPerDay: 3,
      nightRateWindow: { start: "00:30", end: "07:30" },
    });
    expect(data.updateHostSettings).toHaveBeenCalledWith(expect.anything(), host.id, {
      maxSessionsPerDay: 3,
      nightRateStart: "00:30",
      nightRateEnd: "07:30",
    });
    await send("PATCH", url, { nightRateWindow: null });
    expect(data.updateHostSettings).toHaveBeenLastCalledWith(expect.anything(), host.id, {
      nightRateStart: null,
      nightRateEnd: null,
    });
  });

  it("shows no price and no night window when there are none", async () => {
    vi.mocked(data.rulesOf).mockResolvedValue([]);
    vi.mocked(data.findHostChargerView).mockResolvedValue({
      ...view,
      nightRateStart: null,
      nightRateEnd: null,
    });
    const response = await send("PATCH", url, {});
    expect(response.json()).toMatchObject({
      pricePerHourCents: null,
      currency: "EUR",
      kwhCap: null,
      instantBook: false,
      nightRateWindow: null,
    });
  });

  it("is 404 for a charger the user does not own, and validates the body", async () => {
    vi.mocked(data.findOwnedCharger).mockResolvedValueOnce(undefined);
    expect((await send("PATCH", url, { pricePerHourCents: 1 })).statusCode).toBe(404);
    expect((await send("PATCH", url, { pricePerHourCents: -1 })).statusCode).toBe(400);
    expect(
      (await send("PATCH", url, { availability: [{ weekday: 1, start: "20:00", end: "20:00" }] }))
        .statusCode,
    ).toBe(400);
    vi.mocked(data.findHostChargerView).mockResolvedValueOnce(undefined);
    expect((await send("PATCH", url, {})).statusCode).toBe(404);
  });
});
