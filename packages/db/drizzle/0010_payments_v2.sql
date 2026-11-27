CREATE TYPE "public"."refund_reason" AS ENUM('driver_cancelled', 'host_cancelled', 'charger_fault', 'support');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"reason" "refund_reason" NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"stripe_refund_id" text,
	"issued_by_id" text,
	"note" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_stripe_refund_id_unique" UNIQUE("stripe_refund_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "host_tax_details" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "stripe_dispute_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "card_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "capture_method" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
-- Hand edit: a request was held for the host (manual capture).
UPDATE "payments" SET "capture_method" = 'manual' FROM "bookings" WHERE "bookings"."id" = "payments"."booking_id" AND "bookings"."status" = 'requested';--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_payment_reason_unique" ON "refunds" USING btree ("payment_id","reason") WHERE "refunds"."reason" <> 'support';--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_stripe_dispute_id_unique" UNIQUE("stripe_dispute_id");--> statement-breakpoint
-- Hand edit: a payment's amount is its booking's price.
UPDATE "payments" SET "amount_cents" = "bookings"."quoted_amount_cents" FROM "bookings" WHERE "bookings"."id" = "payments"."booking_id";--> statement-breakpoint
ALTER TABLE "transfers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "transfers" CASCADE;--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_stripe_setup_intent_id_unique";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cancellation_fee_non_negative";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_capture_within_authorisation";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_fee_within_capture";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_amounts_non_negative";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
-- Hand edit: map the old payment statuses onto the new ones (paid upfront: a capture is a payment).
UPDATE "payments" SET "status" = CASE "status" WHEN 'pending_authorisation' THEN 'pending' WHEN 'card_saved' THEN 'pending' WHEN 'captured' THEN 'paid' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
DROP TYPE "public"."payment_status";--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'authorised', 'paid', 'cancelled', 'failed');--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."payment_status";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DATA TYPE "public"."payment_status" USING "status"::"public"."payment_status";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "review_reason" SET DATA TYPE text;--> statement-breakpoint
-- Hand edit: review reasons that were about billing no longer exist.
UPDATE "sessions" SET "review_reason" = NULL WHERE "review_reason" IN ('no_authorisation', 'capture_failed', 'host_dispute');--> statement-breakpoint
DROP TYPE "public"."session_review_reason";--> statement-breakpoint
CREATE TYPE "public"."session_review_reason" AS ENUM('meter_mismatch', 'meter_invalid', 'missing_stop');--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "review_reason" SET DATA TYPE "public"."session_review_reason" USING "review_reason"::"public"."session_review_reason";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
-- Hand edit: a session waiting for its host to confirm it was closed from its last meter value.
UPDATE "sessions" SET "status" = 'reconciled' WHERE "status" = 'needs_host_confirmation';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'starting'::text;--> statement-breakpoint
DROP TYPE "public"."session_status";--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('starting', 'charging', 'suspended_ev', 'suspended_evse', 'stopped', 'needs_review', 'reconciled', 'failed');--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'starting'::"public"."session_status";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET DATA TYPE "public"."session_status" USING "status"::"public"."session_status";--> statement-breakpoint
DROP INDEX "payments_status_authorise_at_idx";--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "cancellation_fee_cents";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "stripe_setup_intent_id";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "authorise_at";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "authorised_cents";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "captured_cents";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "confirmation_due_at";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "host_confirmed_at";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fees_within_amount" CHECK ("payments"."platform_fee_cents" + "payments"."card_fee_cents" <= "payments"."amount_cents");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts_non_negative" CHECK ("payments"."amount_cents" >= 0 and "payments"."platform_fee_cents" >= 0 and "payments"."card_fee_cents" >= 0);--> statement-breakpoint
DROP TYPE "public"."transfer_hold_reason";--> statement-breakpoint
DROP TYPE "public"."transfer_status";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_capture_method" CHECK ("payments"."capture_method" in ('automatic', 'manual'));