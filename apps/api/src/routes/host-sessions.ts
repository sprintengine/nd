import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { problemResponses } from "../http/problem.ts";
import { confirmSession, disputeSession } from "../settlement/confirmation.ts";
import type { SettlementServices } from "../settlement/services.ts";

const sessionParams = z.object({ id: z.uuid() });

const disputeBody = z.object({
  reason: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(2000).optional(),
});

export function registerHostSessionRoutes(
  app: FastifyInstance,
  services: SettlementServices,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/hosts/sessions/:id/confirm",
    {
      onRequest: requireUser,
      schema: {
        summary: "Confirm a session closed without a stop",
        description:
          "When the charger never reported the end of a session, it is closed from the last meter value and waits for the host. Confirming bills the driver now; otherwise they are billed 72 hours after it was closed. 409 unless the session is waiting for the caller's confirmation.",
        tags: ["hosts"],
        params: sessionParams,
        response: {
          202: z.object({ sessionId: z.uuid(), confirmed: z.literal(true) }),
          ...problemResponses(400, 401, 404, 409),
        },
      },
    },
    async (request, reply) => {
      await confirmSession(services, sessionOf(request).userId, request.params.id);
      void reply.code(202);
      return { sessionId: request.params.id, confirmed: true as const };
    },
  );

  typed.post(
    "/hosts/sessions/:id/dispute",
    {
      onRequest: requireUser,
      schema: {
        summary: "Dispute a session closed without a stop",
        description:
          "Instead of confirming, the host disputes the recorded session. Nothing is charged or paid out until support resolves it.",
        tags: ["hosts"],
        params: sessionParams,
        body: disputeBody,
        response: {
          201: z.object({ sessionId: z.uuid(), disputeId: z.uuid() }),
          ...problemResponses(400, 401, 404, 409),
        },
      },
    },
    async (request, reply) => {
      const disputeId = await disputeSession(
        services,
        sessionOf(request).userId,
        request.params.id,
        {
          reason: request.body.reason,
          details: request.body.details ?? null,
        },
      );
      void reply.code(201);
      return { sessionId: request.params.id, disputeId };
    },
  );
}
