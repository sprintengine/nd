CREATE TABLE "notification_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"booking_requests" boolean DEFAULT true NOT NULL,
	"guest_arrivals" boolean DEFAULT true NOT NULL,
	"session_updates" boolean DEFAULT true NOT NULL,
	"charger_alerts" boolean DEFAULT true NOT NULL,
	"booking_updates" boolean DEFAULT true NOT NULL,
	"charging_updates" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"event_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "notifications_event_user_unique" UNIQUE("event_key","user_id")
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "web_push_p256dh" text;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "web_push_auth" text;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_kind_created_idx" ON "notifications" USING btree ("user_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_web_push_keys" CHECK (("device_tokens"."platform" = 'web') = ("device_tokens"."web_push_p256dh" is not null and "device_tokens"."web_push_auth" is not null));