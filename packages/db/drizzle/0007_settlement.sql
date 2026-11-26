CREATE TYPE "public"."session_review_reason" AS ENUM('meter_mismatch', 'meter_invalid', 'missing_stop', 'no_authorisation', 'capture_failed', 'host_dispute');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "review_reason" "session_review_reason";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "confirmation_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "host_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reconciled_at" timestamp with time zone;