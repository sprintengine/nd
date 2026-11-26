import { port } from "@nd/config";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";

/** Environment the API reads at start-up. */
export const apiEnvSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: port.default(3000),
});

/** Builds the Fastify application without binding a port, so tests can inject requests. */
export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  app.get("/healthz", () => ({ status: "ok" }));
  return app;
}
