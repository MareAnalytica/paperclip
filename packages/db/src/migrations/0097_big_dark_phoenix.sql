CREATE TABLE "provider_account_cooldowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"adapter_type" text NOT NULL,
	"account" text,
	"cooldown_until" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"last_run_id" uuid,
	"last_issue_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_account_cooldowns" ADD CONSTRAINT "provider_account_cooldowns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_cooldowns_company_provider_idx" ON "provider_account_cooldowns" USING btree ("company_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_account_cooldowns_company_active_idx" ON "provider_account_cooldowns" USING btree ("company_id","cooldown_until");