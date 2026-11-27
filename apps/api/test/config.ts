import type { ApiConfig } from "../src/env.ts";
import { parseTaxKeyring } from "../src/tax/crypto.ts";

/** A fixed key for tests only. */
export const TEST_TAX_KEYS = `test-1:${Buffer.alloc(32, 7).toString("base64")}`;

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
    fees: { platformFeeBps: 0, cardFeeBps: 150, cardFeeFixedCents: 25 },
    bookingRateLimitPerHour: 1_000,
    taxRecordRetentionYears: 6,
    taxKeys: parseTaxKeyring(TEST_TAX_KEYS),
    adminUserIds: [],
    sessionStartTimeoutSeconds: 120,
    staleSessionGraceMinutes: 10,
    minBookingMinutes: 30,
    arrivalLeadMinutes: 240,
    ...overrides,
  };
}
