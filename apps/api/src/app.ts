import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
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
import { changedBooking, createRealtimeFeed } from "./realtime/feed.ts";
import { createRealtimeHub, DEFAULT_HUB_OPTIONS } from "./realtime/hub.ts";
import { MAX_CLIENT_FRAME_BYTES, registerRealtimeRoute } from "./realtime/ws.ts";
import { registerAccountDeletionRoutes } from "./routes/account-deletion.ts";
import { registerBookingRoutes } from "./routes/bookings.ts";
import { registerSessionRoutes } from "./routes/bookings-session.ts";
import { registerChargerRoutes } from "./routes/chargers.ts";
import { registerHostRoutes } from "./routes/hosts.ts";
import { registerMeRoutes } from "./routes/me.ts";
import { registerPaymentMethodRoutes } from "./routes/payment-methods.ts";
import { registerTaxDetailRoutes } from "./routes/tax-details.ts";
import { registerStripeWebhook } from "./routes/webhooks.ts";
import type { Services } from "./services.ts";
import { SESSION_JOBS } from "./sessions/jobs.ts";
import { DEFAULT_SESSION_TIMINGS, type SessionServices } from "./sessions/services.ts";

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

  // Realtime: open WebSockets per user, fed by charger events and the API's own changes.
  const hubOptions = { ...DEFAULT_HUB_OPTIONS, ...deps.realtime };
  const hub = createRealtimeHub({ ...hubOptions, log: app.log });
  const feed = createRealtimeFeed({ db: services.db, clock: deps.clock, hub, log: app.log });
  const sessionServices: SessionServices = {
    ...services,
    chargerControl: deps.chargerControl,
    sessionTimings: { ...DEFAULT_SESSION_TIMINGS, ...deps.sessionTimings },
    realtime: feed,
  };
  void app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });

  void app.register((scope, _options, done) => {
    registerAuthRoutes(scope, auth, config.publicApiUrl);
    registerSession(scope, auth);
    scope.get("/healthz", { schema: { hide: true } }, () => ({ status: "ok" }));
    scope.get("/openapi.json", { schema: { hide: true } }, () => scope.swagger());
    registerMeRoutes(scope, deps);
    registerAccountDeletionRoutes(scope, deps);
    registerChargerRoutes(scope, deps);
    registerHostRoutes(scope, deps);
    // Tell connected apps about bookings the booking routes changed.
    scope.addHook("onSend", (request, reply, payload, done) => {
      const bookingId = changedBooking(
        {
          method: request.method,
          url: request.routeOptions.url,
          statusCode: reply.statusCode,
          params: request.params,
        },
        payload,
      );
      if (bookingId !== undefined) feed.bookingChanged(bookingId);
      done(null, payload);
    });
    registerBookingRoutes(scope, services);
    registerSessionRoutes(scope, sessionServices);
    registerRealtimeRoute(scope, {
      hub,
      auth,
      allowedOrigins: config.corsOrigins,
      maxConnectionsPerUser: hubOptions.maxConnectionsPerUser,
      heartbeatSeconds: Math.round(hubOptions.heartbeatMs / 1000),
    });
    registerPaymentMethodRoutes(scope, services);
    registerStripeWebhook(scope, services, config.stripeWebhookSecret);
    registerTaxDetailRoutes(scope, deps);
    done();
  });

  // Jobs run in this process: they start once the app is ready and stop,
  // letting running jobs finish, when it closes.
  let unsubscribe: () => void = () => undefined;
  app.addHook("onReady", async () => {
    await deps.jobs.start(
      [...BOOKING_JOBS, ...COMPLIANCE_JOBS, ...SESSION_JOBS],
      sessionServices,
      app.log,
    );
    unsubscribe = await deps.chargerEvents.subscribeAll((signal) => {
      feed.handle(signal);
    });
  });
  app.addHook("preClose", () => {
    hub.close();
  });
  app.addHook("onClose", async () => {
    unsubscribe();
    await deps.jobs.stop();
    await feed.idle();
    await deps.chargerEvents.close();
  });
  return app;
}
