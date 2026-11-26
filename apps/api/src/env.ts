import { port } from "@nd/config";
import { z } from "zod";

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
    /** Where sign-in emails go. Only `console` exists so far. */
    EMAIL_PROVIDER: z.enum(["console"]).default("console"),
    /** Where phone codes go. Only `console` exists so far. */
    SMS_PROVIDER: z.enum(["console"]).default("console"),
    /** Stripe secret key; without it, becoming a host answers 503. */
    STRIPE_SECRET_KEY: optionalSecret,
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
    /** Longest the onboarding long-poll waits for the charger to connect, in seconds. */
    ONBOARDING_WAIT_MAX_SECONDS: z.coerce.number().int().min(1).max(120).default(25),
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
    if (env.NODE_ENV === "production") {
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
  };
}
