import { port } from "@nd/config";
import {
  ARRIVAL_LEAD_MINUTES,
  DEFAULT_CARD_FEE_BPS,
  DEFAULT_CARD_FEE_FIXED_CENTS,
  type FeeSettings,
  STALE_SESSION_GRACE_MINUTES,
  START_TIMEOUT_SECONDS,
} from "@nd/domain";
import { z } from "zod";

import { MIN_BOOKING_MINUTES } from "./bookings/rules.ts";
import type { FcmServiceAccount } from "./push/fcm.ts";
import { parseTaxKeyring, type TaxKeyring } from "./tax/crypto.ts";

const NODE_ENVS = ["development", "test", "production"] as const;
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Comma-separated list of origins, e.g. `https://app.example.com,http://localhost:5173`. */
const originList = z
  .string()
  .default("")
  .transform((value, context) => {
    const origins: string[] = [];
    for (const item of value.split(",").map((entry) => entry.trim())) {
      if (item === "") continue;
      if (!URL.canParse(item) || new URL(item).origin !== item) {
        context.addIssue({
          code: "custom",
          message: `not an origin (scheme://host[:port]): ${item}`,
        });
        return z.NEVER;
      }
      origins.push(item);
    }
    return origins;
  });

/**
 * An optional value. An empty string counts as unset, because Compose passes
 * `${NAME:-}` through as one when the variable is not set.
 */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const optionalSecret = optional(z.string().min(1));

/** A value with a default, which an empty string also selects. */
function orDefault<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

/** `name@domain` or `Display Name <name@domain>`, on one line. */
const sender = z
  .string()
  .regex(
    /^[^\r\n<>]*<[^\s@<>]+@[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+$/,
    "must be an address or Name <address>",
  );

/** `id:base64key,...`, parsed into a keyring; errors never echo key material. */
const taxKeys = z.string().transform((value, context): TaxKeyring => {
  try {
    return parseTaxKeyring(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

/** A Google service account key as JSON; errors never echo its content. */
export const serviceAccountJson = z.string().transform((value, context): FcmServiceAccount => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be the service account key file's JSON" });
    return z.NEVER;
  }
  const account = z
    .object({
      project_id: z.string().min(1),
      client_email: z.string().min(1),
      private_key: z.string().min(1),
    })
    .safeParse(parsed);
  if (!account.success) {
    context.addIssue({
      code: "custom",
      message: "must be a service account key with project_id, client_email and private_key",
    });
    return z.NEVER;
  }
  return account.data;
});

/** A base64url key of `bytes` bytes, such as a VAPID key. */
const base64UrlKey = (bytes: number) =>
  z
    .string()
    .refine(
      (value) => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === bytes,
      `must be a base64url key of ${String(bytes)} bytes`,
    );

/**
 * Environment the API reads at start-up. Every value is validated here, so a
 * missing or malformed variable stops the process with a readable message.
 * Never log values from the parsed result: some are secrets.
 */
export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: port.default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Public base URL of this API; magic links and OAuth callbacks point here. */
    PUBLIC_API_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
    /** Public URL of the web app; Stripe returns hosts here after onboarding. */
    PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:5173"),
    /** Signs and encrypts Better Auth cookies and tokens. At least 32 characters. */
    AUTH_SECRET: z.string().min(32),
    /** Browser origins allowed to call the API with cookies (CORS and Better Auth's origin check). */
    CORS_ORIGINS: originList,
    /** Parent domain for the session cookie (e.g. `example.com`), to share it with app.<domain>. */
    COOKIE_DOMAIN: optional(z.string().min(1)),
    /** Number of reverse proxies in front of the API whose X-Forwarded-For is trusted. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /** Turns Better Auth's rate limiter off (only for local experiments). */
    AUTH_RATE_LIMIT: z.enum(["on", "off"]).default("on"),
    /** Requests per minute per client IP on charger search and listing. */
    SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
    APPLE_CLIENT_ID: optionalSecret,
    APPLE_CLIENT_SECRET: optionalSecret,
    APPLE_APP_BUNDLE_ID: optional(z.string().min(1)),
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_CLIENT_SECRET: optionalSecret,
    /**
     * How email is sent: `smtp`, `resend`, `console` (written to the log; development), or
     * `capture` (kept in memory for GET /e2e/messages; end-to-end tests, with E2E_TEST_HOOKS).
     */
    EMAIL_PROVIDER: orDefault(z.enum(["console", "smtp", "resend", "capture"]).default("console")),
    /** Sender of every email, e.g. `nd <no-reply@example.com>`. Required by smtp and resend. */
    EMAIL_FROM: optional(sender),
    SMTP_HOST: optional(z.string().min(1)),
    SMTP_PORT: port.default(587),
    /** TLS from the first byte (port 465). Otherwise STARTTLS is required. Defaults to true on 465. */
    SMTP_SECURE: optional(z.enum(["true", "false"])),
    SMTP_USER: optionalSecret,
    SMTP_PASSWORD: optionalSecret,
    RESEND_API_KEY: optionalSecret,
    /** How phone codes are sent: `twilio`, `console` (development), or `capture` (as for email). */
    SMS_PROVIDER: orDefault(z.enum(["console", "twilio", "capture"]).default("console")),
    TWILIO_ACCOUNT_SID: optional(
      z.string().regex(/^AC[0-9a-fA-F]{32}$/, "must be AC and 32 hex digits"),
    ),
    TWILIO_AUTH_TOKEN: optionalSecret,
    /** Sender number (E.164) or alphanumeric sender id… */
    TWILIO_FROM: optional(z.string().min(1)),
    /** …or a Messaging Service to send through. */
    TWILIO_MESSAGING_SERVICE_SID: optional(
      z.string().regex(/^MG[0-9a-fA-F]{32}$/, "must be MG and 32 hex digits"),
    ),
    /** Lets production start with console senders (they send nothing), e.g. for end-to-end tests. */
    ALLOW_CONSOLE_MESSAGES: z.enum(["true", "false"]).default("false"),
    /** Firebase service account key (JSON) for FCM pushes to iOS and Android… */
    FCM_SERVICE_ACCOUNT_JSON: optional(serviceAccountJson),
    /** …or the path of that JSON file. */
    FCM_SERVICE_ACCOUNT_FILE: optional(z.string().min(1)),
    /** VAPID keys for web push (base64url, as `web-push generate-vapid-keys` prints them). */
    VAPID_PUBLIC_KEY: optional(base64UrlKey(65)),
    VAPID_PRIVATE_KEY: optional(base64UrlKey(32)),
    /** Contact push services can reach the operator at: `mailto:` or an https URL. */
    VAPID_SUBJECT: optional(
      z.string().regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/, "must be mailto: or https:"),
    ),
    /** Lets production start without a push provider (pushes are then dropped), e.g. for end-to-end tests. */
    ALLOW_CONSOLE_PUSH: z.enum(["true", "false"]).default("false"),
    /**
     * Hooks for black-box end-to-end tests: the `capture` senders and GET /e2e/messages,
     * which hands out sign-in links and phone codes. Refused in production.
     */
    E2E_TEST_HOOKS: z.enum(["true", "false"]).default("false"),
    /** Keys for hosts' tax details: `id:base64key` pairs, comma-separated, the first current. */
    TAX_ENCRYPTION_KEYS: optional(taxKeys),
    /** Stripe secret key; without it, becoming a host answers 503. */
    STRIPE_SECRET_KEY: optionalSecret,
    /** Signing secret of the Stripe webhook endpoint; without it POST /webhooks/stripe answers 503. */
    STRIPE_WEBHOOK_SECRET: optionalSecret,
    /** The platform's fee on each booking, in basis points (100 = 1 %). Default 0. */
    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
    /** The card fee estimate passed on to hosts, in basis points of the price. Default 150 (1.5 %). */
    CARD_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_CARD_FEE_BPS),
    /** … plus this many cents per booking. Default 25. */
    CARD_FEE_FIXED_CENTS: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000)
      .default(DEFAULT_CARD_FEE_FIXED_CENTS),
    /** How many bookings one driver may make in an hour. */
    BOOKING_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(20),
    /** Years a deleted host's tax details are kept for platform reporting, then purged. */
    TAX_RECORD_RETENTION_YEARS: z.coerce.number().int().min(1).max(20).default(6),
    /** Alternative Stripe API base URL, e.g. stripe-mock in end-to-end tests. */
    STRIPE_API_BASE_URL: optional(z.url({ protocol: /^https?$/ })),
    /** OCPP URL hosts paste into their charger account. Must end in `/`. */
    OCPP_WSS_URL: z
      .url({ protocol: /^wss?$/ })
      .refine(
        (value) => value.endsWith("/"),
        "must end with a slash: myenergi appends the ChargeboxID",
      )
      .default("ws://localhost:9000/v16/"),
    /** Base URL of the OCPP gateway's internal ChargerControl endpoint. */
    GATEWAY_INTERNAL_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:9100"),
    /** Bearer secret for ChargerControl, shared with the gateway. At least 32 characters. */
    GATEWAY_INTERNAL_SECRET: z.string().min(32),
    /** Comma-separated user ids allowed to use the /admin routes (support staff). */
    ADMIN_USER_IDS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      ),
    /** Longest the onboarding long-poll waits for the charger to connect, in seconds. */
    ONBOARDING_WAIT_MAX_SECONDS: z.coerce.number().int().min(1).max(120).default(25),
    // Durations end-to-end test stacks shorten; production keeps the defaults.
    /** A remote start with no StartTransaction after this many seconds has failed. */
    SESSION_START_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(600)
      .default(START_TIMEOUT_SECONDS),
    /** Minutes after its slot that a session with no StopTransaction is closed. */
    STALE_SESSION_GRACE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(STALE_SESSION_GRACE_MINUTES),
    /** Shortest booking a driver may make, in minutes. */
    MIN_BOOKING_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(MIN_BOOKING_MINUTES),
    /** How long before the slot a driver may arrive and plug in; charging starts at the slot. */
    ARRIVAL_LEAD_MINUTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(ARRIVAL_LEAD_MINUTES),
  })
  .superRefine((env, context) => {
    const pairs = [
      ["APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET"],
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ] as const;
    for (const [id, secret] of pairs) {
      if ((env[id] === undefined) !== (env[secret] === undefined)) {
        context.addIssue({
          code: "custom",
          path: [secret],
          message: `set both ${id} and ${secret}, or neither`,
        });
      }
    }
    const need = (name: keyof typeof env, because: string) => {
      if (env[name] === undefined) {
        context.addIssue({ code: "custom", path: [name], message: `required ${because}` });
      }
    };
    if (env.EMAIL_PROVIDER === "smtp" || env.EMAIL_PROVIDER === "resend")
      need("EMAIL_FROM", `with EMAIL_PROVIDER=${env.EMAIL_PROVIDER}`);
    if (env.E2E_TEST_HOOKS !== "true") {
      for (const name of ["EMAIL_PROVIDER", "SMS_PROVIDER"] as const) {
        if (env[name] === "capture") {
          context.addIssue({
            code: "custom",
            path: [name],
            message:
              "is capture, which only end-to-end test stacks use: it needs E2E_TEST_HOOKS=true",
          });
        }
      }
    }
    if (env.EMAIL_PROVIDER === "smtp") need("SMTP_HOST", "with EMAIL_PROVIDER=smtp");
    if (env.EMAIL_PROVIDER === "resend") need("RESEND_API_KEY", "with EMAIL_PROVIDER=resend");
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["SMTP_PASSWORD"],
        message: "set both SMTP_USER and SMTP_PASSWORD, or neither",
      });
    }
    if (env.FCM_SERVICE_ACCOUNT_JSON !== undefined && env.FCM_SERVICE_ACCOUNT_FILE !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["FCM_SERVICE_ACCOUNT_FILE"],
        message: "set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE, not both",
      });
    }
    const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT];
    if (vapid.some((value) => value === undefined) && vapid.some((value) => value !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["VAPID_SUBJECT"],
        message: "set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, or none",
      });
    }
    if (env.SMS_PROVIDER === "twilio") {
      need("TWILIO_ACCOUNT_SID", "with SMS_PROVIDER=twilio");
      need("TWILIO_AUTH_TOKEN", "with SMS_PROVIDER=twilio");
      if ((env.TWILIO_FROM === undefined) === (env.TWILIO_MESSAGING_SERVICE_SID === undefined)) {
        context.addIssue({
          code: "custom",
          path: ["TWILIO_FROM"],
          message:
            "set one of TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID with SMS_PROVIDER=twilio",
        });
      }
    }
    if (env.NODE_ENV === "production") {
      if (env.E2E_TEST_HOOKS === "true") {
        context.addIssue({
          code: "custom",
          path: ["E2E_TEST_HOOKS"],
          message:
            "must not be true in production: it exposes sign-in links and phone codes over HTTP",
        });
      }
      if (env.STRIPE_API_BASE_URL !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["STRIPE_API_BASE_URL"],
          message: "must not be set in production: payments would go to a test double, not Stripe",
        });
      }
      // Fail fast rather than run with sign-in links and codes going nowhere.
      if (env.ALLOW_CONSOLE_MESSAGES !== "true") {
        for (const name of ["EMAIL_PROVIDER", "SMS_PROVIDER"] as const) {
          if (env[name] === "console") {
            context.addIssue({
              code: "custom",
              path: [name],
              message:
                "is console, which sends nothing: choose a real provider in production, or set ALLOW_CONSOLE_MESSAGES=true to run without one",
            });
          }
        }
      }
      const push =
        env.FCM_SERVICE_ACCOUNT_JSON !== undefined ||
        env.FCM_SERVICE_ACCOUNT_FILE !== undefined ||
        env.VAPID_PUBLIC_KEY !== undefined;
      if (!push && env.ALLOW_CONSOLE_PUSH !== "true") {
        context.addIssue({
          code: "custom",
          path: ["FCM_SERVICE_ACCOUNT_JSON"],
          message:
            "no push provider is configured, so pushes would go nowhere: set FCM_SERVICE_ACCOUNT_JSON (or _FILE) or the VAPID keys in production, or ALLOW_CONSOLE_PUSH=true to run without one",
        });
      }
      need("TAX_ENCRYPTION_KEYS", "in production: hosts' tax details are encrypted with it");
      if (!env.PUBLIC_API_URL.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_API_URL"],
          message: "must be https in production",
        });
      }
      if (!env.OCPP_WSS_URL.startsWith("wss://")) {
        context.addIssue({
          code: "custom",
          path: ["OCPP_WSS_URL"],
          message: "must be wss in production",
        });
      }
    }
  });

export type ApiEnv = z.output<typeof apiEnvSchema>;

/** Settings the application uses, derived from the environment. */
export interface ApiConfig {
  readonly production: boolean;
  readonly publicApiUrl: string;
  readonly publicAppUrl: string;
  readonly authSecret: string;
  readonly corsOrigins: readonly string[];
  readonly cookieDomain: string | undefined;
  readonly secureCookies: boolean;
  readonly trustProxyHops: number;
  readonly authRateLimit: boolean;
  readonly searchRateLimitPerMinute: number;
  readonly apple:
    | {
        readonly clientId: string;
        readonly clientSecret: string;
        readonly appBundleId: string | undefined;
      }
    | undefined;
  readonly google: { readonly clientId: string; readonly clientSecret: string } | undefined;
  readonly ocppWssUrl: string;
  readonly onboardingWaitMaxSeconds: number;
  /** Verifies Stripe webhook signatures; unset turns the webhook endpoint off (503). */
  readonly stripeWebhookSecret: string | undefined;
  /** The platform fee and the card fee passed on to hosts, kept back from each charge. */
  readonly fees: FeeSettings;
  /** Bookings one driver may make in an hour. */
  readonly bookingRateLimitPerHour: number;
  /** Years a deleted host's tax details are kept, then purged. */
  readonly taxRecordRetentionYears: number;
  /** Keys for hosts' tax details; without them saving tax details answers 503. */
  readonly taxKeys: TaxKeyring | undefined;
  /** Users allowed to use the /admin routes. */
  readonly adminUserIds: readonly string[];
  /** Seconds a remote start may take before it has failed. */
  readonly sessionStartTimeoutSeconds: number;
  /** Minutes after its slot that a session with no StopTransaction is closed. */
  readonly staleSessionGraceMinutes: number;
  /** Shortest booking, in minutes. */
  readonly minBookingMinutes: number;
  /** How long before the slot a driver may arrive, in minutes. */
  readonly arrivalLeadMinutes: number;
}

/** Turns the parsed environment into application settings. */
export function configFromEnv(env: ApiEnv): ApiConfig {
  return {
    production: env.NODE_ENV === "production",
    publicApiUrl: env.PUBLIC_API_URL.replace(/\/$/, ""),
    publicAppUrl: env.PUBLIC_APP_URL.replace(/\/$/, ""),
    authSecret: env.AUTH_SECRET,
    corsOrigins: env.CORS_ORIGINS,
    cookieDomain: env.COOKIE_DOMAIN,
    secureCookies: env.PUBLIC_API_URL.startsWith("https://"),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    authRateLimit: env.AUTH_RATE_LIMIT === "on",
    searchRateLimitPerMinute: env.SEARCH_RATE_LIMIT_PER_MINUTE,
    apple:
      env.APPLE_CLIENT_ID !== undefined && env.APPLE_CLIENT_SECRET !== undefined
        ? {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
            appBundleId: env.APPLE_APP_BUNDLE_ID,
          }
        : undefined,
    google:
      env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    ocppWssUrl: env.OCPP_WSS_URL,
    onboardingWaitMaxSeconds: env.ONBOARDING_WAIT_MAX_SECONDS,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    fees: {
      platformFeeBps: env.PLATFORM_FEE_BPS,
      cardFeeBps: env.CARD_FEE_BPS,
      cardFeeFixedCents: env.CARD_FEE_FIXED_CENTS,
    },
    bookingRateLimitPerHour: env.BOOKING_RATE_LIMIT_PER_HOUR,
    taxRecordRetentionYears: env.TAX_RECORD_RETENTION_YEARS,
    taxKeys: env.TAX_ENCRYPTION_KEYS,
    adminUserIds: env.ADMIN_USER_IDS,
    sessionStartTimeoutSeconds: env.SESSION_START_TIMEOUT_SECONDS,
    staleSessionGraceMinutes: env.STALE_SESSION_GRACE_MINUTES,
    minBookingMinutes: env.MIN_BOOKING_MINUTES,
    arrivalLeadMinutes: env.ARRIVAL_LEAD_MINUTES,
  };
}
