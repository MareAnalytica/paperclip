import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Budget caps — the §2.2 cap surface of the agent-budgeting policy
// (docs/policies/2026-05-13-agent-budgeting.md in the eli-board blueprint).
//
// A cap is `(scope, scopeKey, window, limit, action)` plus threshold percents,
// an optional approval gate, and an overshoot grace. Default caps live in
// config/agent-budgeting.yaml; this table stores operator-set explicit caps and
// per-company overrides. All tunables are config-driven and portable — no
// company-specific values are baked into the schema.
//
// Relationship to the legacy budget_policies table: budget_policies is the
// simpler cents-denominated per-company policy used by the existing budget
// service. budget_caps is the richer micro-denominated policy-§2.2 surface
// (full scope set, rolling windows, approval gates). They are additive and
// coexist; migration of budget_policies → budget_caps is out of scope here.

// Allowed window names. Kept in lock-step with `windows.allowed` in
// config/agent-budgeting.yaml; the DB CHECK below and the cap loader both
// enforce this set so an out-of-enum window is rejected at every layer.
export const BUDGET_CAP_WINDOWS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "rolling_24h",
  "rolling_7d",
  "rolling_30d",
  "total",
] as const;
export type BudgetCapWindow = (typeof BUDGET_CAP_WINDOWS)[number];

// Calendar (boundary-anchored) windows are the subset materialized into
// cost_events_window_agg. Rolling / total windows are computed live against
// cost_events (see rolling_window_spend()).
export const BUDGET_CAP_CALENDAR_WINDOWS = ["minute", "hour", "day", "week", "month"] as const;
export type BudgetCapCalendarWindow = (typeof BUDGET_CAP_CALENDAR_WINDOWS)[number];

export const BUDGET_CAP_WINDOW_ANCHORS = ["calendar", "rolling"] as const;
export type BudgetCapWindowAnchor = (typeof BUDGET_CAP_WINDOW_ANCHORS)[number];

// §2.2 scope dimensions. `cluster` uses the constant scopeKey "_"; `model` uses
// "<provider>:<model>"; `billingCode` matches a `code/%` prefix; the rest use
// the corresponding entity id / key as text (NOT uuid — scopeKey is polymorphic).
export const BUDGET_CAP_SCOPES = [
  "cluster",
  "company",
  "project",
  "goal",
  "agent",
  "agent-template",
  "provider",
  "model",
  "billingCode",
  "issue",
  "route",
  "routine",
] as const;
export type BudgetCapScope = (typeof BUDGET_CAP_SCOPES)[number];

// §4.3 enforcement actions, increasing severity.
export const BUDGET_CAP_ACTIONS = [
  "warn",
  "require_approval",
  "pause_writes",
  "pause_runs",
  "hard_stop",
] as const;
export type BudgetCapAction = (typeof BUDGET_CAP_ACTIONS)[number];

function sqlInList(values: readonly string[]): ReturnType<typeof sql.raw> {
  return sql.raw(values.map((v) => `'${v}'`).join(", "));
}

export const budgetCaps = pgTable(
  "budget_caps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for cluster-scope (operator-level / cross-tenant) caps; the tenant
    // company id for every other scope. The CHECK below enforces this invariant.
    companyId: uuid("company_id").references(() => companies.id),
    scope: text("scope").notNull(),
    // Polymorphic: entity uuid, "_", "<provider>:<model>", code prefix, etc.
    scopeKey: text("scope_key").notNull().default("_"),
    window: text("window").notNull(),
    windowAnchor: text("window_anchor").notNull().default("calendar"),
    // Integer micro-units of `currency` (1 unit = 1_000_000 micros), matching
    // cost_events.cost_micros. Never floats.
    limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    warnAtPercent: integer("warn_at_percent").notNull().default(60),
    criticalAtPercent: integer("critical_at_percent").notNull().default(80),
    hardStopAtPercent: integer("hard_stop_at_percent").notNull().default(100),
    action: text("action").notNull(),
    // Present when action implies an approval gate. Shape:
    // { approverRole: "ceo|cfo|manager|board", approvalType: "request_board_approval", expiresMinutes?: number }
    approvalGate: jsonb("approval_gate"),
    // How long an in-flight call may overshoot before being killed (§2.2).
    graceMinutes: integer("grace_minutes").notNull().default(5),
    // Searchable labels; never used for cap math (§2.2).
    tags: jsonb("tags"),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Agent or user id (text — either principal type).
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeActiveIdx: index("budget_caps_company_scope_active_idx").on(
      table.companyId,
      table.scope,
      table.scopeKey,
      table.isActive,
    ),
    scopeKeyIdx: index("budget_caps_scope_scope_key_idx").on(table.scope, table.scopeKey),
    // At most one active cap per (company, scope, scopeKey, window). Cluster caps
    // (company_id NULL) are not constrained by this partial index because
    // Postgres treats NULLs as distinct; cluster defaults come from config and
    // operators set at most one cluster cap per window by convention.
    activeScopeWindowUniqueIdx: uniqueIndex("budget_caps_active_scope_window_unique_idx")
      .on(table.companyId, table.scope, table.scopeKey, table.window)
      .where(sql`${table.isActive}`),
    windowAllowedCheck: check("budget_caps_window_allowed_check", sql`${table.window} IN (${sqlInList(BUDGET_CAP_WINDOWS)})`),
    windowAnchorCheck: check(
      "budget_caps_window_anchor_check",
      sql`${table.windowAnchor} IN (${sqlInList(BUDGET_CAP_WINDOW_ANCHORS)})`,
    ),
    scopeCheck: check("budget_caps_scope_check", sql`${table.scope} IN (${sqlInList(BUDGET_CAP_SCOPES)})`),
    actionCheck: check("budget_caps_action_check", sql`${table.action} IN (${sqlInList(BUDGET_CAP_ACTIONS)})`),
    // Threshold ordering invariant: warn ≤ critical ≤ hardStop, all in (0,1000].
    // (Percents may exceed 100 only as a defensive upper bound; policy uses ≤100.)
    thresholdOrderCheck: check(
      "budget_caps_threshold_order_check",
      sql`${table.warnAtPercent} <= ${table.criticalAtPercent} AND ${table.criticalAtPercent} <= ${table.hardStopAtPercent} AND ${table.warnAtPercent} > 0`,
    ),
    limitNonNegativeCheck: check("budget_caps_limit_non_negative_check", sql`${table.limitMicros} >= 0`),
    // Tenant invariant: company_id is NULL iff scope is 'cluster'.
    clusterTenancyCheck: check(
      "budget_caps_cluster_tenancy_check",
      sql`(${table.scope} = 'cluster' AND ${table.companyId} IS NULL) OR (${table.scope} <> 'cluster' AND ${table.companyId} IS NOT NULL)`,
    ),
  }),
);

export type BudgetCap = typeof budgetCaps.$inferSelect;
export type NewBudgetCap = typeof budgetCaps.$inferInsert;
