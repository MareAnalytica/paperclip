-- Rollback (forward-only repo; reverse manually before any dependent code ships):
--   DROP TRIGGER IF EXISTS "cost_events_window_agg_sync_trg" ON "cost_events";
--   DROP FUNCTION IF EXISTS reconcile_cost_events_window_agg(timestamptz);
--   DROP FUNCTION IF EXISTS cost_events_window_agg_sync();
--   DROP FUNCTION IF EXISTS cost_events_scope_projection(uuid, uuid, uuid, uuid, uuid, text, text, text);
--   DROP FUNCTION IF EXISTS cost_events_window_bounds(text, timestamptz);
--   DROP TABLE IF EXISTS "cost_events_window_agg";
--   DROP TABLE IF EXISTS "budget_caps";
-- Then delete the 0099 entry from migrations/meta/_journal.json and remove
-- 0099_dry_corsair.sql + meta/0099_snapshot.json. Both tables are new and unread
-- by shipped code, so dropping them loses no committed data.
CREATE TABLE "budget_caps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"scope" text NOT NULL,
	"scope_key" text DEFAULT '_' NOT NULL,
	"window" text NOT NULL,
	"window_anchor" text DEFAULT 'calendar' NOT NULL,
	"limit_micros" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"warn_at_percent" integer DEFAULT 60 NOT NULL,
	"critical_at_percent" integer DEFAULT 80 NOT NULL,
	"hard_stop_at_percent" integer DEFAULT 100 NOT NULL,
	"action" text NOT NULL,
	"approval_gate" jsonb,
	"grace_minutes" integer DEFAULT 5 NOT NULL,
	"tags" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_caps_window_allowed_check" CHECK ("budget_caps"."window" IN ('minute', 'hour', 'day', 'week', 'month', 'rolling_24h', 'rolling_7d', 'rolling_30d', 'total')),
	CONSTRAINT "budget_caps_window_anchor_check" CHECK ("budget_caps"."window_anchor" IN ('calendar', 'rolling')),
	CONSTRAINT "budget_caps_scope_check" CHECK ("budget_caps"."scope" IN ('cluster', 'company', 'project', 'goal', 'agent', 'agent-template', 'provider', 'model', 'billingCode', 'issue', 'route', 'routine')),
	CONSTRAINT "budget_caps_action_check" CHECK ("budget_caps"."action" IN ('warn', 'require_approval', 'pause_writes', 'pause_runs', 'hard_stop')),
	CONSTRAINT "budget_caps_threshold_order_check" CHECK ("budget_caps"."warn_at_percent" <= "budget_caps"."critical_at_percent" AND "budget_caps"."critical_at_percent" <= "budget_caps"."hard_stop_at_percent" AND "budget_caps"."warn_at_percent" > 0),
	CONSTRAINT "budget_caps_limit_non_negative_check" CHECK ("budget_caps"."limit_micros" >= 0),
	CONSTRAINT "budget_caps_cluster_tenancy_check" CHECK (("budget_caps"."scope" = 'cluster' AND "budget_caps"."company_id" IS NULL) OR ("budget_caps"."scope" <> 'cluster' AND "budget_caps"."company_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cost_events_window_agg" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"window" text NOT NULL,
	"window_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"company_id" uuid,
	"spend_micros" bigint DEFAULT 0 NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_events_window_agg_window_allowed_check" CHECK ("cost_events_window_agg"."window" IN ('minute', 'hour', 'day', 'week', 'month'))
);
--> statement-breakpoint
ALTER TABLE "budget_caps" ADD CONSTRAINT "budget_caps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_caps_company_scope_active_idx" ON "budget_caps" USING btree ("company_id","scope","scope_key","is_active");--> statement-breakpoint
CREATE INDEX "budget_caps_scope_scope_key_idx" ON "budget_caps" USING btree ("scope","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_caps_active_scope_window_unique_idx" ON "budget_caps" USING btree ("company_id","scope","scope_key","window") WHERE "budget_caps"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_window_agg_key_unique_idx" ON "cost_events_window_agg" USING btree ("scope","scope_key","window_key");--> statement-breakpoint
CREATE INDEX "cost_events_window_agg_company_scope_window_start_idx" ON "cost_events_window_agg" USING btree ("company_id","scope","window_start");--> statement-breakpoint
CREATE INDEX "cost_events_window_agg_window_window_start_idx" ON "cost_events_window_agg" USING btree ("window","window_start");--> statement-breakpoint
-- ============================================================================
-- Aggregator runtime for cost_events_window_agg (budgeting policy §4.2 / §5).
-- Hand-written below the drizzle-generated DDL above; the drizzle snapshot does
-- not model functions/triggers, so these are maintained here directly and
-- reversed in the Rollback block at the top of this file.
-- ============================================================================

-- Bucket math for a single calendar window kind at an instant. Anchored to UTC
-- regardless of session timezone. Returns the half-open bucket [start, end) and
-- the windowKey "<window>:<YYYYMMDD>T<HHMMSS>" (UTC wall stamp). The TypeScript
-- mirror in packages/shared/src/budget/windows.ts MUST produce identical keys.
CREATE OR REPLACE FUNCTION cost_events_window_bounds(p_window text, p_at timestamptz)
RETURNS TABLE(window_start timestamptz, window_end timestamptz, window_key text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    (s.ws_wall AT TIME ZONE 'UTC'),
    ((s.ws_wall + s.step) AT TIME ZONE 'UTC'),
    p_window || ':' || to_char(s.ws_wall, 'YYYYMMDD"T"HH24MISS')
  FROM (
    SELECT
      date_trunc(
        CASE p_window
          WHEN 'minute' THEN 'minute'
          WHEN 'hour'   THEN 'hour'
          WHEN 'day'    THEN 'day'
          WHEN 'week'   THEN 'week'
          WHEN 'month'  THEN 'month'
        END,
        (p_at AT TIME ZONE 'UTC')
      ) AS ws_wall,
      CASE p_window
        WHEN 'minute' THEN interval '1 minute'
        WHEN 'hour'   THEN interval '1 hour'
        WHEN 'day'    THEN interval '1 day'
        WHEN 'week'   THEN interval '7 days'
        WHEN 'month'  THEN interval '1 month'
      END AS step
  ) s
$$;--> statement-breakpoint
-- The set of (scope, scopeKey, companyId) a single cost_events row attributes
-- to (§2.2 scope dimensions derivable from the row alone). agent-template / route
-- / routine are NOT derivable from cost_events and are intentionally omitted here;
-- they are aggregated by their own writers when those dimensions land. Cluster
-- rows carry scopeKey '_' and a NULL companyId (cross-tenant); every other scope
-- carries the tenant companyId. NULL scope keys (absent project/goal/issue/etc.)
-- are filtered out.
CREATE OR REPLACE FUNCTION cost_events_scope_projection(
  p_company_id uuid,
  p_project_id uuid,
  p_goal_id uuid,
  p_agent_id uuid,
  p_issue_id uuid,
  p_provider text,
  p_model text,
  p_billing_code text
)
RETURNS TABLE(scope text, scope_key text, company_id uuid)
LANGUAGE sql IMMUTABLE AS $$
  SELECT v.scope, v.scope_key, v.company_id
  FROM (
    VALUES
      ('cluster',     '_',                              NULL::uuid),
      ('company',     p_company_id::text,               p_company_id),
      ('project',     p_project_id::text,               p_company_id),
      ('goal',        p_goal_id::text,                  p_company_id),
      ('agent',       p_agent_id::text,                 p_company_id),
      ('provider',    p_provider,                       p_company_id),
      ('model',       p_provider || ':' || p_model,     p_company_id),
      ('billingCode', p_billing_code,                   p_company_id),
      ('issue',       p_issue_id::text,                 p_company_id)
  ) AS v(scope, scope_key, company_id)
  WHERE v.scope_key IS NOT NULL
$$;--> statement-breakpoint
-- Inline refresh: AFTER INSERT on cost_events, increment every (scope, calendar
-- window) bucket this row lands in. Idempotency is the caller's concern (the
-- unique idempotency_key on cost_events); this trigger assumes one firing == one
-- new charge to fold in.
CREATE OR REPLACE FUNCTION cost_events_window_agg_sync()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cost_events_window_agg
    (scope, scope_key, "window", window_key, window_start, window_end, company_id,
     spend_micros, event_count, last_event_at, updated_at)
  SELECT sp.scope, sp.scope_key, w.win, b.window_key, b.window_start, b.window_end, sp.company_id,
         COALESCE(NEW.cost_micros, 0), 1, NEW.occurred_at, now()
  FROM cost_events_scope_projection(
         NEW.company_id, NEW.project_id, NEW.goal_id, NEW.agent_id,
         NEW.issue_id, NEW.provider, NEW.model, NEW.billing_code) sp
  CROSS JOIN (VALUES ('minute'),('hour'),('day'),('week'),('month')) AS w(win)
  CROSS JOIN LATERAL cost_events_window_bounds(w.win, NEW.occurred_at) b
  ON CONFLICT (scope, scope_key, window_key) DO UPDATE SET
    spend_micros  = cost_events_window_agg.spend_micros + EXCLUDED.spend_micros,
    event_count   = cost_events_window_agg.event_count + EXCLUDED.event_count,
    last_event_at = GREATEST(cost_events_window_agg.last_event_at, EXCLUDED.last_event_at),
    updated_at    = now();
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER cost_events_window_agg_sync_trg
AFTER INSERT ON cost_events
FOR EACH ROW EXECUTE FUNCTION cost_events_window_agg_sync();--> statement-breakpoint
-- 5-minute reconciliation cron target. Fully recomputes every bucket TOUCHED by
-- a row with occurred_at >= p_since (NULL = whole table) from all rows in that
-- bucket's bounds, correcting any drift the inline trigger may have accrued
-- (crashed transactions, manual inserts, late writes). Recomputing whole buckets
-- — not just rows since p_since — is required: a rolling 5-min pass must not zero
-- out the earlier spend of a long (week/month) bucket. Returns rows upserted.
CREATE OR REPLACE FUNCTION reconcile_cost_events_window_agg(p_since timestamptz DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  affected integer;
BEGIN
  WITH touched AS (
    SELECT DISTINCT sp.scope, sp.scope_key, w.win AS win,
           b.window_key, b.window_start, b.window_end, sp.company_id
    FROM cost_events ce
    CROSS JOIN LATERAL cost_events_scope_projection(
           ce.company_id, ce.project_id, ce.goal_id, ce.agent_id,
           ce.issue_id, ce.provider, ce.model, ce.billing_code) sp
    CROSS JOIN (VALUES ('minute'),('hour'),('day'),('week'),('month')) AS w(win)
    CROSS JOIN LATERAL cost_events_window_bounds(w.win, ce.occurred_at) b
    WHERE p_since IS NULL OR ce.occurred_at >= p_since
  ),
  recomputed AS (
    SELECT t.scope, t.scope_key, t.win, t.window_key, t.window_start, t.window_end, t.company_id,
           SUM(COALESCE(ce.cost_micros, 0))::bigint AS spend_micros,
           COUNT(ce.id)::bigint AS event_count,
           MAX(ce.occurred_at) AS last_event_at
    FROM touched t
    JOIN cost_events ce
      ON ce.occurred_at >= t.window_start AND ce.occurred_at < t.window_end
     AND EXISTS (
       SELECT 1 FROM cost_events_scope_projection(
                ce.company_id, ce.project_id, ce.goal_id, ce.agent_id,
                ce.issue_id, ce.provider, ce.model, ce.billing_code) sp2
       WHERE sp2.scope = t.scope AND sp2.scope_key = t.scope_key
     )
    GROUP BY t.scope, t.scope_key, t.win, t.window_key, t.window_start, t.window_end, t.company_id
  )
  INSERT INTO cost_events_window_agg
    (scope, scope_key, "window", window_key, window_start, window_end, company_id,
     spend_micros, event_count, last_event_at, updated_at)
  SELECT scope, scope_key, win, window_key, window_start, window_end, company_id,
         spend_micros, event_count, last_event_at, now()
  FROM recomputed
  ON CONFLICT (scope, scope_key, window_key) DO UPDATE SET
    spend_micros  = EXCLUDED.spend_micros,
    event_count   = EXCLUDED.event_count,
    last_event_at = EXCLUDED.last_event_at,
    updated_at    = now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;