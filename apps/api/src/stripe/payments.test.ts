import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { HttpProblem } from "../http/problem.ts";
import { type PaymentsSdk, stripePaymentsFrom, unconfiguredStripePayments } from "./payments.ts";

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
    transfers: { create: vi.fn(() => Promise.resolve({ id: "tr_1" })) },
  };
  return { sdk, payments: stripePaymentsFrom(sdk as unknown as PaymentsSdk) };
}

const authorisation = {
  bookingId: "b1",
  amountCents: 1000,
  currency: "EUR",
  customerId: "cus_1",
  paymentMethodId: "pm_1",
  idempotencyKey: "booking-b1-authorise",
};

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

  it("authorises off-session with manual capture, on the platform account", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(payments.authorise(authorisation)).resolves.toEqual({
      status: "authorised",
      paymentIntentId: "pi_1",
      amountCents: 1000,
    });
    const [params, options] = sdk.paymentIntents.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      unknown,
    ];
    expect(params).toMatchObject({
      amount: 1000,
      currency: "eur",
      capture_method: "manual",
      confirm: true,
      off_session: true,
      transfer_group: "b1",
      metadata: { bookingId: "b1" },
    });
    expect(params).not.toHaveProperty("transfer_data");
    expect(options).toEqual({ idempotencyKey: "booking-b1-authorise" });
  });

  it("reports an intent that was not authorised, and card declines, as failures", async () => {
    const { sdk, payments } = fakeSdk();
    sdk.paymentIntents.create.mockResolvedValueOnce(intent({ status: "requires_action" }));
    await expect(payments.authorise(authorisation)).resolves.toEqual({
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
    await expect(payments.authorise(authorisation)).resolves.toEqual({
      status: "failed",
      paymentIntentId: "pi_2",
      reason: "insufficient_funds",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeCardError({ message: "declined", code: "expired_card" }),
    );
    await expect(payments.authorise(authorisation)).resolves.toMatchObject({
      paymentIntentId: null,
      reason: "expired_card",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeCardError({ message: "declined" }),
    );
    await expect(payments.authorise(authorisation)).resolves.toMatchObject({
      reason: "card_declined",
    });
    sdk.paymentIntents.create.mockRejectedValueOnce(new Error("network"));
    await expect(payments.authorise(authorisation)).rejects.toThrow("network");
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

  it("captures part of an authorisation", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(
      payments.capture({ paymentIntentId: "pi_1", amountCents: 250, idempotencyKey: "k" }),
    ).resolves.toEqual({ chargeId: "ch_1", amountCents: 250 });
    expect(sdk.paymentIntents.capture).toHaveBeenCalledWith(
      "pi_1",
      { amount_to_capture: 250 },
      { idempotencyKey: "k" },
    );
    sdk.paymentIntents.capture.mockResolvedValueOnce(
      intent({ amount_received: 250, latest_charge: { id: "ch_2" } }),
    );
    expect(
      (await payments.capture({ paymentIntentId: "pi_1", amountCents: 250, idempotencyKey: "k" }))
        .chargeId,
    ).toBe("ch_2");
  });

  it("transfers to the connected account from the charge", async () => {
    const { sdk, payments } = fakeSdk();
    await expect(
      payments.transfer({
        amountCents: 900,
        currency: "EUR",
        destination: "acct_1",
        sourceTransaction: "ch_1",
        transferGroup: "b1",
        metadata: { bookingId: "b1" },
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({ id: "tr_1" });
    expect(sdk.transfers.create).toHaveBeenCalledWith(
      {
        amount: 900,
        currency: "eur",
        destination: "acct_1",
        source_transaction: "ch_1",
        transfer_group: "b1",
        metadata: { bookingId: "b1" },
      },
      { idempotencyKey: "k" },
    );
  });
});

describe("unconfiguredStripePayments", () => {
  it("answers 503 for every call", async () => {
    await expect(unconfiguredStripePayments.listCards("cus_1")).rejects.toBeInstanceOf(HttpProblem);
    await expect(unconfiguredStripePayments.authorise(authorisation)).rejects.toMatchObject({
      status: 503,
      code: "payments-unavailable",
    });
  });
});
