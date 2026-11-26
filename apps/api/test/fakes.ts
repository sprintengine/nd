import {
  CHARGER_CONTROL_COMMANDS,
  type ChargerControl,
  type ChargerControlCommand,
  type ChargerControlResponse,
  type ControlResult,
} from "@nd/domain";
import type { z } from "zod";

import type {
  ChargerEvents,
  ChargerListener,
  ChargerSignal,
} from "../src/events/charger-events.ts";
import { type AnyJob, type JobRunner, runAttempt, type SendOptions } from "../src/jobs/jobs.ts";
import type { PushDevice, PushMessage, PushOutcome, PushSender } from "../src/push/push.ts";
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
  const everyCharger = new Set<ChargerListener>();
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
    subscribeAll: (listener) => {
      everyCharger.add(listener);
      return Promise.resolve(() => {
        everyCharger.delete(listener);
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
    /** Delivers a signal to the subscribers of every charger (and of its charger, for events). */
    signal: (signal: ChargerSignal) => {
      const own = signal.kind === "event" ? (listeners.get(signal.event.chargerId) ?? []) : [];
      for (const listener of [...own, ...everyCharger]) listener(signal);
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

type AnyControlResult = ControlResult<ChargerControlResponse<ChargerControlCommand>>;

/** What each command answers unless a test queues something else. */
const ACCEPTED: { [C in ChargerControlCommand]: ChargerControlResponse<C> } = {
  remoteStart: { status: "Accepted" },
  remoteStop: { status: "Accepted" },
  changeConfiguration: { status: "Accepted" },
  getConfiguration: { configurationKey: [] },
  triggerMessage: { status: "Accepted" },
  reset: { status: "Accepted" },
  unlockConnector: { status: "Unlocked" },
};

/**
 * ChargerControl that records every command and answers Accepted, or with
 * the results (or errors, which it throws) a test queues per command.
 */
export function scriptedChargerControl() {
  const calls: { command: ChargerControlCommand; request: unknown }[] = [];
  const queued = new Map<ChargerControlCommand, (AnyControlResult | Error)[]>();
  const control = Object.fromEntries(
    CHARGER_CONTROL_COMMANDS.map((command) => [
      command,
      (request: unknown) => {
        calls.push({ command, request });
        const next = queued.get(command)?.shift() ?? { ok: true, response: ACCEPTED[command] };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    ]),
  ) as unknown as ChargerControl;
  return {
    control,
    calls,
    callsTo: (command: ChargerControlCommand) =>
      calls.filter((call) => call.command === command).map((call) => call.request),
    /** Queues the next answers to `command`. */
    answer<C extends ChargerControlCommand>(
      command: C,
      ...results: (ControlResult<ChargerControlResponse<C>> | Error)[]
    ) {
      const list = queued.get(command) ?? [];
      list.push(...(results as (AnyControlResult | Error)[]));
      queued.set(command, list);
    },
    reset() {
      calls.length = 0;
      queued.clear();
    },
  };
}

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
    /** Names of the jobs the runner was started with. */
    registered: () => [...registry.keys()],
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

/**
 * A push transport that records every push and answers `sent`, or the
 * outcome a test sets for a token (`invalid_token`, a failure).
 */
export function recordingPush() {
  const sent: { device: PushDevice; message: PushMessage }[] = [];
  const outcomes = new Map<string, PushOutcome>();
  const push: PushSender = {
    name: "recording",
    send: (devices, message) =>
      Promise.resolve(
        devices.map((device) => {
          const outcome = outcomes.get(device.token) ?? { status: "sent" };
          if (outcome.status === "sent") sent.push({ device, message });
          return outcome;
        }),
      ),
  };
  return {
    push,
    sent,
    /** What pushes to `token` answer from now on. */
    answer(token: string, outcome: PushOutcome) {
      outcomes.set(token, outcome);
    },
  };
}
