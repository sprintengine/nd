import type { ChargerControl } from "../src/charger-control.ts";
import type { ChargerEvents, ChargerListener } from "../src/events/charger-events.ts";
import type { EmailMessage, EmailSender, SmsMessage, SmsSender } from "../src/senders/senders.ts";
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
        listener({ kind: "event", chargerId, type: "boot" });
      }
    },
    subscribers: (chargerId: string) => listeners.get(chargerId)?.size ?? 0,
    isClosed: () => closed,
  };
}

export const rejectingChargerControl: ChargerControl = {
  remoteStart: () => Promise.reject(new Error("not used")),
  remoteStop: () => Promise.reject(new Error("not used")),
  triggerMessage: () => Promise.reject(new Error("not used")),
};
