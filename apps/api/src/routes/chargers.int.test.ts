import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hours, insertBooking, insertListedCharger, tonight } from "../../test/fixtures.ts";
import { type Harness, startHarness } from "../../test/harness.ts";

let h: Harness;
const centre = { lat: 53.326, lng: -6.256 };
const exact = { lat: 53.32617, lng: -6.25543 };
let free: string;
let booked: string;
let driverCookie: string;
let driverId: string;
const start = tonight();
const end = hours(start, 8);

beforeAll(async () => {
  h = await startHarness();
  free = (await insertListedCharger(h.database.db, exact)).chargerId;
  booked = (await insertListedCharger(h.database.db, { lat: 53.3225, lng: -6.2655 })).chargerId;
  await insertListedCharger(h.database.db, { lat: 53.3301, lng: -6.25 }, { status: "onboarding" });
  driverCookie = await h.user("orla@example.com", "+353861110001");
  const me = await h.app.inject({ method: "GET", url: "/me", headers: { cookie: driverCookie } });
  driverId = me.json<{ id: string }>().id;
  await insertBooking(h.database.db, booked, driverId, {
    start: hours(start, 1),
    end: hours(start, 3),
  });
});

afterAll(async () => {
  await h.close();
});

const search = (query: Record<string, string>) =>
  h.app.inject({ method: "GET", url: "/chargers", query });

describe("GET /chargers", () => {
  const window = { from: start.toISOString(), to: end.toISOString() };

  it("finds free online chargers and leaves out one with an overlapping confirmed booking", async () => {
    const response = await search({
      lat: String(centre.lat),
      lng: String(centre.lng),
      radius: "3000",
      ...window,
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ results: { id: string }[] }>().results.map((result) => result.id);
    expect(ids).toEqual([free]);
  });

  it("finds the booked charger for a window after its booking", async () => {
    const response = await search({
      lat: String(centre.lat),
      lng: String(centre.lng),
      from: hours(start, 4).toISOString(),
      to: hours(start, 8).toISOString(),
    });
    const ids = response.json<{ results: { id: string }[] }>().results.map((result) => result.id);
    expect(ids.sort()).toEqual([free, booked].sort());
  });

  it("never returns exact coordinates or the address", async () => {
    const response = await search({ lat: String(centre.lat), lng: String(centre.lng), ...window });
    const [result] = response.json<{ results: Record<string, unknown>[] }>().results;
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("address");
    expect(result).not.toHaveProperty("location");
    expect(result?.approximateLocation).not.toEqual(exact);
    expect(response.body).not.toContain(String(exact.lat));
    expect(response.body).not.toContain(String(exact.lng));
    expect(response.body).not.toContain("Test Lane");
  });

  it("rejects a malformed query with a problem listing each field", async () => {
    const response = await search({ lat: "91", lng: "x", from: window.to, to: window.from });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; errors: { path: string }[] }>();
    expect(body.code).toBe("invalid-request");
    expect(body.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(["querystring.lat", "querystring.lng"]),
    );
  });

  it("rejects a window that has already ended", async () => {
    const response = await search({
      lat: String(centre.lat),
      lng: String(centre.lng),
      from: "2020-01-01T22:00:00Z",
      to: "2020-01-02T06:00:00Z",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "window-in-past" });
  });
});

describe("GET /chargers/:id", () => {
  it("shows the listing without the address to someone with no booking", async () => {
    const stranger = await h.user("aoife@example.com");
    for (const headers of [{}, { cookie: stranger }]) {
      const response = await h.app.inject({ method: "GET", url: `/chargers/${booked}`, headers });
      expect(response.statusCode).toBe(200);
      const listing = response.json<Record<string, unknown>>();
      expect(listing).toMatchObject({ addressVisible: false, address: null, location: null });
      expect(response.body).not.toContain("Test Lane");
      expect(listing.host).toMatchObject({ firstName: "Sam", rating: null, reviewCount: 0 });
      expect(listing.pricePerHourCents).toBe(250);
    }
  });

  it("shows the address and exact position to the driver with a confirmed booking", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: `/chargers/${booked}`,
      headers: { cookie: driverCookie },
    });
    expect(response.json()).toMatchObject({
      addressVisible: true,
      address: "1 Test Lane, Dublin",
      location: { lat: 53.3225, lng: -6.2655 },
    });
  });

  it("lists next week's free slots around the booking", async () => {
    const response = await h.app.inject({ method: "GET", url: `/chargers/${booked}` });
    const slots = response.json<{ slots: { start: string; end: string }[] }>().slots;
    expect(slots.length).toBeGreaterThanOrEqual(6);
    const bookedStart = hours(start, 1).getTime();
    const bookedEnd = hours(start, 3).getTime();
    for (const slot of slots) {
      const overlaps = Date.parse(slot.start) < bookedEnd && Date.parse(slot.end) > bookedStart;
      expect(overlaps).toBe(false);
    }
    expect(slots.some((slot) => Date.parse(slot.end) === bookedStart)).toBe(true);
    expect(slots.some((slot) => Date.parse(slot.start) === bookedEnd)).toBe(true);
  });

  it("is 404 for an unknown or unlisted charger", async () => {
    const unknown = await h.app.inject({
      method: "GET",
      url: "/chargers/00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.statusCode).toBe(404);
    const { chargerId } = await insertListedCharger(h.database.db, exact, {
      acceptingBookings: false,
    });
    const unlisted = await h.app.inject({ method: "GET", url: `/chargers/${chargerId}` });
    expect(unlisted.statusCode).toBe(404);
  });
});
