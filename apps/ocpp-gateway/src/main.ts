import { parseEnv } from "@nd/config";

import { startGateway } from "./app.ts";
import { runtimeEnvSchema } from "./env.ts";
import { gatewayEnvSchema } from "./index.ts";
import { createLogger } from "./logger.ts";
import { closeOnSignal } from "./shutdown.ts";

const env = parseEnv(gatewayEnvSchema);
const runtime = parseEnv(runtimeEnvSchema);
const logger = createLogger({ level: runtime.LOG_LEVEL });

const gateway = await startGateway({
  databaseUrl: runtime.DATABASE_URL,
  host: env.HOST,
  port: env.PORT,
  internal: {
    host: runtime.GATEWAY_INTERNAL_HOST,
    port: runtime.GATEWAY_INTERNAL_PORT,
    secret: runtime.GATEWAY_INTERNAL_SECRET,
  },
  logger,
});

closeOnSignal(() => gateway.close(), {
  log: (message) => {
    logger.info(message);
  },
});

// Log what the sockets are bound to, never fields of the parsed environment,
// which hold secrets.
logger.info(
  { ocpp: gateway.ocppServer.address(), internal: gateway.controlServer.address() },
  "ocpp-gateway listening",
);
