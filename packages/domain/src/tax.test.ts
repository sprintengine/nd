import { describe, expect, it } from "vitest";

import {
  checkTin,
  isValidNino,
  isValidPpsn,
  isValidUtr,
  maskTin,
  normalizeCompanyNumber,
  normalizeTaxNumber,
  TAX_COUNTRIES,
  TAX_ENTITY_TYPES,
  taxCountrySchema,
  taxEntityTypeSchema,
} from "./index.ts";

describe("vocabularies", () => {
  it("cover individuals and businesses in Ireland and the UK", () => {
    expect(TAX_ENTITY_TYPES).toEqual(["individual", "business"]);
    expect(TAX_COUNTRIES).toEqual(["IE", "GB"]);
    expect(taxEntityTypeSchema.safeParse("trust").success).toBe(false);
    expect(taxCountrySchema.safeParse("UK").success).toBe(false);
  });
});

describe("normalizeTaxNumber", () => {
  it("uppercases and drops spaces, dots and dashes", () => {
    expect(normalizeTaxNumber(" 123 4567-t.a ")).toBe("1234567TA");
  });
});

describe("isValidPpsn", () => {
  it.each(["1234567T", "1234567FA", "1234567TW", "0000000W", "7654321G"])("accepts %s", (ppsn) => {
    expect(isValidPpsn(ppsn)).toBe(true);
  });

  it.each([
    ["a wrong check letter", "1234567A"],
    ["a wrong check letter with a second letter", "1234567TA"],
    ["too few digits", "123456T"],
    ["too many digits", "12345678T"],
    ["no check letter", "12345678"],
    ["a check letter after W", "1234567X"],
    ["a second letter outside A-I and W", "1234567TZ"],
    ["lowercase", "1234567t"],
  ])("rejects %s", (_reason, ppsn) => {
    expect(isValidPpsn(ppsn)).toBe(false);
  });
});

describe("isValidUtr", () => {
  it("accepts exactly ten digits", () => {
    expect(isValidUtr("1234567890")).toBe(true);
    expect(isValidUtr("123456789")).toBe(false);
    expect(isValidUtr("12345678901")).toBe(false);
    expect(isValidUtr("123456789K")).toBe(false);
  });
});

describe("isValidNino", () => {
  it.each(["AB123456C", "CE123456A", "JG103759A"])("accepts %s", (nino) => {
    expect(isValidNino(nino)).toBe(true);
  });

  it.each([
    ["a D prefix", "DA123456A"],
    ["O as second letter", "AO123456A"],
    ["an unissued prefix", "GB123456A"],
    ["another unissued prefix", "NK123456A"],
    ["a suffix after D", "AB123456E"],
    ["five digits", "AB12345A"],
  ])("rejects %s", (_reason, nino) => {
    expect(isValidNino(nino)).toBe(false);
  });
});

describe("checkTin", () => {
  it("normalizes and accepts an Irish PPSN", () => {
    expect(checkTin("IE", "1234567 fa")).toEqual({
      valid: true,
      normalized: "1234567FA",
      kind: "ppsn",
    });
  });

  it("rejects an Irish number with a wrong check letter", () => {
    const result = checkTin("IE", "1234567A");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toMatch(/check letter/);
  });

  it("does not accept a UK number for Ireland", () => {
    expect(checkTin("IE", "1234567890").valid).toBe(false);
  });

  it("accepts a UTR or a NINO for the UK", () => {
    expect(checkTin("GB", "12345 67890")).toEqual({
      valid: true,
      normalized: "1234567890",
      kind: "utr",
    });
    expect(checkTin("GB", "ab 12 34 56 c")).toEqual({
      valid: true,
      normalized: "AB123456C",
      kind: "nino",
    });
  });

  it("rejects anything else for the UK", () => {
    const result = checkTin("GB", "1234567T");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toMatch(/UTR/);
  });
});

describe("normalizeCompanyNumber", () => {
  it("accepts up to six digits in Ireland", () => {
    expect(normalizeCompanyNumber("IE", "654 321")).toBe("654321");
    expect(normalizeCompanyNumber("IE", "1234567")).toBeUndefined();
  });

  it("accepts Companies House numbers in the UK", () => {
    expect(normalizeCompanyNumber("GB", "01234567")).toBe("01234567");
    expect(normalizeCompanyNumber("GB", "sc123456")).toBe("SC123456");
    expect(normalizeCompanyNumber("GB", "123456")).toBeUndefined();
  });
});

describe("maskTin", () => {
  it("shows only the last three characters", () => {
    expect(maskTin("1234567FA")).toBe("******7FA");
    expect(maskTin("AB123456C")).toBe("******56C");
  });

  it("shows short values as they are", () => {
    expect(maskTin("12")).toBe("12");
  });
});
