import { randomUUID } from "node:crypto";

import { bookings, disputes, users } from "@nd/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { hours, insertBooking, insertListedCharger, tonight } from "../../test/fixtures.ts";
import { closeCardDispute, insertCardDispute, insertDisputeOnce } from "./disputes.ts";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

describe("insertDisputeOnce", () => {
  it("records one open dispute per user and booking", async () => {
    const { db } = database;
    const { chargerId } = await insertListedCharger(db, { lat: 53.326, lng: -6.256 });
    const driverId = `user-${randomUUID()}`;
    await db.insert(users).values({ id: driverId, name: "Cian", email: `${driverId}@example.com` });
    const start = tonight();
    await insertBooking(db, chargerId, driverId, { start, end: hours(start, 2) }, "completed");
    const [booking] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.driverId, driverId));
    const bookingId = booking?.id ?? "";
    const input = { bookingId, raisedById: driverId, reason: "Overcharged", details: null };

    const first = await insertDisputeOnce(db, input);
    expect(first).toBeDefined();
    await expect(insertDisputeOnce(db, input)).resolves.toBeUndefined();

    // Once support has resolved it, a new dispute may be raised.
    await db.update(disputes).set({ status: "resolved" }).where(eq(disputes.bookingId, bookingId));
    await expect(insertDisputeOnce(db, input)).resolves.toBeDefined();
    const rows = await db.select().from(disputes).where(eq(disputes.bookingId, bookingId));
    expect(rows.map((row) => row.status).sort()).toEqual(["open", "resolved"]);
    expect(rows.find((row) => row.id === first)).toMatchObject({
      raisedById: driverId,
      reason: "Overcharged",
      details: null,
    });
  });
});

describe("card disputes", () => {
  it("stay closed when Stripe's close arrives before its create, and close when it comes after", async () => {
    const { db } = database;
    const { chargerId } = await insertListedCharger(db, { lat: 53.326, lng: -6.256 });
    const driverId = `user-${randomUUID()}`;
    await db.insert(users).values({ id: driverId, name: "Cian", email: `${driverId}@example.com` });
    const start = tonight();
    await insertBooking(db, chargerId, driverId, { start, end: hours(start, 2) }, "completed");
    const [booking] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.driverId, driverId));
    const known = { bookingId: booking?.id ?? "", driverId, reason: "fraudulent" };
    const at = new Date("2027-02-01T10:00:00Z");
    const statusOf = async (stripeDisputeId: string) =>
      (await db.select().from(disputes).where(eq(disputes.stripeDisputeId, stripeDisputeId)))[0]
        ?.status;

    // Closed first (won by the platform), then created: it stays closed.
    await closeCardDispute(db, { ...known, stripeDisputeId: "dp_late", outcome: "won", at });
    await expect(insertCardDispute(db, { ...known, stripeDisputeId: "dp_late" })).resolves.toBe(
      false,
    );
    expect(await statusOf("dp_late")).toBe("rejected");

    // Created, then closed (lost): resolved.
    await insertCardDispute(db, { ...known, stripeDisputeId: "dp_usual" });
    expect(await statusOf("dp_usual")).toBe("open");
    await closeCardDispute(db, { ...known, stripeDisputeId: "dp_usual", outcome: "lost", at });
    expect(await statusOf("dp_usual")).toBe("resolved");
  });
});
