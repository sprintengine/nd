import {
  BOOKING_STATUSES,
  bookingStatusSchema,
  cancelledBySchema,
  currencySchema,
  paymentStatusSchema,
} from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, requireVerifiedPhone, sessionOf } from "../auth/session.ts";
import {
  approveBooking,
  cancelBooking,
  createBooking,
  declineBooking,
} from "../bookings/lifecycle.ts";
import { driverSeesAddress, vehiclePlateSchema } from "../bookings/rules.ts";
import {
  type BookingDetail,
  driverBookingIds,
  findBookingDetail,
  findBookingDetails,
  hostBookingIds,
} from "../data/bookings.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import type { Services } from "../services.ts";

const dateTime = z.iso.datetime({ offset: true }).describe("ISO 8601 date-time with offset");

const createBookingBody = z.object({
  chargerId: z.uuid(),
  from: dateTime.describe("Start of the slot, on a whole minute"),
  to: dateTime.describe("End of the slot (exclusive), on a whole minute"),
  vehiclePlate: vehiclePlateSchema,
  paymentMethodId: z
    .string()
    .regex(/^pm_[A-Za-z0-9_]+$/, "must be a saved card id (pm_…)")
    .optional()
    .describe("A saved card; the default card when omitted"),
});

const latLngSchema = z.object({ lat: z.number(), lng: z.number() });

export const bookingSchema = z
  .object({
    id: z.uuid(),
    chargerId: z.uuid(),
    role: z.enum(["driver", "host"]).describe("How the caller relates to this booking"),
    status: bookingStatusSchema,
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    quotedAmountCents: z.number().int().describe("The most the driver can be charged"),
    pricePerHourCents: z.number().int(),
    currency: currencySchema,
    kwhCap: z.number().nullable(),
    vehiclePlate: z.string().nullable(),
    driverFirstName: z.string().nullable().describe("Shown to the host only"),
    createdAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
    cancelledBy: cancelledBySchema.nullable(),
    cancellationReason: z.string().nullable(),
    feeCents: z.number().int().describe("Cancellation or no-show fee charged"),
    payment: z
      .object({
        status: paymentStatusSchema,
        authorisedCents: z.number().int(),
        capturedCents: z.number().int(),
        authoriseAt: z.iso.datetime().nullable().describe("When a saved card will be authorised"),
      })
      .nullable(),
    addressVisible: z
      .boolean()
      .describe("For the driver, only while the booking is confirmed, arrived or active"),
    address: z.string().nullable(),
    location: latLngSchema.nullable(),
    timezone: z.string().describe("The charger's time zone"),
  })
  .meta({ id: "Booking" });

type BookingView = z.infer<typeof bookingSchema>;

/** A booking as its driver or host sees it. */
export function bookingView(detail: BookingDetail, viewerId: string): BookingView {
  const { booking, charger, host, driver, payment } = detail;
  const role = host.userId === viewerId ? "host" : "driver";
  const addressVisible = role === "host" || driverSeesAddress(booking.status);
  return {
    id: booking.id,
    chargerId: booking.chargerId,
    role,
    status: booking.status,
    start: booking.slot.start.toISOString(),
    end: booking.slot.end.toISOString(),
    quotedAmountCents: booking.quotedAmountCents,
    pricePerHourCents: booking.pricePerHourCents ?? 0,
    currency: booking.currency,
    kwhCap: booking.kwhCap,
    vehiclePlate: booking.vehiclePlate,
    driverFirstName: role === "host" ? (driver.name.trim().split(/\s+/)[0] ?? "") : null,
    createdAt: booking.createdAt.toISOString(),
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    cancelledBy: booking.cancelledBy,
    cancellationReason: booking.cancellationReason,
    feeCents: booking.cancellationFeeCents,
    payment:
      payment === null
        ? null
        : {
            status: payment.status,
            authorisedCents: payment.authorisedCents,
            capturedCents: payment.capturedCents,
            authoriseAt: payment.authoriseAt?.toISOString() ?? null,
          },
    addressVisible,
    address: addressVisible ? charger.address : null,
    location: addressVisible ? charger.location : null,
    timezone: charger.timezone,
  };
}

const bookingParams = z.object({ id: z.uuid() });

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).nullish();

const statusList = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()))
  .pipe(z.array(z.enum(BOOKING_STATUSES)))
  .optional()
  .describe("Comma-separated statuses");

const listQuery = z.object({
  status: statusList,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const hostListQuery = listQuery
  .extend({
    from: dateTime.optional().describe("Only bookings overlapping from … to"),
    to: dateTime.optional(),
  })
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    path: ["to"],
    error: "send both from and to, or neither",
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.to) > Date.parse(query.from),
    { path: ["to"], error: "must be after from" },
  );

const bookingList = z.object({ bookings: z.array(bookingSchema) });

export function registerBookingRoutes(app: FastifyInstance, services: Services): void {
  const { db } = services;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function viewFor(bookingId: string, viewerId: string): Promise<BookingView> {
    const detail = await findBookingDetail(db, bookingId);
    if (
      detail === undefined ||
      (detail.booking.driverId !== viewerId && detail.host.userId !== viewerId)
    ) {
      throw new HttpProblem(404, "booking-not-found", "No such booking");
    }
    return bookingView(detail, viewerId);
  }

  typed.post(
    "/bookings",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Book a slot",
        description:
          "Books a charger for a slot inside one of its availability windows. With instant book the booking is confirmed at once; otherwise it waits for the host. The quote is the slot's minutes at the hourly price, with no fee added. A slot starting within 6 days is authorised on the card now (manual capture); a later one keeps the saved card and is authorised 24 hours before the start. An overlapping slot is 409 and nothing is charged; a declined card is 402.",
        tags: ["bookings"],
        body: createBookingBody,
        response: {
          201: bookingSchema,
          ...problemResponses(400, 401, 402, 403, 404, 409, 422, 502, 503),
        },
      },
    },
    async (request, reply) => {
      const { userId } = sessionOf(request);
      const body = request.body;
      const bookingId = await createBooking(services, {
        driverId: userId,
        chargerId: body.chargerId,
        window: { start: new Date(body.from), end: new Date(body.to) },
        vehiclePlate: body.vehiclePlate,
        paymentMethodId: body.paymentMethodId,
      });
      void reply.code(201);
      return viewFor(bookingId, userId);
    },
  );

  typed.get(
    "/bookings",
    {
      onRequest: requireUser,
      schema: {
        summary: "The driver's bookings",
        description: "Latest slot first.",
        tags: ["bookings"],
        querystring: listQuery,
        response: { 200: bookingList, ...problemResponses(400, 401) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const ids = await driverBookingIds(db, userId, {
        ...(request.query.status === undefined ? {} : { statuses: request.query.status }),
        limit: request.query.limit,
      });
      const details = await findBookingDetails(db, ids);
      return { bookings: details.map((detail) => bookingView(detail, userId)) };
    },
  );

  typed.get(
    "/hosts/bookings",
    {
      onRequest: requireUser,
      schema: {
        summary: "Bookings at the host's chargers",
        description: "Latest slot first; filter by status and by a window the slot overlaps.",
        tags: ["bookings", "hosts"],
        querystring: hostListQuery,
        response: { 200: bookingList, ...problemResponses(400, 401) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const { status, from, to, limit } = request.query;
      const ids = await hostBookingIds(db, userId, {
        ...(status === undefined ? {} : { statuses: status }),
        ...(from === undefined || to === undefined
          ? {}
          : { window: { start: new Date(from), end: new Date(to) } }),
        limit,
      });
      const details = await findBookingDetails(db, ids);
      return { bookings: details.map((detail) => bookingView(detail, userId)) };
    },
  );

  typed.get(
    "/bookings/:id",
    {
      onRequest: requireUser,
      schema: {
        summary: "A booking",
        description:
          "For its driver or the host of its charger; anyone else gets 404. The driver sees the address and exact position only while the booking is confirmed, arrived or active.",
        tags: ["bookings"],
        params: bookingParams,
        response: { 200: bookingSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) => viewFor(request.params.id, sessionOf(request).userId),
  );

  typed.post(
    "/bookings/:id/approve",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Approve a booking request",
        description:
          "The host of the charger confirms a requested booking; its idTag is issued. 409 if the slot has been taken since.",
        tags: ["bookings", "hosts"],
        params: bookingParams,
        response: { 200: bookingSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      await approveBooking(services, userId, request.params.id);
      return viewFor(request.params.id, userId);
    },
  );

  typed.post(
    "/bookings/:id/decline",
    {
      onRequest: requireVerifiedPhone,
      schema: {
        summary: "Decline a booking request",
        description: "The host turns a request down; the card authorisation is released.",
        tags: ["bookings", "hosts"],
        params: bookingParams,
        body: reasonBody,
        response: { 200: bookingSchema, ...problemResponses(400, 401, 403, 404, 409, 503) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      await declineBooking(services, userId, request.params.id, request.body?.reason);
      return viewFor(request.params.id, userId);
    },
  );

  typed.post(
    "/bookings/:id/cancel",
    {
      onRequest: requireUser,
      schema: {
        summary: "Cancel a booking",
        description:
          "The driver or the host cancels a requested or confirmed booking. A driver cancelling a confirmed booking after the host's cutoff (default 2 hours before the start) pays one hour at the hourly price, capped at the quote; otherwise the authorisation is released. Once the driver has arrived a booking can only be stopped (409).",
        tags: ["bookings"],
        params: bookingParams,
        body: reasonBody,
        response: { 200: bookingSchema, ...problemResponses(400, 401, 404, 409, 503) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      await cancelBooking(services, userId, request.params.id, request.body?.reason);
      return viewFor(request.params.id, userId);
    },
  );
}
