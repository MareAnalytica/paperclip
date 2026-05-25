CREATE TABLE IF NOT EXISTS "agent_peer_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"target_company_id" uuid NOT NULL,
	"scopes" text[] NOT NULL DEFAULT ARRAY[]::text[],
	"granted_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_peer_grants_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_peer_grants" ADD CONSTRAINT "agent_peer_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_peer_grants_target_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_peer_grants" ADD CONSTRAINT "agent_peer_grants_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_peer_grants_agent_target_idx" ON "agent_peer_grants" USING btree ("agent_id","target_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_peer_grants_target_company_idx" ON "agent_peer_grants" USING btree ("target_company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "peer_issue_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_company_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"target_issue_identifier" text NOT NULL,
	"source_company_id" uuid NOT NULL,
	"source_agent_id" uuid,
	"source_user_id" text,
	"source_issue_identifier" text NOT NULL,
	"source_callback_url" text NOT NULL,
	"acceptance_criteria" text NOT NULL,
	"requested_assignee_agent_name_key" text,
	"grant_id" uuid,
	"guardrail_ack" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"response_snapshot" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_issue_audits_target_company_id_companies_id_fk') THEN
		ALTER TABLE "peer_issue_audits" ADD CONSTRAINT "peer_issue_audits_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_issue_audits_target_issue_id_issues_id_fk') THEN
		ALTER TABLE "peer_issue_audits" ADD CONSTRAINT "peer_issue_audits_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_issue_audits_source_company_id_companies_id_fk') THEN
		ALTER TABLE "peer_issue_audits" ADD CONSTRAINT "peer_issue_audits_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_issue_audits_source_agent_id_agents_id_fk') THEN
		ALTER TABLE "peer_issue_audits" ADD CONSTRAINT "peer_issue_audits_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_issue_audits_grant_id_agent_peer_grants_id_fk') THEN
		ALTER TABLE "peer_issue_audits" ADD CONSTRAINT "peer_issue_audits_grant_id_agent_peer_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_peer_grants"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_issue_audits_target_company_idx" ON "peer_issue_audits" USING btree ("target_company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_issue_audits_source_company_idx" ON "peer_issue_audits" USING btree ("source_company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_issue_audits_target_issue_idx" ON "peer_issue_audits" USING btree ("target_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "peer_issue_audits_idempotency_uq" ON "peer_issue_audits" USING btree ("target_company_id","source_company_id","idempotency_key");
