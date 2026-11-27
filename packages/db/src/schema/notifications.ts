import { boolean, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "./tables.ts";

// Push notifications: each user's switches, and a ledger of what was sent so
// a notification goes out at most once per event and recipient.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A user's notification switches. No row means every switch is on; the
 * columns match `NOTIFICATION_CATEGORIES` in @nd/domain.
 */
export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  bookingRequests: boolean("booking_requests").notNull().default(true),
  guestArrivals: boolean("guest_arrivals").notNull().default(true),
  sessionUpdates: boolean("session_updates").notNull().default(true),
  chargerAlerts: boolean("charger_alerts").notNull().default(true),
  bookingUpdates: boolean("booking_updates").notNull().default(true),
  chargingUpdates: boolean("charging_updates").notNull().default(true),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One notification to one user about one event (`event_key`, such as
 * `booking:<id>:approved`). The unique key makes sending idempotent;
 * `delivered_at` is set once a push provider accepted it for a device.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** One of `NOTIFICATION_KINDS` in @nd/domain. */
    kind: text("kind").notNull(),
    eventKey: text("event_key").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deliveredAt: timestamptz("delivered_at"),
  },
  (table) => [
    unique("notifications_event_user_unique").on(table.eventKey, table.userId),
    index("notifications_user_kind_created_idx").on(table.userId, table.kind, table.createdAt),
  ],
);
