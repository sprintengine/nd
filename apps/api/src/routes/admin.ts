import { refundReasonSchema, refundStatusSchema } from "@nd/domain";
import type { FastifyInstance, onRequestAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { sessionOf } from "../auth/session.ts";
import { findBookingDetail } from "../data/bookings.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import { refundPayment } from "../payments/charges.ts";
import type { Services } from "../services.ts";

const bookingParams = z.object({ id: z.uuid() });

const refundBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("What to refund; the rest of what was paid when omitted (a full refund)"),
  note: z.string().trim().min(1).max(1000).describe("Why, for the record"),
});

const refundResponse = z.object({
  bookingId: z.uuid(),
  amountCents: z.number().int(),
  reason: refundReasonSchema,
  status: refundStatusSchema,
});

/** Route guard: 401 without a session, 403 unless the user is on the admin list. */
function requireAdmin(adminUserIds: readonly string[]): onRequestAsyncHookHandler {
  return (request) => {
    if (request.session === null) {
      return Promise.reject(new HttpProblem(401, "unauthenticated", "Sign in to continue"));
    }
    if (!adminUserIds.includes(request.session.userId)) {
      return Promise.reject(new HttpProblem(403, "admin-only", "Only support staff can do this"));
    }
    return Promise.resolve();
  };
}

export function registerAdminRoutes(
  scope: FastifyInstance,
  services: Services,
  adminUserIds: readonly string[],
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/admin/bookings/:id/refund",
    {
      onRequest: requireAdmin(adminUserIds),
      schema: {
        summary: "Refund a booking",
        description:
          "Support refunds a paid booking in full or in part, for anything the automatic rules do not cover (a session that went partly wrong, a dispute). The host's share and the application fee are reversed in proportion. Never more than what is left to refund (422). Admins only (ADMIN_USER_IDS).",
        tags: ["admin"],
        params: bookingParams,
        body: refundBody,
        response: { 201: refundResponse, ...problemResponses(400, 401, 403, 404, 409, 422) },
      },
    },
    async (request, reply) => {
      const bookingId = request.params.id;
      const detail = await findBookingDetail(services.db, bookingId);
      if (detail === undefined) {
        throw new HttpProblem(404, "booking-not-found", "No such booking");
      }
      const payment = detail.payment;
      if (payment?.status !== "paid") {
        throw new HttpProblem(409, "not-paid", "This booking has not been paid");
      }
      const refund = await refundPayment(services, payment, {
        amountCents: request.body.amountCents ?? payment.amountCents,
        reason: "support",
        issuedById: sessionOf(request).userId,
        note: request.body.note,
      });
      if (refund === undefined) {
        throw new HttpProblem(
          422,
          "refund-too-large",
          "That is more than is left to refund",
          request.body.amountCents === undefined
            ? "Part of this booking has been refunded already; give the amount left."
            : undefined,
        );
      }
      services.log.info(
        { bookingId, amountCents: refund.amountCents, status: refund.status },
        "booking refunded by support",
      );
      void reply.code(201);
      return {
        bookingId,
        amountCents: refund.amountCents,
        reason: refund.reason,
        status: refund.status,
      };
    },
  );
}
