ALTER TABLE "bookings" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "arrival_distance_m" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "plugged_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_arrival_distance_non_negative" CHECK ("bookings"."arrival_distance_m" >= 0);