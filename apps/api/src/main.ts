import { parseEnv } from "@nd/config";

import { apiEnvSchema, buildApp } from "./index.ts";
import { createDatabaseProbe, readinessEnvSchema, registerReadiness } from "./readiness.ts";
import { closeOnSignal } from "./shutdown.ts";

const env = parseEnv(apiEnvSchema);
const { DATABASE_URL } = parseEnv(readinessEnvSchema);
const probe = DATABASE_URL === undefined ? undefined : createDatabaseProbe(DATABASE_URL);

const app = buildApp({ logger: true });
registerReadiness(app, probe);

closeOnSignal(
  async () => {
    await app.close();
    await probe?.close();
  },
  {
    log: (message) => {
      app.log.info(message);
    },
  },
);

// Fastify logs the bound address itself; never log fields of the parsed environment.
await app.listen({ host: env.HOST, port: env.PORT });
