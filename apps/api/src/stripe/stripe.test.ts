import { describe, expect, it, vi } from "vitest";

import { HttpProblem } from "../http/problem.ts";
import {
  createStripeConnect,
  stripeConnectFrom,
  type StripeSdk,
  unconfiguredStripeConnect,
} from "./stripe.ts";

function fakeSdk() {
  const accounts = vi.fn<StripeSdk["accounts"]["create"]>(() => Promise.resolve({ id: "acct_1" }));
  const links = vi.fn<StripeSdk["accountLinks"]["create"]>(() =>
    Promise.resolve({ url: "https://connect.stripe.test/setup/acct_1", expires_at: 1_900_000_000 }),
  );
  const sdk: StripeSdk = { accounts: { create: accounts }, accountLinks: { create: links } };
  return { sdk, accounts, links };
}

describe("stripeConnectFrom", () => {
  it("creates an Express account for transfers, idempotently per host", async () => {
    const { sdk, accounts } = fakeSdk();
    const account = await stripeConnectFrom(sdk).createExpressAccount({
      hostId: "host-1",
      email: "dev@example.com",
      country: "IE",
    });
    expect(account).toEqual({ id: "acct_1" });
    expect(accounts).toHaveBeenCalledWith(
      {
        type: "express",
        country: "IE",
        email: "dev@example.com",
        capabilities: { transfers: { requested: true } },
        metadata: { hostId: "host-1" },
      },
      { idempotencyKey: "host-account-host-1" },
    );
  });

  it("creates an onboarding link", async () => {
    const { sdk, links } = fakeSdk();
    const link = await stripeConnectFrom(sdk).createAccountLink({
      accountId: "acct_1",
      refreshUrl: "https://app.example.com/refresh",
      returnUrl: "https://app.example.com/return",
    });
    expect(link).toEqual({
      url: "https://connect.stripe.test/setup/acct_1",
      expiresAt: new Date(1_900_000_000_000),
    });
    expect(links).toHaveBeenCalledWith({
      account: "acct_1",
      refresh_url: "https://app.example.com/refresh",
      return_url: "https://app.example.com/return",
      type: "account_onboarding",
    });
  });
});

describe("createStripeConnect", () => {
  it("builds a client, optionally pointed at another API base URL", () => {
    expect(createStripeConnect("sk_test_x")).toHaveProperty("createAccountLink");
    expect(createStripeConnect("sk_test_x", "http://stripe-mock:12111")).toHaveProperty(
      "createAccountLink",
    );
    expect(createStripeConnect("sk_test_x", "https://stripe.example.com")).toHaveProperty(
      "createExpressAccount",
    );
    expect(createStripeConnect("sk_test_x", "http://stripe.example.com")).toHaveProperty(
      "createExpressAccount",
    );
  });
});

describe("unconfiguredStripeConnect", () => {
  it("answers 503", async () => {
    await expect(
      unconfiguredStripeConnect.createExpressAccount({ hostId: "h", email: "e", country: "IE" }),
    ).rejects.toMatchObject({ status: 503, code: "payments-unavailable" });
    await expect(
      unconfiguredStripeConnect.createAccountLink({
        accountId: "a",
        refreshUrl: "r",
        returnUrl: "u",
      }),
    ).rejects.toBeInstanceOf(HttpProblem);
  });
});
