# Runbook — `budget_caps` + `cost_events_window_agg` (migration 0099)

Migration `0099_dry_corsair.sql` adds the §2.2 cap surface and the §4.2/§5
per-window spend rollup of the agent-budgeting policy
(`docs/policies/2026-05-13-agent-budgeting.md` in the eli-board blueprint). It
depends on the §2.1 `cost_events` evolution (migration 0098, ELI-69).

It is **purely additive**: two new tables, plus SQL functions and one trigger.
No existing table or column is altered, so existing writers/readers are
unaffected. Nothing shipped reads the new objects yet — the preflight/charge and
enforcement handlers (ELI-74/75/76) land later and consume them.

## What changed

### Tables

- **`budget_caps`** — operator-set explicit caps and per-company overrides. A cap
  is `(scope, scope_key, window, limit_micros, action)` plus the warn/critical/
  hard-stop threshold percents, an optional `approval_gate` (jsonb), an overshoot
  `grace_minutes`, and `window_anchor` (calendar | rolling). Coexists additively
  with the legacy `budget_policies` table (simpler, cents-denominated); no
  migration of one to the other is performed here.
  - Enum CHECKs pin `window` to `windows.allowed`, `scope` to the §2.2 set, and
    `action` to the §4.3 set, so out-of-enum values are rejected at the DB layer.
  - A partial unique index allows at most one **active** cap per
    `(company_id, scope, scope_key, window)`.
  - `clusterTenancyCheck`: `company_id` is NULL **iff** scope is `cluster`.
  - `thresholdOrderCheck`: `warn ≤ critical ≤ hardStop`, all `> 0`.

- **`cost_events_window_agg`** — per-window spend rollup keyed by
  `(scope, scope_key, window_key)`. Implemented as an incrementally-maintained
  rollup **table** (not a Postgres `MATERIALIZED VIEW`) so it can be refreshed
  inline on insert and reconciled by cron. Only **calendar** windows
  (`minute|hour|day|week|month`) are materialized; rolling/`total` windows are
  relative to `now()` and computed live by readers.

### Functions (hand-written below the drizzle DDL)

| Object | Role |
| --- | --- |
| `cost_events_window_bounds(window, at)` | UTC-anchored bucket `[start, end)` + `window_key` `"<window>:<YYYYMMDD>T<HHMMSS>"`. Mirrored by `packages/shared/src/budget/windows.ts`. |
| `cost_events_scope_projection(company, project, goal, agent, issue, provider, model, billingCode)` | The `(scope, scope_key, company_id)` set a single `cost_events` row attributes to. |
| `cost_events_window_agg_sync()` + `cost_events_window_agg_sync_trg` | AFTER INSERT trigger on `cost_events`; increments every `(scope, calendar window)` bucket the row lands in (upsert). |
| `reconcile_cost_events_window_agg(since)` | Cron target. Fully recomputes every bucket **touched** by a row with `occurred_at ≥ since` (NULL = whole table) from all rows in that bucket's bounds, correcting drift. Returns rows upserted. |

### Scope coverage and `windowKey`

The trigger/reconcile fan a charge out to the scopes derivable from a
`cost_events` row alone: `cluster` (scope_key `_`, NULL company), `company`,
`project`, `goal`, `agent`, `provider`, `model` (`<provider>:<model>`),
`billingCode`, `issue`. The `agent-template`, `route`, and `routine` scopes are
**not** derivable from `cost_events` and are intentionally omitted — they are
aggregated by their own writers when those dimensions land. `billingCode` rows
store the leaf code; the `code/%` LIKE-prefix match (§2.2) is applied by readers.

`windowKey` is the UTC wall-clock bucket start; `week` is Monday-anchored to
match Postgres `date_trunc('week', ...)`. The TS mirror produces byte-identical
keys (asserted by both `packages/shared/.../windows.test.ts` and the embedded-PG
integration test).

## Refresh strategy (inline + cron)

1. **Inline** — the AFTER INSERT trigger folds each new charge into its buckets
   in the same transaction as the `cost_events` insert.
2. **Cron** — a 5-minute job calls `reconcile_cost_events_window_agg(now() -
   interval '10 minutes')` (a window wider than the cron period absorbs late
   writes and the `windows.boundaryGraceSeconds` grace). Whole-bucket recompute
   means a short `since` never undercounts a long (week/month) bucket. The cron
   wiring is a separate scheduler change (out of scope for this schema leg).

## Cap precedence (§2.3)

Codified, pure and DB-independent, in
`packages/shared/src/budget/cap-precedence.ts` (`resolveBindingCap`):

1. Hardest action wins: `hard_stop > pause_runs > pause_writes > require_approval > warn`.
2. Within an action, the highest `currentPercent` binds.
3. Approval gates do not cascade — every firing gate is returned; each must clear.
4. The cluster cap is non-overridable — a per-company approval-grant cannot relax it.

## Backfill

**No backfill is performed.** `cost_events_window_agg` starts empty; the trigger
populates it going forward. To backfill historical buckets, run
`SELECT reconcile_cost_events_window_agg(NULL);` once after deploy (recomputes
every bucket from all of `cost_events`).

## Rollback

The repo uses forward-only drizzle migrations. 0099 is additive and unread by
shipped code, so it can be reversed manually (see the `-- Rollback:` block at the
top of `0099_dry_corsair.sql`): drop the trigger, the four functions, and the two
tables, then remove the `0099` journal entry, the `.sql`, and `meta/0099_snapshot.json`.
Dropping the tables loses no committed data (both are new and empty until the
charge writer ships).
