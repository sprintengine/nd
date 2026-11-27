import { createDb, databaseUrlFromEnv } from "@nd/db";

import { rotateTaxEncryptionKeys } from "./data/tax-details.ts";
import { parseTaxKeyring, type TaxKeyring } from "./tax/crypto.ts";

/**
 * Re-encrypts hosts' tax details still on an older key with the first key
 * in TAX_ENCRYPTION_KEYS, then exits. Run after putting a new key first:
 * `node dist/rotate-tax-keys.js` (docs/RUNBOOK.md). Logs counts only.
 */
export async function rotateTaxKeys(
  source: Readonly<Record<string, string | undefined>> = process.env,
  rotate: (databaseUrl: string, keyring: TaxKeyring) => Promise<number> = withDatabase,
  log: (message: string) => void = (message) => {
    console.info(message);
  },
): Promise<number> {
  const databaseUrl = databaseUrlFromEnv(source);
  const keys = source.TAX_ENCRYPTION_KEYS;
  if (keys === undefined || keys === "") throw new Error("TAX_ENCRYPTION_KEYS must be set");
  let keyring: TaxKeyring;
  try {
    keyring = parseTaxKeyring(keys);
  } catch (error) {
    throw new Error(`TAX_ENCRYPTION_KEYS ${(error as Error).message}`, { cause: error });
  }
  const rewritten = await rotate(databaseUrl, keyring);
  log(`re-encrypted tax details of ${String(rewritten)} host(s) with key ${keyring.currentId}`);
  return rewritten;
}

async function withDatabase(databaseUrl: string, keyring: TaxKeyring): Promise<number> {
  const database = createDb(databaseUrl, { max: 1 });
  try {
    return await rotateTaxEncryptionKeys(database.db, keyring);
  } finally {
    await database.close();
  }
}

if (import.meta.main) {
  await rotateTaxKeys();
}
