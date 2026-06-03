import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { BUDGET_CAP_CALENDAR_WINDOWS } from "./budget_caps.js";

// Per-window spend rollup for cost_events, keyed by (scope, scopeKey, windowKey)
// per budgeting policy §4.2 / §5. This is the "materialized view" the policy
// refers to; it is implemented as an incrementally-maintained rollup TABLE (not
// a Postgres MATERIALIZED VIEW) so it can be:
//   1. refreshed *inline on insert* — an AFTER INSERT trigger on cost_events
//      (cost_events_window_agg_sync) increments the matching buckets, and
//   2. reconciled by a 5-minute cron — reconcile_cost_events_window_agg(since)
//      fully recomputes touched buckets from cost_events, correcting any drift.
// Both the trigger and the reconcile function ship in the same migration.
//
// Only calendar windows (minute|hour|day|week|month) are materialized here.
// Rolling windows (rolling_24h/7d/30d) and `total` are relative to now() and are
// computed live via rolling_window_spend(); materializing them would require
// continuous re-bucketing and is intentionally not modeled (policy §5).
//
// windowKey encodes both the window kind and the bucket start, "<window>:<utcStamp>"
// (e.g. "day:20260603T000000"), so (scope, scopeKey, windowKey) is the full key.
// Buckets are anchored to UTC regardless of session timezone.
export const costEventsWindowAgg = pgTable(
  "cost_events_window_agg",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    window: text("window").notNull(),
    windowKey: text("window_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    // Tenant attribution for fast per-company reads. NULL for cluster-scope rows
    // (which aggregate across all tenants).
    companyId: uuid("company_id"),
    spendMicros: bigint("spend_micros", { mode: "number" }).notNull().default(0),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUniqueIdx: uniqueIndex("cost_events_window_agg_key_unique_idx").on(
      table.scope,
      table.scopeKey,
      table.windowKey,
    ),
    companyScopeWindowStartIdx: index("cost_events_window_agg_company_scope_window_start_idx").on(
      table.companyId,
      table.scope,
      table.windowStart,
    ),
    windowStartIdx: index("cost_events_window_agg_window_window_start_idx").on(
      table.window,
      table.windowStart,
    ),
    windowAllowedCheck: check(
      "cost_events_window_agg_window_allowed_check",
      sql`${table.window} IN (${sql.raw(BUDGET_CAP_CALENDAR_WINDOWS.map((w) => `'${w}'`).join(", "))})`,
    ),
  }),
);

export type CostEventsWindowAgg = typeof costEventsWindowAgg.$inferSelect;
export type NewCostEventsWindowAgg = typeof costEventsWindowAgg.$inferInsert;
