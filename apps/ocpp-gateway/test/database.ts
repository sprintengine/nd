import { randomBytes, randomUUID } from "node:crypto";

import {
  bookings,
  chargers,
  createDb,
  type Database,
  hashChargerSecret,
  hosts,
  ocppMessages,
  payments,
  runMigrations,
  users,
} from "@nd/db";
import { CHARGER_EVENTS_CHANNEL, type ChargerEvent, parseChargerEvent } from "@nd/domain";
import pg from "pg";

// Integration test helpers: each test file gets its own migrated database on
// the server at DATABASE_URL, dropped afterwards.

function serverUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error("DATABASE_URL must be set for integration tests");
  }
  return url;
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface TestDatabase extends Database {
  readonly url: string;
  dispose(): Promise<void>;
}

/** A fresh database with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `nd_gw_test_${randomBytes(6).toString("hex")}`;
  await admin(`create database "${name}"`);
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const database = createDb(url.toString(), { max: 4 });
  return {
    ...database,
    url: url.toString(),
    dispose: async () => {
      await database.close();
      await admin(`drop database if exists "${name}" with (force)`);
    },
  };
}

export interface SeededCharger {
  readonly id: string;
  readonly chargeboxId: string;
  readonly secret: string;
  readonly hostIdTag: string;
}

/** A host with one charger whose OCPP secret is known. */
export async function seedCharger(
  db: Database["db"],
  overrides: Partial<typeof chargers.$inferInsert> = {},
): Promise<SeededCharger> {
  const userId = `user-${randomUUID()}`;
  await db.insert(users).values({ id: userId, name: "Aoife", email: `${userId}@example.com` });
  const [host] = await db.insert(hosts).values({ userId }).returning({ id: hosts.id });
  const secret = randomBytes(18).toString("base64url");
  const suffix = randomBytes(4).toString("hex");
  const chargeboxId = `2${suffix}`;
  const hostIdTag = `HOST${suffix}`.toUpperCase();
  const [charger] = await db
    .insert(chargers)
    .values({
      hostId: host?.id ?? "",
      model: "zappi_v2_1",
      serial: chargeboxId,
      chargeboxId,
      ocppAuthHash: await hashChargerSecret(secret),
      maxKw: 7.4,
      connectorType: "tethered",
      location: { lat: 53.326, lng: -6.256 },
      address: "1 Test Lane, Dublin",
      hostIdTag,
      ...overrides,
    })
    .returning({ id: chargers.id });
  return { id: charger?.id ?? "", chargeboxId, secret, hostIdTag };
}

/** A unique booking idTag of at most 20 characters. */
export function newIdTag(): string {
  return `B${randomBytes(9).toString("hex").toUpperCase()}`.slice(0, 20);
}

/**
 * A driver's booking on a charger whose slot is open now (from 10 minutes
 * ago, for 2 hours), paid upfront unless `paid` is false.
 */
export async function seedOpenBooking(
  db: Database["db"],
  chargerId: string,
  status: "confirmed" | "arrived" | "active" = "arrived",
  { paid = true }: { paid?: boolean } = {},
): Promise<{ id: string; idTag: string }> {
  const driverId = `user-${randomUUID()}`;
  await db.insert(users).values({ id: driverId, name: "Cian", email: `${driverId}@example.com` });
  const now = Date.now();
  const idTag = newIdTag();
  const [booking] = await db
    .insert(bookings)
    .values({
      chargerId,
      driverId,
      slot: { start: new Date(now - 10 * 60_000), end: new Date(now + 2 * 3_600_000) },
      status,
      idTag,
      quotedAmountCents: 1000,
    })
    .returning({ id: bookings.id });
  await db
    .insert(payments)
    .values({ bookingId: booking?.id ?? "", amountCents: 1000, status: paid ? "paid" : "pending" });
  return { id: booking?.id ?? "", idTag };
}

/** Records `count` outbound ChangeConfiguration CALLs, as if sent in the last few minutes. */
export async function seedConfigWrites(
  db: Database["db"],
  chargerId: string,
  count: number,
): Promise<void> {
  if (count === 0) return;
  await db.insert(ocppMessages).values(
    Array.from({ length: count }, (_, index) => ({
      chargerId,
      direction: "out" as const,
      messageType: "call" as const,
      messageId: randomUUID(),
      action: "ChangeConfiguration",
      payload: { key: "MeterValueSampleInterval", value: String(60 + index) },
      ts: new Date(Date.now() - (index + 1) * 60_000),
    })),
  );
}

/** A LISTEN client on charger_events that keeps every event it receives. */
export interface EventListener {
  readonly events: ChargerEvent[];
  waitFor(predicate: (event: ChargerEvent) => boolean, timeoutMs?: number): Promise<ChargerEvent>;
  close(): Promise<void>;
}

export async function listenForEvents(url: string): Promise<EventListener> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const events: ChargerEvent[] = [];
  const waiters: {
    predicate: (event: ChargerEvent) => boolean;
    resolve: (event: ChargerEvent) => void;
  }[] = [];
  client.on("notification", (message) => {
    if (message.channel !== CHARGER_EVENTS_CHANNEL) return;
    const event = parseChargerEvent(message.payload);
    if (event === undefined) {
      throw new Error(`invalid charger event: ${String(message.payload)}`);
    }
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  await client.query(`listen ${CHARGER_EVENTS_CHANNEL}`);
  return {
    events,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timed out waiting for a charger event"));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    close: () => client.end(),
  };
}
