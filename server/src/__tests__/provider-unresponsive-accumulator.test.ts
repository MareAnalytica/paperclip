import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  accumulateProviderUnresponsiveHang,
  providerUnresponsiveFingerprint,
  resolveProviderUnresponsiveAccumulatorOnRecovery,
} from "../services/provider-unresponsive-accumulator.js";

// ELI-964 — the precise N-bound escalate arm of the Contract C cross-run
// provider-unresponsive breaker. Drives the REAL `issue_recovery_actions`
// accumulator against an embedded Postgres so the consecutive-count source and
// the escalate→operator transition are exercised end-to-end, not mocked.
const BOUND = 2;
const PROVIDER = "grok-local";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-unresponsive accumulator tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("accumulateProviderUnresponsiveHang", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueRecoveryActionService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-unresponsive-acc-");
    db = createDb(tempDb.connectionString);
    svc = issueRecoveryActionService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `PU${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Provider Health Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "grok_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement feature",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  // One hang on a fresh root run. `runId` differs each call to model a new run.
  function hang(
    ctx: { companyId: string; agentId: string; issueId: string | null },
    opts: { chainProviderIds?: string[]; cooledDown?: string[]; runId?: string } = {},
  ) {
    return accumulateProviderUnresponsiveHang(svc, {
      companyId: ctx.companyId,
      issueId: ctx.issueId,
      agentId: ctx.agentId,
      provider: PROVIDER,
      account: null,
      model: "grok-4",
      runId: opts.runId ?? randomUUID(),
      chainProviderIds: opts.chainProviderIds ?? [PROVIDER],
      cooledDownProviderIds: new Set(opts.cooledDown ?? []),
      maxUnresponsiveRetriesPerProvider: BOUND,
    });
  }

  it("escalates on the N+1th consecutive hang, sourcing the count from the persisted accumulator", async () => {
    const ctx = await seed();

    // No healthy alternative (chain is the hung provider only). Within the bound
    // ⇒ retry_same; each hang is a separate root run.
    const first = await hang(ctx);
    expect(first.attempt).toBe(1);
    expect(first.attemptSource).toBe("accumulator");
    expect(first.decision.actionTaken).toBe("retry_same");
    expect(first.escalated).toBeNull();

    const second = await hang(ctx);
    expect(second.attempt).toBe(2);
    expect(second.decision.actionTaken).toBe("retry_same");
    expect(second.escalated).toBeNull();

    // N+1th hang ⇒ escalate: opens exactly one operator recovery action and stops
    // re-routing the same pair.
    const third = await hang(ctx);
    expect(third.attempt).toBe(3);
    expect(third.attemptSource).toBe("accumulator");
    expect(third.decision.actionTaken).toBe("escalate");
    expect(third.audit.attempt).toBe(3);
    expect(third.escalated).not.toBeNull();
    expect(third.escalated!.status).toBe("escalated");
    expect(third.escalated!.ownerType).toBe("board");
    expect(third.escalated!.nextAction.toLowerCase()).toContain("cli health check");

    // Persisted: a single accumulator row at the precise count, escalated.
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ctx.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptCount).toBe(3);
    expect(rows[0]!.status).toBe("escalated");
    expect(rows[0]!.cause).toBe("provider_unresponsive");
    expect(rows[0]!.fingerprint).toBe(
      providerUnresponsiveFingerprint({
        companyId: ctx.companyId,
        issueId: ctx.issueId,
        agentId: ctx.agentId,
        provider: PROVIDER,
      }),
    );
  });

  it("is idempotent once escalated: a further hang does not re-count or open a second action", async () => {
    const ctx = await seed();
    await hang(ctx);
    await hang(ctx);
    const escalateHang = await hang(ctx);
    expect(escalateHang.decision.actionTaken).toBe("escalate");

    const repeat = await hang(ctx);
    expect(repeat.attempt).toBe(3); // not incremented past escalation
    expect(repeat.decision.actionTaken).toBe("escalate");
    expect(repeat.escalated).toBeNull(); // no second operator action opened

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ctx.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptCount).toBe(3);
    expect(rows[0]!.status).toBe("escalated");
  });

  it("fails over to a healthy alternative without escalating, even past the bound", async () => {
    const ctx = await seed();
    const chain = [PROVIDER, "claude-code-personal"];
    for (let i = 0; i < BOUND + 2; i++) {
      const result = await hang(ctx, { chainProviderIds: chain });
      expect(result.decision.actionTaken).toBe("failover");
      expect(result.decision.targetProvider).toBe("claude-code-personal");
      expect(result.escalated).toBeNull();
    }
    // The accumulator still tracks the streak but never escalates while a healthy
    // alternative exists.
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ctx.issueId));
    expect(rows[0]!.status).toBe("active");
  });

  it("yields to a competing stranded recovery action without clobbering it (coexistence)", async () => {
    const ctx = await seed();
    // A stranded-issue recovery action already owns the per-issue active slot.
    const stranded = await svc.upsertSourceScoped({
      companyId: ctx.companyId,
      sourceIssueId: ctx.issueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: ctx.agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${ctx.companyId}:${ctx.issueId}:stranded_assigned_issue`,
      nextAction: "Restore a live execution path.",
    });

    const result = await hang(ctx);
    // Yields: proxy attempt, no escalation, no new provider row.
    expect(result.attemptSource).toBe("proxy");
    expect(result.escalated).toBeNull();

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ctx.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(stranded.id); // untouched
    expect(rows[0]!.cause).toBe("stranded_assigned_issue");
    expect(rows[0]!.attemptCount).toBe(1); // not incremented by the provider hang
  });

  it("resets the consecutive streak when the provider recovers", async () => {
    const ctx = await seed();
    await hang(ctx);
    const second = await hang(ctx);
    expect(second.attempt).toBe(2);

    // Provider responds on a clean run ⇒ accumulator resolved.
    const resolved = await resolveProviderUnresponsiveAccumulatorOnRecovery(svc, {
      companyId: ctx.companyId,
      issueId: ctx.issueId,
      agentId: ctx.agentId,
      provider: PROVIDER,
      runId: randomUUID(),
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.outcome).toBe("restored");

    // A subsequent hang starts a fresh streak at attempt 1 (no premature escalate).
    const afterRecovery = await hang(ctx);
    expect(afterRecovery.attempt).toBe(1);
    expect(afterRecovery.decision.actionTaken).toBe("retry_same");
  });

  it("uses the proxy count for source-less runs (no issueId, no accumulator row)", async () => {
    const ctx = await seed();
    const result = await accumulateProviderUnresponsiveHang(svc, {
      companyId: ctx.companyId,
      issueId: null,
      agentId: ctx.agentId,
      provider: PROVIDER,
      runId: randomUUID(),
      chainProviderIds: [PROVIDER],
      cooledDownProviderIds: new Set([PROVIDER]), // already cooling ⇒ proxy attempt 2
      maxUnresponsiveRetriesPerProvider: BOUND,
    });
    expect(result.attemptSource).toBe("proxy");
    expect(result.attempt).toBe(2);
    expect(result.escalated).toBeNull();
    const rows = await db.select().from(issueRecoveryActions);
    expect(rows).toHaveLength(0);
  });
});
