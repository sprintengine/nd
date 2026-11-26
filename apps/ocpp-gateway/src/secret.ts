import { argon2 as argon2Callback, randomBytes, timingSafeEqual } from "node:crypto";

// Per-charger OCPP Basic Auth secrets are stored as argon2 hashes in the
// standard PHC string format, `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`
// (unpadded base64), which every argon2 library reads and writes. Hashing and
// verifying use Node's built-in argon2.

type Algorithm = "argon2id" | "argon2i" | "argon2d";

/** Parameters for new hashes: argon2id with 19 MiB, two passes, one lane. */
export const DEFAULT_ARGON2_PARAMETERS = { memory: 19_456, passes: 2, parallelism: 1 } as const;

// A stored hash with absurd parameters must not let anyone stall the gateway.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 16;

interface ParsedHash {
  readonly algorithm: Algorithm;
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function argon2(
  algorithm: Algorithm,
  parameters: {
    message: string;
    nonce: Buffer;
    memory: number;
    passes: number;
    parallelism: number;
    tagLength: number;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2Callback(algorithm, parameters, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

const toB64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** Reads a PHC argon2 string. Returns undefined when it is not one this gateway can verify. */
export function parseArgon2Hash(encoded: string): ParsedHash | undefined {
  const match =
    /^\$(argon2id|argon2i|argon2d)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      encoded,
    );
  if (match === null) {
    return undefined;
  }
  const [, algorithm, m, t, p, salt, hash] = match as unknown as [
    string,
    Algorithm,
    string,
    string,
    string,
    string,
    string,
  ];
  const parsed = {
    algorithm,
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    salt: Buffer.from(salt, "base64"),
    hash: Buffer.from(hash, "base64"),
  };
  const sane =
    parsed.memory >= 8 * parsed.parallelism &&
    parsed.memory <= MAX_MEMORY_KIB &&
    parsed.passes >= 1 &&
    parsed.passes <= MAX_PASSES &&
    parsed.parallelism >= 1 &&
    parsed.parallelism <= MAX_PARALLELISM &&
    parsed.salt.length >= 8 &&
    parsed.hash.length >= 4;
  return sane ? parsed : undefined;
}

/** Hashes a charger secret as an argon2id PHC string. */
export async function hashChargerSecret(secret: string): Promise<string> {
  const { memory, passes, parallelism } = DEFAULT_ARGON2_PARAMETERS;
  const salt = randomBytes(16);
  const hash = await argon2("argon2id", {
    message: secret,
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength: 32,
  });
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${toB64(salt)}$${toB64(hash)}`;
}

/** Whether `secret` matches a stored PHC argon2 hash. False for an unreadable hash. */
export async function verifyChargerSecret(secret: string, encoded: string): Promise<boolean> {
  const parsed = parseArgon2Hash(encoded);
  if (parsed === undefined) {
    return false;
  }
  const candidate = await argon2(parsed.algorithm, {
    message: secret,
    nonce: parsed.salt,
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.hash.length,
  });
  return timingSafeEqual(candidate, parsed.hash);
}
