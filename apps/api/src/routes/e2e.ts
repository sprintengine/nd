import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { MessageCapture } from "../senders/capture.ts";

// GET /e2e/messages: what the `capture` senders kept, so a black-box test can
// read a sign-in link or a phone code. Registered only when E2E_TEST_HOOKS is
// true, which the environment schema refuses in production; it is left out of
// the OpenAPI document because no client may rely on it.

const messagesQuery = z.object({
  to: z.string().trim().min(1).max(320).optional().describe("Email address or E.164 number"),
});

const messagesResponse = z.object({
  messages: z.array(
    z.object({
      channel: z.enum(["email", "sms"]),
      to: z.string(),
      subject: z.string().nullable(),
      text: z.string(),
      sentAt: z.iso.datetime(),
    }),
  ),
});

export function registerE2eRoutes(app: FastifyInstance, capture: MessageCapture): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/e2e/messages",
    {
      schema: { hide: true, querystring: messagesQuery, response: { 200: messagesResponse } },
    },
    (request, reply) => {
      void reply.header("cache-control", "no-store");
      return { messages: capture.list(request.query.to) };
    },
  );
}
