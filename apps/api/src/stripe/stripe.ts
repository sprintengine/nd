import Stripe from "stripe";

import { HttpProblem } from "../http/problem.ts";

/** A Stripe-hosted onboarding page for a host's connected account. */
export interface AccountLink {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * The Stripe Connect calls host onboarding makes. Payments add their own
 * calls when they land; tests use a fake.
 */
export interface StripeConnect {
  /** Creates an Express connected account that can receive transfers. */
  createExpressAccount(input: {
    readonly hostId: string;
    readonly email: string;
    readonly country: string;
  }): Promise<{ id: string }>;
  /** A one-time link to Stripe's onboarding for an account. */
  createAccountLink(input: {
    readonly accountId: string;
    readonly refreshUrl: string;
    readonly returnUrl: string;
  }): Promise<AccountLink>;
}

/** The part of the Stripe SDK used here, so tests can pass a fake. */
export interface StripeSdk {
  readonly accounts: {
    create(
      params: Stripe.AccountCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
  };
  readonly accountLinks: {
    create(params: Stripe.AccountLinkCreateParams): Promise<{ url: string; expires_at: number }>;
  };
}

/** Stripe Connect on top of the Stripe SDK. */
export function stripeConnectFrom(sdk: StripeSdk): StripeConnect {
  return {
    async createExpressAccount({ hostId, email, country }) {
      const account = await sdk.accounts.create(
        {
          type: "express",
          country,
          email,
          capabilities: { transfers: { requested: true } },
          metadata: { hostId },
        },
        // A retried request for the same host returns the same account.
        { idempotencyKey: `host-account-${hostId}` },
      );
      return { id: account.id };
    },
    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      const link = await sdk.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
    },
  };
}

/** Stripe Connect with a secret key; `apiBaseUrl` points it at stripe-mock in tests. */
export function createStripeConnect(secretKey: string, apiBaseUrl?: string): StripeConnect {
  const base = apiBaseUrl === undefined ? undefined : new URL(apiBaseUrl);
  const sdk = new Stripe(secretKey, {
    maxNetworkRetries: 2,
    ...(base === undefined
      ? {}
      : {
          host: base.hostname,
          port: base.port === "" ? (base.protocol === "https:" ? 443 : 80) : Number(base.port),
          protocol: base.protocol === "https:" ? "https" : "http",
        }),
  });
  return stripeConnectFrom(sdk);
}

/** Used when no Stripe key is configured: becoming a host answers 503. */
export const unconfiguredStripeConnect: StripeConnect = {
  createExpressAccount: unconfigured,
  createAccountLink: unconfigured,
};

function unconfigured(): Promise<never> {
  return Promise.reject(
    new HttpProblem(503, "payments-unavailable", "Payments are not configured on this server"),
  );
}
