import type { HostPayoutStatus } from "@nd/domain";
import Stripe from "stripe";

import {
  findBookingDetail,
  findPaymentByIntent,
  type Payment,
  recordWebhookEvent,
  setPayoutStatusByAccount,
  updatePaymentFrom,
} from "../data/bookings.ts";
import type { Services } from "../services.ts";

// Stripe webhooks: signature checked against the raw body, each event id
// processed once (recorded in the same transaction as its effects), and
// only ids and statuses read from the payload, never card details.

/** Checks a webhook's signature and parses it. Throws when the signature is wrong or stale. */
export function verifyStripeEvent(
  rawBody: Buffer,
  signature: string,
  secret: string,
): Stripe.Event {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** What happened to an event. */
export type WebhookOutcome = "processed" | "duplicate" | "ignored";

/** A connected account's state as the host's payout status. */
export function payoutStatusOf(
  account: Pick<
    Stripe.Account,
    "payouts_enabled" | "charges_enabled" | "capabilities" | "requirements"
  >,
): Exclude<HostPayoutStatus, "not_started"> {
  const canReceive = account.charges_enabled || account.capabilities?.transfers === "active";
  if (account.payouts_enabled && canReceive) return "enabled";
  if (account.requirements?.disabled_reason) return "restricted";
  return "pending";
}

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.id;

/** The payment a PaymentIntent belongs to, by its id or, before that is stored, its booking. */
async function paymentOf(
  services: Services,
  intent: Pick<Stripe.PaymentIntent, "id" | "metadata">,
): Promise<Payment | undefined> {
  const byIntent = await findPaymentByIntent(services.db, intent.id);
  if (byIntent !== undefined) return byIntent;
  const bookingId = intent.metadata.bookingId;
  if (bookingId === undefined) return undefined;
  const payment = (await findBookingDetail(services.db, bookingId))?.payment ?? null;
  // Only adopt the intent for a payment that does not have one yet.
  return payment !== null && payment.stripePaymentIntentId === null ? payment : undefined;
}

async function applyPaymentIntent(
  services: Services,
  type: string,
  intent: Stripe.PaymentIntent,
): Promise<boolean> {
  const payment = await paymentOf(services, intent);
  if (payment === undefined) return false;
  const db = services.db;
  switch (type) {
    case "payment_intent.amount_capturable_updated":
      return updatePaymentFrom(db, payment.id, ["pending_authorisation", "card_saved"], {
        status: "authorised",
        stripePaymentIntentId: intent.id,
        authorisedCents: intent.amount_capturable,
        failureReason: null,
      });
    case "payment_intent.succeeded":
      return updatePaymentFrom(db, payment.id, ["authorised"], {
        status: "captured",
        capturedCents: Math.min(intent.amount_received, payment.authorisedCents),
        stripeChargeId: idOf(intent.latest_charge),
      });
    case "payment_intent.canceled":
      return updatePaymentFrom(
        db,
        payment.id,
        ["pending_authorisation", "card_saved", "authorised"],
        {
          status: "cancelled",
        },
      );
    default:
      // payment_intent.payment_failed: record why; the booking flow decides what follows.
      return updatePaymentFrom(db, payment.id, ["pending_authorisation", "card_saved"], {
        failureReason:
          intent.last_payment_error?.decline_code ??
          intent.last_payment_error?.code ??
          "payment_failed",
      });
  }
}

async function apply(services: Services, event: Stripe.Event): Promise<boolean> {
  if (
    event.type === "payment_intent.amount_capturable_updated" ||
    event.type === "payment_intent.succeeded" ||
    event.type === "payment_intent.canceled" ||
    event.type === "payment_intent.payment_failed"
  ) {
    return applyPaymentIntent(services, event.type, event.data.object);
  }
  if (event.type === "setup_intent.succeeded") {
    const intent = event.data.object;
    const customerId = idOf(intent.customer);
    const paymentMethodId = idOf(intent.payment_method);
    if (customerId === null || paymentMethodId === null) return false;
    // The first card saved becomes the default.
    const { defaultCardId } = await services.payments.listCards(customerId);
    if (defaultCardId !== null) return false;
    await services.payments.setDefaultCard(customerId, paymentMethodId);
    return true;
  }
  if (event.type === "account.updated") {
    const account = event.data.object;
    return setPayoutStatusByAccount(services.db, account.id, payoutStatusOf(account));
  }
  return false;
}

/**
 * Processes a verified event once: its id is recorded in the same
 * transaction as its effects, so a redelivery is a no-op and a failure
 * leaves it to be retried.
 */
export async function handleStripeEvent(
  services: Services,
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  return services.db.transaction(async (tx) => {
    const scoped = { ...services, db: tx };
    if (!(await recordWebhookEvent(tx, { id: event.id, type: event.type }))) return "duplicate";
    return (await apply(scoped, event)) ? "processed" : "ignored";
  });
}
