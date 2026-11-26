import { randomBytes, randomUUID } from "node:crypto";

import type { Executor } from "../src/client.ts";
import type { LatLng, TimeRange } from "../src/schema/columns.ts";
import { availabilityRules, bookings, chargers, hosts, users } from "../src/schema/tables.ts";

type BookingInsert = typeof bookings.$inferInsert;
type ChargerInsert = typeof chargers.$inferInsert;

export async function insertUser(db: Executor, name = "Cian"): Promise<string> {
  const id = `user-${randomUUID()}`;
  await db.insert(users).values({ id, name, email: `${id}@example.com` });
  return id;
}

export async function insertHost(db: Executor): Promise<{ hostId: string; userId: string }> {
  const userId = await insertUser(db, "Aoife");
  const [host] = await db.insert(hosts).values({ userId }).returning({ id: hosts.id });
  if (host === undefined) throw new Error("host not inserted");
  return { hostId: host.id, userId };
}

/** An online, bookable charger with an overnight rule every day (20:00 to 08:00). */
export async function insertCharger(
  db: Executor,
  location: LatLng,
  overrides: Partial<ChargerInsert> = {},
): Promise<string> {
  const { hostId } = await insertHost(db);
  const suffix = randomBytes(4).toString("hex");
  const [charger] = await db
    .insert(chargers)
    .values({
      hostId,
      model: "zappi_v2_1",
      serial: `2${suffix}`,
      chargeboxId: `test-${suffix}`,
      maxKw: 7.4,
      connectorType: "tethered",
      location,
      address: "1 Test Lane, Dublin",
      status: "online",
      acceptingBookings: true,
      ...overrides,
    })
    .returning({ id: chargers.id });
  if (charger === undefined) throw new Error("charger not inserted");
  await db.insert(availabilityRules).values(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      chargerId: charger.id,
      weekday,
      startTime: "20:00",
      endTime: "08:00",
      pricePerHourCents: 250,
    })),
  );
  return charger.id;
}

let tagCounter = 0;

/** A unique idTag of the maximum OCPP length. */
export function idTag(): string {
  tagCounter += 1;
  return `T${randomBytes(6).toString("hex").toUpperCase()}${String(tagCounter).padStart(7, "0")}`;
}

export function insertBooking(
  db: Executor,
  chargerId: string,
  driverId: string,
  slot: TimeRange,
  overrides: Partial<BookingInsert> = {},
) {
  return db
    .insert(bookings)
    .values({
      chargerId,
      driverId,
      slot,
      status: "confirmed",
      idTag: idTag(),
      quotedAmountCents: 2000,
      ...overrides,
    })
    .returning();
}

/** A window on a fixed winter date (Dublin is on UTC), so no DST surprises. */
export function utcWindow(startIso: string, hours: number): TimeRange {
  const start = new Date(startIso);
  return { start, end: new Date(start.getTime() + hours * 60 * 60 * 1000) };
}
