# Runbook — `cost_events` §2.1 evolution (migration 0098)

Migration `0098_flimsy_pepper_potts.sql` evolves the existing `cost_events` table
to track §2.1 of the agent-budgeting policy
(`docs/policies/2026-05-13-agent-budgeting.md` in the eli-board blueprint).

It is **purely additive**: every new column is nullable and every change is an
`ADD COLUMN` / `CREATE INDEX`. No existing column is dropped, renamed, or
re-typed, so existing writers (`costs`, `budgets`, `finance`, `dashboard`,
`agents` services) and readers are unaffected.

## What changed

New columns (all nullable):

| Column | Type | §2.1 role |
| --- | --- | --- |
| `user_id` | text → `user(id)` | Human actor for human-initiated charges. |
| `kind` | text | `tokens \| requests \| seconds \| storage_bytes_day \| egress_bytes \| storage_bytes \| fixed`. |
| `qty` | numeric(20,6) | Quantity in the unit implied by `kind`. |
| `cache_write_tokens` | bigint | Tokens written to cache. |
| `unit_price_micros` | bigint | Frozen unit price (micro-units). |
| `cost_micros` | bigint | `qty * unit_price_micros`, server-computed. |
| `currency` | char(3) | ISO 4217. |
| `pricebook_version` | text | Pricebook revision frozen on insert. |
| `request_id` | text | Vendor request id for invoice reconciliation. |
| `idempotency_key` | text | Retry dedup; unique index below. |
| `meta` | jsonb | Vendor extras; never used for cap math. |

New indexes:

- `cost_events_provider_model_occurred_idx` on `(provider, model, occurred_at)`
- `cost_events_agent_occurred_idx` on `(agent_id, occurred_at)`
- `cost_events_project_occurred_idx` on `(project_id, occurred_at)`
- `cost_events_idempotency_key_uq` — **unique** on `(idempotency_key)`

The policy index `(companyId, eventAt)` already existed as
`cost_events_company_occurred_idx`.

### Naming reconciliation (policy ↔ existing columns)

The table predates the policy and uses slightly different names for two fields.
These are treated as the policy fields, not duplicated:

- policy `eventAt` ≡ existing `occurred_at` (when the underlying call completed)
- policy `runId` ≡ existing `heartbeat_run_id` (FK `heartbeat_runs`)

The legacy `cost_cents` column is retained alongside the new `cost_micros`; the
charge writer (ELI-72) populates both during the transition.

### Deferred (not in this migration)

§2.1 specifies `agentId` as nullable (null for human-initiated or source-less
system/timer charges). It is kept **NOT NULL** here so the migration stays
type-neutral for existing consumers (`event.agentId` flows into non-nullable
call sites in `costs.ts`). The relaxation lands with the charge writer (ELI-72),
which updates those call sites in the same change.

## Backfill plan

**No data backfill is performed or required.** Rows written before 0098 keep
`NULL` in every new column. This is safe because:

- The unique index on `idempotency_key` permits unlimited `NULL` values
  (Postgres treats `NULL`s as distinct), so legacy rows never collide.
- Aggregations and cap math continue to read the existing `cost_cents` /
  `occurred_at` / `heartbeat_run_id` columns, which are unchanged.

Going forward, `POST /cost/charge` (ELI-72) is responsible for populating the
§2.1-required subset (`kind`, `qty`, `unit_price_micros`, `cost_micros`,
`currency`, `pricebook_version`, `idempotency_key`, `event/occurred_at`) on
every new row. The required-ness is enforced at the application layer, not by DB
`NOT NULL` constraints, precisely so legacy rows remain valid.

If a historical price reconstruction is ever wanted, it must go through the
signed reconciliation endpoint (policy §7.4) and write `pricebook_version`
reflecting the revision in effect at each row's `occurred_at` — never a
present-day price. This is explicitly out of scope for 0098.

## Rollback

The repo uses forward-only drizzle migrations (no generated down-migrations).
0098 is additive, so rollback is only needed if the migration must be reversed
before any dependent code ships. Reverse manually:

```sql
DROP INDEX IF EXISTS "cost_events_idempotency_key_uq";
DROP INDEX IF EXISTS "cost_events_project_occurred_idx";
DROP INDEX IF EXISTS "cost_events_agent_occurred_idx";
DROP INDEX IF EXISTS "cost_events_provider_model_occurred_idx";
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_user_id_user_id_fk";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "meta";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "request_id";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "pricebook_version";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "cost_micros";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "unit_price_micros";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "cache_write_tokens";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "qty";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "user_id";
```

Then delete the `0098` entry from `packages/db/src/migrations/meta/_journal.json`
and remove `0098_flimsy_pepper_potts.sql` and `meta/0098_snapshot.json`. Because
no shipped code reads the new columns yet, dropping them loses no committed data
(every value is `NULL` until ELI-72 lands).
