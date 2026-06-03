import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, budgetCaps, companies, costEvents, projects } from "@paperclipai/db";
import { budgetReportService } from "../services/budget-reports.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Integration coverage for the real burn/forecast SQL against Postgres: the
// cost_micros + legacy-cents coalesce, scope filters, top-by-dimension grouping,
// the budget_caps limit join, and the §6.4 minEventsForForecast gating.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Fixed clock inside June 2026 so the calendar-month window is deterministic.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const IN_WINDOW = new Date("2026-06-10T00:00:00.000Z");

describeEmbeddedPostgres("budget-reports service (burn + forecast)", () => {
  let db!: ReturnType<typeof createDb>;
  let reports!: ReturnType<typeof budgetReportService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId!: string;
  let agent1!: string;
  let agent2!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-reports-");
    db = createDb(tempDb.connectionString);
    reports = budgetReportService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(budgetCaps);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agent1 = randomUUID();
    agent2 = randomUUID();
    projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [
      [agent1, "Agent One"],
      [agent2, "Agent Two"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(projects).values({ id: projectId, companyId, name: "Proj", status: "active" });

    await db.insert(costEvents).values([
      // agent1 / project / anthropic opus — 3 USD in micros
      {
        companyId,
        agentId: agent1,
        projectId,
        provider: "anthropic",
        model: "claude-opus-4-7",
        costCents: 300,
        costMicros: 3_000_000,
        occurredAt: IN_WINDOW,
      },
      // agent1 / anthropic sonnet — 1 USD in micros
      {
        companyId,
        agentId: agent1,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        costCents: 100,
        costMicros: 1_000_000,
        occurredAt: IN_WINDOW,
      },
      // agent2 / openai — legacy row, cost_micros NULL → folded from 200 cents = 2 USD
      {
        companyId,
        agentId: agent2,
        provider: "openai",
        model: "gpt-5",
        costCents: 200,
        occurredAt: IN_WINDOW,
      },
      // out-of-window row (May) — must be excluded from the June burn
      {
        companyId,
        agentId: agent1,
        provider: "anthropic",
        model: "claude-opus-4-7",
        costCents: 9_999,
        costMicros: 99_990_000,
        occurredAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ]);
  }

  async function seedCompanyCap(limitMicros: number) {
    await db.insert(budgetCaps).values({
      companyId,
      scope: "company",
      scopeKey: companyId,
      window: "month",
      limitMicros,
      action: "warn",
      warnAtPercent: 60,
      criticalAtPercent: 80,
      hardStopAtPercent: 100,
    });
  }

  it("sums cost_micros + legacy cents within the window and computes percent vs the cap", async () => {
    await seed();
    await seedCompanyCap(10_000_000); // 10 USD

    const burn = await reports.burn(companyId, { now: NOW });

    expect(burn.spendMicros).toBe(6_000_000); // 3M + 1M + 2M (folded), May excluded
    expect(burn.limitMicros).toBe(10_000_000);
    expect(burn.percent).toBeCloseTo(60, 5);
    expect(burn.projectedSpendMicros).toBeGreaterThan(burn.spendMicros);
    expect(burn.windowStart).toBe("2026-06-01T00:00:00.000Z");
    expect(burn.windowEnd).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns null percent when no cap exists for the scope/window", async () => {
    await seed();
    const burn = await reports.burn(companyId, { now: NOW });
    expect(burn.limitMicros).toBeNull();
    expect(burn.percent).toBeNull();
    expect(burn.projectedPercent).toBeNull();
  });

  it("ranks top contributors per dimension and drops null-keyed rows", async () => {
    await seed();
    const burn = await reports.burn(companyId, { now: NOW, topN: 1 });
    const byDim = Object.fromEntries(burn.topAttributable.map((t) => [t.dimension, t]));

    expect(byDim.agent).toMatchObject({ key: agent1, spendMicros: 4_000_000 });
    expect(byDim.provider).toMatchObject({ key: "anthropic", spendMicros: 4_000_000 });
    expect(byDim.model).toMatchObject({ key: "anthropic:claude-opus-4-7", spendMicros: 3_000_000 });
    expect(byDim.project).toMatchObject({ key: projectId, spendMicros: 3_000_000 });
    // No row carries a billingCode → that dimension contributes nothing.
    expect(byDim.billingCode).toBeUndefined();
  });

  it("filters cost_events by scope (agent) for a scoped burn", async () => {
    await seed();
    const burn = await reports.burn(companyId, { scope: "agent", scopeKey: agent2, now: NOW });
    expect(burn.spendMicros).toBe(2_000_000); // only agent2's folded legacy row
  });

  it("gates forecast on minEventsForForecast (§6.4)", async () => {
    await seed();
    await seedCompanyCap(10_000_000);

    // 3 events in window < default 5 → insufficient_history.
    const insufficient = await reports.forecast(companyId, { now: NOW });
    expect(insufficient.minEventsForForecast).toBe(5);
    expect(insufficient.caps).toHaveLength(1);
    expect(insufficient.caps[0].status).toBe("insufficient_history");
    expect(insufficient.caps[0].projectedPercent).toBeNull();

    // Lower the threshold so the 3 events qualify → real projection.
    const projected = await reports.forecast(companyId, { now: NOW, minEvents: 3 });
    const cap = projected.caps[0];
    expect(cap.eventCount).toBe(3);
    expect(cap.currentPercent).toBeCloseTo(60, 5);
    expect(cap.projectedPercent).not.toBeNull();
    // Linear projection of 60% at ~48% elapsed overshoots 100% → exhausted.
    expect(cap.projectedPercent!).toBeGreaterThan(100);
    expect(cap.status).toBe("exhausted");
  });
});
