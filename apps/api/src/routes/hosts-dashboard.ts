import { bookingStatusSchema, chargerStatusSchema, currencySchema } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import {
  calendarBookings,
  type ChargerCard,
  chargerCards,
  dashboardHost,
  dashboardTotals,
  type HostBookingItem,
  localToday,
  pendingRequests,
  type PeriodTotals,
  tonightsBookings,
} from "../data/dashboard.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import type { Services } from "../services.ts";

/** The longest range the calendar answers, in days. */
export const MAX_CALENDAR_DAYS = 31;
/** The calendar's range when none is asked for, in days from today. */
const DEFAULT_CALENDAR_DAYS = 30;

const DAY_MS = 86_400_000;

const isoDay = z.iso.date().describe("A day in the host's time zone, YYYY-MM-DD");

const periodSchema = z.object({
  start: isoDay.describe("First day of the period in the host's time zone"),
  grossCents: z
    .number()
    .int()
    .describe("What drivers paid for the period's bookings, less refunds"),
  cardFeeCents: z.number().int().describe("The card fees passed on to the host"),
  earningsCents: z.number().int().describe("What the host receives: gross less fees"),
  sessions: z.number().int(),
  kwh: z.number(),
});

const hostBookingSchema = z
  .object({
    id: z.uuid(),
    chargerId: z.uuid(),
    status: bookingStatusSchema,
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    quotedAmountCents: z.number().int(),
    currency: currencySchema,
    driverFirstName: z.string(),
    vehiclePlate: z.string().nullable(),
  })
  .meta({ id: "HostBookingItem" });

/** What the status pill shows, most urgent first. */
const CHARGER_PILLS = ["faulted", "offline", "onboarding", "charging", "locked", "online"] as const;

const chargerCardSchema = z
  .object({
    id: z.uuid(),
    model: z.string(),
    status: chargerStatusSchema,
    pill: z
      .enum(CHARGER_PILLS)
      .describe(
        "faulted, offline or onboarding as the gateway reports; otherwise charging during a session, locked while it waits for an authorised driver, or online",
      ),
    acceptingBookings: z.boolean(),
    lastHeartbeatAt: z.iso.datetime().nullable(),
    nextBooking: z
      .object({
        id: z.uuid(),
        status: bookingStatusSchema,
        start: z.iso.datetime(),
        end: z.iso.datetime(),
      })
      .nullable(),
  })
  .meta({ id: "HostChargerCard" });

const dashboardSchema = z
  .object({
    timezone: z.string(),
    month: periodSchema
      .extend({ currency: currencySchema })
      .describe(
        "This calendar month: the host's share of captured payments (paid out or pending), finished sessions and their kWh",
      ),
    weeks: z
      .array(periodSchema)
      .length(8)
      .describe("The last 8 weeks, Monday to Sunday, oldest first; the last is this week"),
    chargers: z.array(chargerCardSchema),
    tonight: z
      .array(hostBookingSchema)
      .describe("Bookings starting between noon today and noon tomorrow"),
    pendingRequests: z.array(hostBookingSchema).describe("Requests to approve or decline"),
  })
  .meta({ id: "HostDashboard" });

const calendarQuery = z.object({
  from: isoDay.optional().describe("First day; defaults to today"),
  to: isoDay.optional().describe("Last day, inclusive; defaults to 29 days after `from`"),
});

const calendarSchema = z
  .object({
    timezone: z.string(),
    from: isoDay,
    to: isoDay,
    days: z.array(z.object({ date: isoDay, bookings: z.array(hostBookingSchema) })),
  })
  .meta({ id: "HostCalendar" });

const bookingJson = (item: HostBookingItem) => ({
  id: item.id,
  chargerId: item.chargerId,
  status: item.status,
  start: item.start.toISOString(),
  end: item.end.toISOString(),
  quotedAmountCents: item.quotedAmountCents,
  currency: item.currency,
  driverFirstName: item.driverFirstName,
  vehiclePlate: item.vehiclePlate,
});

/** The pill for a charger card. */
export function chargerPill(
  card: Pick<ChargerCard, "status" | "charging" | "locked">,
): (typeof CHARGER_PILLS)[number] {
  if (card.status !== "online") return card.status;
  if (card.charging) return "charging";
  return card.locked ? "locked" : "online";
}

const periodJson = (period: PeriodTotals) => ({ ...period });

/** Days from `from` to `to` inclusive, as `YYYY-MM-DD`; stops one past `limit`. */
export function daysBetween(from: string, to: string, limit = MAX_CALENDAR_DAYS): string[] {
  const days: string[] = [];
  const last = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= last && days.length <= limit; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

const addDays = (day: string, count: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

export function registerHostDashboardRoutes(app: FastifyInstance, services: Services): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = services;

  const hostOf = async (userId: string) => {
    const host = await dashboardHost(db, userId);
    if (host === undefined) {
      throw new HttpProblem(403, "host-required", "Become a host first", "Call POST /hosts first.");
    }
    return host;
  };

  typed.get(
    "/hosts/dashboard",
    {
      onRequest: requireUser,
      schema: {
        summary: "The host's home screen",
        description:
          "This month's earnings, sessions and kWh, an 8-week weekly series, a card per charger (status pill, listing switch, next booking), tonight's bookings and requests waiting for an answer. Periods are in the host's time zone and a booking counts in the period its slot starts in. Each booking is paid upfront as a destination charge to the host's account: a period shows what drivers paid (less refunds), the card fees passed on to the host, and what the host keeps, in the currency the host is paid in.",
        tags: ["hosts"],
        response: { 200: dashboardSchema, ...problemResponses(401, 403) },
      },
    },
    async (request) => {
      const host = await hostOf(sessionOf(request).userId);
      const now = clock.now();
      const [totals, cards, tonight, pending] = await Promise.all([
        dashboardTotals(db, host, now),
        chargerCards(db, host, now),
        tonightsBookings(db, host, now),
        pendingRequests(db, host, now),
      ]);
      return {
        timezone: host.timezone,
        month: { ...periodJson(totals.month), currency: host.currency },
        weeks: totals.weeks.map(periodJson),
        chargers: cards.map((card) => ({
          id: card.id,
          model: card.model,
          status: card.status,
          pill: chargerPill(card),
          acceptingBookings: card.acceptingBookings,
          lastHeartbeatAt: card.lastHeartbeatAt?.toISOString() ?? null,
          nextBooking:
            card.nextBooking === null
              ? null
              : {
                  id: card.nextBooking.id,
                  status: card.nextBooking.status,
                  start: card.nextBooking.start.toISOString(),
                  end: card.nextBooking.end.toISOString(),
                },
        })),
        tonight: tonight.map(bookingJson),
        pendingRequests: pending.map(bookingJson),
      };
    },
  );

  typed.get(
    "/hosts/calendar",
    {
      onRequest: requireUser,
      schema: {
        summary: "The host's bookings by day",
        description: `Every day from \`from\` to \`to\` (inclusive, at most ${String(MAX_CALENDAR_DAYS)} days; by default the next ${String(DEFAULT_CALENDAR_DAYS)} days from today) with the bookings starting on it, in the host's time zone. Cancelled bookings are left out.`,
        tags: ["hosts"],
        querystring: calendarQuery,
        response: { 200: calendarSchema, ...problemResponses(400, 401, 403, 422) },
      },
    },
    async (request) => {
      const host = await hostOf(sessionOf(request).userId);
      const from = request.query.from ?? (await localToday(db, host, clock.now()));
      const to = request.query.to ?? addDays(from, DEFAULT_CALENDAR_DAYS - 1);
      const days = daysBetween(from, to);
      if (days.length === 0 || days.length > MAX_CALENDAR_DAYS) {
        throw new HttpProblem(
          422,
          "invalid-range",
          "This range cannot be shown",
          `\`to\` must be on or after \`from\`, at most ${String(MAX_CALENDAR_DAYS)} days in all.`,
        );
      }
      const bookings = await calendarBookings(db, host, { from, to });
      return {
        timezone: host.timezone,
        from,
        to,
        days: days.map((date) => ({
          date,
          bookings: bookings.filter((booking) => booking.day === date).map(bookingJson),
        })),
      };
    },
  );
}
