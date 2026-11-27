import { eq, getTableColumns } from "drizzle-orm";

import type { Executor } from "../client.ts";
import { chargers, hosts } from "../schema/tables.ts";

function omit<T extends Record<string, unknown>, K extends keyof T & string>(
  columns: T,
  keys: readonly K[],
): Omit<T, K> {
  const omitted: readonly string[] = keys;
  return Object.fromEntries(
    Object.entries(columns).filter(([key]) => !omitted.includes(key)),
  ) as Omit<T, K>;
}

/** Charger columns that must never appear in a default selection. */
export const CHARGER_SECRET_COLUMNS = ["ocppAuthHash"] as const;

/** Every charger column except secrets. Use with `db.select(chargerColumns)`. */
export const chargerColumns = omit(getTableColumns(chargers), CHARGER_SECRET_COLUMNS);

/**
 * Every host column. Hosts hold no secrets: tax identity lives in
 * `host_tax_details`, whose encrypted columns are read only by the API's tax module.
 */
export const hostColumns = getTableColumns(hosts);

export type Charger = Omit<typeof chargers.$inferSelect, (typeof CHARGER_SECRET_COLUMNS)[number]>;
export type Host = typeof hosts.$inferSelect;

/** A charger by its OCPP ChargeboxID, without secrets. */
export async function findChargerByChargeboxId(
  db: Executor,
  chargeboxId: string,
): Promise<Charger | undefined> {
  const [row] = await db
    .select(chargerColumns)
    .from(chargers)
    .where(eq(chargers.chargeboxId, chargeboxId))
    .limit(1);
  return row;
}

/** What the gateway needs to check a charger's Basic Auth on upgrade. */
export interface ChargerCredentials {
  readonly id: string;
  readonly chargeboxId: string;
  readonly ocppAuthHash: string | null;
}

/** The one read that returns the OCPP secret hash; use it only to authenticate. */
export async function findChargerCredentials(
  db: Executor,
  chargeboxId: string,
): Promise<ChargerCredentials | undefined> {
  const [row] = await db
    .select({
      id: chargers.id,
      chargeboxId: chargers.chargeboxId,
      ocppAuthHash: chargers.ocppAuthHash,
    })
    .from(chargers)
    .where(eq(chargers.chargeboxId, chargeboxId))
    .limit(1);
  return row;
}

/** A user's host profile. */
export async function findHostByUserId(db: Executor, userId: string): Promise<Host | undefined> {
  const [row] = await db.select(hostColumns).from(hosts).where(eq(hosts.userId, userId)).limit(1);
  return row;
}
