// Where the stack under test listens, and the few values the tests share
// with infra/compose.e2e.yml. None of them is a real secret.

const port = (name: string, fallback: number) => process.env[name] ?? String(fallback);

/** The API as published on the host. */
export const API_URL = process.env.E2E_API_URL ?? `http://127.0.0.1:${port("E2E_API_PORT", 13000)}`;

/** The tests' stateful Stripe (stripe-double/server.ts), for reading what happened. */
export const STRIPE_DOUBLE_URL =
  process.env.E2E_STRIPE_DOUBLE_URL ?? `http://127.0.0.1:${port("E2E_STRIPE_DOUBLE_PORT", 12112)}`;

/** The web app's origin, which the API trusts (CORS_ORIGINS). */
export const APP_ORIGIN = "https://app.e2e.example.com";

/** Signs the webhooks the tests send in Stripe's place (STRIPE_WEBHOOK_SECRET). */
export const STRIPE_WEBHOOK_SECRET = "whsec_e2e_not_a_real_secret";

/** Any test key; the API's STRIPE_SECRET_KEY. */
export const STRIPE_TEST_KEY = "sk_test_e2e";

/** The stack's shortened timings (compose.e2e.yml). */
export const START_TIMEOUT_SECONDS = 8;
export const STALE_SESSION_GRACE_MINUTES = 1;

/** A short tag that keeps this run's emails, phone numbers and serials apart. */
export const RUN_TAG = Date.now().toString(36).slice(-6);
