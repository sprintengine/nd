import { describe, expect, it } from "vitest";

import { scriptedDb } from "../../test/fake-db.ts";
import { parseTaxKeyring, seal } from "../tax/crypto.ts";
import {
  findTaxDetails,
  rotateTaxEncryptionKeys,
  saveTaxDetails,
  sealContext,
  type TaxDetailsInput,
} from "./tax-details.ts";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const OLD = parseTaxKeyring(`old:${key(1)}`);
const ROTATED = parseTaxKeyring(`new:${key(2)},old:${key(1)}`);

const input: TaxDetailsInput = {
  entityType: "individual",
  legalName: "Aoife Byrne",
  dateOfBirth: "1990-04-12",
  companyName: null,
  companyNumber: null,
  addressLine1: "1 Test Lane",
  addressLine2: null,
  city: "Dublin",
  region: null,
  postalCode: null,
  addressCountry: "IE",
  taxCountry: "IE",
  tin: "1234567T",
  tinMasked: "*****67T",
};

describe("sealContext", () => {
  it("binds a value to its column and host", () => {
    expect(sealContext("tin", "host-1")).toBe("host_tax_details.tin_encrypted:host-1");
    expect(sealContext("date_of_birth", "host-1")).not.toBe(sealContext("date_of_birth", "host-2"));
  });
});

describe("saveTaxDetails", () => {
  it("writes only ciphertext, then marks the host complete, in one transaction", async () => {
    const { db, queries } = scriptedDb();
    await saveTaxDetails(db, OLD, "host-1", input);
    expect(queries[0]?.text).toMatch(/^insert into "host_tax_details".*on conflict/s);
    expect(JSON.stringify(queries[0]?.params)).not.toContain("1234567T");
    expect(JSON.stringify(queries[0]?.params)).not.toContain("1990-04-12");
    expect(queries[0]?.params).toContain("old");
    expect(queries[1]?.text).toContain('update "hosts" set "tax_details_complete"');
  });

  it("stores no date of birth for a business", async () => {
    const { db, queries } = scriptedDb();
    await saveTaxDetails(db, OLD, "host-1", {
      ...input,
      entityType: "business",
      legalName: null,
      dateOfBirth: null,
      companyName: "Byrne Charging Ltd",
      companyNumber: "654321",
    });
    expect(queries[0]?.params).toContain("Byrne Charging Ltd");
  });
});

describe("findTaxDetails", () => {
  it("never selects the encrypted columns", async () => {
    const { db, queries } = scriptedDb();
    await expect(findTaxDetails(db, "host-1")).resolves.toBeUndefined();
    expect(queries[0]?.text).not.toMatch(/tin_encrypted|date_of_birth_encrypted/);
  });
});

describe("rotateTaxEncryptionKeys", () => {
  it("re-encrypts rows on an old key with the current one", async () => {
    const tin = seal(OLD, "1234567T", sealContext("tin", "host-1")).ciphertext;
    const dob = seal(OLD, "1990-04-12", sealContext("date_of_birth", "host-1")).ciphertext;
    const { db, queries } = scriptedDb([
      [["host-1"], ["host-2"], ["host-3"]],
      [["old", tin, dob]],
      [],
      [["old", seal(OLD, "1234567890", sealContext("tin", "host-2")).ciphertext, null]],
      [],
      [], // host-3 was rotated by another run in the meantime
    ]);
    await expect(rotateTaxEncryptionKeys(db, ROTATED)).resolves.toBe(2);
    const updates = queries.filter((query) => query.text.startsWith('update "host_tax_details"'));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.params).toContain("new");
    expect(updates[1]?.params).toContain(null);
  });
});
