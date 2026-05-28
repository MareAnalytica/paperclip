CREATE TABLE IF NOT EXISTS "peer_grant_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"source_issue_identifier" text NOT NULL,
	"target_company_id" uuid NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"reason" text NOT NULL,
	"requested_ttl_seconds" integer,
	"requested_uses" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_agent_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"grant_id" uuid,
	"interaction_id" uuid,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_peer_grants" ADD COLUMN IF NOT EXISTS "max_uses" integer;--> statement-breakpoint
ALTER TABLE "agent_peer_grants" ADD COLUMN IF NOT EXISTS "uses_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_grant_requests_source_company_id_companies_id_fk') THEN
		ALTER TABLE "peer_grant_requests" ADD CONSTRAINT "peer_grant_requests_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_grant_requests_requested_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "peer_grant_requests" ADD CONSTRAINT "peer_grant_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_grant_requests_target_company_id_companies_id_fk') THEN
		ALTER TABLE "peer_grant_requests" ADD CONSTRAINT "peer_grant_requests_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_grant_requests_decided_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "peer_grant_requests" ADD CONSTRAINT "peer_grant_requests_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peer_grant_requests_grant_id_agent_peer_grants_id_fk') THEN
		ALTER TABLE "peer_grant_requests" ADD CONSTRAINT "peer_grant_requests_grant_id_agent_peer_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_peer_grants"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "peer_grant_requests_pending_dedupe_uq" ON "peer_grant_requests" USING btree ("dedupe_key") WHERE "peer_grant_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_grant_requests_source_idx" ON "peer_grant_requests" USING btree ("source_company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_grant_requests_target_idx" ON "peer_grant_requests" USING btree ("target_company_id","status");
