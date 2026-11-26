import { bookings, meterValues, ocppMessages, sessions } from "@nd/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { insertBooking, insertListedCharger } from "../../test/fixtures.ts";
import { purgeExpiredTelemetry } from "./retention.ts";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

describe("purgeExpiredTelemetry", () => {
  it("removes only meter values and OCPP messages older than 24 months", async () => {
    const { db } = database;
    const now = new Date();
    const { chargerId, hostUserId } = await insertListedCharger(db, { lat: 53.33, lng: -6.25 });
    await insertBooking(
      db,
      chargerId,
      hostUserId,
      { start: new Date("2024-01-01T22:00:00Z"), end: new Date("2024-01-02T06:00:00Z") },
      "completed",
    );
    const [booking] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.chargerId, chargerId));
    const [session] = await db
      .insert(sessions)
      .values({ bookingId: booking?.id ?? "", status: "reconciled" })
      .returning({ id: sessions.id });
    const sessionId = session?.id ?? "";

    const old = new Date(now.getTime() - 25 * MONTH_MS);
    const recent = new Date(now.getTime() - 23 * MONTH_MS);
    await db.insert(meterValues).values([
      { sessionId, ts: old, energyWh: 1_000 },
      { sessionId, ts: old, energyWh: 1_100 },
      { sessionId, ts: recent, energyWh: 2_000 },
    ]);
    const message = (ts: Date, messageId: string) => ({
      chargerId,
      direction: "in" as const,
      messageType: "call" as const,
      messageId,
      action: "Heartbeat",
      payload: {},
      ts,
    });
    await db.insert(ocppMessages).values([message(old, "old-1"), message(recent, "recent-1")]);

    await expect(purgeExpiredTelemetry(db, now)).resolves.toEqual({
      ocppMessages: 1,
      meterValues: 2,
    });

    const keptValues = await db.select({ ts: meterValues.ts }).from(meterValues);
    expect(keptValues).toEqual([{ ts: recent }]);
    const keptMessages = await db.select({ id: ocppMessages.messageId }).from(ocppMessages);
    expect(keptMessages).toEqual([{ id: "recent-1" }]);
    expect(await db.select({ id: sessions.id }).from(sessions)).toEqual([{ id: sessionId }]);

    await expect(purgeExpiredTelemetry(db, now)).resolves.toEqual({
      ocppMessages: 0,
      meterValues: 0,
    });
  });
});
