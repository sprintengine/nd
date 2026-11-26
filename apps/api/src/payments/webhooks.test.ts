import type * as NdDb from "@nd/db";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment, PAYMENT_ID } from "../../test/booking-detail.ts";
import type { fakePayments, memoryJobs } from "../../test/fakes.ts";
import { startUnitApp } from "../../test/unit-app.ts";
import * as data from "../data/bookings.ts";
import { payoutStatusOf } from "./webhooks.ts";

vi.mock("../data/bookings.ts");

const SECRET = "whsec_test_secret";
let app: FastifyInstance;
let payments: ReturnType<typeof fakePayments>;
let jobs: ReturnType<typeof memoryJobs>;

function post(event: object, secret = SECRET) {
  const payload = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }),
    },
    payload,
  });
}

const event = (type: string, object: object) => ({
  id: `evt_${type}`,
  object: "event",
  type,
  data: { object },
});

beforeEach(() => {
  ({ app, payments, jobs } = startUnitApp());
  // The unit app's database never connects; run "transactions" inline.
  vi.spyOn(app.auth.api, "getSession");
  vi.mocked(data.recordWebhookEvent).mockResolvedValue(true);
  vi.mocked(data.updatePaymentFrom).mockResolvedValue(true);
  vi.mocked(data.findPaymentByIntent).mockResolvedValue(payment());
});

afterEach(async () => {
  await app.close();
  vi.resetAllMocks();
});

vi.mock("@nd/db", async (importOriginal) => {
  const actual = await importOriginal<typeof NdDb>();
  return {
    ...actual,
    createDb: () => {
      const db = {
        transaction: (work: (tx: unknown) => Promise<unknown>) => work(db),
      };
      return { db, pool: {}, close: () => Promise.resolve() };
    },
  };
});

describe("payoutStatusOf", () => {
  it.each([
    [{ payouts_enabled: true, charges_enabled: true }, "enabled"],
    [
      { payouts_enabled: true, charges_enabled: false, capabilities: { transfers: "active" } },
      "enabled",
    ],
    [
      { payouts_enabled: true, charges_enabled: false, capabilities: { transfers: "inactive" } },
      "pending",
    ],
    [
      {
        payouts_enabled: false,
        charges_enabled: false,
        requirements: { disabled_reason: "rejected.fraud" },
      },
      "restricted",
    ],
    [
      { payouts_enabled: false, charges_enabled: false, requirements: { disabled_reason: null } },
      "pending",
    ],
  ] as const)("maps %j to %s", (account, status) => {
    expect(payoutStatusOf(account as unknown as Stripe.Account)).toBe(status);
  });
});

describe("POST /webhooks/stripe", () => {
  it("rejects a missing or wrong signature", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(missing.statusCode).toBe(400);
    const wrong = await post(event("account.updated", {}), "whsec_wrong");
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "invalid-signature" });
    expect(data.recordWebhookEvent).not.toHaveBeenCalled();
  });

  it("is 503 without a webhook secret", async () => {
    await app.close();
    ({ app } = startUnitApp({ stripeWebhookSecret: undefined }));
    expect((await post(event("account.updated", {}))).statusCode).toBe(503);
  });

  it("acknowledges a redelivered event without acting on it", async () => {
    vi.mocked(data.recordWebhookEvent).mockResolvedValue(false);
    const response = await post(event("payment_intent.canceled", { id: "pi_1", metadata: {} }));
    expect(response.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(data.updatePaymentFrom).not.toHaveBeenCalled();
  });

  it("mirrors account.updated onto the host", async () => {
    vi.mocked(data.setPayoutStatusByAccount).mockResolvedValue(true);
    const response = await post(
      event("account.updated", { id: "acct_1", payouts_enabled: true, charges_enabled: true }),
    );
    expect(response.json()).toEqual({ received: true, outcome: "processed" });
    expect(data.setPayoutStatusByAccount).toHaveBeenCalledWith(
      expect.anything(),
      "acct_1",
      "enabled",
    );
    expect(jobs.sent).toEqual([
      { name: "release-held-transfers", payload: {}, options: { singletonKey: "all-hosts" } },
    ]);
  });

  it("does not retry held transfers while payouts stay off, and survives a queue failure", async () => {
    vi.mocked(data.setPayoutStatusByAccount).mockResolvedValue(true);
    await post(event("account.updated", { id: "acct_1", payouts_enabled: false }));
    expect(jobs.sent).toEqual([]);
    vi.spyOn(jobs.runner, "send").mockRejectedValueOnce(new Error("queue down"));
    const response = await post({
      ...event("account.updated", { id: "acct_1", payouts_enabled: true, charges_enabled: true }),
      id: "evt_again",
    });
    expect(response.json()).toEqual({ received: true, outcome: "processed" });
  });

  it.each([
    [
      "payment_intent.amount_capturable_updated",
      { amount_capturable: 1000 },
      ["pending_authorisation", "card_saved"],
      {
        status: "authorised",
        stripePaymentIntentId: "pi_1",
        authorisedCents: 1000,
        failureReason: null,
      },
    ],
    [
      "payment_intent.succeeded",
      { amount_received: 400, latest_charge: "ch_1" },
      ["authorised"],
      { status: "captured", capturedCents: 400, stripeChargeId: "ch_1" },
    ],
    [
      "payment_intent.canceled",
      {},
      ["pending_authorisation", "card_saved", "authorised"],
      { status: "cancelled" },
    ],
    [
      "payment_intent.payment_failed",
      { last_payment_error: { decline_code: "insufficient_funds" } },
      ["pending_authorisation", "card_saved"],
      { failureReason: "insufficient_funds" },
    ],
    [
      "payment_intent.payment_failed",
      { last_payment_error: { code: "expired_card" } },
      ["pending_authorisation", "card_saved"],
      { failureReason: "expired_card" },
    ],
    [
      "payment_intent.payment_failed",
      { last_payment_error: null },
      ["pending_authorisation", "card_saved"],
      { failureReason: "payment_failed" },
    ],
  ])("applies %s to the payment", async (type, fields, from, change) => {
    const response = await post(event(type, { id: "pi_1", metadata: {}, ...fields }));
    expect(response.json()).toMatchObject({ outcome: "processed" });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      from,
      change,
    );
  });

  it("finds a payment by its booking before the intent id is stored", async () => {
    vi.mocked(data.findPaymentByIntent).mockResolvedValue(undefined);
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", {
        payment: { stripePaymentIntentId: null, status: "pending_authorisation" },
      }),
    );
    const response = await post(
      event("payment_intent.amount_capturable_updated", {
        id: "pi_new",
        amount_capturable: 1000,
        metadata: { bookingId: BOOKING_ID },
      }),
    );
    expect(response.json()).toMatchObject({ outcome: "processed" });
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    const other = await post({
      ...event("payment_intent.canceled", { id: "pi_other", metadata: { bookingId: BOOKING_ID } }),
      id: "evt_other",
    });
    expect(other.json()).toMatchObject({ outcome: "ignored" });
    const unknown = await post({
      ...event("payment_intent.canceled", { id: "pi_unknown", metadata: {} }),
      id: "evt_unknown",
    });
    expect(unknown.json()).toMatchObject({ outcome: "ignored" });
  });

  it("makes the first saved card the default", async () => {
    payments.state.defaultCardId = null;
    const response = await post(
      event("setup_intent.succeeded", { id: "seti_1", customer: "cus_1", payment_method: "pm_1" }),
    );
    expect(response.json()).toMatchObject({ outcome: "processed" });
    expect(payments.state.defaultCardId).toBe("pm_1");
    const again = await post({
      ...event("setup_intent.succeeded", {
        id: "seti_2",
        customer: "cus_1",
        payment_method: "pm_2",
      }),
      id: "evt_2",
    });
    expect(again.json()).toMatchObject({ outcome: "ignored" });
    const incomplete = await post({
      ...event("setup_intent.succeeded", { id: "seti_3", customer: null, payment_method: null }),
      id: "evt_3",
    });
    expect(incomplete.json()).toMatchObject({ outcome: "ignored" });
  });

  it("records and ignores other event types", async () => {
    const response = await post(event("customer.created", { id: "cus_1" }));
    expect(response.json()).toEqual({ received: true, outcome: "ignored" });
    expect(data.recordWebhookEvent).toHaveBeenCalledWith(expect.anything(), {
      id: "evt_customer.created",
      type: "customer.created",
    });
  });
});
