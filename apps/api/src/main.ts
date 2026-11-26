import { parseEnv } from "@nd/config";
import { createDb } from "@nd/db";

import { unavailableChargerControl } from "./charger-control.ts";
import { randomIds, systemClock } from "./deps.ts";
import { createPgChargerEvents } from "./events/charger-events.ts";
import { apiEnvSchema, buildApp, configFromEnv, loggerOptions } from "./index.ts";
import { createDatabaseProbe, registerReadiness } from "./readiness.ts";
import { consoleEmailSender, consoleSmsSender } from "./senders/senders.ts";
import { closeOnSignal } from "./shutdown.ts";
import { createStripeConnect, unconfiguredStripeConnect } from "./stripe/stripe.ts";

const env = parseEnv(apiEnvSchema);
const config = configFromEnv(env);
const database = createDb(env.DATABASE_URL);
const probe = createDatabaseProbe(env.DATABASE_URL);

// Real email and SMS providers plug in here. Until then, production writes
// only that a message was dropped, never a link or code.
const app = buildApp({
  config,
  database,
  clock: systemClock,
  ids: randomIds,
  email: consoleEmailSender({ redact: config.production }),
  sms: consoleSmsSender({ redact: config.production }),
  stripe:
    env.STRIPE_SECRET_KEY === undefined
      ? unconfiguredStripeConnect
      : createStripeConnect(env.STRIPE_SECRET_KEY, env.STRIPE_API_BASE_URL),
  chargerControl: unavailableChargerControl,
  chargerEvents: createPgChargerEvents(env.DATABASE_URL, (error) => {
    app.log.warn({ err: error }, "charger events connection failed; reconnecting");
  }),
  logger: loggerOptions(env.LOG_LEVEL),
});
registerReadiness(app, probe);

closeOnSignal(
  async () => {
    await app.close();
    await database.close();
    await probe.close();
  },
  {
    log: (message) => {
      app.log.info(message);
    },
  },
);

// Fastify logs the bound address itself; never log fields of the parsed environment.
await app.listen({ host: env.HOST, port: env.PORT });
