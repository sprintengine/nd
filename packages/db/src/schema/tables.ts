import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { geographyPoint, timeRange } from "./columns.ts";
import {
  bookingStatus,
  cancelledBy,
  chargerStatus,
  connectorType,
  currency,
  devicePlatform,
  disputeStatus,
  hostPayoutStatus,
  ocppMessageDirection,
  ocppMessageType,
  paymentStatus,
  sessionReviewReason,
  sessionStatus,
  transferHoldReason,
  transferStatus,
} from "./enums.ts";

// Foreign keys use the default ON DELETE NO ACTION unless stated otherwise:
// sessions, meter values, OCPP messages and accounting rows must outlive the
// rows they point at being "deleted" (accounts are anonymised, not removed).

/** Maximum length of an OCPP 1.6 idTag (CiString20). */
export const ID_TAG_MAX_LENGTH = 20;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * People. Shaped like Better Auth's core `user` model (text id, name, email,
 * emailVerified, image, timestamps) so its Drizzle adapter can use this table
 * directly; the auth tables (session, account, verification) are added with it.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  phone: text("phone").unique(),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id").unique(),
  /** When the account was deleted: the row stays, anonymised, for accounting. */
  deletedAt: timestamptz("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A user who lists chargers and is paid by transfer to a connected account. */
export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    stripeAccountId: text("stripe_account_id").unique(),
    payoutStatus: hostPayoutStatus("payout_status").notNull().default("not_started"),
    /** Set when `host_tax_details` holds a complete record; transfers are held until then. */
    taxDetailsComplete: boolean("tax_details_complete").notNull().default(false),
    /** Optional cheap night-rate window, in the charger's local time. */
    nightRateStart: time("night_rate_start"),
    nightRateEnd: time("night_rate_end"),
    maxSessionsPerDay: smallint("max_sessions_per_day").notNull().default(2),
    /** Cancelling is free until this many minutes before a booking starts. */
    cancellationCutoffMinutes: smallint("cancellation_cutoff_minutes").notNull().default(120),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("hosts_max_sessions_per_day_positive", sql`${table.maxSessionsPerDay} >= 1`),
    check(
      "hosts_cancellation_cutoff_range",
      sql`${table.cancellationCutoffMinutes} between 0 and 1440`,
    ),
    check(
      "hosts_night_rate_window_complete",
      sql`(${table.nightRateStart} is null) = (${table.nightRateEnd} is null)`,
    ),
  ],
);

/** A home charger, bound to the platform over OCPP by its ChargeboxID. */
export const chargers = pgTable(
  "chargers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id),
    brand: text("brand").notNull().default("myenergi"),
    model: text("model").notNull(),
    serial: text("serial").notNull(),
    chargeboxId: text("chargebox_id").notNull().unique(),
    /** Hash of the per-charger OCPP Basic Auth password. Secret. */
    ocppAuthHash: text("ocpp_auth_hash"),
    firmware: text("firmware"),
    maxKw: numeric("max_kw", { precision: 5, scale: 2, mode: "number" }).notNull(),
    connectorType: connectorType("connector_type").notNull(),
    /** Exact position. Never returned by search; see `approximateLocation`. */
    location: geographyPoint("location").notNull(),
    /** Street address, shown to a driver only once their booking is confirmed. */
    address: text("address").notNull(),
    /** IANA time zone that availability rules are written in. */
    timezone: text("timezone").notNull().default("Europe/Dublin"),
    status: chargerStatus("status").notNull().default("onboarding"),
    ocppConfig: jsonb("ocpp_config").$type<Record<string, string>>().notNull().default({}),
    /** The host's own idTag, accepted (free vend) outside paid windows. */
    hostIdTag: varchar("host_id_tag", { length: ID_TAG_MAX_LENGTH }),
    lastHeartbeatAt: timestamptz("last_heartbeat_at"),
    acceptingBookings: boolean("accepting_bookings").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("chargers_location_gist").using("gist", table.location),
    index("chargers_host_id_idx").on(table.hostId),
    check("chargers_max_kw_positive", sql`${table.maxKw} > 0`),
  ],
);

/**
 * When a charger can be booked: a weekly window in the charger's local time.
 * A window whose end is not after its start runs past midnight.
 */
export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chargerId: uuid("charger_id")
      .notNull()
      .references(() => chargers.id, { onDelete: "cascade" }),
    /** ISO weekday the window starts on: 1 = Monday … 7 = Sunday. */
    weekday: smallint("weekday").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    pricePerHourCents: integer("price_per_hour_cents").notNull(),
    currency: currency("currency").notNull().default("EUR"),
    kwhCap: numeric("kwh_cap", { precision: 6, scale: 2, mode: "number" }),
    instantBook: boolean("instant_book").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("availability_rules_charger_id_idx").on(table.chargerId, table.weekday),
    check("availability_rules_weekday_iso", sql`${table.weekday} between 1 and 7`),
    check("availability_rules_window_not_empty", sql`${table.startTime} <> ${table.endTime}`),
    check("availability_rules_price_non_negative", sql`${table.pricePerHourCents} >= 0`),
    check("availability_rules_kwh_cap_positive", sql`${table.kwhCap} > 0`),
  ],
);

/**
 * A driver's booking of one charger for one slot. The migration adds an
 * exclusion constraint so slot-holding bookings never overlap per charger.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chargerId: uuid("charger_id")
      .notNull()
      .references(() => chargers.id),
    driverId: text("driver_id")
      .notNull()
      .references(() => users.id),
    slot: timeRange("slot").notNull(),
    status: bookingStatus("status").notNull().default("requested"),
    /** Single-use OCPP idTag, generated server-side when the booking is confirmed. */
    idTag: varchar("id_tag", { length: ID_TAG_MAX_LENGTH }).unique(),
    quotedAmountCents: integer("quoted_amount_cents").notNull(),
    /** Hourly price the quote was made at; billing and fees use it. Set on every booking the API makes. */
    pricePerHourCents: integer("price_per_hour_cents"),
    currency: currency("currency").notNull().default("EUR"),
    kwhCap: numeric("kwh_cap", { precision: 6, scale: 2, mode: "number" }),
    vehiclePlate: text("vehicle_plate"),
    /** Delayed remote start inside the host's night-rate window (later feature). */
    scheduledStartAt: timestamptz("scheduled_start_at"),
    /** When the driver said they had arrived ("I'm here"). */
    arrivedAt: timestamptz("arrived_at"),
    /**
     * How far from the charger the driver's phone placed them on arrival, in
     * metres, when they shared a position. Recorded, never enforced.
     */
    arrivalDistanceM: integer("arrival_distance_m"),
    /**
     * When the driver plugged in and asked for a scheduled start. Billing runs
     * from here, because the driver occupies the slot while charging waits.
     */
    pluggedInAt: timestamptz("plugged_in_at"),
    cancelledAt: timestamptz("cancelled_at"),
    cancelledBy: cancelledBy("cancelled_by"),
    cancellationReason: text("cancellation_reason"),
    cancellationFeeCents: integer("cancellation_fee_cents").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("bookings_charger_id_idx").on(table.chargerId),
    index("bookings_driver_id_idx").on(table.driverId),
    check(
      "bookings_slot_bounded",
      sql`not isempty(${table.slot}) and not lower_inf(${table.slot}) and not upper_inf(${table.slot})`,
    ),
    check("bookings_id_tag_not_empty", sql`char_length(${table.idTag}) > 0`),
    check(
      "bookings_id_tag_when_confirmed",
      sql`${table.idTag} is not null or ${table.status} in ('requested', 'cancelled')`,
    ),
    check("bookings_quoted_amount_non_negative", sql`${table.quotedAmountCents} >= 0`),
    check("bookings_price_per_hour_non_negative", sql`${table.pricePerHourCents} >= 0`),
    check("bookings_cancellation_fee_non_negative", sql`${table.cancellationFeeCents} >= 0`),
    check("bookings_arrival_distance_non_negative", sql`${table.arrivalDistanceM} >= 0`),
    check(
      "bookings_scheduled_start_in_slot",
      sql`${table.scheduledStartAt} is null or ${table.scheduledStartAt} <@ ${table.slot}`,
    ),
    check(
      "bookings_cancellation_consistent",
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`,
    ),
  ],
);

/** One OCPP transaction for a booking. A failed start may be followed by another. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    /** The transactionId the gateway returned in StartTransaction.conf. */
    ocppTransactionId: integer("ocpp_transaction_id").unique(),
    meterStartWh: bigint("meter_start_wh", { mode: "number" }),
    meterStopWh: bigint("meter_stop_wh", { mode: "number" }),
    kwh: numeric("kwh", { precision: 10, scale: 3, mode: "number" }),
    startedAt: timestamptz("started_at"),
    stoppedAt: timestamptz("stopped_at"),
    stopReason: text("stop_reason"),
    status: sessionStatus("status").notNull().default("starting"),
    /** Why the session waits for the host or support before it is billed. */
    reviewReason: sessionReviewReason("review_reason"),
    /** Closed without a StopTransaction: billed once the host confirms or this time passes. */
    confirmationDueAt: timestamptz("confirmation_due_at"),
    hostConfirmedAt: timestamptz("host_confirmed_at"),
    /** When the payment was captured (or released) and the session settled. */
    reconciledAt: timestamptz("reconciled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("sessions_booking_id_idx").on(table.bookingId),
    index("sessions_status_idx").on(table.status),
    check(
      "sessions_meter_monotonic",
      sql`${table.meterStopWh} is null or ${table.meterStartWh} is null or ${table.meterStopWh} >= ${table.meterStartWh}`,
    ),
  ],
);

/** Meter samples from MeterValues during a session. */
export const meterValues = pgTable(
  "meter_values",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    ts: timestamptz("ts").notNull(),
    /** Energy.Active.Import.Register, cumulative. */
    energyWh: bigint("energy_wh", { mode: "number" }),
    powerW: integer("power_w"),
    currentA: numeric("current_a", { precision: 6, scale: 2, mode: "number" }),
  },
  (table) => [index("meter_values_session_ts_idx").on(table.sessionId, table.ts)],
);

/**
 * Append-only audit trail of every OCPP frame, in and out. The migration adds
 * triggers that reject UPDATE, DELETE and TRUNCATE; old rows are removed only
 * by `purge_ocpp_messages()`.
 */
export const ocppMessages = pgTable(
  "ocpp_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chargerId: uuid("charger_id")
      .notNull()
      .references(() => chargers.id),
    direction: ocppMessageDirection("direction").notNull(),
    messageType: ocppMessageType("message_type").notNull(),
    /** OCPP-J unique message id, shared by a CALL and its reply. */
    messageId: text("message_id").notNull(),
    /** Action of a CALL; null on replies. */
    action: text("action"),
    payload: jsonb("payload").notNull(),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (table) => [
    index("ocpp_messages_charger_ts_idx").on(table.chargerId, table.ts),
    index("ocpp_messages_charger_message_id_idx").on(table.chargerId, table.messageId),
  ],
);

/** The driver's payment for a booking (separate charges and transfers). */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .unique()
      .references(() => bookings.id),
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    stripeSetupIntentId: text("stripe_setup_intent_id").unique(),
    /** The driver's saved card the authorisation is made with. */
    stripePaymentMethodId: text("stripe_payment_method_id"),
    /** The charge a capture produced; transfers to the host name it as their source. */
    stripeChargeId: text("stripe_charge_id").unique(),
    /** Why authorising failed (a Stripe decline code), when it did. */
    failureReason: text("failure_reason"),
    /** When the authorisation job should create the PaymentIntent (saved-card path). */
    authoriseAt: timestamptz("authorise_at"),
    authorisedCents: integer("authorised_cents").notNull().default(0),
    capturedCents: integer("captured_cents").notNull().default(0),
    platformFeeCents: integer("platform_fee_cents").notNull().default(0),
    currency: currency("currency").notNull().default("EUR"),
    status: paymentStatus("status").notNull().default("pending_authorisation"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("payments_status_authorise_at_idx").on(table.status, table.authoriseAt),
    check(
      "payments_amounts_non_negative",
      sql`${table.authorisedCents} >= 0 and ${table.capturedCents} >= 0 and ${table.platformFeeCents} >= 0`,
    ),
    check(
      "payments_capture_within_authorisation",
      sql`${table.capturedCents} <= ${table.authorisedCents}`,
    ),
    check("payments_fee_within_capture", sql`${table.platformFeeCents} <= ${table.capturedCents}`),
  ],
);

/** A transfer of the host's share to their connected account, after capture. */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    stripeTransferId: text("stripe_transfer_id").unique(),
    amountCents: integer("amount_cents").notNull(),
    currency: currency("currency").notNull().default("EUR"),
    status: transferStatus("status").notNull().default("pending"),
    holdReason: transferHoldReason("hold_reason"),
    sentAt: timestamptz("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("transfers_payment_id_unique").on(table.paymentId),
    index("transfers_status_idx").on(table.status),
    check("transfers_amount_non_negative", sql`${table.amountCents} >= 0`),
    check(
      "transfers_held_has_reason",
      sql`(${table.status} = 'held') = (${table.holdReason} is not null)`,
    ),
  ],
);

/** A rating left by one side of a booking about the other. */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => users.id),
    revieweeId: text("reviewee_id")
      .notNull()
      .references(() => users.id),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("reviews_booking_reviewer_unique").on(table.bookingId, table.reviewerId),
    index("reviews_reviewee_id_idx").on(table.revieweeId),
    check("reviews_rating_range", sql`${table.rating} between 1 and 5`),
    check("reviews_not_self", sql`${table.reviewerId} <> ${table.revieweeId}`),
  ],
);

/** A dispute raised on a booking; holds the host transfer while open. */
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    raisedById: text("raised_by_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    details: text("details"),
    status: disputeStatus("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("disputes_booking_id_idx").on(table.bookingId),
    index("disputes_status_idx").on(table.status),
  ],
);

/** Push notification tokens (FCM for iOS and Android, web push subscriptions); removed with their user. */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: devicePlatform("platform").notNull(),
    /** The FCM registration token, or a web push subscription's endpoint URL. */
    token: text("token").notNull().unique(),
    /** A web push subscription's keys (base64url): the client's P-256 public key and auth secret. */
    webPushP256dh: text("web_push_p256dh"),
    webPushAuth: text("web_push_auth"),
    createdAt: createdAt(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    index("device_tokens_user_id_idx").on(table.userId),
    check(
      "device_tokens_web_push_keys",
      sql`(${table.platform} = 'web') = (${table.webPushP256dh} is not null and ${table.webPushAuth} is not null)`,
    ),
  ],
);

/** Stripe webhook events already processed, so a redelivery is acknowledged and skipped. */
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  /** Stripe's event id (`evt_…`). */
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamptz("received_at").notNull().defaultNow(),
});
