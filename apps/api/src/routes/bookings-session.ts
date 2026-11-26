import { sessionStateSchema } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { findBookingDetail } from "../data/bookings.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import { arrive, contextFor, startCharging, stopCharging } from "../sessions/control.ts";
import type { SessionServices } from "../sessions/services.ts";
import { sessionState } from "../sessions/view.ts";
import { bookingSchema, bookingView } from "./bookings.ts";

// Arrival, remote start and stop, and the live session of a booking.

const bookingParams = z.object({ id: z.uuid() });

const arriveBody = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((body) => (body.lat === undefined) === (body.lng === undefined), {
    path: ["lng"],
    error: "send both lat and lng, or neither",
  })
  .nullish();

const arrivalResponse = z.object({
  booking: bookingSchema,
  arrival: z.object({
    arrivedAt: z.iso.datetime().nullable(),
    distanceM: z
      .int()
      .nullable()
      .describe("How far from the charger the position given on arrival was, in metres"),
    nearCharger: z
      .boolean()
      .nullable()
      .describe("Within 300 m of the charger; recorded, never enforced"),
  }),
});

const startBody = z
  .object({
    startAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Start charging later, inside the slot (for a cheaper night rate). The driver plugs in now and pays from now.",
      ),
  })
  .nullish();

export function registerSessionRoutes(app: FastifyInstance, services: SessionServices): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const currentState = async (userId: string, bookingId: string) =>
    sessionState(await contextFor(services, userId, bookingId), services.clock.now());

  typed.post(
    "/bookings/:id/arrive",
    {
      onRequest: requireUser,
      schema: {
        summary: "Check in at the charger",
        description:
          "The driver says they have arrived, from 15 minutes before the slot starts until it ends: a confirmed booking becomes arrived and the window-end stop is scheduled. A position (lat and lng), when sent, is compared with the charger's; the distance is recorded but never refused. Checking in again changes nothing.",
        tags: ["sessions"],
        params: bookingParams,
        body: arriveBody,
        response: { 200: arrivalResponse, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const body = request.body;
      const position =
        body?.lat === undefined || body.lng === undefined
          ? undefined
          : { lat: body.lat, lng: body.lng };
      const arrival = await arrive(services, userId, request.params.id, position);
      const detail = await findBookingDetail(services.db, request.params.id);
      if (detail === undefined) throw new HttpProblem(404, "booking-not-found", "No such booking");
      return {
        booking: bookingView(detail, userId),
        arrival: {
          arrivedAt: arrival.arrivedAt?.toISOString() ?? null,
          distanceM: arrival.distanceM,
          nearCharger: arrival.nearCharger,
        },
      };
    },
  );

  typed.post(
    "/bookings/:id/start",
    {
      onRequest: requireUser,
      schema: {
        summary: "Start charging",
        description:
          "The driver of an arrived booking starts charging: the charger is sent a remote start with the booking's idTag. The answer is the session: `starting` until the charger reports StartTransaction (then `charging`, pushed as `session:update`), or `failed` with a reason and copy to show, after which starting again retries. A charger that refuses because a stale transaction is open is soft-reset and the start retried once. With `startAt` in the future the session is `scheduled` and the remote start is sent then. Starting while a start is pending or a session runs returns it unchanged.",
        tags: ["sessions"],
        params: bookingParams,
        body: startBody,
        response: {
          200: sessionStateSchema,
          ...problemResponses(400, 401, 403, 404, 409, 422),
        },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const startAt = request.body?.startAt;
      await startCharging(
        services,
        userId,
        request.params.id,
        startAt === undefined ? undefined : new Date(startAt),
      );
      return currentState(userId, request.params.id);
    },
  );

  typed.post(
    "/bookings/:id/stop",
    {
      onRequest: requireUser,
      schema: {
        summary: "Stop charging",
        description:
          "The driver stops charging: a running session is sent a remote stop and stays `charging` until the charger reports StopTransaction, when it becomes `stopped` and the booking `completed`. A start not yet begun is abandoned and a scheduled start cancelled. Stopping again, or with nothing running, returns the session unchanged. 503 when the charger does not answer (unplugging the cable also stops it).",
        tags: ["sessions"],
        params: bookingParams,
        response: {
          200: sessionStateSchema,
          ...problemResponses(400, 401, 403, 404, 409, 503),
        },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      await stopCharging(services, userId, request.params.id);
      return currentState(userId, request.params.id);
    },
  );

  typed.get(
    "/bookings/:id/session",
    {
      onRequest: requireUser,
      schema: {
        summary: "The booking's live session",
        description:
          "Status, energy, power, time and cost so far (rounded up to 5 minutes at the hourly price, capped at the quote) and when the charger last reported, for the booking's driver or host. The same shape is pushed over /ws as `session:update`.",
        tags: ["sessions"],
        params: bookingParams,
        response: { 200: sessionStateSchema, ...problemResponses(400, 401, 404) },
      },
    },
    async (request) => currentState(sessionOf(request).userId, request.params.id),
  );
}
