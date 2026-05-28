ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "trust_level" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "capability_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "policies" jsonb;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN IF NOT EXISTS "description" text;
