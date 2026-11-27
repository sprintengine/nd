import type * as NdDb from "@nd/db";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, payment, PAYMENT_ID } from "../../test/booking-detail.ts";
import type { fakePayments, memoryJobs } from "../../test/fakes.ts";
import { startUnitApp } from "../../test/unit-app.ts";
import * as data from "../data/bookings.ts";
import * as disputes from "../data/disputes.ts";
import * as paymentData from "../data/payments.ts";
import { payoutStatusOf } from "./webhooks.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/disputes.ts");
vi.mock("../data/payments.ts");

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
    // A webhook never moves money or queues anything that would.
    expect(jobs.sent).toEqual([]);
  });

  it.each([
    [
      "payment_intent.succeeded",
      { latest_charge: "ch_1" },
      {
        status: "paid",
        stripePaymentIntentId: "pi_1",
        stripeChargeId: "ch_1",
        failureReason: null,
      },
    ],
    ["payment_intent.canceled", {}, { status: "cancelled", stripePaymentIntentId: "pi_1" }],
  ])("records %s on the payment", async (type, fields, change) => {
    const response = await post(event(type, { id: "pi_1", metadata: {}, ...fields }));
    expect(response.json()).toMatchObject({ outcome: "processed" });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending", "authorised"],
      change,
    );
    expect(payments.calls).toEqual([]);
  });

  it.each([
    [{ decline_code: "insufficient_funds" }, "insufficient_funds"],
    [{ code: "expired_card" }, "expired_card"],
    [null, "payment_failed"],
  ])("fails the payment and cancels the booking on payment_failed (%j)", async (error, reason) => {
    vi.mocked(data.updateBookingFrom).mockResolvedValue(true);
    const response = await post(
      event("payment_intent.payment_failed", {
        id: "pi_1",
        metadata: {},
        last_payment_error: error,
      }),
    );
    expect(response.json()).toMatchObject({ outcome: "processed" });
    expect(data.updatePaymentFrom).toHaveBeenCalledWith(
      expect.anything(),
      PAYMENT_ID,
      ["pending", "authorised"],
      { status: "failed", stripePaymentIntentId: "pi_1", failureReason: reason },
    );
    expect(data.updateBookingFrom).toHaveBeenCalledWith(
      expect.anything(),
      BOOKING_ID,
      ["requested", "confirmed"],
      expect.objectContaining({
        cancelledBy: "system",
        cancellationReason: `payment_failed: ${reason}`,
      }),
    );
    expect(payments.calls).toEqual([]);
  });

  it("leaves the booking alone when the payment had already settled", async () => {
    vi.mocked(data.updatePaymentFrom).mockResolvedValue(false);
    const response = await post(
      event("payment_intent.payment_failed", { id: "pi_1", metadata: {} }),
    );
    expect(response.json()).toMatchObject({ outcome: "ignored" });
    expect(data.updateBookingFrom).not.toHaveBeenCalled();
  });

  it("records each refund's own status, by its Stripe id or our refund id", async () => {
    const row = (id: string) =>
      ({ id, paymentId: PAYMENT_ID }) as Awaited<ReturnType<typeof paymentData.recordStripeRefund>>;
    vi.mocked(paymentData.recordStripeRefund)
      .mockResolvedValueOnce(row("r1"))
      .mockResolvedValueOnce(row("r2"));
    const response = await post(
      event("charge.refunded", {
        id: "ch_1",
        payment_intent: "pi_1",
        refunds: {
          data: [
            { id: "re_1", status: "succeeded", metadata: { refundId: "r1" } },
            {
              id: "re_2",
              status: "failed",
              metadata: {},
              failure_reason: "expired_or_canceled_card",
            },
          ],
        },
      }),
    );
    expect(response.json()).toMatchObject({ outcome: "processed" });
    expect(vi.mocked(paymentData.recordStripeRefund).mock.calls.map((call) => call[1])).toEqual([
      { stripeRefundId: "re_1", refundId: "r1", status: "succeeded", failureReason: null },
      {
        stripeRefundId: "re_2",
        refundId: undefined,
        status: "failed",
        failureReason: "expired_or_canceled_card",
      },
    ]);
  });

  it.each(["refund.updated", "refund.failed", "charge.refund.updated"])(
    "applies %s to the refund it names, and ignores one it cannot match",
    async (type) => {
      vi.mocked(paymentData.recordStripeRefund).mockResolvedValueOnce(undefined);
      const unmatched = await post(event(type, { id: "re_9", status: "canceled", metadata: {} }));
      expect(unmatched.json()).toMatchObject({ outcome: "ignored" });
      expect(vi.mocked(paymentData.recordStripeRefund).mock.calls[0]?.[1]).toMatchObject({
        stripeRefundId: "re_9",
        status: "failed",
      });
    },
  );

  it("ignores a refunded charge without refunds listed", async () => {
    const response = await post(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1" }));
    expect(response.json()).toMatchObject({ outcome: "ignored" });
  });

  it("records a card dispute for support, and its outcome", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(bookingDetail("user-cian"));
    vi.mocked(disputes.insertCardDispute).mockResolvedValue(true);
    const created = await post(
      event("charge.dispute.created", {
        id: "dp_1",
        payment_intent: "pi_1",
        reason: "product_not_received",
        status: "needs_response",
      }),
    );
    expect(created.json()).toMatchObject({ outcome: "processed" });
    expect(disputes.insertCardDispute).toHaveBeenCalledWith(expect.anything(), {
      bookingId: BOOKING_ID,
      driverId: "user-cian",
      stripeDisputeId: "dp_1",
      reason: "product_not_received",
    });
    vi.mocked(disputes.closeCardDispute).mockResolvedValue(true);
    const closed = await post(
      event("charge.dispute.closed", { id: "dp_1", payment_intent: "pi_1", status: "won" }),
    );
    expect(closed.json()).toMatchObject({ outcome: "processed" });
    expect(disputes.closeCardDispute).toHaveBeenCalledWith(expect.anything(), {
      stripeDisputeId: "dp_1",
      outcome: "won",
      at: expect.any(Date) as unknown,
    });
    expect(payments.calls).toEqual([]);
  });

  it("ignores a card dispute on a payment or booking it does not know", async () => {
    vi.mocked(data.findBookingDetail).mockResolvedValue(undefined);
    const noBooking = await post(
      event("charge.dispute.created", { id: "dp_2", payment_intent: "pi_1", reason: "fraudulent" }),
    );
    expect(noBooking.json()).toMatchObject({ outcome: "ignored" });
    vi.mocked(data.findPaymentByIntent).mockResolvedValue(undefined);
    const noPayment = await post({
      ...event("charge.dispute.created", { id: "dp_3", payment_intent: "pi_x", reason: "x" }),
      id: "evt_x",
    });
    expect(noPayment.json()).toMatchObject({ outcome: "ignored" });
    expect(disputes.insertCardDispute).not.toHaveBeenCalled();
  });

  it("finds a payment by its booking before the intent id is stored", async () => {
    vi.mocked(data.findPaymentByIntent).mockResolvedValue(undefined);
    vi.mocked(data.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", {
        payment: { stripePaymentIntentId: null, status: "pending" },
      }),
    );
    const response = await post(
      event("payment_intent.succeeded", {
        id: "pi_new",
        latest_charge: { id: "ch_new" },
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
