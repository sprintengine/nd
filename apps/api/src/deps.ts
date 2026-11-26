import type { Database } from "@nd/db";
import type { FastifyServerOptions } from "fastify";

import type { ChargerControl } from "./charger-control.ts";
import type { ApiConfig } from "./env.ts";
import type { ChargerEvents } from "./events/charger-events.ts";
import type { EmailSender, SmsSender } from "./senders/senders.ts";
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
  readonly chargerControl: ChargerControl;
  readonly chargerEvents: ChargerEvents;
  /** Fastify logger settings; `false` (the default) keeps tests quiet. */
  readonly logger?: FastifyServerOptions["logger"];
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = { newId: () => crypto.randomUUID() };
