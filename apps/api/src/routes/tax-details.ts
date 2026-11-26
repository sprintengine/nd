import {
  checkTin,
  maskTin,
  normalizeCompanyNumber,
  taxCountrySchema,
  taxEntityTypeSchema,
} from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireVerifiedPhone, sessionOf } from "../auth/session.ts";
import { findHost } from "../data/hosts.ts";
import { findTaxDetails, saveTaxDetails, type StoredTaxDetails } from "../data/tax-details.ts";
import type { AppDeps } from "../deps.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 country code");

const addressSchema = z.object({
  line1: text(200),
  line2: text(200).nullish(),
  city: text(100),
  region: text(100).nullish().describe("County, state or region"),
  postalCode: text(20).nullish().describe("Eircode or postcode"),
  country: countryCode,
});

const taxIdentity = {
  address: addressSchema.describe("Primary address"),
  taxCountry: taxCountrySchema.describe("Country of tax residence"),
  tin: text(32).describe(
    "Tax identification number: a PPSN or tax reference for Ireland, a UTR or National Insurance number for the UK",
  ),
};

const putTaxDetailsBody = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("individual"),
      legalName: text(200).describe("Full legal name"),
      dateOfBirth: z.iso.date().describe("YYYY-MM-DD"),
      ...taxIdentity,
    }),
    z.object({
      type: z.literal("business"),
      companyName: text(200).describe("Registered company name"),
      companyNumber: text(20).describe(
        "Companies Registration Office number (IE) or Companies House number (UK)",
      ),
      ...taxIdentity,
    }),
  ])
  .superRefine((body, context) => {
    const tin = checkTin(body.taxCountry, body.tin);
    if (!tin.valid) context.addIssue({ code: "custom", path: ["tin"], message: tin.message });
    if (
      body.type === "business" &&
      normalizeCompanyNumber(body.taxCountry, body.companyNumber) === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["companyNumber"],
        message:
          body.taxCountry === "IE"
            ? "must be a Companies Registration Office number: up to 6 digits"
            : "must be a Companies House number: 8 digits, or 2 letters and 6 digits",
      });
    }
  });

const taxDetailsSchema = z
  .object({
    type: taxEntityTypeSchema,
    legalName: z.string().nullable(),
    dateOfBirthOnFile: z
      .boolean()
      .describe("Whether a date of birth is stored; it is never returned"),
    companyName: z.string().nullable(),
    companyNumber: z.string().nullable(),
    address: z.object({
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      region: z.string().nullable(),
      postalCode: z.string().nullable(),
      country: z.string(),
    }),
    taxCountry: taxCountrySchema,
    tinMasked: z.string().describe("The TIN with all but its last three characters masked"),
    complete: z.boolean().describe("Payouts can be released once this is true"),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "TaxDetails" });

/** Hosts must be adults; anything older than this is a typo. */
const MIN_AGE_YEARS = 18;
const MAX_AGE_YEARS = 120;

function ageOn(dateOfBirth: string, today: Date): number | undefined {
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return undefined;
  let age = today.getUTCFullYear() - year;
  const birthdayPassed =
    today.getUTCMonth() > month - 1 ||
    (today.getUTCMonth() === month - 1 && today.getUTCDate() >= day);
  if (!birthdayPassed) age -= 1;
  return age;
}

function view(row: StoredTaxDetails) {
  return {
    type: row.entityType,
    legalName: row.legalName,
    dateOfBirthOnFile: row.entityType === "individual",
    companyName: row.companyName,
    companyNumber: row.companyNumber,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.addressCountry,
    },
    taxCountry: taxCountrySchema.parse(row.taxCountry),
    tinMasked: row.tinMasked,
    complete: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const notFound = () =>
  new HttpProblem(
    404,
    "tax-details-not-found",
    "No tax details yet",
    "Add them with PUT /hosts/me/tax-details before your first payout.",
  );

export function registerTaxDetailRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database, config, clock } = deps;
  const db = database.db;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const hostOf = async (userId: string) => {
    const host = await findHost(db, userId);
    if (host === undefined) {
      throw new HttpProblem(403, "host-required", "Become a host first", "Call POST /hosts first.");
    }
    return host;
  };

  typed.get(
    "/hosts/me/tax-details",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Your tax details",
        description:
          "The tax details platform reporting needs. The TIN is masked to its last three characters and the date of birth is never returned.",
        tags: ["hosts"],
        response: { 200: taxDetailsSchema, ...problemResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const host = await hostOf(sessionOf(request).userId);
      const row = await findTaxDetails(db, host.id);
      if (row === undefined) throw notFound();
      void reply.header("cache-control", "no-store");
      return view(row);
    },
  );

  typed.put(
    "/hosts/me/tax-details",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Set your tax details",
        description:
          "Stores the legal identity and tax identification number that EU (DAC7) and UK platform reporting need before a host's first payout, and marks the host's tax details complete. The TIN is checked against its country's format (a PPSN with its check letter for Ireland; a 10-digit UTR or a National Insurance number for the UK). The TIN and date of birth are encrypted at rest. Replaces any earlier details.",
        tags: ["hosts"],
        body: putTaxDetailsBody,
        response: { 200: taxDetailsSchema, ...problemResponses(400, 401, 403, 503) },
      },
    },
    async (request, reply) => {
      const host = await hostOf(sessionOf(request).userId);
      const keyring = config.taxKeys;
      if (keyring === undefined) {
        throw new HttpProblem(
          503,
          "tax-details-unavailable",
          "Tax details cannot be saved right now",
          "The server has no encryption key for tax details.",
        );
      }
      const body = request.body;
      if (body.type === "individual") {
        const age = ageOn(body.dateOfBirth, clock.now());
        if (age === undefined || age < MIN_AGE_YEARS || age > MAX_AGE_YEARS) {
          throw new HttpProblem(400, "invalid-request", "The request is not valid", undefined, {
            errors: [
              {
                path: "body.dateOfBirth",
                message: `must be a real date; hosts must be at least ${String(MIN_AGE_YEARS)}`,
              },
            ],
          });
        }
      }
      // The schema has checked both; normalize for storage.
      const tin = checkTin(body.taxCountry, body.tin);
      const normalizedTin = tin.valid ? tin.normalized : body.tin;
      await saveTaxDetails(db, keyring, host.id, {
        entityType: body.type,
        legalName: body.type === "individual" ? body.legalName : null,
        dateOfBirth: body.type === "individual" ? body.dateOfBirth : null,
        companyName: body.type === "business" ? body.companyName : null,
        companyNumber:
          body.type === "business"
            ? (normalizeCompanyNumber(body.taxCountry, body.companyNumber) ?? body.companyNumber)
            : null,
        addressLine1: body.address.line1,
        addressLine2: body.address.line2 ?? null,
        city: body.address.city,
        region: body.address.region ?? null,
        postalCode: body.address.postalCode ?? null,
        addressCountry: body.address.country,
        taxCountry: body.taxCountry,
        tin: normalizedTin,
        tinMasked: maskTin(normalizedTin),
      });
      const row = await findTaxDetails(db, host.id);
      if (row === undefined) throw notFound();
      void reply.header("cache-control", "no-store");
      return view(row);
    },
  );
}
