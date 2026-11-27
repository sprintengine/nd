CREATE TABLE "stripe_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "transfers_payment_id_idx";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "id_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_per_hour_cents" integer;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "cancellation_cutoff_minutes" smallint DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_stripe_charge_id_unique" UNIQUE("stripe_charge_id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_payment_id_unique" UNIQUE("payment_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_id_tag_when_confirmed" CHECK ("bookings"."id_tag" is not null or "bookings"."status" in ('requested', 'cancelled'));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_per_hour_non_negative" CHECK ("bookings"."price_per_hour_cents" >= 0);--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_cancellation_cutoff_range" CHECK ("hosts"."cancellation_cutoff_minutes" between 0 and 1440);