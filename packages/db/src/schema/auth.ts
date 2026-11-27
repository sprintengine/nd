import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { users } from "./tables.ts";

// Tables Better Auth needs next to `users` (its `user` model). The API maps
// Better Auth's model names onto these through its `modelName` options; the
// `auth_` prefix keeps them apart from charging `sessions`. Rows are removed
// with their user, which Better Auth expects; accounts are normally
// anonymised rather than deleted, so this rarely fires.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A signed-in device. The token is the value of the httpOnly session cookie. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("auth_sessions_user_id_idx").on(table.userId)],
);

/** A sign-in method linked to a user: Apple or Google (OAuth tokens encrypted by Better Auth). */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    /** Unused: there are no passwords. Present because Better Auth's account model has it. */
    password: text("password"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("auth_accounts_user_id_idx").on(table.userId)],
);

/** Short-lived values: magic-link tokens (stored hashed) and phone OTPs. */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);
