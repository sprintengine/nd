import Stripe from "stripe";

import { HttpProblem } from "../http/problem.ts";

// Driver payments on the platform account (separate charges and transfers):
// a Customer per driver, cards saved with SetupIntents, manual-capture
// PaymentIntents authorised off-session, partial captures and transfers to
// the host's connected account. Card numbers never reach the API; only
// brand, last four digits and expiry are read back.

/** A card saved on a driver's Customer. */
export interface SavedCard {
  readonly id: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

/** The outcome of authorising a booking's quote. */
export type AuthorisationResult =
  | {
      readonly status: "authorised";
      readonly paymentIntentId: string;
      readonly amountCents: number;
    }
  | {
      readonly status: "failed";
      readonly paymentIntentId: string | null;
      /** A decline code or the PaymentIntent's status; never card details. */
      readonly reason: string;
    };

/** The Stripe calls payments make. Tests pass a fake. */
export interface StripePayments {
  createCustomer(input: {
    readonly userId: string;
    readonly email: string;
    readonly name: string;
  }): Promise<{ id: string }>;
  /** A SetupIntent the app confirms with Stripe's SDK to save a card for off-session use. */
  createSetupIntent(input: {
    readonly customerId: string;
    readonly userId: string;
    readonly idempotencyKey: string;
  }): Promise<{ id: string; clientSecret: string }>;
  listCards(customerId: string): Promise<{ cards: SavedCard[]; defaultCardId: string | null }>;
  /** The card, if it is saved on this customer. */
  findCard(customerId: string, paymentMethodId: string): Promise<SavedCard | undefined>;
  setDefaultCard(customerId: string, paymentMethodId: string): Promise<void>;
  /** Authorises `amountCents` on a saved card off-session, for capture later. */
  authorise(input: {
    readonly bookingId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly customerId: string;
    readonly paymentMethodId: string;
    readonly idempotencyKey: string;
  }): Promise<AuthorisationResult>;
  /** Releases an authorisation. Succeeds if it was already released. */
  cancelAuthorisation(input: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  /** Captures part or all of an authorisation; the rest is released. */
  capture(input: {
    readonly paymentIntentId: string;
    readonly amountCents: number;
    readonly idempotencyKey: string;
  }): Promise<{ chargeId: string | null; amountCents: number }>;
  /** A transfer to a connected account, funded by a captured charge. */
  transfer(input: {
    readonly amountCents: number;
    readonly currency: string;
    readonly destination: string;
    readonly sourceTransaction: string;
    readonly transferGroup: string;
    readonly metadata: Record<string, string>;
    readonly idempotencyKey: string;
  }): Promise<{ id: string }>;
}

type PaymentIntentLike = Pick<
  Stripe.PaymentIntent,
  "id" | "status" | "amount" | "amount_capturable" | "amount_received" | "latest_charge"
>;

type PaymentMethodLike = Pick<Stripe.PaymentMethod, "id" | "card" | "customer">;

/** The part of the Stripe SDK payments use, so tests can pass a fake. */
export interface PaymentsSdk {
  readonly customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
    retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
    update(id: string, params: Stripe.CustomerUpdateParams): Promise<unknown>;
  };
  readonly setupIntents: {
    create(
      params: Stripe.SetupIntentCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string; client_secret: string | null }>;
  };
  readonly paymentMethods: {
    list(params: Stripe.PaymentMethodListParams): Promise<{ data: PaymentMethodLike[] }>;
    retrieve(id: string): Promise<PaymentMethodLike>;
  };
  readonly paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<PaymentIntentLike>;
    retrieve(id: string): Promise<PaymentIntentLike>;
    cancel(
      id: string,
      params?: Stripe.PaymentIntentCancelParams,
      options?: Stripe.RequestOptions,
    ): Promise<PaymentIntentLike>;
    capture(
      id: string,
      params?: Stripe.PaymentIntentCaptureParams,
      options?: Stripe.RequestOptions,
    ): Promise<PaymentIntentLike>;
  };
  readonly transfers: {
    create(
      params: Stripe.TransferCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
  };
}

function cardOf(method: PaymentMethodLike): SavedCard | undefined {
  const card = method.card;
  if (card === undefined) return undefined;
  return {
    id: method.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
  };
}

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.id;

/** Payments on top of the Stripe SDK. */
export function stripePaymentsFrom(sdk: PaymentsSdk): StripePayments {
  return {
    async createCustomer({ userId, email, name }) {
      const customer = await sdk.customers.create(
        { email, name, metadata: { userId } },
        // A retried request for the same driver returns the same customer.
        { idempotencyKey: `customer-${userId}` },
      );
      return { id: customer.id };
    },

    async createSetupIntent({ customerId, userId, idempotencyKey }) {
      const intent = await sdk.setupIntents.create(
        {
          customer: customerId,
          usage: "off_session",
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: { userId },
        },
        { idempotencyKey },
      );
      if (intent.client_secret === null) throw new Error("SetupIntent has no client secret");
      return { id: intent.id, clientSecret: intent.client_secret };
    },

    async listCards(customerId) {
      const [methods, customer] = await Promise.all([
        sdk.paymentMethods.list({ customer: customerId, type: "card", limit: 100 }),
        sdk.customers.retrieve(customerId),
      ]);
      const cards = methods.data.flatMap((method) => cardOf(method) ?? []);
      const defaultCardId =
        customer.deleted === true ? null : idOf(customer.invoice_settings.default_payment_method);
      return { cards, defaultCardId };
    },

    async findCard(customerId, paymentMethodId) {
      try {
        const method = await sdk.paymentMethods.retrieve(paymentMethodId);
        return idOf(method.customer) === customerId ? cardOf(method) : undefined;
      } catch (error) {
        if (error instanceof Stripe.errors.StripeInvalidRequestError) return undefined;
        throw error;
      }
    },

    async setDefaultCard(customerId, paymentMethodId) {
      await sdk.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    },

    async authorise({
      bookingId,
      amountCents,
      currency,
      customerId,
      paymentMethodId,
      idempotencyKey,
    }) {
      try {
        const intent = await sdk.paymentIntents.create(
          {
            amount: amountCents,
            currency: currency.toLowerCase(),
            customer: customerId,
            payment_method: paymentMethodId,
            // Off-session cards only: nothing that would need a redirect.
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            capture_method: "manual",
            confirm: true,
            off_session: true,
            // Separate charges and transfers: the host's transfer joins this group.
            transfer_group: bookingId,
            metadata: { bookingId },
          },
          { idempotencyKey },
        );
        if (intent.status === "requires_capture") {
          return {
            status: "authorised",
            paymentIntentId: intent.id,
            amountCents: intent.amount_capturable,
          };
        }
        return { status: "failed", paymentIntentId: intent.id, reason: intent.status };
      } catch (error) {
        if (error instanceof Stripe.errors.StripeCardError) {
          // A card error's decline code is empty when the issuer gave none.
          const declined: Stripe.errors.StripeError = error;
          const reason = [declined.decline_code, declined.code].find(
            (code) => code !== undefined && code !== "",
          );
          return {
            status: "failed",
            paymentIntentId: declined.payment_intent?.id ?? null,
            reason: reason ?? "card_declined",
          };
        }
        throw error;
      }
    },

    async cancelAuthorisation({ paymentIntentId, idempotencyKey }) {
      try {
        await sdk.paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey });
      } catch (error) {
        // Already released (by us earlier, or by Stripe when it expired).
        if (
          error instanceof Stripe.errors.StripeInvalidRequestError &&
          error.code === "payment_intent_unexpected_state"
        ) {
          const intent = await sdk.paymentIntents.retrieve(paymentIntentId);
          if (intent.status === "canceled") return;
        }
        throw error;
      }
    },

    async capture({ paymentIntentId, amountCents, idempotencyKey }) {
      const intent = await sdk.paymentIntents.capture(
        paymentIntentId,
        { amount_to_capture: amountCents },
        { idempotencyKey },
      );
      return { chargeId: idOf(intent.latest_charge), amountCents: intent.amount_received };
    },

    async transfer({
      amountCents,
      currency,
      destination,
      sourceTransaction,
      transferGroup,
      metadata,
      idempotencyKey,
    }) {
      const transfer = await sdk.transfers.create(
        {
          amount: amountCents,
          currency: currency.toLowerCase(),
          destination,
          source_transaction: sourceTransaction,
          transfer_group: transferGroup,
          metadata,
        },
        { idempotencyKey },
      );
      return { id: transfer.id };
    },
  };
}

const unavailable = (): Promise<never> =>
  Promise.reject(
    new HttpProblem(503, "payments-unavailable", "Payments are not configured on this server"),
  );

/** Used when no Stripe key is configured: every payment call answers 503. */
export const unconfiguredStripePayments: StripePayments = {
  createCustomer: unavailable,
  createSetupIntent: unavailable,
  listCards: unavailable,
  findCard: unavailable,
  setDefaultCard: unavailable,
  authorise: unavailable,
  cancelAuthorisation: unavailable,
  capture: unavailable,
  transfer: unavailable,
};
