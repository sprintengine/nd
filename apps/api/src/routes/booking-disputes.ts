import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { disputeBooking } from "../bookings/dispute.ts";
import { problemResponses } from "../http/problem.ts";
import type { Services } from "../services.ts";

const bookingParams = z.object({ id: z.uuid() });

const disputeBody = z.object({
  reason: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(2000).optional(),
});

export function registerBookingDisputeRoutes(app: FastifyInstance, services: Services): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/bookings/:id/dispute",
    {
      onRequest: requireUser,
      schema: {
        summary: "Dispute a finished booking",
        description:
          "The driver of a completed, cancelled or no-show booking disputes it (the charge, a fee, or the session), for support to look into. One open dispute per booking; 403 for the host, 404 for anyone else, 409 before the booking has finished or while a dispute is open.",
        tags: ["bookings"],
        params: bookingParams,
        body: disputeBody,
        response: {
          201: z.object({ bookingId: z.uuid(), disputeId: z.uuid() }),
          ...problemResponses(400, 401, 403, 404, 409),
        },
      },
    },
    async (request, reply) => {
      const disputeId = await disputeBooking(
        services,
        sessionOf(request).userId,
        request.params.id,
        { reason: request.body.reason, details: request.body.details ?? null },
      );
      void reply.code(201);
      return { bookingId: request.params.id, disputeId };
    },
  );
}
