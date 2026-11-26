import { parseEnv } from "@nd/config";
import { createDb } from "@nd/db";
import { createChargerControlClient } from "@nd/domain";

import { randomIds, systemClock } from "./deps.ts";
import { createPgChargerEvents } from "./events/charger-events.ts";
import { apiEnvSchema, buildApp, configFromEnv, loggerOptions } from "./index.ts";
import { createPgBossRunner } from "./jobs/pg-boss.ts";
import { createDatabaseProbe, registerReadiness } from "./readiness.ts";
import { sendersFromEnv } from "./senders/from-env.ts";
import { closeOnSignal } from "./shutdown.ts";
import { stripePaymentsFrom, unconfiguredStripePayments } from "./stripe/payments.ts";
import { createStripeSdk, stripeConnectFrom, unconfiguredStripeConnect } from "./stripe/stripe.ts";

const env = parseEnv(apiEnvSchema);
const config = configFromEnv(env);
const database = createDb(env.DATABASE_URL);
const probe = createDatabaseProbe(env.DATABASE_URL);
const stripeSdk =
  env.STRIPE_SECRET_KEY === undefined
    ? undefined
    : createStripeSdk(env.STRIPE_SECRET_KEY, env.STRIPE_API_BASE_URL);

const { email, sms } = sendersFromEnv(env);
const app = buildApp({
  config,
  database,
  clock: systemClock,
  ids: randomIds,
  email,
  sms,
  stripe: stripeSdk === undefined ? unconfiguredStripeConnect : stripeConnectFrom(stripeSdk),
  payments: stripeSdk === undefined ? unconfiguredStripePayments : stripePaymentsFrom(stripeSdk),
  // pg-boss in its own schema of the same database; started and stopped with the app.
  jobs: createPgBossRunner({ connectionString: env.DATABASE_URL }),
  chargerControl: createChargerControlClient({
    baseUrl: env.GATEWAY_INTERNAL_URL,
    secret: env.GATEWAY_INTERNAL_SECRET,
  }),
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
