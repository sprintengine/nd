import { fileURLToPath } from "node:url";

import type * as DbModule from "@nd/db";
import type { FastifyInstance } from "fastify";
import { format, resolveConfig } from "prettier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { fakeChargerEvents } from "../test/fakes.ts";
import { SESSION_COOKIE as cookie, signInAs, startUnitApp, USER_ID } from "../test/unit-app.ts";
import { loggerOptions, REDACTED_LOG_PATHS } from "./app.ts";
import * as listingData from "./data/listing.ts";
import * as usersData from "./data/users.ts";
import type { ApiConfig } from "./env.ts";

vi.mock("./data/users.ts");
vi.mock("./data/listing.ts");
vi.mock("@nd/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  searchChargers: vi.fn(() => Promise.resolve([])),
}));

const { searchChargers } = await import("@nd/db");

const CHARGER_ID = "11111111-1111-4111-8111-111111111111";

let app: FastifyInstance;
let events: ReturnType<typeof fakeChargerEvents>;

function start(config: Partial<ApiConfig> = {}) {
  ({ app, events } = startUnitApp(config));
}

const signedIn = (phoneVerified = true, setCookie?: string) => {
  signInAs(app, { phoneVerified, ...(setCookie === undefined ? {} : { setCookie }) });
};

beforeEach(() => {
  start();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("platform", () => {
  it("answers the health check", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("echoes a sensible request id and makes one otherwise", async () => {
    const echoed = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "req-123" },
    });
    expect(echoed.headers["x-request-id"]).toBe("req-123");
    const replaced = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(replaced.headers["x-request-id"]).toBe("generated-id");
  });

  it("sets security headers", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toBeDefined();
  });

  it("allows CORS with credentials only from configured origins", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers unknown routes with a problem", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("closes the charger event subscription with the app", async () => {
    await app.close();
    expect(events.isClosed()).toBe(true);
  });

  it("logs request paths without their query strings", async () => {
    await app.close();
    const lines: string[] = [];
    ({ app } = startUnitApp(
      {},
      {
        logger: { ...loggerOptions("info"), stream: { write: (line: string) => lines.push(line) } },
      },
    ));
    await app.inject({
      method: "GET",
      url: "/healthz?token=magic-link-token-123&code=oauth-code-456",
    });
    const logged = lines.join("\n");
    expect(logged).toContain('"url":"/healthz"');
    expect(logged).not.toContain("magic-link-token-123");
    expect(logged).not.toContain("oauth-code-456");
  });

  it("redacts cookies, authorization and secrets from logs", () => {
    expect(REDACTED_LOG_PATHS).toEqual(
      expect.arrayContaining(["req.headers.cookie", "req.headers.authorization", "*.secret"]),
    );
    expect(loggerOptions("info")).toMatchObject({
      level: "info",
      redact: { censor: "[redacted]" },
    });
  });
});

describe("OpenAPI", () => {
  it("serves an OpenAPI 3.1 document that matches the committed contract", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const spec = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/admin/sessions/{id}/resolve",
      "/bookings",
      "/bookings/{id}",
      "/bookings/{id}/approve",
      "/bookings/{id}/arrive",
      "/bookings/{id}/cancel",
      "/bookings/{id}/decline",
      "/bookings/{id}/receipt",
      "/bookings/{id}/review",
      "/bookings/{id}/session",
      "/bookings/{id}/start",
      "/bookings/{id}/stop",
      "/chargers",
      "/chargers/{id}",
      "/hosts",
      "/hosts/bookings",
      "/hosts/calendar",
      "/hosts/chargers",
      "/hosts/chargers/{id}",
      "/hosts/chargers/{id}/onboarding",
      "/hosts/dashboard",
      "/hosts/me/tax-details",
      "/hosts/sessions/{id}/confirm",
      "/hosts/sessions/{id}/dispute",
      "/me",
      "/me/delete",
      "/me/delete/cancel",
      "/me/devices",
      "/me/devices/{id}",
      "/me/notification-preferences",
      "/me/payment-methods",
      "/me/payment-methods/default",
      "/me/payment-methods/setup-intent",
      "/webhooks/stripe",
    ]);
    // Written in the repository's Prettier style, so formatting the file (from
    // any directory, or in an editor) never changes it and `format:check` covers it.
    const file = fileURLToPath(new URL("__snapshots__/openapi.json", import.meta.url));
    const contract = await format(JSON.stringify(spec, null, 2), {
      ...(await resolveConfig(file)),
      filepath: file,
    });
    await expect(contract).toMatchFileSnapshot(file);
  });
});

describe("session", () => {
  it("skips the session lookup without a cookie", async () => {
    const getSession = vi.spyOn(app.auth.api, "getSession");
    await app.inject({ method: "GET", url: "/me" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("is 401 when the cookie matches no session", async () => {
    vi.spyOn(app.auth.api, "getSession").mockResolvedValue({
      headers: new Headers(),
      response: null,
    } as never);
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie });
    expect(response.statusCode).toBe(401);
  });

  it("passes a renewed session cookie on", async () => {
    signedIn(true, "better-auth.session_token=renewed; Path=/; HttpOnly");
    vi.mocked(usersData.findUserWithHost).mockResolvedValue(undefined);
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie });
    expect(response.headers["set-cookie"]).toContain(
      "better-auth.session_token=renewed; Path=/; HttpOnly",
    );
  });
});

describe("GET /me", () => {
  const user = {
    id: USER_ID,
    name: "Aoife",
    email: "aoife@example.com",
    emailVerified: true,
    image: null,
    phone: "+353861234567",
    phoneVerified: true,
  };

  it("returns the user with phone and host flags", async () => {
    signedIn();
    vi.mocked(usersData.findUserWithHost).mockResolvedValue({
      user,
      host: { id: "host-1", payoutStatus: "enabled" } as never,
    });
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie });
    expect(response.json()).toEqual({
      id: USER_ID,
      name: "Aoife",
      email: "aoife@example.com",
      emailVerified: true,
      image: null,
      phoneNumber: "+353861234567",
      phoneVerified: true,
      isHost: true,
      host: { id: "host-1", payoutStatus: "enabled", payoutsEnabled: true },
    });
  });

  it("reports a user who is not a host", async () => {
    signedIn();
    vi.mocked(usersData.findUserWithHost).mockResolvedValue({ user, host: null });
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie });
    expect(response.json()).toMatchObject({ isHost: false, host: null });
  });

  it("is 401 when the user has gone", async () => {
    signedIn();
    vi.mocked(usersData.findUserWithHost).mockResolvedValue(undefined);
    const response = await app.inject({ method: "GET", url: "/me", headers: cookie });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /chargers", () => {
  const query = {
    lat: "53.33",
    lng: "-6.26",
    from: "2027-01-11T22:00:00Z",
    to: "2027-01-12T06:00:00Z",
  };

  it("searches with the parsed point, radius and window", async () => {
    const response = await app.inject({ method: "GET", url: "/chargers", query });
    expect(response.json()).toEqual({ results: [] });
    expect(vi.mocked(searchChargers)).toHaveBeenCalledWith(expect.anything(), {
      point: { lat: 53.33, lng: -6.26 },
      radiusM: 5000,
      window: { start: new Date(query.from), end: new Date(query.to) },
    });
  });

  it("rejects windows longer than a day or the wrong way round", async () => {
    const long = await app.inject({
      method: "GET",
      url: "/chargers",
      query: { ...query, to: "2027-01-13T06:00:00Z" },
    });
    expect(long.statusCode).toBe(400);
    const backwards = await app.inject({
      method: "GET",
      url: "/chargers",
      query: { ...query, from: query.to, to: query.from },
    });
    expect(backwards.statusCode).toBe(400);
  });

  it("is rate limited per client", async () => {
    await app.close();
    start({ searchRateLimitPerMinute: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "GET", url: "/chargers", query })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    const limited = await app.inject({ method: "GET", url: "/chargers", query });
    expect(limited.json()).toMatchObject({ code: "rate-limited", status: 429 });
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});

describe("GET /chargers/:id", () => {
  const charger = {
    id: CHARGER_ID,
    brand: "myenergi",
    model: "zappi_v2_1",
    connectorType: "tethered" as const,
    maxKw: 7.4,
    timezone: "Europe/Dublin",
    location: { lat: 53.32617, lng: -6.25543 },
    address: "1 Test Lane, Dublin",
    status: "online" as const,
    acceptingBookings: true,
    hostId: "host-1",
    hostUserId: "user-sam",
    hostName: "Sam Byrne",
    hostSince: new Date("2026-01-01T00:00:00Z"),
  };

  beforeEach(() => {
    vi.mocked(listingData.findListingCharger).mockResolvedValue(charger);
    vi.mocked(listingData.hasSlotHoldingBooking).mockResolvedValue(false);
    vi.mocked(listingData.chargerRules).mockResolvedValue([
      {
        weekday: 1,
        startTime: "20:00:00",
        endTime: "08:00:00",
        pricePerHourCents: 300,
        currency: "EUR",
        kwhCap: null,
        instantBook: false,
      },
      {
        weekday: 2,
        startTime: "20:00:00",
        endTime: "08:00:00",
        pricePerHourCents: 250,
        currency: "EUR",
        kwhCap: 40,
        instantBook: true,
      },
    ]);
    vi.mocked(listingData.heldSlots).mockResolvedValue([]);
    vi.mocked(listingData.chargerRating).mockResolvedValue({ rating: 4.5, reviewCount: 2 });
    vi.mocked(listingData.hostRating).mockResolvedValue({ rating: 4.7, reviewCount: 3 });
  });

  it("shows the listing with approximate position and no address", async () => {
    const response = await app.inject({ method: "GET", url: `/chargers/${CHARGER_ID}` });
    const listing = response.json<Record<string, unknown>>();
    expect(listing).toMatchObject({
      pricePerHourCents: 250,
      currency: "EUR",
      instantBook: true,
      rating: 4.5,
      reviewCount: 2,
      host: {
        firstName: "Sam",
        memberSince: "2026-01-01T00:00:00.000Z",
        rating: 4.7,
        reviewCount: 3,
      },
      addressVisible: false,
      address: null,
      location: null,
    });
    expect(listing.approximateLocation).not.toEqual(charger.location);
    expect(listing.slots).toHaveLength(2);
    expect(listingData.hasSlotHoldingBooking).not.toHaveBeenCalled();
  });

  it("shows the address to a driver holding a booking, even once unlisted", async () => {
    signedIn();
    vi.mocked(listingData.findListingCharger).mockResolvedValue({ ...charger, status: "offline" });
    vi.mocked(listingData.hasSlotHoldingBooking).mockResolvedValue(true);
    const response = await app.inject({
      method: "GET",
      url: `/chargers/${CHARGER_ID}`,
      headers: cookie,
    });
    expect(response.json()).toMatchObject({
      addressVisible: true,
      address: "1 Test Lane, Dublin",
      location: charger.location,
      slots: [],
    });
    expect(listingData.hasSlotHoldingBooking).toHaveBeenCalledWith(
      expect.anything(),
      CHARGER_ID,
      USER_ID,
    );
  });

  it("is 404 for unlisted chargers and unknown ids", async () => {
    vi.mocked(listingData.findListingCharger).mockResolvedValueOnce({
      ...charger,
      acceptingBookings: false,
    });
    expect((await app.inject({ method: "GET", url: `/chargers/${CHARGER_ID}` })).statusCode).toBe(
      404,
    );
    vi.mocked(listingData.findListingCharger).mockResolvedValueOnce(undefined);
    expect((await app.inject({ method: "GET", url: `/chargers/${CHARGER_ID}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "GET", url: "/chargers/not-a-uuid" })).statusCode).toBe(400);
  });

  it("shows no price for a charger without windows", async () => {
    vi.mocked(listingData.chargerRules).mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: `/chargers/${CHARGER_ID}` });
    expect(response.json()).toMatchObject({
      pricePerHourCents: null,
      currency: null,
      instantBook: false,
      slots: [],
    });
  });
});
