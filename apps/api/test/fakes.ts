import { CHARGER_CONTROL_COMMANDS, type ChargerControl } from "@nd/domain";
import type { z } from "zod";

import type { ChargerEvents, ChargerListener } from "../src/events/charger-events.ts";
import { type AnyJob, type JobRunner, runAttempt, type SendOptions } from "../src/jobs/jobs.ts";
import type { EmailMessage, EmailSender, SmsMessage, SmsSender } from "../src/senders/senders.ts";
import type { SavedCard, StripePayments } from "../src/stripe/payments.ts";
import type { StripeConnect } from "../src/stripe/stripe.ts";

/** Email and SMS senders that keep every message for the test to read. */
export function outbox() {
  const emails: EmailMessage[] = [];
  const texts: SmsMessage[] = [];
  const email: EmailSender = {
    send: (message) => {
      emails.push(message);
      return Promise.resolve();
    },
  };
  const sms: SmsSender = {
    send: (message) => {
      texts.push(message);
      return Promise.resolve();
    },
  };
  return { emails, texts, email, sms };
}

/** Stripe Connect that records calls and hands out predictable ids. */
export function fakeStripe() {
  const calls: { method: string; input: unknown }[] = [];
  let accounts = 0;
  const stripe: StripeConnect = {
    createExpressAccount: (input) => {
      calls.push({ method: "createExpressAccount", input });
      accounts += 1;
      return Promise.resolve({ id: `acct_test_${String(accounts)}` });
    },
    createAccountLink: (input) => {
      calls.push({ method: "createAccountLink", input });
      return Promise.resolve({
        url: `https://connect.stripe.test/setup/${input.accountId}`,
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      });
    },
  };
  return { stripe, calls };
}

/** Charger events the test triggers by hand. */
export function fakeChargerEvents() {
  const listeners = new Map<string, Set<ChargerListener>>();
  let closed = false;
  const events: ChargerEvents = {
    subscribe: (chargerId, listener) => {
      const set = listeners.get(chargerId) ?? new Set();
      set.add(listener);
      listeners.set(chargerId, set);
      return Promise.resolve(() => {
        set.delete(listener);
      });
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  return {
    events,
    emit: (chargerId: string) => {
      for (const listener of listeners.get(chargerId) ?? []) {
        listener({ kind: "resync" });
      }
    },
    subscribers: (chargerId: string) => listeners.get(chargerId)?.size ?? 0,
    isClosed: () => closed,
  };
}

/** ChargerControl for tests that never send a command: every command rejects. */
export const rejectingChargerControl = Object.fromEntries(
  CHARGER_CONTROL_COMMANDS.map((command) => [
    command,
    () => Promise.reject(new Error(`${command} is not expected in this test`)),
  ]),
) as unknown as ChargerControl;

/** A job sent to the in-memory runner. */
export interface SentJob {
  readonly name: string;
  readonly payload: unknown;
  readonly options: SendOptions;
}

/**
 * Jobs kept in memory: `sent` records every job queued, `drain` runs the
 * queued ones (and any they queue) in order, `runNow` runs one at once.
 */
export function memoryJobs() {
  const sent: SentJob[] = [];
  let pending: SentJob[] = [];
  let registry = new Map<string, AnyJob<unknown>>();
  let context: unknown;
  let started = false;
  let stopped = false;
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

  const runner: JobRunner = {
    start: (jobs, ctx) => {
      registry = new Map(jobs.map((job) => [job.name, job as AnyJob<unknown>]));
      context = ctx;
      started = true;
      return Promise.resolve();
    },
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
    send: <S extends z.ZodType>(
      job: { name: string; payload: S },
      payload: z.input<S>,
      options: SendOptions = {},
    ) => {
      const entry = { name: job.name, payload: job.payload.parse(payload), options };
      sent.push(entry);
      pending.push(entry);
      return Promise.resolve(`job-${String(sent.length)}`);
    },
    drain: async () => {
      let processed = 0;
      let failed = 0;
      while (pending.length > 0) {
        const batch = pending;
        pending = [];
        for (const entry of batch) {
          const job = registry.get(entry.name);
          if (job === undefined) throw new Error(`unknown job ${entry.name}`);
          processed += 1;
          try {
            await runAttempt(
              job,
              entry.payload,
              context,
              { jobId: "memory", retryCount: job.retry.limit },
              quiet,
            );
          } catch {
            failed += 1;
          }
        }
      }
      return { processed, failed };
    },
    runNow: async (job, payload) => {
      await runAttempt(
        job as AnyJob<unknown>,
        payload,
        context,
        { jobId: "now", retryCount: job.retry.limit },
        quiet,
      );
    },
  };
  return {
    runner,
    sent,
    isStarted: () => started,
    isStopped: () => stopped,
    /** Forgets queued jobs without running them. */
    clear: () => {
      pending = [];
      sent.length = 0;
    },
  };
}

/** Payments that record every call; tests set what the next authorisation returns. */
export function fakePayments() {
  const calls: { method: keyof StripePayments; input: unknown }[] = [];
  const cards: SavedCard[] = [
    { id: "pm_card_visa", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
  ];
  const state = {
    defaultCardId: "pm_card_visa" as string | null,
    authorisation: { status: "authorised" } as
      { status: "authorised" } | { status: "failed"; reason: string } | { status: "error" },
    intents: 0,
  };
  const record = (method: keyof StripePayments, input: unknown) => {
    calls.push({ method, input });
  };
  const payments: StripePayments = {
    createCustomer: (input) => {
      record("createCustomer", input);
      return Promise.resolve({ id: `cus_${input.userId}` });
    },
    createSetupIntent: (input) => {
      record("createSetupIntent", input);
      return Promise.resolve({ id: "seti_1", clientSecret: "seti_1_secret_x" });
    },
    listCards: (customerId) => {
      record("listCards", customerId);
      return Promise.resolve({ cards: [...cards], defaultCardId: state.defaultCardId });
    },
    findCard: (customerId, paymentMethodId) => {
      record("findCard", { customerId, paymentMethodId });
      return Promise.resolve(cards.find((card) => card.id === paymentMethodId));
    },
    setDefaultCard: (customerId, paymentMethodId) => {
      record("setDefaultCard", { customerId, paymentMethodId });
      state.defaultCardId = paymentMethodId;
      return Promise.resolve();
    },
    authorise: (input) => {
      record("authorise", input);
      state.intents += 1;
      const outcome = state.authorisation;
      if (outcome.status === "error") return Promise.reject(new Error("network down"));
      if (outcome.status === "failed") {
        return Promise.resolve({
          status: "failed",
          paymentIntentId: `pi_${String(state.intents)}`,
          reason: outcome.reason,
        });
      }
      return Promise.resolve({
        status: "authorised",
        paymentIntentId: `pi_${String(state.intents)}`,
        amountCents: input.amountCents,
      });
    },
    cancelAuthorisation: (input) => {
      record("cancelAuthorisation", input);
      return Promise.resolve();
    },
    capture: (input) => {
      record("capture", input);
      return Promise.resolve({
        chargeId: `ch_${input.paymentIntentId}`,
        amountCents: input.amountCents,
      });
    },
    transfer: (input) => {
      record("transfer", input);
      return Promise.resolve({ id: "tr_1" });
    },
  };
  return {
    payments,
    calls,
    state,
    cards,
    callsTo: (method: keyof StripePayments) => calls.filter((call) => call.method === method),
  };
}
