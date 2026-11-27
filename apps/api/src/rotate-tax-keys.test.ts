import { describe, expect, it, vi } from "vitest";

import { rotateTaxKeys } from "./rotate-tax-keys.ts";

const KEYS = `new:${Buffer.alloc(32, 2).toString("base64")},old:${Buffer.alloc(32, 1).toString("base64")}`;
const DATABASE_URL = "postgres://nd:nd@db:5432/nd";

describe("rotateTaxKeys", () => {
  it("rotates to the first key and logs only a count", async () => {
    const rotate = vi.fn(() => Promise.resolve(3));
    const log = vi.fn();
    await expect(
      rotateTaxKeys({ DATABASE_URL, TAX_ENCRYPTION_KEYS: KEYS }, rotate, log),
    ).resolves.toBe(3);
    expect(rotate).toHaveBeenCalledWith(
      DATABASE_URL,
      expect.objectContaining({ currentId: "new" }),
    );
    expect(log).toHaveBeenCalledWith("re-encrypted tax details of 3 host(s) with key new");
  });

  it("needs the keys and the database", async () => {
    const rotate = vi.fn(() => Promise.resolve(0));
    await expect(rotateTaxKeys({ DATABASE_URL }, rotate, vi.fn())).rejects.toThrow(
      /TAX_ENCRYPTION_KEYS must be set/,
    );
    await expect(
      rotateTaxKeys({ DATABASE_URL, TAX_ENCRYPTION_KEYS: "k1:short" }, rotate, vi.fn()),
    ).rejects.toThrow(/TAX_ENCRYPTION_KEYS entry 1 \(k1\) must be 32 bytes/);
    await expect(rotateTaxKeys({ TAX_ENCRYPTION_KEYS: KEYS }, rotate, vi.fn())).rejects.toThrow(
      /DATABASE_URL/,
    );
    expect(rotate).not.toHaveBeenCalled();
  });

  it("logs to the console by default", async () => {
    await expect(
      rotateTaxKeys({ DATABASE_URL, TAX_ENCRYPTION_KEYS: KEYS }, () => Promise.resolve(0)),
    ).resolves.toBe(0);
  });
});
