import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { HttpProblem, problemResponses } from "../http/problem.ts";
import { handleStripeEvent, verifyStripeEvent } from "../payments/webhooks.ts";
import type { Services } from "../services.ts";

const webhookResponse = z.object({
  received: z.literal(true),
  outcome: z.enum(["processed", "duplicate", "ignored"]),
});

/**
 * POST /webhooks/stripe. Registered in its own scope so that JSON bodies
 * stay raw bytes here: the signature is over the exact body Stripe sent.
 */
export function registerStripeWebhook(
  app: FastifyInstance,
  services: Services,
  secret: string | undefined,
): void {
  void app.register((scope, _options, done) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, next) => {
        next(null, body);
      },
    );
    scope.withTypeProvider<ZodTypeProvider>().post(
      "/webhooks/stripe",
      {
        schema: {
          summary: "Stripe webhook events",
          description:
            "Verified against the Stripe-Signature header and processed once per event id; a redelivered event is acknowledged without repeating its effects.",
          tags: ["webhooks"],
          response: { 200: webhookResponse, ...problemResponses(400, 503) },
        },
      },
      async (request) => {
        if (secret === undefined) {
          throw new HttpProblem(503, "webhooks-unavailable", "Webhooks are not configured");
        }
        const signature = request.headers["stripe-signature"];
        if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
          throw new HttpProblem(400, "invalid-signature", "The webhook signature is missing");
        }
        let event;
        try {
          event = verifyStripeEvent(request.body, signature, secret);
        } catch {
          throw new HttpProblem(400, "invalid-signature", "The webhook signature is not valid");
        }
        const outcome = await handleStripeEvent(services, event);
        request.log.info({ eventId: event.id, eventType: event.type, outcome }, "stripe webhook");
        return { received: true as const, outcome };
      },
    );
    done();
  });
}
