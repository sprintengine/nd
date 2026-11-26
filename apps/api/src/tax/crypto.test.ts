import { describe, expect, it } from "vitest";

import { parseTaxKeyring, seal, unseal } from "./crypto.ts";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const CONTEXT = "host_tax_details.tin_encrypted:host-1";

describe("parseTaxKeyring", () => {
  it("makes the first key current", () => {
    const ring = parseTaxKeyring(` k2:${key(2)} , k1:${key(1)} ,`);
    expect(ring.currentId).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"]);
  });

  it.each([
    ["", /no keys/],
    [`k1${key(1)}`, /entry 1 must be <id>:<base64 key>/],
    [`bad id:${key(1)}`, /entry 1 must be/],
    [`k1:${key(1)},k1:${key(2)}`, /entry 2 repeats the key id k1/],
    [`k1:${Buffer.alloc(16).toString("base64")}`, /entry 1 \(k1\) must be 32 bytes/],
    ["k1:not base64!", /must be 32 bytes/],
  ])("rejects %j", (value, message) => {
    expect(() => parseTaxKeyring(value)).toThrow(message);
  });

  it("never puts key material in its errors", () => {
    const short = Buffer.alloc(31, 5).toString("base64");
    expect(() => parseTaxKeyring(`k1:${short}`)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(short) as unknown }),
    );
  });
});

describe("seal and unseal", () => {
  const ring = parseTaxKeyring(`k1:${key(1)}`);

  it("round-trips and never stores the plaintext", () => {
    const sealed = seal(ring, "1234567FA", CONTEXT);
    expect(sealed.keyId).toBe("k1");
    expect(sealed.ciphertext).not.toContain("1234567FA");
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("1234567");
    expect(unseal(ring, sealed, CONTEXT)).toBe("1234567FA");
  });

  it("uses a fresh IV every time", () => {
    expect(seal(ring, "same", CONTEXT).ciphertext).not.toBe(seal(ring, "same", CONTEXT).ciphertext);
  });

  it("refuses a value moved to another row or column", () => {
    const sealed = seal(ring, "1234567FA", CONTEXT);
    expect(() => unseal(ring, sealed, "host_tax_details.tin_encrypted:host-2")).toThrow();
  });

  it("refuses a tampered or truncated value", () => {
    const sealed = seal(ring, "1234567FA", CONTEXT);
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[14] = (raw[14] ?? 0) ^ 1;
    expect(() =>
      unseal(ring, { ...sealed, ciphertext: raw.toString("base64") }, CONTEXT),
    ).toThrow();
    expect(() => unseal(ring, { ...sealed, ciphertext: "AAAA" }, CONTEXT)).toThrow(/truncated/);
  });

  it("refuses a key it does not hold", () => {
    const other = parseTaxKeyring(`k9:${key(9)}`);
    expect(() => unseal(other, seal(ring, "x", CONTEXT), CONTEXT)).toThrow(
      /tax key k1 is not in TAX_ENCRYPTION_KEYS/,
    );
  });

  it("fails clearly if the current key is missing", () => {
    expect(() => seal({ currentId: "gone", keys: new Map() }, "x", CONTEXT)).toThrow(/missing/);
  });
});

describe("key rotation", () => {
  it("reads old values with the old key while writing with the new one", () => {
    const before = parseTaxKeyring(`k1:${key(1)}`);
    const old = seal(before, "QQ123456C", CONTEXT);

    const after = parseTaxKeyring(`k2:${key(2)},k1:${key(1)}`);
    expect(unseal(after, old, CONTEXT)).toBe("QQ123456C");
    const rewritten = seal(after, unseal(after, old, CONTEXT), CONTEXT);
    expect(rewritten.keyId).toBe("k2");

    const retired = parseTaxKeyring(`k2:${key(2)}`);
    expect(unseal(retired, rewritten, CONTEXT)).toBe("QQ123456C");
    expect(() => unseal(retired, old, CONTEXT)).toThrow(/k1/);
  });
});
