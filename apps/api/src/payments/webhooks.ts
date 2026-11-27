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
import { closeCardDispute, insertCardDispute } from "../data/disputes.ts";
import { confirmPendingRefunds } from "../data/payments.ts";
import type { Services } from "../services.ts";

// Stripe webhooks: signature checked against the raw body, each event id
// processed once (recorded in the same transaction as its effects), and
// only ids and statuses read from the payload, never card details. A webhook
// only records what Stripe did; it never moves money.

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
  intentId: string | null,
  bookingId: string | undefined,
): Promise<Payment | undefined> {
  if (intentId === null) return undefined;
  const byIntent = await findPaymentByIntent(services.db, intentId);
  if (byIntent !== undefined) return byIntent;
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
  const payment = await paymentOf(services, intent.id, intent.metadata.bookingId);
  if (payment === undefined) return false;
  const db = services.db;
  switch (type) {
    case "payment_intent.succeeded":
      return updatePaymentFrom(db, payment.id, ["pending", "authorised"], {
        status: "paid",
        stripePaymentIntentId: intent.id,
        stripeChargeId: idOf(intent.latest_charge),
        failureReason: null,
      });
    case "payment_intent.canceled":
      return updatePaymentFrom(db, payment.id, ["pending", "authorised"], {
        status: "cancelled",
        stripePaymentIntentId: intent.id,
      });
    default:
      // payment_intent.payment_failed: record why; the booking flow decides what follows.
      return updatePaymentFrom(db, payment.id, ["pending", "authorised"], {
        stripePaymentIntentId: intent.id,
        failureReason:
          intent.last_payment_error?.decline_code ??
          intent.last_payment_error?.code ??
          "payment_failed",
      });
  }
}

/** Records what a card dispute's creation or closing says. */
async function applyDispute(services: Services, event: Stripe.Event): Promise<boolean> {
  if (event.type === "charge.dispute.closed") {
    return closeCardDispute(services.db, {
      stripeDisputeId: event.data.object.id,
      outcome: event.data.object.status,
      at: services.clock.now(),
    });
  }
  if (event.type !== "charge.dispute.created") return false;
  const dispute = event.data.object;
  const payment = await paymentOf(services, idOf(dispute.payment_intent), undefined);
  if (payment === undefined) return false;
  const detail = await findBookingDetail(services.db, payment.bookingId);
  if (detail === undefined) return false;
  services.log.warn({ bookingId: payment.bookingId }, "card dispute raised; needs support");
  return insertCardDispute(services.db, {
    bookingId: payment.bookingId,
    driverId: detail.booking.driverId,
    stripeDisputeId: dispute.id,
    reason: dispute.reason,
  });
}

/** Applies the events the upfront flow needs; every other type is recorded and ignored. */
async function apply(services: Services, event: Stripe.Event): Promise<boolean> {
  if (
    event.type === "payment_intent.succeeded" ||
    event.type === "payment_intent.canceled" ||
    event.type === "payment_intent.payment_failed"
  ) {
    return applyPaymentIntent(services, event.type, event.data.object);
  }
  if (event.type === "charge.refunded") {
    const payment = await paymentOf(services, idOf(event.data.object.payment_intent), undefined);
    if (payment === undefined) return false;
    return (await confirmPendingRefunds(services.db, payment.id)) > 0;
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    return applyDispute(services, event);
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
  return services.db.transaction(async (tx): Promise<WebhookOutcome> => {
    const scoped = { ...services, db: tx };
    if (!(await recordWebhookEvent(tx, { id: event.id, type: event.type }))) return "duplicate";
    return (await apply(scoped, event)) ? "processed" : "ignored";
  });
}
