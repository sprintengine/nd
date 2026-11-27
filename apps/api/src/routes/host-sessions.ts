import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import { problemResponses } from "../http/problem.ts";
import { emergencyStop } from "../sessions/control.ts";
import type { SessionServices } from "../sessions/services.ts";

const chargerParams = z.object({ id: z.uuid() });

export function registerHostSessionRoutes(app: FastifyInstance, services: SessionServices): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/hosts/chargers/:id/stop",
    {
      onRequest: requireUser,
      schema: {
        summary: "Emergency stop",
        description:
          "The host stops the booking session charging on their charger now (RemoteStopTransaction). The session closes when the charger reports the stop; the booking was paid upfront and is not refunded automatically. 404 for another host's charger, 409 when nothing is charging or the charger rejects the stop, 503 when it does not answer.",
        tags: ["hosts"],
        params: chargerParams,
        response: {
          202: z.object({ chargerId: z.uuid(), bookingId: z.uuid() }),
          ...problemResponses(400, 401, 404, 409, 503),
        },
      },
    },
    async (request, reply) => {
      const stopped = await emergencyStop(services, sessionOf(request).userId, request.params.id);
      void reply.code(202);
      return { chargerId: request.params.id, bookingId: stopped.bookingId };
    },
  );
}
