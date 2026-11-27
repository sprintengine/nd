import { parseEnv } from "@nd/config";
import { describe, expect, it } from "vitest";

import { apiEnvSchema, configFromEnv } from "./env.ts";

const required = {
  DATABASE_URL: "postgres://nd:nd@localhost:5432/nd",
  AUTH_SECRET: "x".repeat(32),
  GATEWAY_INTERNAL_SECRET: "g".repeat(32),
};

describe("apiEnvSchema", () => {
  it("needs only a database and an auth secret for local development", () => {
    const env = apiEnvSchema.parse(required);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 3000,
      PUBLIC_API_URL: "http://localhost:3000",
      CORS_ORIGINS: [],
      OCPP_WSS_URL: "ws://localhost:9000/v16/",
      ONBOARDING_WAIT_MAX_SECONDS: 25,
      GATEWAY_INTERNAL_URL: "http://localhost:9100",
      EMAIL_PROVIDER: "console",
      SMS_PROVIDER: "console",
    });
  });

  it("rejects a short auth secret and a missing database", () => {
    expect(() => parseEnv(apiEnvSchema, { AUTH_SECRET: "short" })).toThrow(
      /AUTH_SECRET[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*AUTH_SECRET/,
    );
  });

  it("parses a list of origins and rejects anything that is not an origin", () => {
    expect(
      apiEnvSchema.parse({
        ...required,
        CORS_ORIGINS: "https://app.example.com, http://localhost:5173",
      }).CORS_ORIGINS,
    ).toEqual(["https://app.example.com", "http://localhost:5173"]);
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, CORS_ORIGINS: "https://app.example.com/path" }),
    ).toThrow(/not an origin/);
  });

  it("insists on the OCPP URL's trailing slash", () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, OCPP_WSS_URL: "wss://ocpp.example.com/v16" }),
    ).toThrow(/trailing|slash/);
  });

  it("needs both halves of a social provider's credentials", () => {
    expect(() => parseEnv(apiEnvSchema, { ...required, GOOGLE_CLIENT_ID: "id" })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
    expect(() => parseEnv(apiEnvSchema, { ...required, APPLE_CLIENT_SECRET: "secret" })).toThrow(
      /APPLE_CLIENT_SECRET/,
    );
  });

  it("requires https and wss in production", () => {
    expect(() => parseEnv(apiEnvSchema, { ...required, NODE_ENV: "production" })).toThrow(
      /PUBLIC_API_URL[\s\S]*OCPP_WSS_URL/,
    );
    expect(apiEnvSchema.parse(production).NODE_ENV).toBe("production");
  });
});

const KEY = Buffer.alloc(32, 1).toString("base64");

/** A complete production environment. */
const production = {
  ...required,
  NODE_ENV: "production",
  PUBLIC_API_URL: "https://api.example.com",
  OCPP_WSS_URL: "wss://ocpp.example.com/v16/",
  EMAIL_PROVIDER: "smtp",
  EMAIL_FROM: "nd <no-reply@example.com>",
  SMTP_HOST: "smtp.example.com",
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM: "+15005550006",
  TAX_ENCRYPTION_KEYS: `k1:${KEY}`,
  VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString("base64url"),
  VAPID_PRIVATE_KEY: Buffer.alloc(32, 9).toString("base64url"),
  VAPID_SUBJECT: "mailto:dev@example.com",
};

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: "nd-test",
  client_email: "push@nd-test.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
});

describe("push providers", () => {
  it("refuse to run production without one unless console pushes are allowed", () => {
    const none = {
      ...production,
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
      VAPID_SUBJECT: "",
    };
    expect(() => parseEnv(apiEnvSchema, none)).toThrow(/ALLOW_CONSOLE_PUSH=true/);
    expect(apiEnvSchema.parse({ ...none, ALLOW_CONSOLE_PUSH: "true" }).ALLOW_CONSOLE_PUSH).toBe(
      "true",
    );
    expect(
      apiEnvSchema.parse({ ...none, FCM_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT })
        .FCM_SERVICE_ACCOUNT_JSON,
    ).toMatchObject({ project_id: "nd-test" });
    expect(() =>
      parseEnv(apiEnvSchema, { ...none, FCM_SERVICE_ACCOUNT_FILE: "/run/secrets/fcm.json" }),
    ).not.toThrow();
  });

  it("parse the service account without echoing it", () => {
    const secret = "not-json-but-secret";
    expect(() => parseEnv(apiEnvSchema, { ...required, FCM_SERVICE_ACCOUNT_JSON: secret })).toThrow(
      /service account key file's JSON/,
    );
    try {
      parseEnv(apiEnvSchema, { ...required, FCM_SERVICE_ACCOUNT_JSON: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}' }),
    ).toThrow(/project_id, client_email and private_key/);
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...required,
        FCM_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
        FCM_SERVICE_ACCOUNT_FILE: "/run/secrets/fcm.json",
      }),
    ).toThrow(/not both/);
  });

  it("need all three VAPID settings, with keys of the right size", () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, VAPID_PUBLIC_KEY: production.VAPID_PUBLIC_KEY }),
    ).toThrow(/VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...production, VAPID_PRIVATE_KEY: production.VAPID_PUBLIC_KEY }),
    ).toThrow(/32 bytes/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...production, VAPID_SUBJECT: "dev@example.com" }),
    ).toThrow(/mailto/);
  });
});

describe("message providers", () => {
  it("refuse console senders in production", () => {
    const run = () =>
      parseEnv(apiEnvSchema, { ...production, EMAIL_PROVIDER: "", SMS_PROVIDER: "console" });
    expect(run).toThrow(/EMAIL_PROVIDER[\s\S]*sends nothing[\s\S]*SMS_PROVIDER/);
    expect(run).toThrow(/ALLOW_CONSOLE_MESSAGES=true/);
  });

  it("allow console senders in production only when asked to", () => {
    const env = apiEnvSchema.parse({
      ...production,
      EMAIL_PROVIDER: "console",
      SMS_PROVIDER: "console",
      ALLOW_CONSOLE_MESSAGES: "true",
    });
    expect(env.EMAIL_PROVIDER).toBe("console");
  });

  it("need the settings of the chosen provider", () => {
    expect(() => parseEnv(apiEnvSchema, { ...required, EMAIL_PROVIDER: "smtp" })).toThrow(
      /EMAIL_FROM[\s\S]*SMTP_HOST/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@b.c" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...production, SMTP_USER: "mailer", SMTP_PASSWORD: "" }),
    ).toThrow(/SMTP_PASSWORD/);
    expect(() => parseEnv(apiEnvSchema, { ...required, SMS_PROVIDER: "twilio" })).toThrow(
      /TWILIO_ACCOUNT_SID[\s\S]*TWILIO_AUTH_TOKEN[\s\S]*TWILIO_FROM/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...production,
        TWILIO_MESSAGING_SERVICE_SID: `MG${"0".repeat(32)}`,
      }),
    ).toThrow(/one of TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/);
  });

  it("check the sender and Twilio ids", () => {
    expect(() => parseEnv(apiEnvSchema, { ...production, EMAIL_FROM: "nobody" })).toThrow(
      /EMAIL_FROM/,
    );
    expect(() => parseEnv(apiEnvSchema, { ...production, TWILIO_ACCOUNT_SID: "AC1" })).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
  });
});

describe("durations", () => {
  it("default to the production values and may be shortened", () => {
    expect(configFromEnv(apiEnvSchema.parse(required))).toMatchObject({
      sessionStartTimeoutSeconds: 120,
      staleSessionGraceMinutes: 10,
      minBookingMinutes: 30,
    });
    expect(
      configFromEnv(
        apiEnvSchema.parse({
          ...required,
          SESSION_START_TIMEOUT_SECONDS: "10",
          STALE_SESSION_GRACE_MINUTES: "1",
          MIN_BOOKING_MINUTES: "2",
        }),
      ),
    ).toMatchObject({
      sessionStartTimeoutSeconds: 10,
      staleSessionGraceMinutes: 1,
      minBookingMinutes: 2,
    });
  });

  it("refuse values out of range", () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...required,
        SESSION_START_TIMEOUT_SECONDS: "1",
        STALE_SESSION_GRACE_MINUTES: "0",
        MIN_BOOKING_MINUTES: "0",
      }),
    ).toThrow(
      /SESSION_START_TIMEOUT_SECONDS[\s\S]*STALE_SESSION_GRACE_MINUTES[\s\S]*MIN_BOOKING_MINUTES/,
    );
  });
});

describe("E2E_TEST_HOOKS", () => {
  it("is off by default and allows the capture senders when on, outside production", () => {
    expect(apiEnvSchema.parse(required).E2E_TEST_HOOKS).toBe("false");
    const env = apiEnvSchema.parse({
      ...required,
      NODE_ENV: "test",
      E2E_TEST_HOOKS: "true",
      EMAIL_PROVIDER: "capture",
      SMS_PROVIDER: "capture",
    });
    expect(env).toMatchObject({ EMAIL_PROVIDER: "capture", SMS_PROVIDER: "capture" });
  });

  it("refuses the capture senders without it", () => {
    expect(() =>
      parseEnv(apiEnvSchema, { ...required, EMAIL_PROVIDER: "capture", SMS_PROVIDER: "capture" }),
    ).toThrow(
      /E2E_TEST_HOOKS=true[\s\S]*EMAIL_PROVIDER[\s\S]*E2E_TEST_HOOKS=true[\s\S]*SMS_PROVIDER/,
    );
  });

  it("refuses to start in production with it on", () => {
    expect(() => parseEnv(apiEnvSchema, { ...production, E2E_TEST_HOOKS: "true" })).toThrow(
      /must not be true in production[\s\S]*E2E_TEST_HOOKS/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...production,
        E2E_TEST_HOOKS: "true",
        EMAIL_PROVIDER: "capture",
        SMS_PROVIDER: "capture",
      }),
    ).toThrow(/must not be true in production/);
  });
});

describe("TAX_ENCRYPTION_KEYS", () => {
  it("is required in production", () => {
    expect(() => parseEnv(apiEnvSchema, { ...production, TAX_ENCRYPTION_KEYS: "" })).toThrow(
      /TAX_ENCRYPTION_KEYS/,
    );
  });

  it("parses into a keyring with the first key current", () => {
    const config = configFromEnv(
      apiEnvSchema.parse({ ...required, TAX_ENCRYPTION_KEYS: `new:${KEY},old:${KEY}` }),
    );
    expect(config.taxKeys?.currentId).toBe("new");
    expect([...(config.taxKeys?.keys.keys() ?? [])]).toEqual(["new", "old"]);
  });

  it("reports a bad key without echoing it", () => {
    const secret = Buffer.alloc(16, 9).toString("base64");
    let message = "";
    try {
      parseEnv(apiEnvSchema, { ...required, TAX_ENCRYPTION_KEYS: `k1:${secret}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TAX_ENCRYPTION_KEYS/);
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain(secret);
  });
});

describe("optional variables", () => {
  it("treat an empty value as unset, as Compose passes one", () => {
    const env = apiEnvSchema.parse({
      ...required,
      COOKIE_DOMAIN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_API_BASE_URL: "",
    });
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_API_BASE_URL).toBeUndefined();
  });
});

describe("configFromEnv", () => {
  it("derives secure cookies from an https base URL and trims trailing slashes", () => {
    const config = configFromEnv(
      apiEnvSchema.parse({
        ...required,
        PUBLIC_API_URL: "https://api.example.com/",
        PUBLIC_APP_URL: "https://app.example.com/",
        COOKIE_DOMAIN: "example.com",
        AUTH_RATE_LIMIT: "off",
      }),
    );
    expect(config).toMatchObject({
      production: false,
      publicApiUrl: "https://api.example.com",
      publicAppUrl: "https://app.example.com",
      secureCookies: true,
      cookieDomain: "example.com",
      authRateLimit: false,
      apple: undefined,
      google: undefined,
    });
  });

  it("configures Apple and Google only when their credentials are set", () => {
    const config = configFromEnv(
      apiEnvSchema.parse({
        ...required,
        APPLE_CLIENT_ID: "apple-id",
        APPLE_CLIENT_SECRET: "apple-secret",
        APPLE_APP_BUNDLE_ID: "com.example.app",
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
      }),
    );
    expect(config.apple).toEqual({
      clientId: "apple-id",
      clientSecret: "apple-secret",
      appBundleId: "com.example.app",
    });
    expect(config.google).toEqual({ clientId: "google-id", clientSecret: "google-secret" });
    expect(config.secureCookies).toBe(false);
  });

  it("reads the webhook secret and the fees: no platform fee, the card fee passed on", () => {
    expect(configFromEnv(apiEnvSchema.parse(required))).toMatchObject({
      stripeWebhookSecret: undefined,
      fees: { platformFeeBps: 0, cardFeeBps: 150, cardFeeFixedCents: 25 },
      bookingRateLimitPerHour: 20,
      taxRecordRetentionYears: 6,
      arrivalLeadMinutes: 240,
    });
    const config = configFromEnv(
      apiEnvSchema.parse({
        ...required,
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        PLATFORM_FEE_BPS: "250",
        CARD_FEE_BPS: "140",
        CARD_FEE_FIXED_CENTS: "20",
        BOOKING_RATE_LIMIT_PER_HOUR: "5",
        TAX_RECORD_RETENTION_YEARS: "7",
        ARRIVAL_LEAD_MINUTES: "30",
      }),
    );
    expect(config).toMatchObject({
      stripeWebhookSecret: "whsec_example",
      fees: { platformFeeBps: 250, cardFeeBps: 140, cardFeeFixedCents: 20 },
      bookingRateLimitPerHour: 5,
      taxRecordRetentionYears: 7,
      arrivalLeadMinutes: 30,
    });
    for (const bad of [
      { PLATFORM_FEE_BPS: "10001" },
      { CARD_FEE_BPS: "-1" },
      { CARD_FEE_FIXED_CENTS: "1001" },
      { TAX_RECORD_RETENTION_YEARS: "0" },
      { ARRIVAL_LEAD_MINUTES: "1441" },
    ]) {
      expect(apiEnvSchema.safeParse({ ...required, ...bad }).success).toBe(false);
    }
  });

  it("reads the admin allowlist, which is empty by default", () => {
    expect(configFromEnv(apiEnvSchema.parse(required)).adminUserIds).toEqual([]);
    expect(
      configFromEnv(apiEnvSchema.parse({ ...required, ADMIN_USER_IDS: " user-a, ,user-b " }))
        .adminUserIds,
    ).toEqual(["user-a", "user-b"]);
  });
});
