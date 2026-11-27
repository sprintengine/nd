CREATE TYPE "public"."booking_status" AS ENUM('requested', 'confirmed', 'arrived', 'active', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."cancelled_by" AS ENUM('driver', 'host', 'system');--> statement-breakpoint
CREATE TYPE "public"."charger_status" AS ENUM('onboarding', 'online', 'offline', 'faulted');--> statement-breakpoint
CREATE TYPE "public"."connector_type" AS ENUM('tethered', 'untethered');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('EUR', 'GBP');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."host_payout_status" AS ENUM('not_started', 'pending', 'enabled', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."ocpp_message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."ocpp_message_type" AS ENUM('call', 'call_result', 'call_error');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending_authorisation', 'card_saved', 'authorised', 'captured', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('starting', 'charging', 'suspended_ev', 'suspended_evse', 'stopped', 'needs_review', 'needs_host_confirmation', 'reconciled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transfer_hold_reason" AS ENUM('session_needs_review', 'dispute_open', 'tax_details_incomplete', 'payouts_not_enabled');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('pending', 'held', 'sent', 'failed', 'reversed');--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charger_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"price_per_hour_cents" integer NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"kwh_cap" numeric(6, 2),
	"instant_book" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rules_weekday_iso" CHECK ("availability_rules"."weekday" between 1 and 7),
	CONSTRAINT "availability_rules_window_not_empty" CHECK ("availability_rules"."start_time" <> "availability_rules"."end_time"),
	CONSTRAINT "availability_rules_price_non_negative" CHECK ("availability_rules"."price_per_hour_cents" >= 0),
	CONSTRAINT "availability_rules_kwh_cap_positive" CHECK ("availability_rules"."kwh_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charger_id" uuid NOT NULL,
	"driver_id" text NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"status" "booking_status" DEFAULT 'requested' NOT NULL,
	"id_tag" varchar(20) NOT NULL,
	"quoted_amount_cents" integer NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"kwh_cap" numeric(6, 2),
	"vehicle_plate" text,
	"scheduled_start_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "cancelled_by",
	"cancellation_reason" text,
	"cancellation_fee_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_id_tag_unique" UNIQUE("id_tag"),
	CONSTRAINT "bookings_slot_bounded" CHECK (not isempty("bookings"."slot") and not lower_inf("bookings"."slot") and not upper_inf("bookings"."slot")),
	CONSTRAINT "bookings_id_tag_not_empty" CHECK (char_length("bookings"."id_tag") > 0),
	CONSTRAINT "bookings_quoted_amount_non_negative" CHECK ("bookings"."quoted_amount_cents" >= 0),
	CONSTRAINT "bookings_cancellation_fee_non_negative" CHECK ("bookings"."cancellation_fee_cents" >= 0),
	CONSTRAINT "bookings_scheduled_start_in_slot" CHECK ("bookings"."scheduled_start_at" is null or "bookings"."scheduled_start_at" <@ "bookings"."slot"),
	CONSTRAINT "bookings_cancellation_consistent" CHECK (("bookings"."status" = 'cancelled') = ("bookings"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "chargers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"brand" text DEFAULT 'myenergi' NOT NULL,
	"model" text NOT NULL,
	"serial" text NOT NULL,
	"chargebox_id" text NOT NULL,
	"ocpp_auth_hash" text,
	"firmware" text,
	"max_kw" numeric(5, 2) NOT NULL,
	"connector_type" "connector_type" NOT NULL,
	"location" geography(Point,4326) NOT NULL,
	"address" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Dublin' NOT NULL,
	"status" charger_status DEFAULT 'onboarding' NOT NULL,
	"ocpp_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"host_id_tag" varchar(20),
	"last_heartbeat_at" timestamp with time zone,
	"accepting_bookings" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chargers_chargebox_id_unique" UNIQUE("chargebox_id"),
	CONSTRAINT "chargers_max_kw_positive" CHECK ("chargers"."max_kw" > 0)
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"raised_by_id" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_account_id" text,
	"payout_status" "host_payout_status" DEFAULT 'not_started' NOT NULL,
	"tax_country" char(2),
	"tin_encrypted" text,
	"tax_details_complete" boolean DEFAULT false NOT NULL,
	"night_rate_start" time,
	"night_rate_end" time,
	"max_sessions_per_day" smallint DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "hosts_stripe_account_id_unique" UNIQUE("stripe_account_id"),
	CONSTRAINT "hosts_tax_country_format" CHECK ("hosts"."tax_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "hosts_max_sessions_per_day_positive" CHECK ("hosts"."max_sessions_per_day" >= 1),
	CONSTRAINT "hosts_night_rate_window_complete" CHECK (("hosts"."night_rate_start" is null) = ("hosts"."night_rate_end" is null))
);
--> statement-breakpoint
CREATE TABLE "meter_values" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meter_values_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"energy_wh" bigint,
	"power_w" integer,
	"current_a" numeric(6, 2)
);
--> statement-breakpoint
CREATE TABLE "ocpp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charger_id" uuid NOT NULL,
	"direction" "ocpp_message_direction" NOT NULL,
	"message_type" "ocpp_message_type" NOT NULL,
	"message_id" text NOT NULL,
	"action" text,
	"payload" jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_setup_intent_id" text,
	"authorise_at" timestamp with time zone,
	"authorised_cents" integer DEFAULT 0 NOT NULL,
	"captured_cents" integer DEFAULT 0 NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"status" "payment_status" DEFAULT 'pending_authorisation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "payments_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "payments_stripe_setup_intent_id_unique" UNIQUE("stripe_setup_intent_id"),
	CONSTRAINT "payments_amounts_non_negative" CHECK ("payments"."authorised_cents" >= 0 and "payments"."captured_cents" >= 0 and "payments"."platform_fee_cents" >= 0),
	CONSTRAINT "payments_capture_within_authorisation" CHECK ("payments"."captured_cents" <= "payments"."authorised_cents"),
	CONSTRAINT "payments_fee_within_capture" CHECK ("payments"."platform_fee_cents" <= "payments"."captured_cents")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"reviewee_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_booking_reviewer_unique" UNIQUE("booking_id","reviewer_id"),
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_not_self" CHECK ("reviews"."reviewer_id" <> "reviews"."reviewee_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"ocpp_transaction_id" integer,
	"meter_start_wh" bigint,
	"meter_stop_wh" bigint,
	"kwh" numeric(10, 3),
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"status" "session_status" DEFAULT 'starting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_ocpp_transaction_id_unique" UNIQUE("ocpp_transaction_id"),
	CONSTRAINT "sessions_meter_monotonic" CHECK ("sessions"."meter_stop_wh" is null or "sessions"."meter_start_wh" is null or "sessions"."meter_stop_wh" >= "sessions"."meter_start_wh")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"stripe_transfer_id" text,
	"amount_cents" integer NOT NULL,
	"currency" "currency" DEFAULT 'EUR' NOT NULL,
	"status" "transfer_status" DEFAULT 'pending' NOT NULL,
	"hold_reason" "transfer_hold_reason",
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_stripe_transfer_id_unique" UNIQUE("stripe_transfer_id"),
	CONSTRAINT "transfers_amount_non_negative" CHECK ("transfers"."amount_cents" >= 0),
	CONSTRAINT "transfers_held_has_reason" CHECK (("transfers"."status" = 'held') = ("transfers"."hold_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_charger_id_chargers_id_fk" FOREIGN KEY ("charger_id") REFERENCES "public"."chargers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_charger_id_chargers_id_fk" FOREIGN KEY ("charger_id") REFERENCES "public"."chargers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargers" ADD CONSTRAINT "chargers_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpp_messages" ADD CONSTRAINT "ocpp_messages_charger_id_chargers_id_fk" FOREIGN KEY ("charger_id") REFERENCES "public"."chargers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewee_id_users_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_rules_charger_id_idx" ON "availability_rules" USING btree ("charger_id","weekday");--> statement-breakpoint
CREATE INDEX "bookings_charger_id_idx" ON "bookings" USING btree ("charger_id");--> statement-breakpoint
CREATE INDEX "bookings_driver_id_idx" ON "bookings" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "chargers_location_gist" ON "chargers" USING gist ("location");--> statement-breakpoint
CREATE INDEX "chargers_host_id_idx" ON "chargers" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "disputes_booking_id_idx" ON "disputes" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meter_values_session_ts_idx" ON "meter_values" USING btree ("session_id","ts");--> statement-breakpoint
CREATE INDEX "ocpp_messages_charger_ts_idx" ON "ocpp_messages" USING btree ("charger_id","ts");--> statement-breakpoint
CREATE INDEX "ocpp_messages_charger_message_id_idx" ON "ocpp_messages" USING btree ("charger_id","message_id");--> statement-breakpoint
CREATE INDEX "payments_status_authorise_at_idx" ON "payments" USING btree ("status","authorise_at");--> statement-breakpoint
CREATE INDEX "reviews_reviewee_id_idx" ON "reviews" USING btree ("reviewee_id");--> statement-breakpoint
CREATE INDEX "sessions_booking_id_idx" ON "sessions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transfers_payment_id_idx" ON "transfers" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "transfers_status_idx" ON "transfers" USING btree ("status");