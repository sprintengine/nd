import { randomBytes, randomUUID } from "node:crypto";

import { availabilityRules, bookings, chargers, type Executor, hosts, users } from "@nd/db";

type ChargerInsert = typeof chargers.$inferInsert;

/** An online, bookable charger of a new host, open 20:00 to 08:00 every day at 250 cents an hour. */
export async function insertListedCharger(
  db: Executor,
  location: { lat: number; lng: number },
  overrides: Partial<ChargerInsert> = {},
): Promise<{ chargerId: string; hostUserId: string }> {
  const hostUserId = `user-${randomUUID()}`;
  await db
    .insert(users)
    .values({ id: hostUserId, name: "Sam Byrne", email: `${hostUserId}@example.com` });
  const [host] = await db
    .insert(hosts)
    .values({ userId: hostUserId, payoutStatus: "enabled" })
    .returning({ id: hosts.id });
  if (host === undefined) throw new Error("host not inserted");
  const suffix = randomBytes(4).toString("hex");
  const [charger] = await db
    .insert(chargers)
    .values({
      hostId: host.id,
      model: "zappi_v2_1",
      serial: `2${suffix}`,
      chargeboxId: `test-${suffix}`,
      firmware: "5.794",
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
      instantBook: true,
    })),
  );
  return { chargerId: charger.id, hostUserId };
}

/** A booking by `driverId` for a slot. */
export async function insertBooking(
  db: Executor,
  chargerId: string,
  driverId: string,
  slot: { start: Date; end: Date },
  status: "requested" | "confirmed" | "arrived" | "active" | "completed" = "confirmed",
): Promise<void> {
  await db.insert(bookings).values({
    chargerId,
    driverId,
    slot,
    status,
    idTag: `T${randomBytes(9).toString("hex").toUpperCase()}`,
    quotedAmountCents: 2000,
  });
}

/** The next 22:00 UTC at least a day from now, for an overnight window. */
export function tonight(): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(22, 0, 0, 0);
  return date;
}

export const hours = (start: Date, count: number) => new Date(start.getTime() + count * 3_600_000);
