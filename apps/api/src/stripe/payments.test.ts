import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { HttpProblem } from "../http/problem.ts";
import {
  PaymentRejectedError,
  type PaymentsSdk,
  stripePaymentsFrom,
  unconfiguredStripePayments,
} from "./payments.ts";

const visa = { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 };

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_1",
    status: "requires_capture",
    amount: 1000,
    amount_capturable: 1000,
    amount_received: 0,
    latest_charge: null,
    ...overrides,
  } as Awaited<ReturnType<PaymentsSdk["paymentIntents"]["create"]>>;
}

function fakeSdk() {
  const sdk = {
    customers: {
      create: vi.fn(() => Promise.resolve({ id: "cus_1" })),
      retrieve: vi.fn(() =>
        Promise.resolve({ invoice_settings: { default_payment_method: { id: "pm_1" } } }),
      ),
      update: vi.fn(() => Promise.resolve({})),
      del: vi.fn(() => Promise.resolve({ id: "cus_1", deleted: true })),
    },
    setupIntents: {
      create: vi.fn(() => Promise.resolve({ id: "seti_1", client_secret: "seti_1_secret" })),
    },
    paymentMethods: {
      list: vi.fn(() =>
        Promise.resolve({
          data: [
            { id: "pm_1", customer: "cus_1", card: visa },
            { id: "pm_sepa", customer: "cus_1", card: undefined },
          ],
        }),
      ),
      retrieve: vi.fn(() => Promise.resolve({ id: "pm_1", customer: "cus_1", card: visa })),
    },
    paymentIntents: {
      create: vi.fn(() => Promise.resolve(intent())),
      retrieve: vi.fn(() => Promise.resolve(intent({ status: "canceled" }))),
      cancel: vi.fn(() => Promise.resolve(intent({ status: "canceled" }))),
      capture: vi.fn(() =>
        Promise.resolve(
          intent({ status: "succeeded", amount_received: 250, latest_charge: "ch_1" }),
        ),
      ),
    },
    refunds: {
      create: vi.fn((): Promise<{ id: string; status: string | null }> =>
        Promise.resolve({ id: "re_1", status: "succeeded" }),
      ),
      retrieve: vi.fn(() => Promise.resolve({ id: "re_1", status: "canceled" })),
    },
  };
  return { sdk, payments: stripePaymentsFrom(sdk as unknown as PaymentsSdk) };
}

const charge = {
  bookingId: "b1",
  amountCents: 1000,
  currency: "EUR",
  customerId: "cus_1",
  paymentMethodId: "pm_1",
  destination: "acct_host",
  applicationFeeCents: 40,
  captureMethod: "automatic",
  idempotencyKey: "booking-b1-charge",
} as const;

describe("stripePaymentsFrom", () => {
  it("creates a customer per user, idempotently", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(
      payments.createCustomer({ userId: "u1", email: "dev@example.com", name: "Cian" }),
    ).resolves.toEqual({ id: "cus_1" });
    expect(sdk.customers.create).toHaveBeenCalledWith(
      { email: "dev@example.com", name: "Cian", metadata: { userId: "u1" } },
      { idempotencyKey: "customer-u1" },
    );
  });

  it("creates an off-session SetupIntent", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(
      payments.createSetupIntent({ customerId: "cus_1", userId: "u1", idempotencyKey: "k" }),
    ).resolves.toEqual({ id: "seti_1", clientSecret: "seti_1_secret" });
    expect(sdk.setupIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1", usage: "off_session" }),
      { idempotencyKey: "k" },
    );
    sdk.setupIntents.create.mockResolvedValueOnce({ id: "seti_2", client_secret: null } as never);
    await expect(
      payments.createSetupIntent({ customerId: "cus_1", userId: "u1", idempotencyKey: "k2" }),
    ).rejects.toThrow(/client secret/);
  });

  it("lists cards with brand, last four and expiry, and the default", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(payments.listCards("cus_1")).resolves.toEqual({
      cards: [{ id: "pm_1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 }],
      defaultCardId: "pm_1",
    });
    sdk.customers.retrieve.mockResolvedValueOnce({ deleted: true } as never);
    expect((await payments.listCards("cus_1")).defaultCardId).toBeNull();
    sdk.customers.retrieve.mockResolvedValueOnce({
      invoice_settings: { default_payment_method: null },
    } as never);
    expect((await payments.listCards("cus_1")).defaultCardId).toBeNull();
  });

  it("finds a card only on its own customer", async () => {
    const { sdk, payments } = fakeSdk();
    expect(await payments.findCard("cus_1", "pm_1")).toMatchObject({ id: "pm_1" });
    expect(await payments.findCard("cus_2", "pm_1")).toBeUndefined();
    sdk.paymentMethods.retrieve.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ message: "No such PaymentMethod" }),
    );
    expect(await payments.findCard("cus_1", "pm_x")).toBeUndefined();
    sdk.paymentMethods.retrieve.mockRejectedValueOnce(new Error("network"));
    await expect(payments.findCard("cus_1", "pm_x")).rejects.toThrow("network");
  });

  it("sets the default card", async () => {
    const { sdk, payments } = fakeSdk();
    await payments.setDefaultCard("cus_1", "pm_1");
    expect(sdk.customers.update).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_1" },
    });
  });

  it("charges off-session as a destination charge with the application fee", async () => {
    const { sdk, payments } = fakeSdk();
    sdk.paymentIntents.create.mockResolvedValueOnce(
      intent({ status: "succeeded", latest_charge: "ch_1" }),
    );
    await expect(payments.charge(charge)).resolves.toEqual({
      status: "paid",
      paymentIntentId: "pi_1",
      chargeId: "ch_1",
    });
    const [params, options] = sdk.paymentIntents.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      unknown,
    ];
    expect(params).toMatchObject({
      amount: 1000,
      currency: "eur",
      capture_method: "automatic",
      confirm: true,
      off_session: true,
      transfer_data: { destination: "acct_host" },
      application_fee_amount: 40,
      transfer_group: "b1",
      metadata: { bookingId: "b1" },
    });
    expect(options).toEqual({ idempotencyKey: "booking-b1-charge" });
  });

  it("holds a request's price with manual capture", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(payments.charge({ ...charge, captureMethod: "manual" })).resolves.toEqual({
      status: "authorised",
      paymentIntentId: "pi_1",
    });
    expect(sdk.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ capture_method: "manual" }),
      { idempotencyKey: "booking-b1-charge" },
    );
    sdk.paymentIntents.create.mockResolvedValueOnce(intent({ status: "processing" }));
    await expect(payments.charge(charge)).resolves.toEqual({
      status: "pending",
      paymentIntentId: "pi_1",
    });
  });

  it("reports an intent that did not go through, and card declines, as failures", async () => {
    const { sdk, payments } = fakeSdk();
    sdk.paymentIntents.create.mockResolvedValueOnce(intent({ status: "requires_action" }));
    await expect(payments.charge(charge)).resolves.toEqual({
      status: "failed",
      paymentIntentId: "pi_1",
      reason: "requires_action",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeCardError({
        message: "declined",
        code: "card_declined",
        decline_code: "insufficient_funds",
        payment_intent: { id: "pi_2" } as Stripe.PaymentIntent,
      }),
    );
    await expect(payments.charge(charge)).resolves.toEqual({
      status: "failed",
      paymentIntentId: "pi_2",
      reason: "insufficient_funds",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeCardError({ message: "declined", code: "expired_card" }),
    );
    await expect(payments.charge(charge)).resolves.toMatchObject({
      paymentIntentId: null,
      reason: "expired_card",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeCardError({ message: "declined" }),
    );
    await expect(payments.charge(charge)).resolves.toMatchObject({ reason: "card_declined" });
    sdk.paymentIntents.create.mockRejectedValueOnce(new Error("network"));
    await expect(payments.charge(charge)).rejects.toThrow("network");
  });

  it("releases an authorisation, accepting one already released", async () => {
    const { sdk, payments } = fakeSdk();
    await payments.cancelAuthorisation({ paymentIntentId: "pi_1", idempotencyKey: "k" });
    expect(sdk.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: "k" });
    const unexpected = () =>
      new Stripe.errors.StripeInvalidRequestError({
        message: "already canceled",
        code: "payment_intent_unexpected_state",
      });
    sdk.paymentIntents.cancel.mockRejectedValueOnce(unexpected());
    await expect(
      payments.cancelAuthorisation({ paymentIntentId: "pi_1", idempotencyKey: "k" }),
    ).resolves.toBeUndefined();
    sdk.paymentIntents.cancel.mockRejectedValueOnce(unexpected());
    sdk.paymentIntents.retrieve.mockResolvedValueOnce(intent({ status: "succeeded" }));
    await expect(
      payments.cancelAuthorisation({ paymentIntentId: "pi_1", idempotencyKey: "k" }),
    ).rejects.toThrow("already canceled");
  });

  it("captures the whole hold, and reports one that lapsed", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(
      payments.capture({ paymentIntentId: "pi_1", idempotencyKey: "k" }),
    ).resolves.toEqual({ status: "paid", chargeId: "ch_1" });
    expect(sdk.paymentIntents.capture).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: "k" });
    sdk.paymentIntents.capture.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: "canceled",
        code: "payment_intent_unexpected_state",
      }),
    );
    await expect(
      payments.capture({ paymentIntentId: "pi_1", idempotencyKey: "k" }),
    ).resolves.toEqual({ status: "failed", reason: "authorisation_expired" });
    sdk.paymentIntents.capture.mockRejectedValueOnce(new Error("network"));
    await expect(
      payments.capture({ paymentIntentId: "pi_1", idempotencyKey: "k" }),
    ).rejects.toThrow("network");
  });

  it("refunds with the host's share and the application fee reversed", async () => {
    const { sdk, payments } = fakeSdk();
    const input = {
      paymentIntentId: "pi_1",
      amountCents: 500,
      metadata: { bookingId: "b1" },
      idempotencyKey: "refund-r1",
    };
    await expect(payments.refund(input)).resolves.toEqual({ id: "re_1", status: "succeeded" });
    expect(sdk.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: "pi_1",
        amount: 500,
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: { bookingId: "b1" },
      },
      { idempotencyKey: "refund-r1" },
    );
    for (const [status, expected] of [
      ["pending", "pending"],
      ["requires_action", "pending"],
      [null, "pending"],
      ["failed", "failed"],
      ["canceled", "failed"],
    ] as const) {
      sdk.refunds.create.mockResolvedValueOnce({ id: "re_2", status });
      expect((await payments.refund(input)).status).toBe(expected);
    }
  });

  it("looks a refund up by id", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(payments.retrieveRefund("re_1")).resolves.toEqual({
      id: "re_1",
      status: "failed",
    });
    expect(sdk.refunds.retrieve).toHaveBeenCalledWith("re_1");
  });

  it("tells a refusal that will not go away from an error worth retrying", async () => {
    const { sdk, payments } = fakeSdk();
    const input = {
      paymentIntentId: "pi_1",
      amountCents: 500,
      metadata: {},
      idempotencyKey: "refund-r1",
    };
    sdk.refunds.create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: "already refunded",
        code: "charge_already_refunded",
      }),
    );
    await expect(payments.refund(input)).rejects.toEqual(
      expect.objectContaining({ name: "PaymentRejectedError", code: "charge_already_refunded" }),
    );
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripePermissionError({
        message: "capability lost",
        type: "invalid_request_error",
      }),
    );
    await expect(payments.charge(charge)).rejects.toBeInstanceOf(PaymentRejectedError);
    for (const transient of [
      new Stripe.errors.StripeConnectionError({ message: "no route" }),
      new Stripe.errors.StripeAPIError({ message: "server error" }),
      new Stripe.errors.StripeRateLimitError({ message: "slow down" }),
      new Stripe.errors.StripeIdempotencyError({
        message: "in use",
        code: "idempotency_key_in_use",
      }),
    ]) {
      sdk.paymentIntents.capture.mockRejectedValueOnce(transient);
      await expect(payments.capture({ paymentIntentId: "pi_1", idempotencyKey: "k" })).rejects.toBe(
        transient,
      );
    }
  });

  it("looks a PaymentIntent up by id", async () => {
    const { sdk, payments } = fakeSdk();
    sdk.paymentIntents.retrieve.mockResolvedValueOnce(intent({ status: "processing" }));
    await expect(payments.retrieveCharge("pi_1")).resolves.toEqual({
      status: "pending",
      paymentIntentId: "pi_1",
    });
    sdk.paymentIntents.retrieve.mockResolvedValueOnce(
      intent({ status: "requires_payment_method" }),
    );
    await expect(payments.retrieveCharge("pi_1")).resolves.toMatchObject({
      status: "failed",
      reason: "requires_payment_method",
    });
  });

  it("deletes a customer, accepting one already gone", async () => {
    const { sdk, payments } = fakeSdk();
    await payments.deleteCustomer("cus_1");
    expect(sdk.customers.del).toHaveBeenCalledWith("cus_1");
    sdk.customers.del.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such customer",
        code: "resource_missing",
      }),
    );
    await expect(payments.deleteCustomer("cus_gone")).resolves.toBeUndefined();
    sdk.customers.del.mockRejectedValueOnce(new Error("network"));
    await expect(payments.deleteCustomer("cus_1")).rejects.toThrow("network");
  });
});

describe("unconfiguredStripePayments", () => {
  it("answers 503 for every call", async () => {
    await expect(unconfiguredStripePayments.listCards("cus_1")).rejects.toBeInstanceOf(HttpProblem);
    await expect(unconfiguredStripePayments.charge(charge)).rejects.toMatchObject({
      status: 503,
      code: "payments-unavailable",
    });
  });
});
