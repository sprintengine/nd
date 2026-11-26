import type { Database } from "@nd/db";
import type { ChargerControl } from "@nd/domain";
import type { FastifyServerOptions } from "fastify";

import type { ApiConfig } from "./env.ts";
import type { ChargerEvents } from "./events/charger-events.ts";
import type { JobRunner } from "./jobs/jobs.ts";
import type { RealtimeHubOptions } from "./realtime/hub.ts";
import type { EmailSender, SmsSender } from "./senders/senders.ts";
import type { SessionTimings } from "./sessions/services.ts";
import type { StripePayments } from "./stripe/payments.ts";
import type { StripeConnect } from "./stripe/stripe.ts";

/** The current time. Tests pass a fixed clock. */
export interface Clock {
  now(): Date;
}

/** New identifiers for rows the API (and Better Auth) creates. */
export interface IdGenerator {
  newId(): string;
}

/** Everything `buildApp` needs from the outside world. */
export interface AppDeps {
  readonly config: ApiConfig;
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly email: EmailSender;
  readonly sms: SmsSender;
  readonly stripe: StripeConnect;
  /** Driver payments: customers, cards, authorisations, captures and host transfers. */
  readonly payments: StripePayments;
  /** Background jobs (pg-boss in production); started when the app is ready, stopped on close. */
  readonly jobs: JobRunner;
  readonly chargerControl: ChargerControl;
  readonly chargerEvents: ChargerEvents;
  /** How long session control waits for chargers; defaults to the production timings. */
  readonly sessionTimings?: Partial<SessionTimings>;
  /** Realtime connection limits and heartbeat; defaults suit production. */
  readonly realtime?: Partial<Omit<RealtimeHubOptions, "log">>;
  /** Fastify logger settings; `false` (the default) keeps tests quiet. */
  readonly logger?: FastifyServerOptions["logger"];
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = { newId: () => crypto.randomUUID() };
