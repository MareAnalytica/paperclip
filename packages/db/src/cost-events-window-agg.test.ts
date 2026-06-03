import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Integration coverage for the migration-0099 aggregator runtime: the
// cost_events_window_bounds / cost_events_scope_projection helpers, the inline
// AFTER INSERT trigger, and the reconcile function. Runs against embedded
// Postgres; skipped on hosts where that is unavailable (same gate as the other
// db integration suites).

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cost_events_window_agg integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function migratedDatabase() {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-window-agg-");
  cleanups.push(db.cleanup);
  await applyPendingMigrations(db.connectionString);
  return postgres(db.connectionString, { max: 1, onnotice: () => {} });
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

const OCCURRED = "2026-06-03T15:30:45Z";

async function seedCharge(
  sql: postgres.Sql,
  opts: { provider?: string; model?: string; costMicros?: number; occurredAt?: string } = {},
) {
  const [{ id: companyId }] = await sql<{ id: string }[]>`
    INSERT INTO companies (name) VALUES ('Acme') RETURNING id`;
  const [{ id: agentId }] = await sql<{ id: string }[]>`
    INSERT INTO agents (company_id, name) VALUES (${companyId}, 'Engineer') RETURNING id`;
  await sql`
    INSERT INTO cost_events (company_id, agent_id, provider, model, cost_cents, cost_micros, occurred_at)
    VALUES (${companyId}, ${agentId}, ${opts.provider ?? "anthropic"}, ${opts.model ?? "claude-opus-4-8"},
            0, ${opts.costMicros ?? 1_000_000}, ${opts.occurredAt ?? OCCURRED})`;
  return { companyId, agentId };
}

describeEmbeddedPostgres("migration 0099 — cost_events_window_agg aggregator", () => {
  it("cost_events_window_bounds produces UTC buckets with keys matching the TS mirror", async () => {
    const sql = await migratedDatabase();
    const day = await sql<{ window_key: string; window_start: Date; window_end: Date }[]>`
      SELECT * FROM cost_events_window_bounds('day', ${OCCURRED}::timestamptz)`;
    expect(day[0].window_key).toBe("day:20260603T000000");
    expect(day[0].window_start.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    expect(day[0].window_end.toISOString()).toBe("2026-06-04T00:00:00.000Z");

    const month = await sql<{ window_key: string; window_end: Date }[]>`
      SELECT * FROM cost_events_window_bounds('month', '2026-12-31T23:59:59Z'::timestamptz)`;
    expect(month[0].window_key).toBe("month:20261201T000000");
    expect(month[0].window_end.toISOString()).toBe("2027-01-01T00:00:00.000Z");

    const week = await sql<{ window_key: string }[]>`
      SELECT * FROM cost_events_window_bounds('week', '2026-06-07T12:00:00Z'::timestamptz)`;
    expect(week[0].window_key).toBe("week:20260601T000000"); // Monday-anchored
  });

  it("cost_events_scope_projection fans out only the populated, derivable scopes", async () => {
    const sql = await migratedDatabase();
    const rows = await sql<{ scope: string; scope_key: string; company_id: string | null }[]>`
      SELECT * FROM cost_events_scope_projection(
        '11111111-1111-1111-1111-111111111111'::uuid, NULL, NULL,
        '22222222-2222-2222-2222-222222222222'::uuid, NULL,
        'anthropic', 'claude-opus-4-8', NULL)
      ORDER BY scope`;
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toEqual(["agent", "cluster", "company", "model", "provider"]);
    const cluster = rows.find((r) => r.scope === "cluster")!;
    expect(cluster.scope_key).toBe("_");
    expect(cluster.company_id).toBeNull(); // cross-tenant
    expect(rows.find((r) => r.scope === "model")!.scope_key).toBe("anthropic:claude-opus-4-8");
  });

  it("the inline trigger folds each charge into every (scope, calendar window) bucket", async () => {
    const sql = await migratedDatabase();
    const { companyId } = await seedCharge(sql, { costMicros: 1_000_000 });
    // A second charge in the same buckets, same company/agent/provider/model.
    const [{ id: agentId2 }] = await sql<{ id: string }[]>`
      SELECT id FROM agents LIMIT 1`;
    await sql`
      INSERT INTO cost_events (company_id, agent_id, provider, model, cost_cents, cost_micros, occurred_at)
      VALUES (${companyId}, ${agentId2}, 'anthropic', 'claude-opus-4-8', 0, 1_500_000, ${OCCURRED})`;

    const [companyDay] = await sql<{ spend_micros: number; event_count: number }[]>`
      SELECT spend_micros::int, event_count::int FROM cost_events_window_agg
      WHERE scope = 'company' AND scope_key = ${companyId} AND window_key = 'day:20260603T000000'`;
    expect(companyDay.spend_micros).toBe(2_500_000);
    expect(companyDay.event_count).toBe(2);

    // Cluster bucket aggregates cross-tenant with a NULL company_id.
    const [clusterDay] = await sql<{ spend_micros: number; company_id: string | null }[]>`
      SELECT spend_micros::int, company_id FROM cost_events_window_agg
      WHERE scope = 'cluster' AND window_key = 'day:20260603T000000'`;
    expect(clusterDay.spend_micros).toBe(2_500_000);
    expect(clusterDay.company_id).toBeNull();

    // 5 scopes (cluster/company/agent/provider/model) × 5 calendar windows.
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int FROM cost_events_window_agg`;
    expect(count).toBe(25);
  });

  it("reconcile recomputes drifted buckets from cost_events", async () => {
    const sql = await migratedDatabase();
    const { companyId } = await seedCharge(sql, { costMicros: 3_000_000 });

    // Simulate drift: corrupt the materialized company/day bucket.
    await sql`
      UPDATE cost_events_window_agg SET spend_micros = 0, event_count = 0
      WHERE scope = 'company' AND scope_key = ${companyId} AND window_key = 'day:20260603T000000'`;

    const repaired = await sql<{ reconcile_cost_events_window_agg: number }[]>`
      SELECT reconcile_cost_events_window_agg(NULL)`;
    expect(repaired[0].reconcile_cost_events_window_agg).toBeGreaterThan(0);

    const [companyDay] = await sql<{ spend_micros: number; event_count: number }[]>`
      SELECT spend_micros::int, event_count::int FROM cost_events_window_agg
      WHERE scope = 'company' AND scope_key = ${companyId} AND window_key = 'day:20260603T000000'`;
    expect(companyDay.spend_micros).toBe(3_000_000);
    expect(companyDay.event_count).toBe(1);
  });

  it("reconcile recomputes whole buckets, not just rows since `since` (no undercount)", async () => {
    const sql = await migratedDatabase();
    // Two charges in the same month bucket, hours apart.
    const { companyId } = await seedCharge(sql, { costMicros: 4_000_000, occurredAt: "2026-06-03T01:00:00Z" });
    const [{ id: agentId }] = await sql<{ id: string }[]>`SELECT id FROM agents LIMIT 1`;
    await sql`
      INSERT INTO cost_events (company_id, agent_id, provider, model, cost_cents, cost_micros, occurred_at)
      VALUES (${companyId}, ${agentId}, 'anthropic', 'claude-opus-4-8', 0, 5_000_000, '2026-06-03T09:00:00Z')`;

    // Reconcile with a `since` that only covers the second charge. The month
    // bucket it touches must still recompute from BOTH rows (4M + 5M), not just
    // the row >= since.
    await sql`SELECT reconcile_cost_events_window_agg('2026-06-03T08:00:00Z'::timestamptz)`;

    const [companyMonth] = await sql<{ spend_micros: number; event_count: number }[]>`
      SELECT spend_micros::int, event_count::int FROM cost_events_window_agg
      WHERE scope = 'company' AND scope_key = ${companyId} AND window_key = 'month:20260601T000000'`;
    expect(companyMonth.spend_micros).toBe(9_000_000);
    expect(companyMonth.event_count).toBe(2);
  });
});
