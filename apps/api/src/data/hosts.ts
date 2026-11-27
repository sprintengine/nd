import {
  availabilityRules,
  chargers,
  type Db,
  type Executor,
  findHostByUserId,
  type Host,
  hosts,
} from "@nd/db";
import type { Currency, HostPayoutStatus } from "@nd/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

// Reads and writes behind the /hosts routes. Integration tests cover them
// against Postgres. Ordinary reads never select `ocpp_auth_hash`.

/** The user's host record, created if it does not exist yet. */
export async function ensureHost(db: Executor, userId: string): Promise<Host> {
  await db.insert(hosts).values({ userId }).onConflictDoNothing({ target: hosts.userId });
  const host = await findHostByUserId(db, userId);
  if (host === undefined) throw new Error("host not created");
  return host;
}

export { findHostByUserId as findHost };

/**
 * Saves the host's new Stripe account and the currency of its country. Rules
 * already set up (before the account existed) are moved to that currency.
 */
export async function saveStripeAccount(
  db: Executor,
  hostId: string,
  account: { stripeAccountId: string; payoutStatus: HostPayoutStatus; currency: Currency },
): Promise<void> {
  const { stripeAccountId, payoutStatus, currency } = account;
  await db
    .update(hosts)
    .set({ stripeAccountId, payoutStatus, currency })
    .where(eq(hosts.id, hostId));
  await db
    .update(availabilityRules)
    .set({ currency })
    .where(
      inArray(
        availabilityRules.chargerId,
        db.select({ id: chargers.id }).from(chargers).where(eq(chargers.hostId, hostId)),
      ),
    );
}

/** Chargers registered with a serial number, by any host. */
export function chargersWithSerial(db: Executor, serial: string) {
  return db
    .select({
      id: chargers.id,
      hostId: chargers.hostId,
      status: chargers.status,
      chargeboxId: chargers.chargeboxId,
    })
    .from(chargers)
    .where(eq(chargers.serial, serial));
}

export interface ChargerDetails {
  readonly model: string;
  readonly connectorType: "tethered" | "untethered";
  readonly maxKw: number;
  readonly address: string;
  readonly location: { lat: number; lng: number };
  readonly timezone: string;
  readonly ocppAuthHash: string;
}

/** Creates a charger in `onboarding`. */
export async function insertCharger(
  db: Executor,
  input: ChargerDetails & { hostId: string; serial: string; chargeboxId: string },
): Promise<string> {
  const [row] = await db.insert(chargers).values(input).returning({ id: chargers.id });
  if (row === undefined) throw new Error("charger not inserted");
  return row.id;
}

/** Replaces the details and OCPP password hash of a charger still onboarding. */
export async function updateChargerDetails(
  db: Executor,
  chargerId: string,
  details: ChargerDetails,
): Promise<void> {
  await db.update(chargers).set(details).where(eq(chargers.id, chargerId));
}

/** A charger owned by the user's host, without secrets; optionally locked for update. */
export async function findOwnedCharger(
  db: Executor,
  userId: string,
  chargerId: string,
  { lock = false }: { lock?: boolean } = {},
) {
  const query = db
    .select({
      id: chargers.id,
      status: chargers.status,
      firmware: chargers.firmware,
      maxKw: chargers.maxKw,
      acceptingBookings: chargers.acceptingBookings,
      hostId: hosts.id,
      payoutStatus: hosts.payoutStatus,
      currency: hosts.currency,
    })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(and(eq(chargers.id, chargerId), eq(hosts.userId, userId)))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: chargers }) : await query;
  return row;
}

export type OwnedCharger = NonNullable<Awaited<ReturnType<typeof findOwnedCharger>>>;

/** A stored availability rule. */
export interface StoredRule {
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly pricePerHourCents: number;
  readonly currency: Currency;
  readonly kwhCap: number | null;
  readonly instantBook: boolean;
}

export function rulesOf(db: Executor, chargerId: string): Promise<StoredRule[]> {
  return db
    .select({
      weekday: availabilityRules.weekday,
      startTime: availabilityRules.startTime,
      endTime: availabilityRules.endTime,
      pricePerHourCents: availabilityRules.pricePerHourCents,
      currency: availabilityRules.currency,
      kwhCap: availabilityRules.kwhCap,
      instantBook: availabilityRules.instantBook,
    })
    .from(availabilityRules)
    .where(eq(availabilityRules.chargerId, chargerId))
    .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime));
}

export interface NewRule {
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly pricePerHourCents: number;
  readonly kwhCap: number | null;
  readonly instantBook: boolean;
}

/** Replaces every availability rule of a charger, priced in the host's currency. */
export async function replaceRules(
  db: Executor,
  chargerId: string,
  currency: Currency,
  rules: readonly NewRule[],
): Promise<void> {
  await db.delete(availabilityRules).where(eq(availabilityRules.chargerId, chargerId));
  if (rules.length > 0) {
    await db
      .insert(availabilityRules)
      .values(rules.map((rule) => ({ chargerId, currency, ...rule })));
  }
}

/** Applies price, kWh cap or instant book to every rule of a charger. */
export async function updateRuleTerms(
  db: Executor,
  chargerId: string,
  terms: Partial<Pick<NewRule, "pricePerHourCents" | "kwhCap" | "instantBook">>,
): Promise<void> {
  await db.update(availabilityRules).set(terms).where(eq(availabilityRules.chargerId, chargerId));
}

export async function setAcceptingBookings(
  db: Executor,
  chargerId: string,
  acceptingBookings: boolean,
): Promise<void> {
  await db.update(chargers).set({ acceptingBookings }).where(eq(chargers.id, chargerId));
}

export async function updateHostSettings(
  db: Executor,
  hostId: string,
  settings: {
    maxSessionsPerDay?: number;
    nightRateStart?: string | null;
    nightRateEnd?: string | null;
  },
): Promise<void> {
  await db.update(hosts).set(settings).where(eq(hosts.id, hostId));
}

/** Everything the host's view of a charger shows, without secrets. */
export async function findHostChargerView(db: Executor, chargerId: string) {
  const [row] = await db
    .select({
      id: chargers.id,
      chargeboxId: chargers.chargeboxId,
      serial: chargers.serial,
      model: chargers.model,
      status: chargers.status,
      firmware: chargers.firmware,
      maxKw: chargers.maxKw,
      connectorType: chargers.connectorType,
      address: chargers.address,
      location: chargers.location,
      timezone: chargers.timezone,
      acceptingBookings: chargers.acceptingBookings,
      payoutStatus: hosts.payoutStatus,
      currency: hosts.currency,
      maxSessionsPerDay: hosts.maxSessionsPerDay,
      nightRateStart: hosts.nightRateStart,
      nightRateEnd: hosts.nightRateEnd,
    })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(chargers.id, chargerId))
    .limit(1);
  return row;
}

export type HostChargerRow = NonNullable<Awaited<ReturnType<typeof findHostChargerView>>>;

/** Runs `work` in one transaction. */
export function inTransaction<T>(db: Db, work: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(work);
}
