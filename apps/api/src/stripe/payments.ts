import Stripe from "stripe";

import { HttpProblem } from "../http/problem.ts";

// Driver payments as Stripe Connect destination charges: a Customer per
// driver, cards saved with SetupIntents, and one off-session PaymentIntent
// per booking whose funds go to the host's connected account, less an
// application fee (the platform fee plus the card fee passed on to the
// host). Instant bookings are charged at once; requests are held (manual
// capture) until the host answers. Refunds reverse the host's share and the
// application fee. Card numbers never reach the API; only brand, last four
// digits and expiry are read back.

/** A card saved on a driver's Customer. */
export interface SavedCard {
  readonly id: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

/** The outcome of charging (or holding) a booking's price. */
export type ChargeResult =
  | {
      /** Charged (automatic capture). */
      readonly status: "paid";
      readonly paymentIntentId: string;
      readonly chargeId: string | null;
    }
  | {
      /** Held on the card until captured (manual capture). */
      readonly status: "authorised";
      readonly paymentIntentId: string;
    }
  | {
      /** Stripe has not decided yet (`processing`); a webhook settles it. */
      readonly status: "pending";
      readonly paymentIntentId: string;
    }
  | {
      readonly status: "failed";
      readonly paymentIntentId: string | null;
      /** A decline code or the PaymentIntent's status; never card details. */
      readonly reason: string;
    };

/** The outcome of capturing a held booking. */
export type CaptureResult =
  | { readonly status: "paid"; readonly chargeId: string | null }
  | {
      /** The hold can no longer be captured (it expired or was released). */
      readonly status: "failed";
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
  /**
   * Charges a booking's price on a saved card off-session, as a destination
   * charge to the host's connected account with `applicationFeeCents` kept
   * back. `manual` holds it for capture when the host approves.
   */
  charge(input: {
    readonly bookingId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly customerId: string;
    readonly paymentMethodId: string;
    readonly destination: string;
    readonly applicationFeeCents: number;
    readonly captureMethod: "automatic" | "manual";
    readonly idempotencyKey: string;
  }): Promise<ChargeResult>;
  /** Releases a hold. Succeeds if it was already released. */
  cancelAuthorisation(input: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  /** Captures the whole of a hold. */
  capture(input: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
  }): Promise<CaptureResult>;
  /** Refunds part or all of a charge, reversing the host's share and the application fee in proportion. */
  refund(input: {
    readonly paymentIntentId: string;
    readonly amountCents: number;
    readonly metadata: Record<string, string>;
    readonly idempotencyKey: string;
  }): Promise<{ id: string; status: "pending" | "succeeded" | "failed" }>;
  /** A refund as Stripe has it now. */
  retrieveRefund(
    refundId: string,
  ): Promise<{ id: string; status: "pending" | "succeeded" | "failed" }>;
  /** Deletes a driver's Customer and the cards saved on it. Succeeds if it is already gone. */
  deleteCustomer(customerId: string): Promise<void>;
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
    del(id: string): Promise<unknown>;
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
  readonly refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string; status: string | null }>;
    retrieve(id: string): Promise<{ id: string; status: string | null }>;
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

/** A Stripe refund status as ours: succeeded, failed (or cancelled), or still pending. */
export function refundStatusOf(
  status: string | null | undefined,
): "pending" | "succeeded" | "failed" {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

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

    async charge({
      bookingId,
      amountCents,
      currency,
      customerId,
      paymentMethodId,
      destination,
      applicationFeeCents,
      captureMethod,
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
            capture_method: captureMethod,
            confirm: true,
            off_session: true,
            // Destination charge: the host's account receives the price less the application fee.
            transfer_data: { destination },
            application_fee_amount: applicationFeeCents,
            transfer_group: bookingId,
            metadata: { bookingId },
          },
          { idempotencyKey },
        );
        if (intent.status === "succeeded") {
          return {
            status: "paid",
            paymentIntentId: intent.id,
            chargeId: idOf(intent.latest_charge),
          };
        }
        if (intent.status === "requires_capture") {
          return { status: "authorised", paymentIntentId: intent.id };
        }
        if (intent.status === "processing")
          return { status: "pending", paymentIntentId: intent.id };
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

    async capture({ paymentIntentId, idempotencyKey }) {
      try {
        const intent = await sdk.paymentIntents.capture(paymentIntentId, {}, { idempotencyKey });
        return { status: "paid", chargeId: idOf(intent.latest_charge) };
      } catch (error) {
        // The hold expired or was released: nothing can be captured any more.
        if (
          error instanceof Stripe.errors.StripeInvalidRequestError &&
          error.code === "payment_intent_unexpected_state"
        ) {
          return { status: "failed", reason: "authorisation_expired" };
        }
        throw error;
      }
    },

    async refund({ paymentIntentId, amountCents, metadata, idempotencyKey }) {
      const refund = await sdk.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountCents,
          // Take the host's share back from their account, and give up the application fee.
          reverse_transfer: true,
          refund_application_fee: true,
          metadata,
        },
        { idempotencyKey },
      );
      return { id: refund.id, status: refundStatusOf(refund.status) };
    },

    async retrieveRefund(refundId) {
      const refund = await sdk.refunds.retrieve(refundId);
      return { id: refund.id, status: refundStatusOf(refund.status) };
    },

    async deleteCustomer(customerId) {
      try {
        await sdk.customers.del(customerId);
      } catch (error) {
        if (
          error instanceof Stripe.errors.StripeInvalidRequestError &&
          error.code === "resource_missing"
        ) {
          return;
        }
        throw error;
      }
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
  charge: unavailable,
  cancelAuthorisation: unavailable,
  capture: unavailable,
  refund: unavailable,
  retrieveRefund: unavailable,
  deleteCustomer: unavailable,
};
