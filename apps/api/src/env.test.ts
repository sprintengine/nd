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
};

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

  it("reads the webhook secret and the platform fee, which defaults to nothing", () => {
    expect(configFromEnv(apiEnvSchema.parse(required))).toMatchObject({
      stripeWebhookSecret: undefined,
      platformFeeBps: 0,
    });
    const config = configFromEnv(
      apiEnvSchema.parse({
        ...required,
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        PLATFORM_FEE_BPS: "250",
      }),
    );
    expect(config).toMatchObject({ stripeWebhookSecret: "whsec_example", platformFeeBps: 250 });
    expect(apiEnvSchema.safeParse({ ...required, PLATFORM_FEE_BPS: "10001" }).success).toBe(false);
  });
});
