import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, type MigratedDatabase, pgErrorCode } from "../../test/database.ts";
import { idTag, insertBooking, insertCharger, insertUser, utcWindow } from "../../test/fixtures.ts";
import { bookings } from "./tables.ts";

const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const STRING_TOO_LONG = "22001";

let database: MigratedDatabase;
let chargerId: string;
let otherChargerId: string;
let driverId: string;

beforeAll(async () => {
  database = await createMigratedDatabase();
  chargerId = await insertCharger(database.db, { lat: 53.326, lng: -6.256 });
  otherChargerId = await insertCharger(database.db, { lat: 53.327, lng: -6.257 });
  driverId = await insertUser(database.db);
});

afterAll(async () => {
  await database.dispose();
});

describe("bookings slot exclusion", () => {
  it("rejects a second confirmed booking overlapping the first on one charger", async () => {
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-01-04T22:00:00Z", 8));
    const code = await pgErrorCode(
      insertBooking(database.db, chargerId, driverId, utcWindow("2027-01-05T02:00:00Z", 8)),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it.each(["arrived", "active"] as const)(
    "treats %s bookings as holding the slot",
    async (status) => {
      const slot = utcWindow("2027-01-06T22:00:00Z", 8);
      await insertBooking(database.db, chargerId, driverId, slot, { status });
      expect(await pgErrorCode(insertBooking(database.db, chargerId, driverId, slot))).toBe(
        EXCLUSION_VIOLATION,
      );
      await database.db.delete(bookings).where(eq(bookings.chargerId, chargerId));
    },
  );

  it("allows back-to-back slots, since slots are half-open", async () => {
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-01-10T20:00:00Z", 4));
    await expect(
      insertBooking(database.db, chargerId, driverId, utcWindow("2027-01-11T00:00:00Z", 4)),
    ).resolves.toHaveLength(1);
  });

  it("allows overlapping slots on different chargers", async () => {
    const slot = utcWindow("2027-01-12T22:00:00Z", 8);
    await insertBooking(database.db, chargerId, driverId, slot);
    await expect(insertBooking(database.db, otherChargerId, driverId, slot)).resolves.toHaveLength(
      1,
    );
  });

  it.each([
    ["requested", "2027-01-14T22:00:00Z"],
    ["completed", "2027-01-15T22:00:00Z"],
    ["no_show", "2027-01-16T22:00:00Z"],
  ] as const)("lets a %s booking overlap a confirmed one", async (status, start) => {
    const slot = utcWindow(start, 8);
    await insertBooking(database.db, otherChargerId, driverId, slot);
    await expect(
      insertBooking(database.db, otherChargerId, driverId, slot, { status }),
    ).resolves.toHaveLength(1);
  });

  it("lets a cancelled booking overlap a confirmed one", async () => {
    const slot = utcWindow("2027-01-17T02:00:00Z", 4);
    await insertBooking(database.db, chargerId, driverId, slot);
    await expect(
      insertBooking(database.db, chargerId, driverId, slot, {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: "driver",
      }),
    ).resolves.toHaveLength(1);
  });

  it("frees the slot when the holding booking is cancelled", async () => {
    const slot = utcWindow("2027-01-18T22:00:00Z", 8);
    const [first] = await insertBooking(database.db, chargerId, driverId, slot);
    if (first === undefined) throw new Error("booking not inserted");
    await database.db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: "host" })
      .where(eq(bookings.id, first.id));
    await expect(insertBooking(database.db, chargerId, driverId, slot)).resolves.toHaveLength(1);
  });

  it("rejects confirming a request into a taken slot", async () => {
    const slot = utcWindow("2027-01-20T22:00:00Z", 8);
    await insertBooking(database.db, chargerId, driverId, slot);
    const [request] = await insertBooking(database.db, chargerId, driverId, slot, {
      status: "requested",
    });
    if (request === undefined) throw new Error("booking not inserted");
    const code = await pgErrorCode(
      database.db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, request.id)),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it("round-trips the slot as a half-open range", async () => {
    const slot = utcWindow("2027-01-22T22:30:00Z", 7.5);
    const [row] = await insertBooking(database.db, chargerId, driverId, slot);
    expect(row?.slot).toEqual(slot);
  });

  it("rejects a slot that ends before it starts", async () => {
    const code = await pgErrorCode(
      database.db.execute(
        sql`insert into bookings (charger_id, driver_id, slot, id_tag, quoted_amount_cents)
            values (${chargerId}, ${driverId}, '[2027-01-02 00:00Z,)', 'UNBOUNDED', 0)`,
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe("bookings id_tag", () => {
  it("is unique across all bookings", async () => {
    const tag = idTag();
    await insertBooking(database.db, chargerId, driverId, utcWindow("2027-02-01T22:00:00Z", 8), {
      idTag: tag,
    });
    const code = await pgErrorCode(
      insertBooking(database.db, otherChargerId, driverId, utcWindow("2027-02-02T22:00:00Z", 8), {
        idTag: tag,
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("is at most 20 characters, the OCPP limit", async () => {
    const window = utcWindow("2027-02-03T22:00:00Z", 8);
    await expect(
      insertBooking(database.db, chargerId, driverId, window, { idTag: "A".repeat(20) }),
    ).resolves.toHaveLength(1);
    const code = await pgErrorCode(
      insertBooking(database.db, otherChargerId, driverId, window, { idTag: "B".repeat(21) }),
    );
    expect(code).toBe(STRING_TOO_LONG);
  });

  it("cannot be empty", async () => {
    const code = await pgErrorCode(
      insertBooking(database.db, chargerId, driverId, utcWindow("2027-02-05T22:00:00Z", 8), {
        idTag: "",
      }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});
