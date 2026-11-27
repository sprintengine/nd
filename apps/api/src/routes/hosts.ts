import { type Executor, hashChargerSecret } from "@nd/db";
import {
  chargerStatusSchema,
  chargeSplit,
  connectorTypeSchema,
  currencyForCountry,
  currencySchema,
  type FeeSettings,
  hostCountrySchema,
  hostPayoutStatusSchema,
} from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireVerifiedPhone, sessionOf } from "../auth/session.ts";
import { isTimeZone } from "../chargers/slots.ts";
import {
  chargersWithSerial,
  ensureHost,
  findHost,
  findHostChargerView,
  findOwnedCharger,
  insertCharger,
  inTransaction,
  replaceRules,
  rulesOf,
  saveStripeAccount,
  setAcceptingBookings,
  updateChargerDetails,
  updateHostSettings,
  updateRuleTerms,
} from "../data/hosts.ts";
import type { AppDeps } from "../deps.ts";
import { waitForCharger } from "../events/charger-events.ts";
import {
  CHARGER_MODELS,
  eligibilityProblem,
  firmwareAtLeast,
  MIN_FIRMWARE,
  newChargeboxId,
  newChargerSecret,
  publishBlockers,
  storedModel,
} from "../hosts/rules.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)")
  .describe("Local time of day, HH:MM");

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createHostBody = z
  .object({
    country: hostCountrySchema
      .default("IE")
      .describe(
        "Country of the host's payouts account, fixed when it is created. Listings are priced in its currency: EUR for IE, GBP for GB",
      ),
  })
  .nullish();

const createHostResponse = z
  .object({
    hostId: z.uuid(),
    payoutStatus: hostPayoutStatusSchema,
    onboardingUrl: z.url().describe("Stripe-hosted payouts onboarding; single use"),
    onboardingUrlExpiresAt: z.iso.datetime(),
  })
  .meta({ id: "HostOnboardingLink" });

const createChargerBody = z.object({
  serial: z.string().regex(/^\d{8}$/, "must be the 8-digit serial number"),
  model: z.enum(CHARGER_MODELS).default("zappi"),
  connectorType: connectorTypeSchema,
  maxKw: z.number().positive().max(22).default(7.4),
  address: z.string().trim().min(1).max(300),
  location: latLngSchema.describe("Exact position; shown to drivers only once booked"),
  timezone: z.string().refine(isTimeZone, "must be an IANA time zone").default("Europe/Dublin"),
});

const createChargerResponse = z
  .object({
    chargerId: z.uuid(),
    chargeboxId: z.string().describe("Enter as the ChargeboxID in the charger's OCPP settings"),
    wssUrl: z.string().describe("OCPP server URL to enter; ends in a slash"),
    secret: z
      .string()
      .describe("OCPP password. Shown only in this response; it cannot be retrieved again"),
  })
  .meta({ id: "ChargerCredentials" });

const onboardingQuery = z.object({
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Seconds to wait for the charger to connect (capped by the server)"),
});

const onboardingResponse = z
  .object({
    chargerId: z.uuid(),
    status: chargerStatusSchema,
    connected: z.boolean().describe("The charger has sent its first BootNotification"),
    firmware: z.string().nullable(),
    firmwareSupported: z.boolean().nullable(),
    maxKw: z.number(),
    notice: z.string().nullable(),
  })
  .meta({ id: "ChargerOnboarding" });

const availabilityWindow = z
  .object({ weekday: z.number().int().min(1).max(7), start: timeOfDay, end: timeOfDay })
  .refine((window) => window.start !== window.end, "start and end must differ")
  .describe("A weekly window; one ending at or before its start runs past midnight")
  .meta({ id: "AvailabilityWindow" });

const patchChargerBody = z
  .object({
    pricePerHourCents: z.number().int().min(0).max(100_000).optional(),
    kwhCap: z.number().positive().max(200).nullable().optional(),
    instantBook: z.boolean().optional(),
    availability: z.array(availabilityWindow).max(28).optional().describe("Replaces every window"),
    maxSessionsPerDay: z.number().int().min(1).max(10).optional().describe("Applies to the host"),
    nightRateWindow: z
      .object({ start: timeOfDay, end: timeOfDay })
      .nullable()
      .optional()
      .describe("The host's cheap electricity window"),
    acceptingBookings: z.boolean().optional().describe("Publish or unpublish the listing"),
  })
  .strict();

const blockerSchema = z.object({ code: z.string(), message: z.string() });

const hostChargerSchema = z
  .object({
    id: z.uuid(),
    chargeboxId: z.string(),
    serial: z.string(),
    model: z.string(),
    status: chargerStatusSchema,
    firmware: z.string().nullable(),
    maxKw: z.number(),
    connectorType: connectorTypeSchema,
    address: z.string(),
    location: latLngSchema,
    timezone: z.string(),
    acceptingBookings: z.boolean(),
    pricePerHourCents: z.number().int().nullable(),
    netPerHourCents: z
      .number()
      .int()
      .nullable()
      .describe(
        "What the host receives for an hour's booking after the card fee passed on to them (and any platform fee); longer bookings spread the card fee's fixed part",
      ),
    currency: currencySchema,
    kwhCap: z.number().nullable(),
    instantBook: z.boolean(),
    availability: z.array(
      z.object({ weekday: z.number().int(), start: z.string(), end: z.string() }),
    ),
    maxSessionsPerDay: z.number().int(),
    nightRateWindow: z.object({ start: z.string(), end: z.string() }).nullable(),
    publishBlockers: z.array(blockerSchema).describe("Unmet conditions for publishing"),
  })
  .meta({ id: "HostCharger" });

const chargerParams = z.object({ id: z.uuid() });

const hhmm = (time: string) => time.slice(0, 5);

const chargerNotFound = () => new HttpProblem(404, "charger-not-found", "No such charger");

async function hostOf(db: Executor, userId: string) {
  const host = await findHost(db, userId);
  if (host === undefined) {
    throw new HttpProblem(403, "host-required", "Become a host first", "Call POST /hosts first.");
  }
  return host;
}

/** The charger, if the user's host owns it; otherwise 404, so others cannot probe ids. */
async function ownedCharger(db: Executor, userId: string, chargerId: string, lock = false) {
  const charger = await findOwnedCharger(db, userId, chargerId, { lock });
  if (charger === undefined) throw chargerNotFound();
  return charger;
}

async function hostChargerView(db: Executor, chargerId: string, fees: FeeSettings) {
  const [row, rules] = await Promise.all([
    findHostChargerView(db, chargerId),
    rulesOf(db, chargerId),
  ]);
  if (row === undefined) throw chargerNotFound();
  const first = rules[0];
  return {
    id: row.id,
    chargeboxId: row.chargeboxId,
    serial: row.serial,
    model: row.model,
    status: row.status,
    firmware: row.firmware,
    maxKw: row.maxKw,
    connectorType: row.connectorType,
    address: row.address,
    location: row.location,
    timezone: row.timezone,
    acceptingBookings: row.acceptingBookings,
    pricePerHourCents: first?.pricePerHourCents ?? null,
    netPerHourCents:
      first === undefined ? null : chargeSplit(first.pricePerHourCents, fees).hostNetCents,
    currency: first?.currency ?? row.currency,
    kwhCap: first?.kwhCap ?? null,
    instantBook: first?.instantBook ?? false,
    availability: rules.map((rule) => ({
      weekday: rule.weekday,
      start: hhmm(rule.startTime),
      end: hhmm(rule.endTime),
    })),
    maxSessionsPerDay: row.maxSessionsPerDay,
    nightRateWindow:
      row.nightRateStart === null || row.nightRateEnd === null
        ? null
        : { start: hhmm(row.nightRateStart), end: hhmm(row.nightRateEnd) },
    publishBlockers: publishBlockers({
      status: row.status,
      firmware: row.firmware,
      payoutStatus: row.payoutStatus,
      taxDetailsComplete: row.taxDetailsComplete,
      availabilityCount: rules.length,
    }),
  };
}

export function registerHostRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database, stripe, config } = deps;
  const db = database.db;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/hosts",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Become a host",
        description:
          "Creates the host profile (once) and a Stripe Express account for payouts, and returns a fresh link to Stripe's onboarding.",
        tags: ["hosts"],
        body: createHostBody,
        response: { 200: createHostResponse, ...problemResponses(400, 401, 403, 503) },
      },
    },
    async (request) => {
      const { userId, email } = sessionOf(request);
      const host = await ensureHost(db, userId);
      let accountId = host.stripeAccountId;
      let payoutStatus = host.payoutStatus;
      if (accountId === null) {
        const country = request.body?.country ?? "IE";
        const account = await stripe.createExpressAccount({ hostId: host.id, email, country });
        accountId = account.id;
        if (payoutStatus === "not_started") payoutStatus = "pending";
        await inTransaction(db, (tx) =>
          saveStripeAccount(tx, host.id, {
            stripeAccountId: account.id,
            payoutStatus,
            currency: currencyForCountry(country),
          }),
        );
      }
      const link = await stripe.createAccountLink({
        accountId,
        refreshUrl: `${config.publicAppUrl}/host/payouts?stripe=refresh`,
        returnUrl: `${config.publicAppUrl}/host/payouts?stripe=return`,
      });
      return {
        hostId: host.id,
        payoutStatus,
        onboardingUrl: link.url,
        onboardingUrlExpiresAt: link.expiresAt.toISOString(),
      };
    },
  );

  typed.post(
    "/hosts/chargers",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Start connecting a charger",
        description:
          "Checks the charger can connect (Zappi v2.1, serial starting with 2, or Zappi GLO) and returns the OCPP URL, ChargeboxID and password to enter in the charger's account. The password is shown once and stored only as an argon2 hash. Asking again for a charger still connecting replaces its password.",
        tags: ["hosts"],
        body: createChargerBody,
        response: {
          201: createChargerResponse,
          ...problemResponses(400, 401, 403, 409, 422),
        },
      },
    },
    async (request, reply) => {
      const { userId } = sessionOf(request);
      const host = await hostOf(db, userId);
      const body = request.body;
      const problem = eligibilityProblem(body.serial, body.model);
      if (problem !== undefined) {
        throw new HttpProblem(422, "charger-not-eligible", "This charger cannot connect", problem);
      }
      const existing = await chargersWithSerial(db, body.serial);
      if (existing.some((charger) => charger.hostId !== host.id)) {
        throw new HttpProblem(
          409,
          "charger-registered",
          "This charger is registered to another account",
          "Ask the other account holder to remove it, or contact support.",
        );
      }
      const mine = existing.find((charger) => charger.hostId === host.id);
      if (mine !== undefined && mine.status !== "onboarding") {
        throw new HttpProblem(409, "charger-connected", "This charger is already connected");
      }
      const secret = newChargerSecret();
      const details = {
        model: storedModel(body.model),
        connectorType: body.connectorType,
        maxKw: body.maxKw,
        address: body.address,
        location: body.location,
        timezone: body.timezone,
        ocppAuthHash: await hashChargerSecret(secret),
      };
      let chargerId: string;
      let chargeboxId: string;
      if (mine === undefined) {
        chargeboxId = newChargeboxId();
        chargerId = await insertCharger(db, {
          hostId: host.id,
          serial: body.serial,
          chargeboxId,
          ...details,
        });
      } else {
        await updateChargerDetails(db, mine.id, details);
        chargerId = mine.id;
        chargeboxId = mine.chargeboxId;
      }
      void reply.header("cache-control", "no-store").code(201);
      return { chargerId, chargeboxId, wssUrl: config.ocppWssUrl, secret };
    },
  );

  typed.get(
    "/hosts/chargers/:id/onboarding",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Wait for a charger to connect",
        description:
          "Long-polls until the charger sends its first BootNotification, or `wait` seconds pass (capped by the server), then returns its state. Poll again while `connected` is false.",
        tags: ["hosts"],
        params: chargerParams,
        querystring: onboardingQuery,
        response: { 200: onboardingResponse, ...problemResponses(400, 401, 403, 404) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const chargerId = request.params.id;
      const read = () => ownedCharger(db, userId, chargerId);
      let charger = await read();
      const waitSeconds = Math.min(
        request.query.wait ?? config.onboardingWaitMaxSeconds,
        config.onboardingWaitMaxSeconds,
      );
      if (charger.status === "onboarding" && waitSeconds > 0) {
        const abort = new AbortController();
        request.raw.once("close", () => {
          abort.abort();
        });
        charger =
          (await waitForCharger(
            deps.chargerEvents,
            chargerId,
            async () => {
              const current = await read();
              return current.status === "onboarding" ? undefined : current;
            },
            { timeoutMs: waitSeconds * 1000, abort: abort.signal },
          )) ?? charger;
      }
      const connected = charger.status !== "onboarding";
      const firmwareSupported = connected ? firmwareAtLeast(charger.firmware) : null;
      return {
        chargerId,
        status: charger.status,
        connected,
        firmware: charger.firmware,
        firmwareSupported,
        maxKw: charger.maxKw,
        notice:
          firmwareSupported === false
            ? `Connected, but the firmware is too old to list. Update it to ${MIN_FIRMWARE} or later.`
            : null,
      };
    },
  );

  typed.patch(
    "/hosts/chargers/:id",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Set a charger's price, availability and listing",
        description:
          "Changes only the fields sent. `availability` replaces every window; price, kWh cap and instant book apply to every window. Publishing (`acceptingBookings: true`) needs the charger online on firmware 5.794 or later, payouts enabled, tax details given and at least one window, otherwise 409 lists what is missing.",
        tags: ["hosts"],
        params: chargerParams,
        body: patchChargerBody,
        response: { 200: hostChargerSchema, ...problemResponses(400, 401, 403, 404, 409, 422) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const chargerId = request.params.id;
      const patch = request.body;
      await inTransaction(db, async (tx) => {
        const charger = await ownedCharger(tx, userId, chargerId, true);
        const rules = await rulesOf(tx, chargerId);
        const current = rules[0];

        let availabilityCount = rules.length;
        if (patch.availability !== undefined) {
          const price = patch.pricePerHourCents ?? current?.pricePerHourCents;
          if (price === undefined && patch.availability.length > 0) {
            throw new HttpProblem(
              422,
              "price-required",
              "Set a price",
              "Send pricePerHourCents with the first availability windows.",
            );
          }
          const kwhCap = patch.kwhCap === undefined ? (current?.kwhCap ?? null) : patch.kwhCap;
          const instantBook = patch.instantBook ?? current?.instantBook ?? false;
          await replaceRules(
            tx,
            chargerId,
            charger.currency,
            patch.availability.map((window) => ({
              weekday: window.weekday,
              startTime: window.start,
              endTime: window.end,
              pricePerHourCents: price ?? 0,
              kwhCap,
              instantBook,
            })),
          );
          availabilityCount = patch.availability.length;
        } else {
          const terms = {
            ...(patch.pricePerHourCents === undefined
              ? {}
              : { pricePerHourCents: patch.pricePerHourCents }),
            ...(patch.kwhCap === undefined ? {} : { kwhCap: patch.kwhCap }),
            ...(patch.instantBook === undefined ? {} : { instantBook: patch.instantBook }),
          };
          if (Object.keys(terms).length > 0 && rules.length > 0) {
            await updateRuleTerms(tx, chargerId, terms);
          }
        }

        const accepting = patch.acceptingBookings ?? charger.acceptingBookings;
        if (accepting && (patch.acceptingBookings === true || patch.availability !== undefined)) {
          const blockers = publishBlockers({
            status: charger.status,
            firmware: charger.firmware,
            payoutStatus: charger.payoutStatus,
            taxDetailsComplete: charger.taxDetailsComplete,
            availabilityCount,
          });
          if (blockers.length > 0) {
            throw new HttpProblem(
              409,
              "cannot-publish",
              "This charger cannot be listed yet",
              blockers.map((blocker) => blocker.message).join(" "),
              { reasons: blockers },
            );
          }
        }
        if (patch.acceptingBookings !== undefined) {
          await setAcceptingBookings(tx, chargerId, patch.acceptingBookings);
        }

        const settings = {
          ...(patch.maxSessionsPerDay === undefined
            ? {}
            : { maxSessionsPerDay: patch.maxSessionsPerDay }),
          ...(patch.nightRateWindow === undefined
            ? {}
            : {
                nightRateStart: patch.nightRateWindow?.start ?? null,
                nightRateEnd: patch.nightRateWindow?.end ?? null,
              }),
        };
        if (Object.keys(settings).length > 0) {
          await updateHostSettings(tx, charger.hostId, settings);
        }
      });
      return hostChargerView(db, chargerId, config.fees);
    },
  );
}
