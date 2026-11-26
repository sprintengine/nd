import Stripe from "stripe";

import type { PaymentsSdk } from "../src/stripe/payments.ts";
import { createStripeSdk } from "../src/stripe/stripe.ts";

/** Where stripe-mock listens; CI runs it as a service container. */
export const STRIPE_MOCK_URL = process.env.STRIPE_API_BASE_URL ?? "http://localhost:12111";

interface IntentState {
  id: string;
  status: Stripe.PaymentIntent.Status;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  latest_charge: string | null;
  metadata: Record<string, string>;
}

/**
 * The Stripe SDK against stripe-mock, with state on top. stripe-mock checks
 * every request against Stripe's OpenAPI spec but is stateless: it answers
 * from fixtures (a PaymentIntent is always `requires_payment_method`). This
 * wrapper sends each call through for that check, then applies the state
 * changes Stripe documents (an off-session manual-capture confirm leaves the
 * intent `requires_capture`, capture makes it `succeeded`, cancel
 * `canceled`), replays idempotent requests, and lets a test decline the next
 * authorisation.
 */
export function statefulStripeMock() {
  const sdk = createStripeSdk("sk_test_ndintegration", STRIPE_MOCK_URL);
  const intents = new Map<string, IntentState>();
  const created: Stripe.PaymentIntentCreateParams[] = [];
  const captures: { id: string; amount: number }[] = [];
  const transfers: Stripe.TransferCreateParams[] = [];
  const cards = new Map<string, { customer: string; card: Stripe.PaymentMethod.Card }>();
  const defaults = new Map<string, string>();
  const replay = new Map<string, unknown>();
  const declines: string[] = [];
  let sequence = 0;

  async function once<T>(key: string | undefined, call: () => Promise<T>): Promise<T> {
    if (key !== undefined && replay.has(key)) {
      const saved = replay.get(key);
      if (saved instanceof Error) throw saved;
      return saved as T;
    }
    try {
      const result = await call();
      if (key !== undefined) replay.set(key, result);
      return result;
    } catch (error) {
      if (key !== undefined && error instanceof Stripe.errors.StripeCardError) {
        replay.set(key, error);
      }
      throw error;
    }
  }

  const view = (state: IntentState) => ({ ...state });

  const wrapped: PaymentsSdk = {
    customers: {
      create: (params, options) =>
        once(options?.idempotencyKey, () => sdk.customers.create(params)),
      retrieve: async (id) => {
        const customer = (await sdk.customers.retrieve(id)) as Stripe.Customer;
        return {
          ...customer,
          deleted: undefined,
          invoice_settings: {
            ...customer.invoice_settings,
            default_payment_method: defaults.get(id) ?? null,
          },
        };
      },
      update: async (id, params) => {
        const result = await sdk.customers.update(id, params);
        const method = params.invoice_settings?.default_payment_method;
        if (typeof method === "string") defaults.set(id, method);
        return result;
      },
    },
    setupIntents: {
      create: (params, options) =>
        once(options?.idempotencyKey, () => sdk.setupIntents.create(params)),
    },
    paymentMethods: {
      list: async (params) => {
        await sdk.paymentMethods.list(params);
        return {
          data: [...cards.entries()]
            .filter(([, saved]) => saved.customer === params.customer)
            .map(([id, saved]) => ({ id, customer: saved.customer, card: saved.card })),
        };
      },
      retrieve: (id) => {
        const saved = cards.get(id);
        if (saved === undefined) {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              code: "resource_missing",
              message: `No such PaymentMethod: '${id}'`,
            }),
          );
        }
        return Promise.resolve({ id, customer: saved.customer, card: saved.card });
      },
    },
    paymentIntents: {
      create: (params, options) =>
        once(options?.idempotencyKey, async () => {
          const fixture = await sdk.paymentIntents.create(params);
          created.push(params);
          sequence += 1;
          const state: IntentState = {
            id: `${fixture.id}_${String(sequence)}`,
            status: "requires_payment_method",
            amount: params.amount,
            amount_capturable: 0,
            amount_received: 0,
            latest_charge: null,
            metadata: { ...(params.metadata as Record<string, string> | undefined) },
          };
          intents.set(state.id, state);
          const decline = declines.shift();
          if (decline !== undefined) {
            throw new Stripe.errors.StripeCardError({
              type: "card_error",
              code: "card_declined",
              decline_code: decline,
              message: "Your card was declined.",
              payment_intent: view(state) as unknown as Stripe.PaymentIntent,
            });
          }
          if (params.confirm === true && params.capture_method === "manual") {
            state.status = "requires_capture";
            state.amount_capturable = params.amount;
          }
          return view(state);
        }),
      retrieve: async (id) => {
        const state = intents.get(id);
        if (state === undefined) throw new Error(`no PaymentIntent ${id}`);
        await sdk.paymentIntents.retrieve(id);
        return view(state);
      },
      cancel: (id, params, options) =>
        once(options?.idempotencyKey, async () => {
          const state = intents.get(id);
          if (state === undefined) throw new Error(`no PaymentIntent ${id}`);
          await sdk.paymentIntents.cancel(id, params);
          if (state.status !== "requires_capture") {
            throw new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              code: "payment_intent_unexpected_state",
              message: `This PaymentIntent's status is ${state.status}`,
            });
          }
          state.status = "canceled";
          state.amount_capturable = 0;
          return view(state);
        }),
      capture: (id, params, options) =>
        once(options?.idempotencyKey, async () => {
          const state = intents.get(id);
          if (state === undefined) throw new Error(`no PaymentIntent ${id}`);
          await sdk.paymentIntents.capture(id, params);
          const amount = params?.amount_to_capture ?? state.amount_capturable;
          if (state.status !== "requires_capture" || amount > state.amount_capturable) {
            throw new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              code: "amount_too_large",
              message: "Cannot capture this amount",
            });
          }
          state.status = "succeeded";
          state.amount_received = amount;
          state.amount_capturable = 0;
          state.latest_charge = `ch_${id}`;
          captures.push({ id, amount });
          return view(state);
        }),
    },
    transfers: {
      create: (params, options) =>
        once(options?.idempotencyKey, async () => {
          const transfer = await sdk.transfers.create(params);
          transfers.push(params);
          return { id: `${transfer.id}_${String(transfers.length)}` };
        }),
    },
  };

  return {
    sdk: wrapped,
    intents,
    created,
    captures,
    transfers,
    /** Saves a card on a customer, as confirming a SetupIntent in the app would. */
    saveCard(customerId: string, paymentMethodId = `pm_card_${String(cards.size + 1)}`) {
      cards.set(paymentMethodId, {
        customer: customerId,
        card: {
          brand: "visa",
          last4: "4242",
          exp_month: 12,
          exp_year: 2030,
        } as Stripe.PaymentMethod.Card,
      });
      if (!defaults.has(customerId)) defaults.set(customerId, paymentMethodId);
      return paymentMethodId;
    },
    /** The next PaymentIntent confirmation is declined with this code. */
    declineNext(code = "insufficient_funds") {
      declines.push(code);
    },
  };
}
