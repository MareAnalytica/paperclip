ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "mutation_type" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "routed_reviewer_of" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "routing_evidence_link" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "routing_metadata" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comments_mutation_type_idx" ON "issue_comments" USING btree ("company_id","mutation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comments_routed_reviewer_of_idx" ON "issue_comments" USING btree ("company_id","routed_reviewer_of");
