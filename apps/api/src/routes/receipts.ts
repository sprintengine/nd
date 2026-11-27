import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { problemResponses } from "../http/problem.ts";
import type { Services } from "../services.ts";
import { loadReceipt, receiptSchema } from "../settlement/receipt.ts";
import { reviewBooking } from "../settlement/review.ts";

const bookingParams = z.object({ id: z.uuid() });

const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(1000).optional(),
});

const reviewSchema = z
  .object({
    rating: z.number().int(),
    comment: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "Review" });

export function registerReceiptRoutes(app: FastifyInstance, services: Services): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/bookings/:id/receipt",
    {
      onRequest: requireUser,
      schema: {
        summary: "A booking's receipt",
        description:
          "For the driver or the host, once a paid booking has finished or its session has stopped (409 before). The driver paid the booked hours upfront; the receipt shows that price, any refunds, and the session as evidence of what the charger did: start and stop, kWh delivered (meter start to stop), meter readings and power samples. Nothing is billed by energy or by minutes used. The driver sees their card; the host sees the card fee passed on to them and what they keep.",
        tags: ["bookings"],
        params: bookingParams,
        response: { 200: receiptSchema, ...problemResponses(400, 401, 404, 409) },
      },
    },
    (request) => loadReceipt(services, request.params.id, sessionOf(request).userId),
  );

  typed.post(
    "/bookings/:id/review",
    {
      onRequest: requireUser,
      schema: {
        summary: "Rate the host",
        description:
          "The driver rates a completed booking from 1 to 5, with an optional comment, once. The host's listing shows the average.",
        tags: ["bookings"],
        params: bookingParams,
        body: reviewBody,
        response: { 201: reviewSchema, ...problemResponses(400, 401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      const review = await reviewBooking(services, sessionOf(request).userId, request.params.id, {
        rating: request.body.rating,
        comment: request.body.comment ?? null,
      });
      void reply.code(201);
      return review;
    },
  );
}
