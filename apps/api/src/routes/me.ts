import { hostPayoutStatusSchema } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { findUserWithHost } from "../data/users.ts";
import type { AppDeps } from "../deps.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";

export const meSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    phoneVerified: z.boolean().describe("Booking and hosting need a verified phone number"),
    isHost: z.boolean(),
    host: z
      .object({
        id: z.string(),
        payoutStatus: hostPayoutStatusSchema,
        payoutsEnabled: z.boolean(),
      })
      .nullable(),
  })
  .meta({ id: "Me" });

export function registerMeRoutes(app: FastifyInstance, { database }: AppDeps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/me",
    {
      onRequest: requireUser,
      schema: {
        summary: "The signed-in user",
        tags: ["account"],
        response: { 200: meSchema, ...problemResponses(401) },
      },
    },
    async (request) => {
      const { userId } = sessionOf(request);
      const found = await findUserWithHost(database.db, userId);
      if (found === undefined) throw new HttpProblem(401, "unauthenticated", "Sign in to continue");
      const { user, host } = found;
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        phoneNumber: user.phone,
        phoneVerified: user.phoneVerified,
        isHost: host !== null,
        host:
          host === null
            ? null
            : {
                id: host.id,
                payoutStatus: host.payoutStatus,
                payoutsEnabled: host.payoutStatus === "enabled",
              },
      };
    },
  );
}
