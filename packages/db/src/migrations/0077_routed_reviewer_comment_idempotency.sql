ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_company_issue_author_idempotency_uq"
  ON "issue_comments" USING btree ("company_id","issue_id","author_agent_id","idempotency_key")
  WHERE "issue_comments"."idempotency_key" IS NOT NULL AND "issue_comments"."author_agent_id" IS NOT NULL;
