import type { FastifyInstance, onRequestAsyncHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { HttpProblem, problemResponses } from "../http/problem.ts";
import { resolveSession } from "../settlement/resolve.ts";
import type { SettlementServices } from "../settlement/services.ts";

const sessionParams = z.object({ id: z.uuid() });

const resolveBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(0)
    .describe("What the driver pays; at most what was authorised. 0 releases the authorisation"),
  note: z.string().trim().min(1).max(1000).optional().describe("Recorded on any open dispute"),
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
  services: SettlementServices,
  adminUserIds: readonly string[],
): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/admin/sessions/:id/resolve",
    {
      onRequest: requireAdmin(adminUserIds),
      schema: {
        summary: "Resolve a session that needs review",
        description:
          "Support decides what the driver pays for a session in review (meter mismatch, missing stop, dispute): the amount is captured, open disputes on the booking are resolved, and the host's transfer is sent or held. Admins only (ADMIN_USER_IDS).",
        tags: ["admin"],
        params: sessionParams,
        body: resolveBody,
        response: {
          200: z.object({ sessionId: z.uuid(), amountCents: z.number().int() }),
          ...problemResponses(400, 401, 403, 404, 409, 422, 502),
        },
      },
    },
    async (request) => {
      await resolveSession(
        services,
        request.params.id,
        request.body.amountCents,
        request.body.note ?? "Resolved by support",
      );
      return { sessionId: request.params.id, amountCents: request.body.amountCents };
    },
  );
}
