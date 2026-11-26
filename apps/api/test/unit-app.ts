import { createDb } from "@nd/db";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";

import { buildApp } from "../src/app.ts";
import type { ApiConfig } from "../src/env.ts";
import { testConfig } from "./config.ts";
import {
  fakeChargerEvents,
  fakePayments,
  fakeStripe,
  memoryJobs,
  outbox,
  rejectingChargerControl,
} from "./fakes.ts";

export const USER_ID = "user-aoife";
export const NOW = new Date("2027-01-11T12:00:00Z");
export const SESSION_COOKIE = { cookie: "better-auth.session_token=abc" };

/** The app over a database that never connects; tests mock every query. */
export function startUnitApp(config: Partial<ApiConfig> = {}) {
  const events = fakeChargerEvents();
  const stripe = fakeStripe();
  const mail = outbox();
  const payments = fakePayments();
  const jobs = memoryJobs();
  const app = buildApp({
    config: testConfig(config),
    database: createDb("postgres://nobody@127.0.0.1:1/none"),
    clock: { now: () => NOW },
    ids: { newId: () => "generated-id" },
    email: mail.email,
    sms: mail.sms,
    stripe: stripe.stripe,
    payments: payments.payments,
    jobs: jobs.runner,
    chargerControl: rejectingChargerControl,
    chargerEvents: events.events,
  });
  return { app, events, stripe, mail, payments, jobs };
}

/** Makes every request with a cookie belong to a signed-in user. */
export function signInAs(
  app: FastifyInstance,
  { phoneVerified = true, setCookie }: { phoneVerified?: boolean; setCookie?: string } = {},
): void {
  const headers = new Headers();
  if (setCookie !== undefined) headers.append("set-cookie", setCookie);
  vi.spyOn(app.auth.api, "getSession").mockResolvedValue({
    headers,
    response: {
      user: { id: USER_ID, email: "aoife@example.com", phoneNumberVerified: phoneVerified },
      session: { id: "session-1" },
    },
  } as never);
}
