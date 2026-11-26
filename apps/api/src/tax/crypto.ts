import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Field encryption for hosts' tax details: AES-256-GCM with keys from the
// TAX_ENCRYPTION_KEYS environment variable. The first key encrypts; every
// listed key can decrypt, so a key is rotated by putting a new one first,
// re-encrypting (`rotateTaxEncryptionKeys`), then dropping the old one.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface TaxKeyring {
  /** Id of the key new values are encrypted with. */
  readonly currentId: string;
  /** Every usable key by id, the current one included. */
  readonly keys: ReadonlyMap<string, Buffer>;
}

/**
 * Parses `id:base64key,id:base64key`; the first is current. Each key is 32
 * random bytes (`openssl rand -base64 32`). Errors name the entry by
 * position and never include key material.
 */
export function parseTaxKeyring(value: string): TaxKeyring {
  const keys = new Map<string, Buffer>();
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new Error("lists no keys");
  entries.forEach((entry, index) => {
    const position = `entry ${String(index + 1)}`;
    const colon = entry.indexOf(":");
    const id = colon < 0 ? "" : entry.slice(0, colon);
    const encoded = colon < 0 ? "" : entry.slice(colon + 1);
    if (!KEY_ID.test(id)) {
      throw new Error(`${position} must be <id>:<base64 key>, the id 1-32 of A-Z a-z 0-9 _ -`);
    }
    if (keys.has(id)) throw new Error(`${position} repeats the key id ${id}`);
    const key = Buffer.from(encoded, "base64");
    if (key.length !== KEY_BYTES || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
      throw new Error(`${position} (${id}) must be ${String(KEY_BYTES)} bytes, base64-encoded`);
    }
    keys.set(id, key);
  });
  const [currentId] = keys.keys();
  return { currentId: currentId ?? "", keys };
}

/** An encrypted value and the id of the key it was written with. */
export interface Sealed {
  readonly keyId: string;
  /** base64 of IV (12 bytes), ciphertext and GCM tag (16 bytes). */
  readonly ciphertext: string;
}

/**
 * Encrypts `plaintext` with the current key. `context` (e.g. the row and
 * column) is bound as associated data, so a value copied to another row or
 * column no longer decrypts.
 */
export function seal(keyring: TaxKeyring, plaintext: string, context: string): Sealed {
  const key = keyring.keys.get(keyring.currentId);
  if (key === undefined) throw new Error("the current tax key is missing");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: keyring.currentId,
    ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64"),
  };
}

/** Decrypts a value written by `seal` with any key in the ring. */
export function unseal(keyring: TaxKeyring, sealed: Sealed, context: string): string {
  const key = keyring.keys.get(sealed.keyId);
  if (key === undefined) {
    throw new Error(`tax key ${sealed.keyId} is not in TAX_ENCRYPTION_KEYS`);
  }
  const raw = Buffer.from(sealed.ciphertext, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("encrypted value is truncated");
  const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
