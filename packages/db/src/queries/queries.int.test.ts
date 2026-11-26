import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, type MigratedDatabase } from "../../test/database.ts";
import { insertBooking, insertCharger, insertUser, utcWindow } from "../../test/fixtures.ts";
import { chargers, hosts, sessions } from "../schema/tables.ts";
import { buildSeedData, seed } from "../seed.ts";
import { bookingsInWindow, openTransactionForCharger } from "./bookings.ts";
import { findChargerByChargeboxId, findChargerCredentials, findHostByUserId } from "./chargers.ts";

let database: MigratedDatabase;
const seeded = buildSeedData();

beforeAll(async () => {
  database = await createMigratedDatabase();
  await expect(seed(database.db)).resolves.toEqual({ inserted: true });
});

afterAll(async () => {
  await database.dispose();
});

describe("seed", () => {
  it("does nothing when run twice", async () => {
    await expect(seed(database.db)).resolves.toEqual({ inserted: false });
  });

  it("round-trips locations exactly", async () => {
    const rows = await database.db
      .select({ id: chargers.id, location: chargers.location })
      .from(chargers);
    for (const expected of seeded.chargers) {
      const row = rows.find((candidate) => candidate.id === expected.id);
      expect(row?.location.lat).toBeCloseTo(expected.location.lat, 10);
      expect(row?.location.lng).toBeCloseTo(expected.location.lng, 10);
    }
  });
});

describe("bookingsInWindow", () => {
  let chargerId: string;
  let driverId: string;

  beforeAll(async () => {
    chargerId = await insertCharger(database.db, { lat: 53.33, lng: -6.26 });
    driverId = await insertUser(database.db);
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-03-01T22:00:00Z", 8));
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-03-02T22:00:00Z", 8), {
      status: "requested",
    });
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-03-05T22:00:00Z", 8));
  });

  it("returns the charger's bookings that overlap the window, earliest first", async () => {
    const rows = await bookingsInWindow(database.db, {
      chargerId,
      window: utcWindow("2027-03-02T00:00:00Z", 24),
    });
    expect(rows.map((row) => row.slot.start.toISOString())).toEqual([
      "2027-03-01T22:00:00.000Z",
      "2027-03-02T22:00:00.000Z",
    ]);
  });

  it("filters by status", async () => {
    const window = utcWindow("2027-03-01T00:00:00Z", 24 * 7);
    const confirmed = await bookingsInWindow(database.db, {
      chargerId,
      window,
      statuses: ["confirmed"],
    });
    expect(confirmed).toHaveLength(2);
    expect(confirmed.every((row) => row.status === "confirmed")).toBe(true);
    await expect(
      bookingsInWindow(database.db, { chargerId, window, statuses: [] }),
    ).resolves.toEqual([]);
  });

  it("treats the window as half-open", async () => {
    await expect(
      bookingsInWindow(database.db, { chargerId, window: utcWindow("2027-03-01T20:00:00Z", 2) }),
    ).resolves.toEqual([]);
  });
});

describe("openTransactionForCharger", () => {
  it("returns the charging session on a seeded charger with its booking", async () => {
    const milltown = seeded.chargers[2];
    if (milltown?.id === undefined) throw new Error("no seeded charger");
    const open = await openTransactionForCharger(database.db, milltown.id);
    expect(open?.session.status).toBe("charging");
    expect(open?.session.ocppTransactionId).toBe(1001);
    expect(open?.booking.status).toBe("active");
    expect(open?.booking.chargerId).toBe(milltown.id);
  });

  it("returns nothing once the session has stopped", async () => {
    const chargerId = await insertCharger(database.db, { lat: 53.33, lng: -6.26 });
    const driverId = await insertUser(database.db);
    const [booking] = await insertBooking(
      database.db,
      chargerId,
      driverId,
      utcWindow("2027-04-01T22:00:00Z", 8),
      { status: "active" },
    );
    if (booking === undefined) throw new Error("booking not inserted");
    const [session] = await database.db
      .insert(sessions)
      .values({ bookingId: booking.id, status: "starting" })
      .returning();
    if (session === undefined) throw new Error("session not inserted");
    await expect(openTransactionForCharger(database.db, chargerId)).resolves.toMatchObject({
      session: { id: session.id },
    });

    await database.db
      .update(sessions)
      .set({ status: "stopped", stoppedAt: new Date() })
      .where(eq(sessions.id, session.id));
    await expect(openTransactionForCharger(database.db, chargerId)).resolves.toBeUndefined();
  });
});

describe("charger and host helpers", () => {
  it("never select secrets by default", async () => {
    await database.db
      .update(chargers)
      .set({ ocppAuthHash: "hash-for-test" })
      .where(eq(chargers.chargeboxId, "seed-ranelagh"));
    await database.db
      .update(hosts)
      .set({ tinEncrypted: "ciphertext-for-test" })
      .where(eq(hosts.userId, "seed-user-aoife"));

    const charger = await findChargerByChargeboxId(database.db, "seed-ranelagh");
    expect(charger?.chargeboxId).toBe("seed-ranelagh");
    expect(charger).not.toHaveProperty("ocppAuthHash");
    expect(JSON.stringify(charger)).not.toContain("hash-for-test");

    const host = await findHostByUserId(database.db, "seed-user-aoife");
    expect(host?.taxCountry).toBe("IE");
    expect(host).not.toHaveProperty("tinEncrypted");

    await expect(findChargerCredentials(database.db, "seed-ranelagh")).resolves.toMatchObject({
      ocppAuthHash: "hash-for-test",
    });
  });

  it("return nothing for unknown ids", async () => {
    await expect(findChargerByChargeboxId(database.db, "missing")).resolves.toBeUndefined();
    await expect(findChargerCredentials(database.db, "missing")).resolves.toBeUndefined();
    await expect(findHostByUserId(database.db, "missing")).resolves.toBeUndefined();
  });
});
