import { authAccounts, authSessions, authVerifications, type Db, users } from "@nd/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { phoneNumber } from "better-auth/plugins/phone-number";

import type { IdGenerator } from "../deps.ts";
import type { ApiConfig } from "../env.ts";
import type { EmailSender, SmsSender } from "../senders/senders.ts";

/** Path Better Auth is mounted under. */
export const AUTH_BASE_PATH = "/auth";

/**
 * Header the API sets to the client IP Fastify resolved (honouring the
 * trusted proxy hops), so Better Auth's rate limiter keys on the real client.
 * Any value a client sends is dropped first.
 */
export const CLIENT_IP_HEADER = "x-nd-client-ip";

const DAY_S = 24 * 60 * 60;

/** Sessions last 30 days and slide: using one renews it once a day. */
export const SESSION_EXPIRES_IN_S = 30 * DAY_S;
export const SESSION_UPDATE_AGE_S = DAY_S;

/** Magic links work once, within 15 minutes. */
export const MAGIC_LINK_EXPIRES_IN_S = 15 * 60;

/** Phone codes: 6 digits, 5 minutes, 3 tries. */
export const PHONE_OTP_EXPIRES_IN_S = 5 * 60;

/** E.164: a plus sign and up to 15 digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Better Auth routes not offered: phone numbers are verified, not used to
 * sign in (there are no passwords), so the phone sign-in and reset routes
 * are switched off.
 */
const DISABLED_PATHS = [
  "/sign-in/phone-number",
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
];

export interface AuthDeps {
  readonly config: ApiConfig;
  readonly db: Db;
  readonly ids: IdGenerator;
  readonly email: EmailSender;
  readonly sms: SmsSender;
}

/**
 * Better Auth, with its data in our Postgres: magic link sign-in, Apple and
 * Google when configured, and phone verification by SMS code. Its `user`
 * model is our `users` table (phone fields mapped onto `phone` and
 * `phoneVerified`); sessions are httpOnly cookies.
 */
export function createAuth({ config, db, ids, email, sms }: AuthDeps) {
  return betterAuth({
    appName: "nd",
    baseURL: config.publicApiUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [...config.corsOrigins, config.publicAppUrl],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { users, authSessions, authAccounts, authVerifications },
    }),
    user: { modelName: "users" },
    session: {
      modelName: "authSessions",
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
    },
    account: {
      modelName: "authAccounts",
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["apple", "google"] },
    },
    verification: { modelName: "authVerifications" },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.apple === undefined
        ? {}
        : {
            apple: {
              clientId: config.apple.clientId,
              clientSecret: config.apple.clientSecret,
              ...(config.apple.appBundleId === undefined
                ? {}
                : { appBundleIdentifier: config.apple.appBundleId }),
            },
          }),
      ...(config.google === undefined
        ? {}
        : {
            google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
          }),
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_S,
        storeToken: "hashed",
        sendMagicLink: async ({ email: to, url }) => {
          await email.send({
            to,
            subject: "Your sign-in link",
            text: `Sign in with this link. It works once and expires in 15 minutes.\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
          });
        },
      }),
      phoneNumber({
        otpLength: 6,
        expiresIn: PHONE_OTP_EXPIRES_IN_S,
        allowedAttempts: 3,
        phoneNumberValidator: (value) => E164.test(value),
        sendOTP: async ({ phoneNumber: to, code }) => {
          await sms.send({ to, body: `Your verification code is ${code}` });
        },
        schema: {
          user: { fields: { phoneNumber: "phone", phoneNumberVerified: "phoneVerified" } },
        },
      }),
    ],
    disabledPaths: DISABLED_PATHS,
    hooks: {
      // A code verifies the signed-in user's number; it never signs anyone in.
      before: createAuthMiddleware((ctx) => {
        const body = ctx.body as { updatePhoneNumber?: unknown } | undefined;
        if (ctx.path === "/phone-number/verify" && body?.updatePhoneNumber !== true) {
          return Promise.reject(
            new APIError("BAD_REQUEST", {
              message: "Sign in first, then verify your phone number with updatePhoneNumber: true",
              code: "PHONE_VERIFICATION_REQUIRES_SESSION",
            }),
          );
        }
        return Promise.resolve();
      }),
    },
    rateLimit: {
      enabled: config.authRateLimit,
      storage: "memory",
      window: 60,
      max: 100,
    },
    advanced: {
      useSecureCookies: config.secureCookies,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => ids.newId() },
      ...(config.cookieDomain === undefined
        ? {}
        : { crossSubDomainCookies: { enabled: true, domain: config.cookieDomain } }),
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
