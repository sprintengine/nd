import { createHmac, randomBytes } from "node:crypto";

import { API_URL, STRIPE_DOUBLE_URL, STRIPE_TEST_KEY, STRIPE_WEBHOOK_SECRET } from "./config.ts";
import type { ApiClient } from "./http.ts";
import { eventually } from "./wait.ts";

// Stripe's side of the tests. The API talks to the Stripe double (which
// checks every call with stripe-mock); these helpers do what Stripe and the
// app's Stripe SDK would do: send signed webhooks and confirm a card.

type Json = Record<string, unknown>;

/** Sends a webhook event to the API, signed the way Stripe signs them. */
export async function sendWebhook(type: string, object: Json): Promise<void> {
  const payload = JSON.stringify({
    id: `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    api_version: "2025-01-27.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${String(timestamp)}.${payload}`)
    .digest("hex");
  const response = await fetch(`${API_URL}/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${String(timestamp)},v1=${signature}`,
    },
    body: payload,
  });
  if (response.status !== 200) {
    throw new Error(`webhook ${type} -> ${String(response.status)}: ${await response.text()}`);
  }
}

async function readDouble<T>(path: string): Promise<T> {
  const response = await fetch(`${STRIPE_DOUBLE_URL}${path}`);
  if (!response.ok) throw new Error(`Stripe double ${path} -> ${String(response.status)}`);
  return (await response.json()) as T;
}

/** Stripe finishing a host's Express onboarding: `account.updated` with payouts on. */
export async function completePayoutsOnboarding(hostId: string): Promise<void> {
  await sendWebhook("account.updated", {
    id: await accountOf(hostId),
    object: "account",
    type: "express",
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { card_payments: "active", transfers: "active" },
    requirements: { disabled_reason: null, currently_due: [] },
  });
}

/**
 * A driver saving a card: the API creates the SetupIntent, the app confirms it
 * with Stripe (here, with the double), and Stripe reports it by webhook.
 * Resolves once the card is the driver's default.
 */
export async function saveCard(api: ApiClient): Promise<string> {
  const setup = await api.post<{ setupIntentId: string; clientSecret: string }>(
    "/me/payment-methods/setup-intent",
  );
  const response = await fetch(
    `${STRIPE_DOUBLE_URL}/v1/setup_intents/${encodeURIComponent(setup.setupIntentId)}/confirm`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${STRIPE_TEST_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ payment_method: "pm_card_visa" }).toString(),
    },
  );
  const intent = (await response.json()) as Json;
  if (!response.ok) throw new Error(`confirming the SetupIntent failed: ${JSON.stringify(intent)}`);
  await sendWebhook("setup_intent.succeeded", intent);
  return eventually("the saved card to become the default", async () => {
    const saved = await api.get<{ defaultPaymentMethodId: string | null }>("/me/payment-methods");
    return saved.defaultPaymentMethodId ?? undefined;
  });
}

export interface DoubleIntent {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly amount_capturable: number;
  readonly amount_received: number;
  readonly capture_method: string;
}

/** The PaymentIntents Stripe holds for a booking. */
export async function paymentIntentsFor(bookingId: string): Promise<DoubleIntent[]> {
  const { data } = await readDouble<{ data: DoubleIntent[] }>(
    `/__double/payment_intents?bookingId=${encodeURIComponent(bookingId)}`,
  );
  return data;
}

export interface DoubleTransfer {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly destination: string;
  readonly sourceTransaction: string | null;
}

/** The transfers Stripe made for a booking (its transfer group). */
export async function transfersFor(bookingId: string): Promise<DoubleTransfer[]> {
  const { data } = await readDouble<{ data: DoubleTransfer[] }>(
    `/__double/transfers?transferGroup=${encodeURIComponent(bookingId)}`,
  );
  return data;
}

/** The connected account Stripe opened for a host. */
export async function accountOf(hostId: string): Promise<string> {
  const { data } = await readDouble<{ data: { id: string }[] }>(
    `/__double/accounts?hostId=${encodeURIComponent(hostId)}`,
  );
  const account = data[0];
  if (account === undefined) throw new Error(`no Stripe account for host ${hostId}`);
  return account.id;
}
