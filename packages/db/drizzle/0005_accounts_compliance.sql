CREATE TYPE "public"."tax_entity_type" AS ENUM('individual', 'business');--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"undo_token_hash" text NOT NULL,
	"paused_charger_ids" uuid[] DEFAULT '{}' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_deletions_undo_token_hash_unique" UNIQUE("undo_token_hash"),
	CONSTRAINT "account_deletions_due_after_request" CHECK ("account_deletions"."due_at" > "account_deletions"."requested_at"),
	CONSTRAINT "account_deletions_single_outcome" CHECK ("account_deletions"."cancelled_at" is null or "account_deletions"."completed_at" is null)
);
--> statement-breakpoint
CREATE TABLE "host_tax_details" (
	"host_id" uuid PRIMARY KEY NOT NULL,
	"entity_type" "tax_entity_type" NOT NULL,
	"legal_name" text,
	"date_of_birth_encrypted" text,
	"company_name" text,
	"company_number" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text,
	"address_country" char(2) NOT NULL,
	"tax_country" char(2) NOT NULL,
	"tin_encrypted" text NOT NULL,
	"tin_masked" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_tax_details_tax_country_format" CHECK ("host_tax_details"."tax_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "host_tax_details_address_country_format" CHECK ("host_tax_details"."address_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "host_tax_details_identity_complete" CHECK (("host_tax_details"."entity_type" = 'individual' and "host_tax_details"."legal_name" is not null and "host_tax_details"."date_of_birth_encrypted" is not null)
        or ("host_tax_details"."entity_type" = 'business' and "host_tax_details"."company_name" is not null and "host_tax_details"."company_number" is not null))
);
--> statement-breakpoint
ALTER TABLE "hosts" DROP CONSTRAINT "hosts_tax_country_format";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_tax_details" ADD CONSTRAINT "host_tax_details_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_one_pending_per_user" ON "account_deletions" USING btree ("user_id") WHERE "account_deletions"."cancelled_at" is null and "account_deletions"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "account_deletions_pending_due_at_idx" ON "account_deletions" USING btree ("due_at") WHERE "account_deletions"."cancelled_at" is null and "account_deletions"."completed_at" is null;--> statement-breakpoint
ALTER TABLE "hosts" DROP COLUMN "tax_country";--> statement-breakpoint
ALTER TABLE "hosts" DROP COLUMN "tin_encrypted";