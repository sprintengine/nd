import type { ApiConfig } from "../src/env.ts";

/** Settings for tests: plain http on localhost, no auth rate limit, short onboarding waits. */
export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    production: false,
    publicApiUrl: "http://localhost:3000",
    publicAppUrl: "http://localhost:5173",
    authSecret: "test-secret-that-is-at-least-32-characters-long",
    corsOrigins: ["http://localhost:5173"],
    cookieDomain: undefined,
    secureCookies: false,
    trustProxyHops: 0,
    authRateLimit: false,
    searchRateLimitPerMinute: 1_000,
    apple: undefined,
    google: undefined,
    ocppWssUrl: "wss://ocpp.example.com/v16/",
    onboardingWaitMaxSeconds: 5,
    stripeWebhookSecret: "whsec_test_secret",
    platformFeeBps: 0,
    ...overrides,
  };
}
