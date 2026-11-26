import { z } from "zod";

// Tax identity rules for hosts. Platform reporting (EU DAC7 for Irish hosts,
// the UK platform-operator rules for UK hosts) needs a host's legal identity
// and tax identification number (TIN) before the first payout. These checks
// are format checks only: they catch typos, not whether a number is issued.

/** Whether the host reports as a person or as a business. */
export const TAX_ENTITY_TYPES = ["individual", "business"] as const;
export type TaxEntityType = (typeof TAX_ENTITY_TYPES)[number];
export const taxEntityTypeSchema = z.enum(TAX_ENTITY_TYPES);

/** Countries of tax residence the platform reports for (ISO 3166-1 alpha-2). */
export const TAX_COUNTRIES = ["IE", "GB"] as const;
export type TaxCountry = (typeof TAX_COUNTRIES)[number];
export const taxCountrySchema = z.enum(TAX_COUNTRIES);

/** Which kind of number a TIN turned out to be. */
export type TinKind = "ppsn" | "utr" | "nino";

export type TinCheck =
  | { readonly valid: true; readonly normalized: string; readonly kind: TinKind }
  | { readonly valid: false; readonly message: string };

/** Uppercases and drops spaces, dots and dashes people type into numbers. */
export function normalizeTaxNumber(value: string): string {
  return value.toUpperCase().replace(/[\s.-]/g, "");
}

/** Seven digits, a check letter, and an optional second letter (Irish PPSN or tax reference). */
const PPSN = /^(\d{7})([A-W])([A-IW]?)$/;

/**
 * Whether `value` (normalized) is an Irish PPSN or tax reference number with
 * a correct check character. The check character is the weighted sum of the
 * seven digits (weights 8 down to 2), plus 9 times the second letter's
 * position in the alphabet (`W` or none counts as 0), modulo 23, where 0 is
 * `W` and 1 to 22 are `A` to `V`.
 */
export function isValidPpsn(value: string): boolean {
  const match = PPSN.exec(value);
  if (match === null) return false;
  const [, digits = "", check = "", second = ""] = match;
  let sum = 0;
  for (let index = 0; index < 7; index += 1) sum += Number(digits[index]) * (8 - index);
  if (second !== "" && second !== "W") sum += (second.charCodeAt(0) - 64) * 9;
  const remainder = sum % 23;
  const expected = remainder === 0 ? "W" : String.fromCharCode(64 + remainder);
  return check === expected;
}

/** A UK Unique Taxpayer Reference: ten digits. */
export function isValidUtr(value: string): boolean {
  return /^\d{10}$/.test(value);
}

/**
 * A UK National Insurance number: two prefix letters, six digits and a
 * suffix A to D. D, F, I, Q, U and V never appear in the prefix, O never as
 * its second letter, and BG, GB, KN, NK, NT, TN and ZZ are not issued.
 */
export function isValidNino(value: string): boolean {
  return (
    /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(value) &&
    !["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"].includes(value.slice(0, 2))
  );
}

/** Checks a TIN against the formats of its country and returns it normalized. */
export function checkTin(country: TaxCountry, value: string): TinCheck {
  const normalized = normalizeTaxNumber(value);
  if (country === "IE") {
    return isValidPpsn(normalized)
      ? { valid: true, normalized, kind: "ppsn" }
      : {
          valid: false,
          message:
            "must be a PPSN or Irish tax reference: 7 digits and 1 or 2 letters, with a correct check letter",
        };
  }
  if (isValidUtr(normalized)) return { valid: true, normalized, kind: "utr" };
  if (isValidNino(normalized)) return { valid: true, normalized, kind: "nino" };
  return {
    valid: false,
    message: "must be a UTR (10 digits) or a National Insurance number (e.g. AB123456C)",
  };
}

/**
 * Checks a company registration number for its country: up to six digits
 * for the Irish Companies Registration Office, eight characters (eight
 * digits, or two letters and six digits) for Companies House in the UK.
 * Returns the normalized number, or undefined if it does not fit.
 */
export function normalizeCompanyNumber(country: TaxCountry, value: string): string | undefined {
  const normalized = normalizeTaxNumber(value);
  const pattern = country === "IE" ? /^\d{1,6}$/ : /^(\d{8}|[A-Z]{2}\d{6})$/;
  return pattern.test(normalized) ? normalized : undefined;
}

/** How many trailing characters of a TIN may be shown. */
export const TIN_VISIBLE_CHARACTERS = 3;

/** A TIN with everything but its last three characters replaced by `*`. */
export function maskTin(tin: string): string {
  const visible = tin.slice(-TIN_VISIBLE_CHARACTERS);
  return "*".repeat(Math.max(tin.length - visible.length, 0)) + visible;
}
