import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_REARM_MAX_MS,
  ACTIVE_RUN_OUTPUT_REARM_MIN_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
  heartbeatService,
} from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { getRunLogStore } from "../services/run-log-store.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged stale-run evaluation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-run output watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("active-run output watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-output-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun(opts: {
    now: Date;
    ageMs: number;
    withOutput?: boolean;
    logChunk?: string;
    sourceStatus?: "in_progress" | "done" | "cancelled";
    sourceOriginKind?: string;
    sameRunTerminalEvidence?: "activity" | "comment";
    watchdogPolicies?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const lastOutputAt = opts.withOutput ? new Date(opts.now.getTime() - 5 * 60 * 1000) : null;
    const sourceStatus = opts.sourceStatus ?? "in_progress";
    const terminalEvidenceAt = new Date(startedAt.getTime() + 10 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      policies: opts.watchdogPolicies ? { watchdog: opts.watchdogPolicies } : null,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long running implementation",
      status: sourceStatus,
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: opts.sourceOriginKind ?? "manual",
      completedAt: sourceStatus === "done" ? terminalEvidenceAt : null,
      cancelledAt: sourceStatus === "cancelled" ? terminalEvidenceAt : null,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt,
      lastOutputSeq: opts.withOutput ? 3 : 0,
      lastOutputStream: opts.withOutput ? "stdout" : null,
      contextSnapshot: { issueId },
      stdoutExcerpt: "OPENAI_API_KEY=sk-test-secret-value should not leak",
      logBytes: 0,
    });
    if (opts.logChunk) {
      const store = getRunLogStore();
      const handle = await store.begin({ companyId, agentId: coderId, runId });
      const logBytes = await store.append(handle, {
        stream: "stdout",
        chunk: opts.logChunk,
        ts: startedAt.toISOString(),
      });
      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          logBytes,
        })
        .where(eq(heartbeatRuns.id, runId));
    }
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    if (opts.sameRunTerminalEvidence === "activity") {
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: coderId,
        agentId: coderId,
        runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: {
          identifier: `${issuePrefix}-1`,
          status: sourceStatus,
          _previous: { status: "in_progress" },
        },
        createdAt: terminalEvidenceAt,
      });
    } else if (opts.sameRunTerminalEvidence === "comment") {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: coderId,
        authorType: "agent",
        createdByRunId: runId,
        body: "Completed and verified.",
        createdAt: terminalEvidenceAt,
        updatedAt: terminalEvidenceAt,
      });
    }
    return { companyId, managerId, coderId, issueId, runId, issuePrefix };
  }

  it("creates one medium-priority evaluation issue for a suspicious silent run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const second = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(1);
    expect(["todo", "in_progress"]).toContain(evaluations[0]?.status);
    expect(evaluations[0]).toMatchObject({
      priority: "medium",
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
      originId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
    });
    expect(evaluations[0]?.description).toContain("Decision Checklist");
    expect(evaluations[0]?.description).not.toContain("sk-test-secret-value");
  });

  it("re-arms an evaluation auto-resolved without an explicit decision instead of re-creating it every scan (§10)", async () => {
    // Regression for the 314-issue churn: an evaluation auto-resolved to `done`
    // with no recorded watchdog decision previously left no re-arm window, so the
    // next ~60s scan re-created it. The creation-side dedupe must count the
    // recently-resolved action and back-fill a `continue` decision.
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(first.created).toBe(1);
    const firstEvaluationId = first.evaluationIssueIds[0];
    expect(firstEvaluationId).toBeTruthy();

    // The owner marks it done WITHOUT calling the watchdog-decision route — the
    // exact path that produced the churn.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, firstEvaluationId));

    // Next scan, still inside the re-arm window: no new evaluation, an explicit
    // `continue` decision is back-filled, and the run is counted as re-armed.
    const second = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(second).toMatchObject({ created: 0, rearmed: 1 });

    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(and(eq(heartbeatRunWatchdogDecisions.companyId, companyId), eq(heartbeatRunWatchdogDecisions.runId, runId)));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "continue", evaluationIssueId: firstEvaluationId });
    expect(decisions[0]?.snoozedUntil?.toISOString()).toBe(
      new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS).toISOString(),
    );

    // A third scan still inside the window stays quiet (no second re-arm).
    const third = await heartbeat.scanSilentActiveRuns({
      now: new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS - 60_000),
      companyId,
    });
    expect(third).toMatchObject({ created: 0, rearmed: 0, snoozed: 1 });

    // After the window elapses, a single fresh evaluation is minted (not 314).
    const afterWindow = await heartbeat.scanSilentActiveRuns({
      now: new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS + 60_000),
      companyId,
    });
    expect(afterWindow.created).toBe(1);
    expect(afterWindow.evaluationIssueIds[0]).not.toBe(firstEvaluationId);
  });

  it("honors the company-configured re-arm window for explicit and back-filled continues (§10)", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const customReArmMs = 90 * 60 * 1000;
    expect(customReArmMs).not.toBe(ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);
    await db
      .update(companies)
      .set({ policies: { watchdog: { reArmWindow: customReArmMs } } })
      .where(eq(companies.id, companyId));
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    // Explicit continue uses the configured window.
    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "continue",
      evaluationIssueId,
      reason: "Acceptable evidence; keep watching on the configured window.",
      now,
    });
    expect(decision.snoozedUntil?.toISOString()).toBe(
      new Date(now.getTime() + customReArmMs).toISOString(),
    );

    // The configured window also suppresses re-creation: nothing before it, a
    // fresh evaluation only after it elapses.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));
    const beforeDefault = await heartbeat.scanSilentActiveRuns({
      now: new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS + 60_000),
      companyId,
    });
    expect(beforeDefault).toMatchObject({ created: 0, snoozed: 1 });
    const afterCustom = await heartbeat.scanSilentActiveRuns({
      now: new Date(now.getTime() + customReArmMs + 60_000),
      companyId,
    });
    expect(afterCustom.created).toBe(1);
  });

  it("clamps a misconfigured re-arm window to operational bounds (§10/ELI-776)", async () => {
    // A `0`/negative window would re-create an evaluation every ~60s scan (the
    // exact churn this contract stops); an absurd window would suppress watchdog
    // review of a critical-silent run indefinitely. Both are clamped, not honored.
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    // Disarming value (0) → clamped up to the floor.
    {
      const { companyId, managerId, runId } = await seedRunningRun({
        now: new Date("2026-04-22T20:00:00.000Z"),
        ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      });
      const now = new Date("2026-04-22T20:00:00.000Z");
      await db
        .update(companies)
        .set({ policies: { watchdog: { reArmWindow: 0 } } })
        .where(eq(companies.id, companyId));
      const heartbeat = heartbeatService(db);
      const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
      const evaluationIssueId = scan.evaluationIssueIds[0];
      expect(evaluationIssueId).toBeTruthy();
      const decision = await recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "Misconfigured (0) window must be clamped to the floor.",
        now,
      });
      expect(decision.snoozedUntil?.toISOString()).toBe(
        new Date(now.getTime() + ACTIVE_RUN_OUTPUT_REARM_MIN_MS).toISOString(),
      );
    }

    // Absurdly large value → clamped down to the ceiling.
    {
      const { companyId, managerId, runId } = await seedRunningRun({
        now: new Date("2026-04-22T20:00:00.000Z"),
        ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      });
      const now = new Date("2026-04-22T20:00:00.000Z");
      await db
        .update(companies)
        .set({ policies: { watchdog: { reArmWindow: 365 * 24 * 60 * 60 * 1000 } } })
        .where(eq(companies.id, companyId));
      const heartbeat = heartbeatService(db);
      const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
      const evaluationIssueId = scan.evaluationIssueIds[0];
      expect(evaluationIssueId).toBeTruthy();
      const decision = await recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "Absurd window must be clamped to the ceiling.",
        now,
      });
      expect(decision.snoozedUntil?.toISOString()).toBe(
        new Date(now.getTime() + ACTIVE_RUN_OUTPUT_REARM_MAX_MS).toISOString(),
      );
    }
  });

  it("creation dedup and re-arm cover source-less timer/system runs (§10)", async () => {
    // Source-less runs (no linked source issue) are first-class: they cannot fold
    // (§10), so they rely entirely on the creation-side (companyId, runId) dedupe
    // and re-arm window.
    const now = new Date("2026-04-22T20:00:00.000Z");
    const companyId = randomUUID();
    const managerId = randomUUID();
    const workerId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const silenceMs = ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000;
    const startedAt = new Date(now.getTime() - silenceMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Sourceless Watchdog Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerId,
        companyId,
        name: "Timer Worker",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    // Source-less: a timer/system run with no linked source issue in its context.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {},
      logBytes: 0,
    });

    const heartbeat = heartbeatService(db);

    // Exactly one evaluation, then open-evaluation dedup keyed on (companyId, runId).
    const scan1 = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(scan1).toMatchObject({ created: 1 });
    const evaluationIssueId = scan1.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();
    const scan2 = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(scan2).toMatchObject({ created: 0, existing: 1 });

    // Auto-resolved without a decision — source-less runs are re-armed too.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));
    const scan3 = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(scan3).toMatchObject({ created: 0, rearmed: 1 });

    const rearmAt = new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);
    const beforeRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() - 60_000),
      companyId,
    });
    expect(beforeRearm).toMatchObject({ created: 0, snoozed: 1 });
    const afterRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() + 60_000),
      companyId,
    });
    expect(afterRearm.created).toBe(1);
    expect(afterRearm.evaluationIssueIds[0]).not.toBe(evaluationIssueId);
  });

  it("redacts sensitive values from actual run-log evidence", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const leakedJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const leakedGithubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const { companyId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      logChunk: [
        "Authorization: Bearer live-bearer-token-value",
        `POST payload {"apiKey":"json-secret-value","token":"${leakedJwt}"}`,
        `GITHUB_TOKEN=${leakedGithubToken}`,
      ].join("\n"),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.scanSilentActiveRuns({ now, companyId });

    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.description).toContain("***REDACTED***");
    expect(evaluation?.description).not.toContain("live-bearer-token-value");
    expect(evaluation?.description).not.toContain("json-secret-value");
    expect(evaluation?.description).not.toContain(leakedJwt);
    expect(evaluation?.description).not.toContain(leakedGithubToken);
  });

  it("raises critical stale-run evaluations and blocks the source issue", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, issueId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result.created).toBe(1);
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.priority).toBe("high");

    const [blocker] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, issueId)));
    expect(blocker?.issueId).toBe(evaluation?.id);

    const [source] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(source?.status).toBe("blocked");
  });

  it("folds terminal source issues with same-run durable evidence instead of creating watchdog work", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, coderId, issueId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
      sameRunTerminalEvidence: "activity",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result).toMatchObject({ created: 0, folded: 1, skipped: 0 });
    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(run?.finishedAt?.toISOString()).toBe(now.toISOString());
    expect(run?.resultJson).toMatchObject({
      sourceResolvedWatchdogFold: {
        sourceIssueId: issueId,
        sourceIssueStatus: "done",
        sameRunEvidenceKind: "activity",
        evaluationIssueId: null,
        evaluationIssueIdentifier: null,
        cleanup: { outcome: "no_process_metadata" },
      },
    });

    const [source] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(source?.executionRunId).toBeNull();
    const [agent] = await db.select().from(agents).where(eq(agents.id, coderId));
    expect(agent?.status).toBe("idle");
    const [decision] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.runId, runId));
    expect(decision?.decision).toBe("dismissed_false_positive");
    const [event] = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(event?.message).toContain("Source-resolved watchdog fold");
  });

  it("still escalates terminal source issues without same-run terminal evidence", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result).toMatchObject({ created: 1, folded: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.originId).toBe(runId);
    expect(evaluation?.parentId).toBeNull();
  });

  it("still escalates when a same-run comment is followed by another actor marking the source done", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, issueId, runId, issuePrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "in_progress",
      sameRunTerminalEvidence: "comment",
    });
    const completedAt = new Date(now.getTime() - 5 * 60_000);
    await db
      .update(issues)
      .set({ status: "done", completedAt, updatedAt: completedAt })
      .where(eq(issues.id, issueId));
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        identifier: `${issuePrefix}-1`,
        status: "done",
        _previous: { status: "in_progress" },
      },
      createdAt: completedAt,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result).toMatchObject({ created: 1, folded: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    const [evaluation] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluation?.originId).toBe(runId);
    expect(evaluation?.parentId).toBeNull();
  });

  it("folds existing evaluation and active watchdog recovery action idempotently", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, issueId, runId, issuePrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceStatus: "done",
      sameRunTerminalEvidence: "activity",
    });
    const evaluationIssueId = randomUUID();
    await db.insert(issues).values({
      id: evaluationIssueId,
      companyId,
      title: "Existing stale evaluation",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: evaluationIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      recoveryIssueId: evaluationIssueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "active_run_watchdog",
      fingerprint: `active-run-watchdog:${companyId}:${runId}:${issueId}`,
      evidence: { runId },
      nextAction: "Review stale active run",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const second = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(first).toMatchObject({ created: 0, folded: 1 });
    expect(second).toMatchObject({ scanned: 0, created: 0, folded: 0 });
    const [evaluation] = await db.select().from(issues).where(eq(issues.id, evaluationIssueId));
    expect(evaluation?.status).toBe("done");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.resultJson).toMatchObject({
      sourceResolvedWatchdogFold: {
        sourceIssueId: issueId,
        sourceIssueStatus: "done",
        evaluationIssueId,
        evaluationIssueIdentifier: `${issuePrefix}-2`,
      },
    });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action?.status).toBe("resolved");
    expect(action?.outcome).toBe("false_positive");
    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.runId, runId));
    expect(decisions).toHaveLength(1);
  });

  it("refuses recovery-on-recovery stale-run recursion", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      sourceOriginKind: "stale_active_run_evaluation",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations).toHaveLength(1);
  });

  it("skips snoozed runs and healthy noisy runs", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const stale = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
    });
    const noisy = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000,
      withOutput: true,
    });
    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId: stale.companyId,
      runId: stale.runId,
      decision: "snooze",
      snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      reason: "Intentional quiet run",
    });
    const heartbeat = heartbeatService(db);

    const staleResult = await heartbeat.scanSilentActiveRuns({ now, companyId: stale.companyId });
    const noisyResult = await heartbeat.scanSilentActiveRuns({ now, companyId: noisy.companyId });

    expect(staleResult).toMatchObject({ created: 0, snoozed: 1 });
    expect(noisyResult).toMatchObject({ scanned: 0, created: 0 });
  });

  it("records watchdog decisions through recovery owner authorization", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: randomUUID() },
        decision: "continue",
        evaluationIssueId,
        reason: "not my recovery issue",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000);
    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "snooze",
      evaluationIssueId,
      reason: "Long compile with no output",
      snoozedUntil,
    });

    expect(decision).toMatchObject({
      runId,
      evaluationIssueId,
      decision: "snooze",
      createdByAgentId: managerId,
    });
    await expect(recovery.buildRunOutputSilence({
      id: runId,
      companyId,
      status: "running",
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
      createdAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 60_000),
    }, now)).resolves.toMatchObject({
      level: "snoozed",
      snoozedUntil,
      evaluationIssueId,
    });
  });

  it("honors a company-configured re-arm window for continue decisions", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const configuredReArmMs = 90 * 60 * 1000; // 90m — distinct from the 30m default
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      watchdogPolicies: { reArmWindow: configuredReArmMs },
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "continue",
      evaluationIssueId,
      reason: "Acceptable; re-check after the configured window.",
      now,
    });

    // The configured 90m window must be applied, not the hard-coded 30m default.
    const expectedRearmAt = new Date(now.getTime() + configuredReArmMs);
    expect(decision.snoozedUntil?.toISOString()).toBe(expectedRearmAt.toISOString());
  });

  it("re-arms continue decisions after the default quiet window", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId },
      decision: "continue",
      evaluationIssueId,
      reason: "Current evidence is acceptable; keep watching.",
      now,
    });
    const rearmAt = new Date(now.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS);
    expect(decision).toMatchObject({
      runId,
      evaluationIssueId,
      decision: "continue",
      createdByAgentId: managerId,
    });
    expect(decision.snoozedUntil?.toISOString()).toBe(rearmAt.toISOString());

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));

    const beforeRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() - 60_000),
      companyId,
    });
    expect(beforeRearm).toMatchObject({ created: 0, snoozed: 1 });

    const afterRearm = await heartbeat.scanSilentActiveRuns({
      now: new Date(rearmAt.getTime() + 60_000),
      companyId,
    });
    expect(afterRearm.created).toBe(1);
    expect(afterRearm.evaluationIssueIds[0]).not.toBe(evaluationIssueId);

    const evaluations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
    expect(evaluations.filter((issue) => !["done", "cancelled"].includes(issue.status))).toHaveLength(1);
  });

  it("rejects agent watchdog decisions using issues not bound to the target run", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, coderId, runId, issuePrefix } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId,
      title: "Assigned but unrelated",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 20,
      identifier: `${issuePrefix}-20`,
    });

    const otherRunId = randomUUID();
    const otherEvaluationIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      processStartedAt: new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000),
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {},
      logBytes: 0,
    });
    await db.insert(issues).values({
      id: otherEvaluationIssueId,
      companyId,
      title: "Other run evaluation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 21,
      identifier: `${issuePrefix}-21`,
      originKind: "stale_active_run_evaluation",
      originId: otherRunId,
      originFingerprint: `stale_active_run:${companyId}:${otherRunId}`,
    });

    const attempts = [
      { decision: "continue" as const, evaluationIssueId: unrelatedIssueId },
      { decision: "dismissed_false_positive" as const, evaluationIssueId: unrelatedIssueId },
      {
        decision: "snooze" as const,
        evaluationIssueId: unrelatedIssueId,
        snoozedUntil: new Date(now.getTime() + 60 * 60 * 1000),
      },
      { decision: "continue" as const, evaluationIssueId: otherEvaluationIssueId },
    ];

    for (const attempt of attempts) {
      await expect(
        recovery.recordWatchdogDecision({
          runId,
          actor: { type: "agent", agentId: managerId },
          reason: "malicious or stale binding",
          ...attempt,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, evaluationIssueId));
    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "closed evaluation should not authorize",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates createdByRunId before storing watchdog decisions", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const { companyId, managerId, runId } = await seedRunningRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
    });
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const scan = await heartbeat.scanSilentActiveRuns({ now, companyId });
    const evaluationIssueId = scan.evaluationIssueIds[0];
    expect(evaluationIssueId).toBeTruthy();

    await expect(
      recovery.recordWatchdogDecision({
        runId,
        actor: { type: "agent", agentId: managerId },
        decision: "continue",
        evaluationIssueId,
        reason: "client supplied another agent run",
        createdByRunId: runId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: managerRunId,
      companyId,
      agentId: managerId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: now,
      processStartedAt: now,
      lastOutputAt: now,
      lastOutputSeq: 1,
      lastOutputStream: "stdout",
      contextSnapshot: {},
      logBytes: 0,
    });

    const decision = await recovery.recordWatchdogDecision({
      runId,
      actor: { type: "agent", agentId: managerId, runId: managerRunId },
      decision: "continue",
      evaluationIssueId,
      reason: "valid current actor run",
      createdByRunId: randomUUID(),
    });
    expect(decision.createdByRunId).toBe(managerRunId);
  });
});

// §11 bounded escalation horizon tests
describeEmbeddedPostgres("watchdog escalation horizon (§11)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-horizon-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Seeds a critically-silent run and adds N prior re-arm decisions to simulate elapsed windows.
  async function seedHorizonRun(opts: {
    now: Date;
    priorReArmWindows: number;
    watchdogPolicies?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // Silence must clear the critical threshold AND leave room for N post-critical
    // re-arm windows: §11 counts re-arm windows acknowledged *after* critical onset,
    // not from silence start. +60s nudges silenceAge just past the critical threshold.
    const reArmWindows = Math.max(0, opts.priorReArmWindows);
    const startedAt = new Date(
      opts.now.getTime() -
        ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS -
        reArmWindows * 30 * 60 * 1000 -
        60_000,
    );
    const criticalOnset = new Date(startedAt.getTime() + ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);

    await db.insert(companies).values({
      id: companyId,
      name: "Horizon Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      policies: opts.watchdogPolicies ? { watchdog: opts.watchdogPolicies } : null,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long running horizon test",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "manual",
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    // Insert N prior continue decisions to simulate elapsed re-arm windows, each
    // acknowledged AFTER the critical-threshold onset so they count toward the §11 horizon.
    for (let i = 0; i < reArmWindows; i++) {
      const windowTime = new Date(criticalOnset.getTime() + i * 30 * 60 * 1000);
      await db.insert(heartbeatRunWatchdogDecisions).values({
        companyId,
        runId,
        decision: "continue",
        snoozedUntil: new Date(windowTime.getTime() + 30 * 60 * 1000),
        createdAt: windowTime,
      });
    }

    return { companyId, runId, issueId, coderId, issuePrefix };
  }

  it("does NOT horizon-escalate before maxReArmWindows is reached", async () => {
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 3, // below default of 8
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(0);
    expect(result.created + result.existing + result.escalated).toBeGreaterThanOrEqual(1);
  });

  it("horizon-escalates when maxReArmWindows is reached (default 8)", async () => {
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 8, // exactly at default
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(1);
    expect(result.created).toBe(0);

    // Verify the evaluation issue was created at critical priority and is not cancelled
    const [evalIssue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originId, runId),
        ),
      );
    expect(evalIssue).toBeTruthy();
    expect(evalIssue!.priority).toBe("critical");
    expect(["cancelled", "done"]).not.toContain(evalIssue!.status);

    // Verify the live run was NOT mutated (must still be running)
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  it("horizon-escalates using config-override maxReArmWindows", async () => {
    const now = new Date();
    const { companyId } = await seedHorizonRun({
      now,
      priorReArmWindows: 3, // 3 windows elapsed
      // Contract shape (doc §11): policies.watchdog.escalationHorizon.maxReArmWindows
      watchdogPolicies: { escalationHorizon: { maxReArmWindows: 3 } }, // override: trip at 3
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(1);
  });

  it("horizon-escalates via maxSilentHours when configured", async () => {
    // Silence age is CRITICAL_THRESHOLD_MS + 60s ≈ 4h 1m
    // Set maxSilentHours=4 so it trips immediately.
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 0, // no prior decisions needed — maxSilentHours trips first
      // Contract shape (doc §11): nested under escalationHorizon
      watchdogPolicies: { escalationHorizon: { maxReArmWindows: null, maxSilentHours: 4 } },
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(1);

    // Verify run still running (not mutated)
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  it("does NOT horizon-escalate when maxReArmWindows is explicitly null (disabled), even past the default", async () => {
    // Regression for DEE-583 F2: an explicit `maxReArmWindows: null` must DISABLE the
    // re-arm-windows horizon, not coerce to the default (8). Here 8 elapsed windows would
    // trip the default, and maxSilentHours is left absent (resolving to its null default,
    // also disabled), so with the windows horizon disabled NO horizon should trip and the
    // run must take the normal evaluation path without a horizon escalation.
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 8, // at/over the default horizon — would trip if null were coerced to 8
      watchdogPolicies: { escalationHorizon: { maxReArmWindows: null } },
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(0);

    // Live run must remain untouched (the §11 no-mutation invariant holds on the non-horizon path too).
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  it("does NOT re-log horizon escalation on repeated scans (§11 idempotency)", async () => {
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 8, // at default horizon — escalates on first scan
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });

    // Three consecutive scans with the run still silent and still running.
    await recovery.scanSilentActiveRuns({ now, companyId });
    await recovery.scanSilentActiveRuns({ now, companyId });
    await recovery.scanSilentActiveRuns({ now, companyId });

    // The horizon escalation is a one-time terminal hand-off: exactly one activity entry,
    // not one per scan. Without the idempotency guard this would be 3.
    const escalationEvents = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.runId, runId),
          eq(activityLog.action, "heartbeat.output_stale_horizon_escalated"),
        ),
      );
    expect(escalationEvents.length).toBe(1);

    // Run still untouched.
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  it("does NOT re-escalate after the horizon evaluation is closed while the run stays silent (§11 one-time hand-off)", async () => {
    // Codex P2 (DEE-583): the idempotency guard previously lived only inside the
    // open-evaluation branch. If an operator closed/cancelled the [Horizon] evaluation
    // while the run remained running and silent, the next scan found no open evaluation
    // and the create branch manufactured a SECOND escalation + duplicate activity log.
    const now = new Date();
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 8, // at default horizon — escalates on first scan
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });

    // First scan escalates and creates the [Horizon] evaluation issue.
    const first = await recovery.scanSilentActiveRuns({ now, companyId });
    expect(first.horizonEscalated).toBe(1);

    // Operator closes the evaluation issue (cancel) WITHOUT stopping the live run.
    await db
      .update(issues)
      .set({ status: "cancelled" })
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, runId)));

    // Second scan: run still silent + still running, but the prior escalation already
    // happened for this silence episode → must NOT create a second [Horizon] issue or
    // log a second escalation.
    await recovery.scanSilentActiveRuns({ now, companyId });

    const escalationEvents = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.runId, runId),
          eq(activityLog.action, "heartbeat.output_stale_horizon_escalated"),
        ),
      );
    expect(escalationEvents.length).toBe(1);

    // Exactly one stale-run evaluation issue ever created for this run (no duplicate [Horizon]).
    const evalIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, runId)));
    expect(evalIssues.length).toBe(1);

    // Live run still untouched.
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  it("does NOT count pre-critical (suspicious-phase) re-arm windows toward the §11 horizon", async () => {
    const now = new Date();
    // No post-critical windows; the run is just past the critical threshold.
    const { companyId, runId } = await seedHorizonRun({
      now,
      priorReArmWindows: 0,
    });

    // Seed 8 continue decisions during the SUSPICIOUS phase (2h ago — before critical onset
    // at ~now-60s). Under a from-silence-start count these would trip the default-8 horizon;
    // the contract measures the horizon only after the critical threshold, so they must NOT.
    for (let i = 0; i < 8; i++) {
      const preCriticalTime = new Date(now.getTime() - 2 * 60 * 60 * 1000 - i * 60_000);
      await db.insert(heartbeatRunWatchdogDecisions).values({
        companyId,
        runId,
        decision: "continue",
        snoozedUntil: new Date(preCriticalTime.getTime() + 30 * 60 * 1000),
        createdAt: preCriticalTime,
      });
    }

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(0);
  });

  it("ignores legacy flat watchdog.maxReArmWindows — contract requires nested escalationHorizon", async () => {
    const now = new Date();
    const { companyId } = await seedHorizonRun({
      now,
      priorReArmWindows: 3,
      // Legacy/incorrect flat shape: must be ignored so the default (8) applies, not 3.
      watchdogPolicies: { maxReArmWindows: 3 },
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    // 3 < default 8, and the flat shape is not the contract key → no horizon escalation.
    expect(result.horizonEscalated).toBe(0);
  });

  it("source-less run (no contextSnapshot issueId) is in scope for horizon", async () => {
    const now = new Date();
    const companyId = randomUUID();
    const coderId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // Silence long enough to fit 8 post-critical re-arm windows (§11 counts windows
    // after critical onset, not from silence start).
    const startedAt = new Date(
      now.getTime() - ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS - 8 * 30 * 60 * 1000 - 60_000,
    );
    const criticalOnset = new Date(startedAt.getTime() + ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);

    await db.insert(companies).values({
      id: companyId,
      name: "Sourceless Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: coderId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {}, // no issueId — source-less run
      logBytes: 0,
    });
    // Add 8 continue decisions AFTER critical onset to trip the default horizon
    for (let i = 0; i < 8; i++) {
      const windowTime = new Date(criticalOnset.getTime() + i * 30 * 60 * 1000);
      await db.insert(heartbeatRunWatchdogDecisions).values({
        companyId,
        runId,
        decision: "continue",
        snoozedUntil: new Date(windowTime.getTime() + 30 * 60 * 1000),
        createdAt: windowTime,
      });
    }

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.horizonEscalated).toBe(1);
    // Run must not be mutated
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");
  });

  // §9 step 1 reap-defer: a SESSIONED_LOCAL_ADAPTERS run whose recorded pid is
  // positively dead and which holds no in-memory handle is orphaned dead work. The
  // watchdog must NOT create/re-arm an evaluation or horizon-escalate it (that is the
  // ELI-774 churn); it defers to the §9 `reapOrphanedRuns` pass. The run itself is left
  // untouched (the reaper owns finalization), and an audit activity is recorded.
  async function seedSilentLocalRun(opts: {
    now: Date;
    processPid: number | null;
    processGroupId?: number | null;
    priorReArmWindows: number;
  }) {
    const companyId = randomUUID();
    const coderId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(
      opts.now.getTime() -
        ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS -
        opts.priorReArmWindows * 30 * 60 * 1000 -
        60_000,
    );
    const criticalOnset = new Date(startedAt.getTime() + ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);
    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: coderId,
      companyId,
      name: "Local Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      processPid: opts.processPid,
      processGroupId: opts.processGroupId ?? null,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: {},
      logBytes: 0,
    });
    for (let i = 0; i < opts.priorReArmWindows; i++) {
      const windowTime = new Date(criticalOnset.getTime() + i * 30 * 60 * 1000);
      await db.insert(heartbeatRunWatchdogDecisions).values({
        companyId,
        runId,
        decision: "continue",
        snoozedUntil: new Date(windowTime.getTime() + 30 * 60 * 1000),
        createdAt: windowTime,
      });
    }
    return { companyId, runId, coderId };
  }

  it("reap-defers an orphaned local-child run (recorded pid dead, no handle) instead of escalating", async () => {
    const now = new Date();
    // A child that has already exited by the time spawnSync returns → its pid is dead.
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
    expect(typeof deadPid).toBe("number");
    // 8 prior re-arm windows would ALSO trip the default horizon — proves reap-defer
    // takes precedence over both evaluation creation and §11 horizon escalation.
    const { companyId, runId } = await seedSilentLocalRun({
      now,
      processPid: deadPid,
      priorReArmWindows: 8,
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.reapDeferred).toBe(1);
    expect(result.horizonEscalated).toBe(0);
    expect(result.created).toBe(0);
    expect(result.escalated).toBe(0);

    // No evaluation issue was manufactured for the dead run.
    const evalIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, runId)));
    expect(evalIssues).toHaveLength(0);

    // The reaper (§9), not the watchdog, owns finalization — run is left running here.
    const [activeRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(activeRun!.status).toBe("running");

    // Audit trail preserved (ELI-776 constraint 3).
    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "heartbeat.output_stale_orphan_reap_deferred"),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it("does NOT reap-defer a live-but-silent local run (recorded pid alive) — stays on horizon", async () => {
    const now = new Date();
    // process.pid is this test process — definitively alive → not orphaned.
    const { companyId } = await seedSilentLocalRun({
      now,
      processPid: process.pid,
      priorReArmWindows: 8,
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.scanSilentActiveRuns({ now, companyId });

    expect(result.reapDeferred).toBe(0);
    expect(result.horizonEscalated).toBe(1);
  });
});
