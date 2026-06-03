import { describe, expect, it, beforeAll, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  costEvents,
  heartbeatRuns,
  issues,
  projects,
  activityLog,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  invoiceReconcileService,
  INVOICE_RECONCILE_ORIGIN_KIND,
} from "../services/invoice-reconcile.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// NOTE: these tests exercise the two DB-bound halves of the reconciler that the
// server owns — the cost_events aggregate and the idempotent governance/billing
// issue creation. The pure parse + diff math (parseInvoice / reconcileInvoice)
// is covered by the shared package's own invoice-reconcile.test.ts vectors;
// reconcile() is the thin wiring over those tested pieces.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The cost_events aggregate needs the §2.1 micro-denominated columns on the
// resolved @paperclipai/db schema object. A shared/stale platform node_modules
// (worktree node_modules symlinked to a behind-origin checkout) can resolve a
// pre-§2.1 cost_events without `cost_micros`; skip the aggregate cases there so
// the suite stays green locally while CI (fresh install) runs them in full.
const hasCostMicros = "costMicros" in costEvents && "requestId" in costEvents;

// A minimal BillingReviewSubtask for a (provider, model, day) cell.
function subtaskFor(provider: string, model: string, day: string) {
  return {
    billingCode: "governance/billing" as const,
    title: `Invoice variance: ${provider}/${model} ${day} (+100.0%)`,
    body: `Vendor invoice reconciliation flagged a variance for ${provider}/${model} on ${day}.`,
    cell: { provider, model, day },
    expectedMicros: 1_000_000,
    observedMicros: 2_000_000,
    variancePercent: 100,
    thresholdPercent: 3,
    sampleRequestIds: ["req-a"],
  };
}

describeEmbeddedPostgres("invoiceReconcileService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof invoiceReconcileService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invoice-reconcile-");
    db = createDb(tempDb.connectionString);
    svc = invoiceReconcileService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it.skipIf(!hasCostMicros)("aggregates cost_events into (provider, model, UTC-day) cells with a bounded requestId sample", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(costEvents).values([
      {
        companyId, agentId, provider: "anthropic", biller: "anthropic",
        billingType: "metered_api", model: "claude-x", costCents: 0,
        costMicros: 1_000_000, requestId: "req-a",
        occurredAt: new Date("2026-04-10T03:00:00.000Z"),
      },
      {
        companyId, agentId, provider: "anthropic", biller: "anthropic",
        billingType: "metered_api", model: "claude-x", costCents: 0,
        costMicros: 500_000, requestId: "req-b",
        occurredAt: new Date("2026-04-10T20:00:00.000Z"),
      },
      {
        companyId, agentId, provider: "anthropic", biller: "anthropic",
        billingType: "metered_api", model: "claude-x", costCents: 0,
        costMicros: 250_000, requestId: "req-c",
        occurredAt: new Date("2026-04-11T01:00:00.000Z"),
      },
      // legacy cents-only row (no costMicros) must be excluded from the diff.
      {
        companyId, agentId, provider: "anthropic", biller: "anthropic",
        billingType: "metered_api", model: "claude-x", costCents: 999,
        requestId: "req-legacy",
        occurredAt: new Date("2026-04-10T05:00:00.000Z"),
      },
    ]);

    const cells = await svc.aggregateCostEventsCells(companyId, {}, 10);
    const day10 = cells.find((c) => c.day === "2026-04-10");
    const day11 = cells.find((c) => c.day === "2026-04-11");

    expect(cells).toHaveLength(2);
    expect(day10?.expectedMicros).toBe(1_500_000);
    expect(day10?.requestIds).toEqual(["req-a", "req-b"]); // legacy row excluded
    expect(day11?.expectedMicros).toBe(250_000);
  });

  it.skipIf(!hasCostMicros)("honours the from/to window and the requestId sample limit", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(costEvents).values([
      {
        companyId, agentId, provider: "openai", biller: "openai",
        billingType: "metered_api", model: "gpt", costCents: 0,
        costMicros: 100_000, requestId: "r1",
        occurredAt: new Date("2026-04-10T01:00:00.000Z"),
      },
      {
        companyId, agentId, provider: "openai", biller: "openai",
        billingType: "metered_api", model: "gpt", costCents: 0,
        costMicros: 100_000, requestId: "r2",
        occurredAt: new Date("2026-04-10T02:00:00.000Z"),
      },
      // out of window — must be ignored.
      {
        companyId, agentId, provider: "openai", biller: "openai",
        billingType: "metered_api", model: "gpt", costCents: 0,
        costMicros: 999_999, requestId: "r-out",
        occurredAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    ]);

    const cells = await svc.aggregateCostEventsCells(
      companyId,
      { from: new Date("2026-04-10T00:00:00.000Z"), to: new Date("2026-04-11T00:00:00.000Z") },
      1,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]?.expectedMicros).toBe(200_000);
    expect(cells[0]?.requestIds).toHaveLength(1); // sample capped at 1
  });

  it("opens a governance/billing review issue for a cell, idempotently per (provider, model, day)", async () => {
    const { companyId } = await seedCompany();
    const subtask = subtaskFor("anthropic", "claude-x", "2026-04-10");

    const first = await svc.ensureReviewIssue(companyId, subtask);
    expect(first.deduped).toBe(false);

    const created = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, INVOICE_RECONCILE_ORIGIN_KIND));
    expect(created).toHaveLength(1);
    expect(created[0]?.billingCode).toBe("governance/billing");
    expect(created[0]?.originFingerprint).toBe("anthropic:claude-x:2026-04-10");
    expect(created[0]?.status).toBe("todo");

    // Same cell again → dedups against the open issue, no second issue.
    const second = await svc.ensureReviewIssue(companyId, subtask);
    expect(second.deduped).toBe(true);
    expect(second.ref.id).toBe(first.ref.id);

    const afterRerun = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, INVOICE_RECONCILE_ORIGIN_KIND));
    expect(afterRerun).toHaveLength(1);
  });

  it("re-arms after the prior review issue is resolved", async () => {
    const { companyId } = await seedCompany();
    const subtask = subtaskFor("anthropic", "claude-x", "2026-04-10");

    const first = await svc.ensureReviewIssue(companyId, subtask);
    expect(first.deduped).toBe(false);

    // Resolve it; a later run for the still-divergent cell arms a fresh issue.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.ref.id));
    const second = await svc.ensureReviewIssue(companyId, subtask);
    expect(second.deduped).toBe(false);
    expect(second.ref.id).not.toBe(first.ref.id);

    const all = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, INVOICE_RECONCILE_ORIGIN_KIND));
    expect(all).toHaveLength(2);
  });

  it("scopes dedup per company (same cell in two companies → two issues)", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const subtask = subtaskFor("anthropic", "claude-x", "2026-04-10");

    const ra = await svc.ensureReviewIssue(a.companyId, subtask);
    const rb = await svc.ensureReviewIssue(b.companyId, subtask);
    expect(ra.deduped).toBe(false);
    expect(rb.deduped).toBe(false);
    expect(rb.ref.id).not.toBe(ra.ref.id);
  });
});
