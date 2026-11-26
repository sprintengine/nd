import { port } from "@nd/config";
import { dbEnvSchema } from "@nd/db";
import { z } from "zod";

import { LOG_LEVELS } from "./logger.ts";

/**
 * Environment for the gateway's database, internal ChargerControl endpoint
 * and logging. The public OCPP listener's HOST and PORT are in
 * `gatewayEnvSchema`.
 */
export const runtimeEnvSchema = z.object({
  DATABASE_URL: dbEnvSchema.shape.DATABASE_URL,
  /** Interface of the internal endpoint. Loopback unless the deployment opens it to a private network. */
  GATEWAY_INTERNAL_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_INTERNAL_PORT: port.default(9100),
  /** Shared secret the API sends as a bearer token. At least 32 characters. */
  GATEWAY_INTERNAL_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});
