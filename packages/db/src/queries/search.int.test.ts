import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, type MigratedDatabase } from "../../test/database.ts";
import { insertBooking, insertCharger, insertUser, utcWindow } from "../../test/fixtures.ts";
import { bookings, chargers } from "../schema/tables.ts";
import { buildSeedData, seed, SEED_CENTRE } from "../seed.ts";
import { searchChargers } from "./search.ts";

let database: MigratedDatabase;

// A Wednesday night in January: Dublin is on UTC, inside every seeded overnight rule.
const window = utcWindow("2027-01-13T22:00:00Z", 8);
const seeded = buildSeedData();
const seededChargerIds = seeded.chargers.map((charger) => charger.id);

beforeAll(async () => {
  database = await createMigratedDatabase();
  await seed(database.db);
});

afterAll(async () => {
  await database.dispose();
});

const search = (overrides: Partial<Parameters<typeof searchChargers>[1]> = {}) =>
  searchChargers(database.db, { point: SEED_CENTRE, radiusM: 2_000, window, ...overrides });

describe("searchChargers", () => {
  it("finds every seeded charger within 2 km of Ranelagh, nearest first", async () => {
    const results = await search();
    expect(results.map((result) => result.id).sort()).toEqual([...seededChargerIds].sort());
    const distances = results.map((result) => result.approximateDistanceM);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    for (const result of results) {
      expect(result.approximateDistanceM).toBeLessThanOrEqual(2_000);
      expect(result.currency).toBe("EUR");
    }
  });

  it("finds nothing from 50 km away", async () => {
    // 0.45 degrees of latitude north of the centre is about 50 km.
    const farAway = { lat: SEED_CENTRE.lat + 0.45, lng: SEED_CENTRE.lng };
    await expect(search({ point: farAway })).resolves.toEqual([]);
    await expect(search({ point: farAway, radiusM: 40_000 })).resolves.toEqual([]);
  });

  it("never returns the exact location", async () => {
    const results = await search();
    for (const result of results) {
      const exact = seeded.chargers.find((charger) => charger.id === result.id)?.location;
      expect(exact).toBeDefined();
      if (exact === undefined) continue;
      expect(result.approximateLocation).not.toEqual(exact);
      // Within half a 150 m cell diagonal of the real position.
      const dLatM = (result.approximateLocation.lat - exact.lat) * 111_320;
      const dLngM =
        (result.approximateLocation.lng - exact.lng) *
        111_320 *
        Math.cos((exact.lat * Math.PI) / 180);
      expect(Math.hypot(dLatM, dLngM)).toBeLessThan(110);
      expect(result).not.toHaveProperty("address");
      expect(result).not.toHaveProperty("location");
    }
  });

  it("uses the price and terms of the rule that covers the window", async () => {
    const results = await search();
    const ranelagh = results.find((result) => result.id === seeded.chargers[0]?.id);
    expect(ranelagh).toMatchObject({
      pricePerHourCents: 250,
      instantBook: true,
      kwhCap: 40,
      maxKw: 7.4,
      connectorType: "tethered",
      rating: 5,
      reviewCount: 1,
    });
  });

  it("excludes a charger with a slot-holding booking in the window", async () => {
    const [ranelagh] = seededChargerIds;
    if (ranelagh === undefined) throw new Error("no seeded charger");
    const driverId = await insertUser(database.db);
    const [booking] = await insertBooking(
      database.db,
      ranelagh,
      driverId,
      utcWindow("2027-01-14T04:00:00Z", 2),
    );
    try {
      const ids = (await search()).map((result) => result.id);
      expect(ids).not.toContain(ranelagh);
      expect(ids).toHaveLength(seededChargerIds.length - 1);

      // A booking that only requests the slot does not hide the charger.
      const requested = await search({ window: utcWindow("2027-01-20T22:00:00Z", 8) });
      expect(requested.map((result) => result.id)).toContain(ranelagh);
    } finally {
      if (booking !== undefined) {
        // Test cleanup only; bookings are otherwise never deleted.
        await database.db.delete(bookings).where(eq(bookings.id, booking.id));
      }
    }
  });

  it("ignores cancelled and requested bookings in the window", async () => {
    const [, rathmines] = seededChargerIds;
    if (rathmines === undefined) throw new Error("no seeded charger");
    const driverId = await insertUser(database.db);
    await insertBooking(database.db, rathmines, driverId, window, { status: "requested" });
    await insertBooking(database.db, rathmines, driverId, window, {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: "driver",
    });
    expect((await search()).map((result) => result.id)).toContain(rathmines);
  });

  it.each([
    ["offline", { status: "offline" as const }],
    ["faulted", { status: "faulted" as const }],
    ["still onboarding", { status: "onboarding" as const }],
    ["not accepting bookings", { acceptingBookings: false }],
  ])("excludes a charger that is %s", async (_label, overrides) => {
    const id = await insertCharger(database.db, { lat: 53.3265, lng: -6.2555 }, overrides);
    expect((await search()).map((result) => result.id)).not.toContain(id);
    await database.db
      .update(chargers)
      .set({ status: "online", acceptingBookings: true })
      .where(eq(chargers.id, id));
    expect((await search()).map((result) => result.id)).toContain(id);
    await database.db.update(chargers).set({ acceptingBookings: false }).where(eq(chargers.id, id));
  });

  it("excludes chargers whose rules do not cover the whole window", async () => {
    // 07:00 to 10:00 runs past the overnight rules' 08:00 end.
    const morning = await search({ window: utcWindow("2027-01-14T07:00:00Z", 3) });
    expect(morning).toEqual([]);
    // Rathmines alone also takes daytime bookings (09:00 to 17:00).
    const daytime = await search({ window: utcWindow("2027-01-14T10:00:00Z", 4) });
    expect(daytime.map((result) => result.id)).toEqual([seededChargerIds[1]]);
    expect(daytime[0]?.pricePerHourCents).toBe(300);
  });

  it("matches the early hours against the previous evening's overnight rule", async () => {
    const earlyHours = await search({ window: utcWindow("2027-01-14T01:00:00Z", 4) });
    expect(earlyHours).toHaveLength(seededChargerIds.length);
  });

  it("reads rules in the charger's local time", async () => {
    // 21:00 to 23:00 Dublin summer time is 20:00 to 22:00 UTC: inside 20:00 to 08:00.
    const summer = await search({ window: utcWindow("2027-07-14T20:00:00Z", 2) });
    expect(summer).toHaveLength(seededChargerIds.length);
    // 19:30 to 21:30 Dublin summer time starts before the rules open.
    const early = await search({ window: utcWindow("2027-07-14T18:30:00Z", 2) });
    expect(early).toEqual([]);
  });

  it("honours the limit", async () => {
    await expect(search({ limit: 2 })).resolves.toHaveLength(2);
  });
});
