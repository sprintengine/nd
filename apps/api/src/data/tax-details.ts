import { type Db, type Executor, hosts, hostTaxDetails } from "@nd/db";
import type { TaxCountry, TaxEntityType } from "@nd/domain";
import { and, eq, ne } from "drizzle-orm";

import { seal, type TaxKeyring, unseal } from "../tax/crypto.ts";

// Hosts' tax details. The TIN and date of birth are encrypted here, bound to
// the host and column, and nothing in this file returns them decrypted
// except key rotation, which writes them straight back.

/** Associated data for an encrypted column of one host's row. */
export const sealContext = (column: "tin" | "date_of_birth", hostId: string) =>
  `host_tax_details.${column}_encrypted:${hostId}`;

export interface TaxDetailsInput {
  readonly entityType: TaxEntityType;
  readonly legalName: string | null;
  /** `YYYY-MM-DD`, individuals only. */
  readonly dateOfBirth: string | null;
  readonly companyName: string | null;
  readonly companyNumber: string | null;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly addressCountry: string;
  readonly taxCountry: TaxCountry;
  /** Normalized TIN. */
  readonly tin: string;
  readonly tinMasked: string;
}

/** The columns a host may see: everything except the encrypted values. */
const visibleColumns = {
  entityType: hostTaxDetails.entityType,
  legalName: hostTaxDetails.legalName,
  companyName: hostTaxDetails.companyName,
  companyNumber: hostTaxDetails.companyNumber,
  addressLine1: hostTaxDetails.addressLine1,
  addressLine2: hostTaxDetails.addressLine2,
  city: hostTaxDetails.city,
  region: hostTaxDetails.region,
  postalCode: hostTaxDetails.postalCode,
  addressCountry: hostTaxDetails.addressCountry,
  taxCountry: hostTaxDetails.taxCountry,
  tinMasked: hostTaxDetails.tinMasked,
  updatedAt: hostTaxDetails.updatedAt,
};

/** A host's tax details without the encrypted values, or undefined. */
export async function findTaxDetails(db: Executor, hostId: string) {
  const [row] = await db
    .select(visibleColumns)
    .from(hostTaxDetails)
    .where(eq(hostTaxDetails.hostId, hostId))
    .limit(1);
  return row;
}

export type StoredTaxDetails = NonNullable<Awaited<ReturnType<typeof findTaxDetails>>>;

/**
 * Encrypts and stores a host's tax details, replacing any earlier ones, and
 * marks the host's tax details complete, in one transaction.
 */
export async function saveTaxDetails(
  db: Db,
  keyring: TaxKeyring,
  hostId: string,
  input: TaxDetailsInput,
): Promise<void> {
  const tin = seal(keyring, input.tin, sealContext("tin", hostId));
  const dateOfBirth =
    input.dateOfBirth === null
      ? null
      : seal(keyring, input.dateOfBirth, sealContext("date_of_birth", hostId));
  const values = {
    entityType: input.entityType,
    legalName: input.legalName,
    dateOfBirthEncrypted: dateOfBirth?.ciphertext ?? null,
    companyName: input.companyName,
    companyNumber: input.companyNumber,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    addressCountry: input.addressCountry,
    taxCountry: input.taxCountry,
    tinEncrypted: tin.ciphertext,
    tinMasked: input.tinMasked,
    encryptionKeyId: tin.keyId,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(hostTaxDetails)
      .values({ hostId, ...values })
      .onConflictDoUpdate({ target: hostTaxDetails.hostId, set: values });
    await tx.update(hosts).set({ taxDetailsComplete: true }).where(eq(hosts.id, hostId));
  });
}

/**
 * Re-encrypts every host's tax details still written with an older key, so
 * that key can be removed from TAX_ENCRYPTION_KEYS. Scheduled step: run it
 * after putting a new key first (safe to run any time; it does nothing when
 * every row is on the current key). Returns how many rows it rewrote.
 */
export async function rotateTaxEncryptionKeys(db: Db, keyring: TaxKeyring): Promise<number> {
  const stale = await db
    .select({ hostId: hostTaxDetails.hostId })
    .from(hostTaxDetails)
    .where(ne(hostTaxDetails.encryptionKeyId, keyring.currentId));
  let rewritten = 0;
  for (const { hostId } of stale) {
    rewritten += await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          keyId: hostTaxDetails.encryptionKeyId,
          tin: hostTaxDetails.tinEncrypted,
          dateOfBirth: hostTaxDetails.dateOfBirthEncrypted,
        })
        .from(hostTaxDetails)
        .where(
          and(
            eq(hostTaxDetails.hostId, hostId),
            ne(hostTaxDetails.encryptionKeyId, keyring.currentId),
          ),
        )
        .for("update");
      if (row === undefined) return 0;
      const reseal = (ciphertext: string, column: "tin" | "date_of_birth") => {
        const context = sealContext(column, hostId);
        return seal(keyring, unseal(keyring, { keyId: row.keyId, ciphertext }, context), context)
          .ciphertext;
      };
      await tx
        .update(hostTaxDetails)
        .set({
          tinEncrypted: reseal(row.tin, "tin"),
          dateOfBirthEncrypted:
            row.dateOfBirth === null ? null : reseal(row.dateOfBirth, "date_of_birth"),
          encryptionKeyId: keyring.currentId,
        })
        .where(eq(hostTaxDetails.hostId, hostId));
      return 1;
    });
  }
  return rewritten;
}
