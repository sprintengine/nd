import { argon2Sync, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashChargerSecret, parseArgon2Hash, verifyChargerSecret } from "./charger-secret.ts";

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

describe("charger secrets", () => {
  it("hash as argon2id PHC strings that verify", async () => {
    const hash = await hashChargerSecret("correct horse");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    await expect(verifyChargerSecret("correct horse", hash)).resolves.toBe(true);
    await expect(verifyChargerSecret("wrong horse", hash)).resolves.toBe(false);
  });

  it("use a fresh salt every time", async () => {
    expect(await hashChargerSecret("same")).not.toBe(await hashChargerSecret("same"));
  });

  it("verify hashes written by other argon2 implementations and variants", async () => {
    const salt = randomBytes(16);
    const tag = argon2Sync("argon2i", {
      message: "pw",
      nonce: salt,
      memory: 4096,
      passes: 3,
      parallelism: 2,
      tagLength: 24,
    });
    const hash = `$argon2i$v=19$m=4096,t=3,p=2$${b64(salt)}$${b64(tag)}`;
    await expect(verifyChargerSecret("pw", hash)).resolves.toBe(true);
  });

  it.each([
    "",
    "plain-text",
    "$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g",
    "$scrypt$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g",
    "$argon2id$v=19$m=999999999,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g",
    "$argon2id$v=19$m=19456,t=99,p=1$c2FsdHNhbHQ$aGFzaGhhc2g",
    "$argon2id$v=19$m=19456,t=2,p=0$c2FsdHNhbHQ$aGFzaGhhc2g",
    "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaGhhc2g",
  ])("refuse an unusable stored hash %#", async (hash) => {
    expect(parseArgon2Hash(hash)).toBeUndefined();
    await expect(verifyChargerSecret("pw", hash)).resolves.toBe(false);
  });
});
