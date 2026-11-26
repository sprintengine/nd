import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.ts";
import { type Clock, randomIds, systemClock } from "../src/deps.ts";
import type { ApiConfig } from "../src/env.ts";
import { createPgChargerEvents } from "../src/events/charger-events.ts";
import type { JobRunner } from "../src/jobs/jobs.ts";
import { createPgBossRunner } from "../src/jobs/pg-boss.ts";
import { stripePaymentsFrom } from "../src/stripe/payments.ts";
import { testConfig } from "./config.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { fakeStripe, outbox, rejectingChargerControl } from "./fakes.ts";
import { signIn, verifyPhone } from "./http.ts";
import { statefulStripeMock } from "./stripe-mock.ts";

export interface Harness {
  readonly app: FastifyInstance;
  readonly database: TestDatabase;
  readonly mail: ReturnType<typeof outbox>;
  readonly stripe: ReturnType<typeof fakeStripe>;
  /** Driver payments against stripe-mock, with Stripe's state changes applied on top. */
  readonly stripeMock: ReturnType<typeof statefulStripeMock>;
  /** pg-boss on the test database. */
  readonly jobs: JobRunner;
  /** Signs a new user in by magic link, optionally verifying a phone number. */
  user(email: string, phoneNumber?: string): Promise<string>;
  close(): Promise<void>;
}

/** The real app on a fresh, migrated database, with Postgres LISTEN for charger events. */
export async function startHarness(
  options: { config?: Partial<ApiConfig>; clock?: Clock } = {},
): Promise<Harness> {
  const database = await createTestDatabase();
  const mail = outbox();
  const stripe = fakeStripe();
  const stripeMock = statefulStripeMock();
  const jobs = createPgBossRunner({ connectionString: database.url, pollingIntervalSeconds: 60 });
  const app = buildApp({
    config: testConfig(options.config),
    database,
    clock: options.clock ?? systemClock,
    ids: randomIds,
    email: mail.email,
    sms: mail.sms,
    stripe: stripe.stripe,
    payments: stripePaymentsFrom(stripeMock.sdk),
    jobs,
    chargerControl: rejectingChargerControl,
    chargerEvents: createPgChargerEvents(database.url),
  });
  await app.ready();
  return {
    app,
    database,
    mail,
    stripe,
    stripeMock,
    jobs,
    async user(email, phoneNumber) {
      const cookie = await signIn(app, mail.emails, email);
      if (phoneNumber !== undefined) await verifyPhone(app, mail.texts, cookie, phoneNumber);
      return cookie;
    },
    async close() {
      await app.close();
      await database.dispose();
    },
  };
}
