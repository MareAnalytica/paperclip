import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Account/provider-scoped fallback cooldown (ticket ELI-855).
//
// When a provider in the fallback chain reports a session/usage limit, we
// record the reset window here so that *new root runs* skip that provider until
// it is healthy again — instead of every fresh run re-trying a Claude account
// that already said "blocked until <reset>". Within-run fallback continues to
// hop the chain as before; this table is the cross-run circuit breaker the
// scheduler consults when a run starts with no provider already selected.
//
// One row per (company, provider id). The window is advisory and self-expiring:
// readers filter on `cooldown_until > now`, so an expired row simply stops
// matching and the provider becomes eligible again — no reaper required.
export const providerAccountCooldowns = pgTable(
  "provider_account_cooldowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Public provider id from the fallback chain (e.g. "claude-code-personal").
    providerId: text("provider_id").notNull(),
    adapterType: text("adapter_type").notNull(),
    // The account label the provider id maps to, recorded for observability of
    // account-level state (nullable for account-less providers like codex/grok).
    account: text("account"),
    // The provider is considered cooled down until this instant.
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }).notNull(),
    // Where the reset time came from: a provider-supplied reset header, or the
    // configured retryAfterMinutesDefault back-off.
    source: text("source").notNull(),
    reason: text("reason"),
    // Last run/issue that observed the limit — audit trail, not load-bearing.
    lastRunId: uuid("last_run_id"),
    lastIssueId: text("last_issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: uniqueIndex("provider_account_cooldowns_company_provider_idx").on(
      table.companyId,
      table.providerId,
    ),
    companyActiveIdx: index("provider_account_cooldowns_company_active_idx").on(
      table.companyId,
      table.cooldownUntil,
    ),
  }),
);
