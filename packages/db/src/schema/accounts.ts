import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { taxEntityType } from "./enums.ts";
import { hosts, users } from "./tables.ts";

// Account compliance: hosts' tax identity for platform reporting, and
// requests to delete an account.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A host's tax identity, needed before their first payout. The TIN and date
 * of birth are encrypted by the API (AES-256-GCM) with the key named in
 * `encryption_key_id`, so keys can be rotated; `tin_masked` shows only the
 * last three characters. Secret columns: `tin_encrypted`, `date_of_birth_encrypted`.
 */
export const hostTaxDetails = pgTable(
  "host_tax_details",
  {
    hostId: uuid("host_id")
      .primaryKey()
      .references(() => hosts.id),
    entityType: taxEntityType("entity_type").notNull(),
    /** Full legal name of an individual. */
    legalName: text("legal_name"),
    /** Date of birth of an individual, encrypted. Secret. */
    dateOfBirthEncrypted: text("date_of_birth_encrypted"),
    /** Registered name and number of a business. */
    companyName: text("company_name"),
    companyNumber: text("company_number"),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    region: text("region"),
    postalCode: text("postal_code"),
    /** ISO 3166-1 alpha-2 country of the address. */
    addressCountry: char("address_country", { length: 2 }).notNull(),
    /** ISO 3166-1 alpha-2 country of tax residence. */
    taxCountry: char("tax_country", { length: 2 }).notNull(),
    /** Tax identification number, encrypted. Secret. */
    tinEncrypted: text("tin_encrypted").notNull(),
    /** The TIN with all but its last three characters masked, for display. */
    tinMasked: text("tin_masked").notNull(),
    /** Id of the key the encrypted columns were written with. */
    encryptionKeyId: text("encryption_key_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("host_tax_details_tax_country_format", sql`${table.taxCountry} ~ '^[A-Z]{2}$'`),
    check("host_tax_details_address_country_format", sql`${table.addressCountry} ~ '^[A-Z]{2}$'`),
    check(
      "host_tax_details_identity_complete",
      sql`(${table.entityType} = 'individual' and ${table.legalName} is not null and ${table.dateOfBirthEncrypted} is not null)
        or (${table.entityType} = 'business' and ${table.companyName} is not null and ${table.companyNumber} is not null)`,
    ),
  ],
);

/**
 * A request to delete an account. The user can undo it with the emailed
 * token until `due_at`; after that a scheduled step anonymises the account.
 * At most one request per user is pending (neither cancelled nor completed).
 */
export const accountDeletions = pgTable(
  "account_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamptz("requested_at").notNull(),
    dueAt: timestamptz("due_at").notNull(),
    /** SHA-256 of the undo token emailed to the user. */
    undoTokenHash: text("undo_token_hash").notNull().unique(),
    /** The host's chargers taken off the listings by the request, relisted if it is undone. */
    pausedChargerIds: uuid("paused_charger_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    cancelledAt: timestamptz("cancelled_at"),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    uniqueIndex("account_deletions_one_pending_per_user")
      .on(table.userId)
      .where(sql`${table.cancelledAt} is null and ${table.completedAt} is null`),
    index("account_deletions_pending_due_at_idx")
      .on(table.dueAt)
      .where(sql`${table.cancelledAt} is null and ${table.completedAt} is null`),
    check("account_deletions_due_after_request", sql`${table.dueAt} > ${table.requestedAt}`),
    check(
      "account_deletions_single_outcome",
      sql`${table.cancelledAt} is null or ${table.completedAt} is null`,
    ),
  ],
);
