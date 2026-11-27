import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { problemResponses } from "../http/problem.ts";
import { cardsOf, chooseDefaultCard, ensureCustomer } from "../payments/cards.ts";
import type { Services } from "../services.ts";

const setupIntentResponse = z
  .object({
    setupIntentId: z.string(),
    clientSecret: z
      .string()
      .describe("Confirm it with Stripe's SDK in the app; the card never reaches this API"),
  })
  .meta({ id: "CardSetup" });

const cardSchema = z
  .object({
    id: z.string().describe("Stripe payment method id (pm_…)"),
    brand: z.string(),
    last4: z.string(),
    expMonth: z.number().int(),
    expYear: z.number().int(),
    isDefault: z.boolean(),
  })
  .meta({ id: "SavedCard" });

const cardList = z
  .object({ cards: z.array(cardSchema), defaultPaymentMethodId: z.string().nullable() })
  .meta({ id: "SavedCards" });

const defaultBody = z.object({ paymentMethodId: z.string().regex(/^pm_[A-Za-z0-9_]+$/) });

export function registerPaymentMethodRoutes(app: FastifyInstance, services: Services): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const list = async (userId: string) => {
    const { cards, defaultCardId } = await cardsOf(services, userId);
    return {
      cards: cards.map((card) => ({ ...card, isDefault: card.id === defaultCardId })),
      defaultPaymentMethodId: defaultCardId,
    };
  };

  typed.post(
    "/me/payment-methods/setup-intent",
    {
      onRequest: requireUser,
      schema: {
        summary: "Start saving a card",
        description:
          "Creates the driver's Stripe customer on first use and a SetupIntent for an off-session card. The first card saved becomes the default.",
        tags: ["payments"],
        response: { 200: setupIntentResponse, ...problemResponses(401, 503) },
      },
    },
    async (request, reply) => {
      const { userId } = sessionOf(request);
      const customerId = await ensureCustomer(services, userId);
      const intent = await services.payments.createSetupIntent({
        customerId,
        userId,
        idempotencyKey: `setup-intent-${userId}-${request.id}`,
      });
      void reply.header("cache-control", "no-store");
      return { setupIntentId: intent.id, clientSecret: intent.clientSecret };
    },
  );

  typed.get(
    "/me/payment-methods",
    {
      onRequest: requireUser,
      schema: {
        summary: "The driver's saved cards",
        description: "Brand, last four digits and expiry only.",
        tags: ["payments"],
        response: { 200: cardList, ...problemResponses(401, 503) },
      },
    },
    async (request) => list(sessionOf(request).userId),
  );

  typed.post(
    "/me/payment-methods/default",
    {
      onRequest: requireUser,
      schema: {
        summary: "Choose the default card",
        description: "The card bookings use when they do not name one.",
        tags: ["payments"],
        body: defaultBody,
        response: { 200: cardList, ...problemResponses(400, 401, 404, 503) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      await chooseDefaultCard(services, userId, request.body.paymentMethodId);
      return list(userId);
    },
  );
}
