import { approximateLocation, MAX_SEARCH_RADIUS_M, searchChargers } from "@nd/db";
import { connectorTypeSchema, currencySchema } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { freeSlots, SLOT_HORIZON_DAYS } from "../chargers/slots.ts";
import {
  chargerRating,
  chargerRules,
  findListingCharger,
  hasSlotHoldingBooking,
  heldSlots,
  hostRating,
} from "../data/listing.ts";
import type { AppDeps } from "../deps.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Longest window one search may ask for. */
export const MAX_SEARCH_WINDOW_HOURS = 24;

/** Default search radius, in metres. */
export const DEFAULT_SEARCH_RADIUS_M = 5_000;

const latLngSchema = z.object({ lat: z.number(), lng: z.number() }).meta({ id: "LatLng" });

const dateTime = z.iso.datetime({ offset: true }).describe("ISO 8601 date-time with offset");

export const searchQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius: z.coerce
      .number()
      .positive()
      .max(MAX_SEARCH_RADIUS_M)
      .default(DEFAULT_SEARCH_RADIUS_M)
      .describe("Metres around the point"),
    from: dateTime.describe("Start of the wanted slot"),
    to: dateTime.describe("End of the wanted slot (exclusive)"),
  })
  .refine((query) => Date.parse(query.to) > Date.parse(query.from), {
    path: ["to"],
    error: "must be after from",
  })
  .refine(
    (query) => Date.parse(query.to) - Date.parse(query.from) <= MAX_SEARCH_WINDOW_HOURS * HOUR_MS,
    { path: ["to"], error: `the window may be at most ${String(MAX_SEARCH_WINDOW_HOURS)} hours` },
  );

const searchResultSchema = z
  .object({
    id: z.uuid(),
    brand: z.string(),
    model: z.string(),
    connectorType: connectorTypeSchema,
    maxKw: z.number(),
    approximateLocation: latLngSchema.describe("Snapped to a grid of about 150 m; never exact"),
    approximateDistanceM: z.number().describe("Rounded to 100 m"),
    pricePerHourCents: z.number().int(),
    currency: currencySchema,
    kwhCap: z.number().nullable(),
    instantBook: z.boolean(),
    rating: z.number().nullable(),
    reviewCount: z.number().int(),
  })
  .meta({ id: "ChargerSearchResult" });

const slotSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    pricePerHourCents: z.number().int(),
    currency: currencySchema,
    kwhCap: z.number().nullable(),
    instantBook: z.boolean(),
  })
  .meta({ id: "Slot" });

export const listingSchema = z
  .object({
    id: z.uuid(),
    brand: z.string(),
    model: z.string(),
    connectorType: connectorTypeSchema,
    maxKw: z.number(),
    timezone: z.string(),
    approximateLocation: latLngSchema.describe("Snapped to a grid of about 150 m"),
    pricePerHourCents: z.number().int().nullable().describe("Lowest price of any window"),
    currency: currencySchema.nullable(),
    instantBook: z.boolean().describe("Whether any window can be booked without approval"),
    rating: z.number().nullable(),
    reviewCount: z.number().int(),
    host: z.object({
      firstName: z.string(),
      memberSince: z.iso.datetime(),
      rating: z.number().nullable(),
      reviewCount: z.number().int(),
    }),
    slots: z.array(slotSchema).describe("Free slots over the next 7 days"),
    addressVisible: z
      .boolean()
      .describe("True only for a driver with a confirmed, arrived or active booking here"),
    address: z.string().nullable(),
    location: latLngSchema.nullable().describe("Exact position, with the address only"),
  })
  .meta({ id: "ChargerListing" });

export function registerChargerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database, clock, config } = deps;
  const db = database.db;
  const rateLimit = { max: config.searchRateLimitPerMinute, timeWindow: "1 minute" };
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/chargers",
    {
      config: { rateLimit },
      schema: {
        summary: "Search bookable chargers near a point for a window",
        description:
          "Online chargers accepting bookings, with an availability window covering the whole slot and no booking overlapping it, nearest first. Positions are approximate.",
        tags: ["chargers"],
        querystring: searchQuerySchema,
        response: {
          200: z.object({ results: z.array(searchResultSchema) }),
          ...problemResponses(400, 429),
        },
      },
    },
    async (request) => {
      const { lat, lng, radius, from, to } = request.query;
      const window = { start: new Date(from), end: new Date(to) };
      if (window.end.getTime() <= clock.now().getTime()) {
        throw new HttpProblem(400, "window-in-past", "The window has already ended");
      }
      const results = await searchChargers(db, { point: { lat, lng }, radiusM: radius, window });
      return { results };
    },
  );

  typed.get(
    "/chargers/:id",
    {
      config: { rateLimit },
      schema: {
        summary: "A charger's listing",
        description:
          "Listing, host summary, rating and free slots for the next 7 days. The address and exact position are included only for a driver with a confirmed, arrived or active booking at this charger.",
        tags: ["chargers"],
        params: z.object({ id: z.uuid() }),
        response: { 200: listingSchema, ...problemResponses(400, 404, 429) },
      },
    },
    async (request) => {
      const { id } = request.params;
      const now = clock.now();
      const row = await findListingCharger(db, id);
      const viewer = request.session?.userId;
      const hasBooking =
        row !== undefined && viewer !== undefined && (await hasSlotHoldingBooking(db, id, viewer));
      const listed = row?.status === "online" && row.acceptingBookings;
      if (row === undefined || (!listed && !hasBooking)) {
        throw new HttpProblem(404, "charger-not-found", "No such charger");
      }

      const horizon = {
        start: now,
        end: new Date(now.getTime() + SLOT_HORIZON_DAYS * 24 * HOUR_MS),
      };
      const [rules, taken, forCharger, forHost] = await Promise.all([
        chargerRules(db, id),
        listed ? heldSlots(db, id, horizon) : Promise.resolve([]),
        chargerRating(db, id, row.hostUserId),
        hostRating(db, row.hostId, row.hostUserId),
      ]);

      const slots = listed ? freeSlots({ rules, taken, timeZone: row.timezone, now }) : [];
      const cheapest = rules.reduce<(typeof rules)[number] | undefined>(
        (best, rule) =>
          best === undefined || rule.pricePerHourCents < best.pricePerHourCents ? rule : best,
        undefined,
      );

      return {
        id: row.id,
        brand: row.brand,
        model: row.model,
        connectorType: row.connectorType,
        maxKw: row.maxKw,
        timezone: row.timezone,
        approximateLocation: approximateLocation(row.location),
        pricePerHourCents: cheapest?.pricePerHourCents ?? null,
        currency: cheapest?.currency ?? null,
        instantBook: rules.some((rule) => rule.instantBook),
        rating: forCharger.rating,
        reviewCount: forCharger.reviewCount,
        host: {
          firstName: row.hostName.trim().split(/\s+/)[0] ?? "",
          memberSince: row.hostSince.toISOString(),
          rating: forHost.rating,
          reviewCount: forHost.reviewCount,
        },
        slots: slots.map((slot) => ({
          ...slot,
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
        })),
        addressVisible: hasBooking,
        address: hasBooking ? row.address : null,
        location: hasBooking ? row.location : null,
      };
    },
  );
}
