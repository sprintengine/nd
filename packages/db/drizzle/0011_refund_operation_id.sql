ALTER TABLE "refunds" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_operation_unique" UNIQUE("payment_id","operation_id");