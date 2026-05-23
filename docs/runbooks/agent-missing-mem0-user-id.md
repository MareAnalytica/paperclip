# Runbook — agent_missing_mem0_user_id

**Owner:** DeepSee Hydra Platform team
**Cross-company peer:** Eli Board ELI-168
**Ticket of record:** DEE-448 (peer of ELI-168 Option C-light)

## What this signal means

When an agent is created via `POST /api/companies/:companyId/agents` or patched
via `PATCH /api/agents/:id`, the control plane inspects the post-merge
`adapterConfig.env.MEM0_USER_ID` value. If it is absent or empty, the server
emits:

1. A structured **pino warn log** under event tag `agent_missing_mem0_user_id`
   with fields `companyId`, `agentId`, `verb` (`create`/`update`), `caller`
   (`agent`/`user`/`board`/`system`/`plugin`), `callerActorId`.
2. A single **activity_log row** with `action = "agent_missing_mem0_user_id"`,
   `entity_type = "agent"`, `entity_id = <agentId>`, and `details = {verb,
   caller, callerActorId, agentName, agentRole}`.
3. A **telemetry counter event** `agent.missing_mem0_user_id` with dimensions
   `{ company_id, verb, caller }` — the Paperclip-native analog of the
   Prometheus counter `agent_writes_missing_mem0_user_id_total{companyId,verb,caller}`
   named in the ELI-161 / ELI-168 blueprint.

This is a **WARN-only** gate. It does NOT block the write. Promotion to
blocking is a separate future ticket governed by the metric contract on
ELI-168.

## Why we care

`MEM0_USER_ID` is the per-agent Mem0 user/namespace; without it, any Mem0 read
or write inside that agent's runtime falls back to the adapter default and
either pollutes shared memory or creates a ghost user bucket. The
ELI-161/ELI-168 company-formation blueprint standardises
`MEM0_USER_ID = "${companyId}-${agent.nameKey}"` for every agent. This signal
is the early-warning instrument that lets us see how often non-bootstrap
writes (manual API calls, test scripts, future code paths) bypass the
convention before we decide whether to promote the check to blocking.

## How to query the count (audit-log SQL)

```sql
SELECT company_id,
       COALESCE(details->>'verb',   'unknown') AS verb,
       COALESCE(details->>'caller', 'unknown') AS caller,
       COUNT(*) AS hits,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen
FROM activity_log
WHERE action = 'agent_missing_mem0_user_id'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3
ORDER BY hits DESC;
```

For a totals-only view used for ELI-168 7-day back-reports:

```sql
SELECT COUNT(*)                                              AS total,
       COUNT(*) FILTER (WHERE details->>'verb' = 'create')   AS creates,
       COUNT(*) FILTER (WHERE details->>'verb' = 'update')   AS updates,
       COUNT(DISTINCT entity_id)                             AS distinct_agents,
       COUNT(DISTINCT company_id)                            AS distinct_companies
FROM activity_log
WHERE action = 'agent_missing_mem0_user_id'
  AND created_at >= NOW() - INTERVAL '7 days';
```

## Dashboard panel

Until a Grafana/Prometheus pipeline is wired into the control plane, the
canonical source of truth for the counter is the SQL above against the
control-plane Postgres `activity_log` table. Paste the first query into a
Grafana SQL panel (data source: Paperclip primary) titled
**"Agent writes missing MEM0_USER_ID (last 7d)"** with `verb` and `caller` as
breakdown fields and a `hits` value column.

If a Prometheus scrape is added later (separate ticket), the existing
telemetry counter event `agent.missing_mem0_user_id` is the natural shim
target — its dimensions match the Prometheus labels in the ELI-168 metric
contract one-for-one.

## How to triage a hit

1. **Read the warn log line.** It carries `companyId`, `agentId`, `verb`,
   `caller`, `callerActorId`. Decide whether this caller is supposed to be
   writing the env var (bootstrap pipeline / known governance flow) or
   whether it is unexpected (ad-hoc PATCH, test script, plugin).
2. **Look up the agent row.** `GET /api/companies/{companyId}/agents/{agentId}`
   and confirm `adapterConfig.env.MEM0_USER_ID` is indeed missing or empty.
   The check is non-blocking, so the write succeeded; the agent is live and
   may already be touching Mem0 against the adapter default.
3. **Patch the agent** with the correct id when remediation is appropriate:
   ```
   PATCH /api/agents/{agentId}
   { "adapterConfig": { "env": { "MEM0_USER_ID": "<companyId>-<agentNameKey>" } } }
   ```
   (`adapterConfig` merges into the existing object; this preserves other env
   keys.)
4. **Update the upstream caller.** If the caller is a Paperclip bootstrap
   script, plugin, or test helper, fix the caller so the next write sets the
   env var — silencing the warn at source is the goal, not patching after
   the fact.
5. **Do NOT promote the gate to blocking unilaterally.** Promotion is
   governed by ELI-168.

## 7-day back-report procedure (ELI-168)

At the 7-day mark after this PR lands in `brandon/update-latest-paperclip`,
the assigned Hydra Platform Architect posts the totals-only SQL above as a
back-report on ELI-168 with:

- date window (UTC),
- totals (`total`, `creates`, `updates`, `distinct_agents`, `distinct_companies`),
- top 5 breakdown rows by `(company_id, verb, caller)`,
- recommendation: stay at WARN, promote to a stricter warn, or open the
  Option C-blocking ticket.

The back-report itself stays inside DEE; ELI-168 receives a cross-company
comment via Hermes per the ELI-161 coordination protocol.

## Code references

- Helper service: `server/src/services/agent-mem0-warn.ts` (`recordAgentMem0UserIdGap`)
- POST wire-up: `server/src/routes/agents.ts`, `router.post("/companies/:companyId/agents", ...)`
- PATCH wire-up: `server/src/routes/agents.ts`, `router.patch("/agents/:id", ...)`
- Telemetry event name: `packages/shared/src/telemetry/types.ts` (`TelemetryEventName = "agent.missing_mem0_user_id"`)
- Telemetry helper: `packages/shared/src/telemetry/events.ts` (`trackAgentMissingMem0UserId`)
