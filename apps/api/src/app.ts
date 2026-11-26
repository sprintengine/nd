import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { type Auth, createAuth } from "./auth/auth.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { registerSession } from "./auth/session.ts";
import { BOOKING_JOBS } from "./bookings/jobs.ts";
import { COMPLIANCE_JOBS } from "./compliance/jobs.ts";
import type { AppDeps } from "./deps.ts";
import { HttpProblem, registerProblemHandlers } from "./http/problem.ts";
import { registerAccountDeletionRoutes } from "./routes/account-deletion.ts";
import { registerBookingRoutes } from "./routes/bookings.ts";
import { registerChargerRoutes } from "./routes/chargers.ts";
import { registerHostRoutes } from "./routes/hosts.ts";
import { registerMeRoutes } from "./routes/me.ts";
import { registerPaymentMethodRoutes } from "./routes/payment-methods.ts";
import { registerTaxDetailRoutes } from "./routes/tax-details.ts";
import { registerStripeWebhook } from "./routes/webhooks.ts";
import type { Services } from "./services.ts";

declare module "fastify" {
  interface FastifyInstance {
    /** The Better Auth instance behind /auth/* and the session hook. */
    auth: Auth;
  }
}

/** Paths pino replaces with `[redacted]` in every log line. */
export const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-nd-client-ip"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.secret",
  "*.token",
  "*.ocppAuthHash",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
  "*.tin",
  "*.dateOfBirth",
];

/** A client may send its own request id if it is short and plain; otherwise one is made. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Logger settings: JSON to stdout with secrets redacted. */
export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return { level, redact: { paths: REDACTED_LOG_PATHS, censor: "[redacted]" } };
}

/**
 * Builds the API without binding a port, so tests can inject requests.
 * Every outside dependency comes in through `deps`.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, ids } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    // Trust exactly the configured number of proxies in front of the API.
    trustProxy: (_address, hop) => hop < config.trustProxyHops,
    requestIdHeader: false,
    genReqId: (request) => {
      const sent = request.headers["x-request-id"];
      return typeof sent === "string" && REQUEST_ID.test(sent) ? sent : ids.newId();
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemHandlers(app);

  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  void app.register(helmet, { global: true });
  void app.register(cors, {
    origin: [...config.corsOrigins],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["x-request-id", "retry-after"],
  });
  void app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new HttpProblem(
        429,
        "rate-limited",
        "Too many requests",
        `Try again in ${String(Math.ceil(context.ttl / 1000))} seconds.`,
      ),
  });
  void app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "nd API",
        version: "0.1.0",
        description:
          "Peer-to-peer home EV charger sharing. Authentication routes under /auth/* are served by Better Auth and are not listed here. Errors are application/problem+json.",
        license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  const auth = createAuth({
    config,
    db: deps.database.db,
    ids,
    email: deps.email,
    sms: deps.sms,
  });

  app.decorate("auth", auth);

  const services: Services = {
    db: deps.database.db,
    clock: deps.clock,
    payments: deps.payments,
    jobs: deps.jobs,
    platformFeeBps: config.platformFeeBps,
    log: app.log,
  };

  void app.register((scope, _options, done) => {
    registerAuthRoutes(scope, auth, config.publicApiUrl);
    registerSession(scope, auth);
    scope.get("/healthz", { schema: { hide: true } }, () => ({ status: "ok" }));
    scope.get("/openapi.json", { schema: { hide: true } }, () => scope.swagger());
    registerMeRoutes(scope, deps);
    registerAccountDeletionRoutes(scope, deps);
    registerChargerRoutes(scope, deps);
    registerHostRoutes(scope, deps);
    registerBookingRoutes(scope, services);
    registerPaymentMethodRoutes(scope, services);
    registerStripeWebhook(scope, services, config.stripeWebhookSecret);
    registerTaxDetailRoutes(scope, deps);
    done();
  });

  // Jobs run in this process: they start once the app is ready and stop,
  // letting running jobs finish, when it closes.
  app.addHook("onReady", async () => {
    await deps.jobs.start([...BOOKING_JOBS, ...COMPLIANCE_JOBS], services, app.log);
  });
  app.addHook("onClose", async () => {
    await deps.jobs.stop();
    await deps.chargerEvents.close();
  });
  return app;
}
