import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { AGENT_LATCH_RECOVERY_REASON } from "../services/recovery/index.ts";

// DEE-680 §6 integration test (CEO binding condition 7 merge gate). Drives the public
// `heartbeat.reconcileAgentLatchRecovery({ now })` sweep wrapper against embedded Postgres.
// The sweep ENQUEUES only — it never mutates `agents.status`; "clears to running" is the
// normal queued-run pickup lifecycle, so the assertions are on the enqueued wake rows.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping embedded Postgres agent-latch-recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileAgentLatchRecovery (DEE-680 §6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-latch-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // TRUNCATE ... CASCADE clears companies and every FK-referencing table the wake path
    // may have touched (company_skills, cost_events, runs, wakeups, activity log, ...),
    // independent of which child tables the enqueue lever populated.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const PAST = new Date("2026-06-01T09:00:00.000Z");
  const NOW = new Date("2026-06-01T10:00:00.000Z");
  const FUTURE = new Date("2026-06-01T11:00:00.000Z");

  async function seedLatchedAgent(input?: {
    enabled?: boolean;
    maxAttempts?: number;
    adapterType?: string;
    retryNotBefore?: Date | null;
    errorCode?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const latchRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      policies:
        input?.enabled === false
          ? {}
          : {
              recovery: {
                agentLatchRecovery: {
                  enabled: input?.enabled ?? true,
                  maxAttempts: input?.maxAttempts ?? 3,
                  backoffBaseMinutes: 60,
                },
              },
            },
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeWorker",
      role: "engineer",
      status: "error",
      adapterType: input?.adapterType ?? "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: latchRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "failed",
      startedAt: PAST,
      finishedAt: PAST,
      updatedAt: PAST,
      errorCode: input?.errorCode === undefined ? "claude_transient_upstream" : input.errorCode,
      error: "session limit",
      resultJson:
        input?.retryNotBefore === null
          ? {}
          : { retryNotBefore: (input?.retryNotBefore ?? PAST).toISOString() },
      contextSnapshot: {},
    });

    return { companyId, agentId, latchRunId };
  }

  async function countRecoveryWakes(companyId: string) {
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, AGENT_LATCH_RECOVERY_REASON),
        ),
      );
    return rows.length;
  }

  // Simulate "the recovery wake ran and re-latched on the same cleared transient": settle
  // any in-flight recovery run, then drop in a brand-new failed transient run that propagates
  // the episode-origin run id. Deterministic and independent of the background executor — this
  // is exactly the new-run-per-retry case the P1 cap-bounding contract must survive. `createdAt`
  // is set explicitly increasing so this is unambiguously the latest run for the agent.
  async function simulateReLatch(companyId: string, agentId: string, episodeRunId: string, seq: number) {
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: PAST, updatedAt: PAST })
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        ),
      );
    // Far-future, monotonically-increasing createdAt so this re-latch is unambiguously the
    // latest run for the agent (beyond real wall-clock and any executor-created run).
    const createdAt = new Date(NOW.getTime() + seq * 30 * 24 * 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      startedAt: createdAt,
      finishedAt: createdAt,
      updatedAt: createdAt,
      createdAt,
      errorCode: "claude_transient_upstream",
      error: "session limit",
      resultJson: { retryNotBefore: PAST.toISOString() },
      contextSnapshot: { agentLatchRecoverySourceRunId: episodeRunId },
    });
    // Keep the agent latched in error for the next sweep.
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, agentId));
  }

  it("does not wake before the retry window has elapsed", async () => {
    const { companyId } = await seedLatchedAgent({ retryNotBefore: FUTURE });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });

    expect(result.wakesEmitted).toBe(0);
    expect(await countRecoveryWakes(companyId)).toBe(0);
  });

  it("does not wake when the feature flag is disabled (ships dark)", async () => {
    const { companyId } = await seedLatchedAgent({ enabled: false });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });

    expect(result.wakesEmitted).toBe(0);
    expect(await countRecoveryWakes(companyId)).toBe(0);
  });

  it("does not wake a non-transient (permanent) latch", async () => {
    const { companyId } = await seedLatchedAgent({ errorCode: "adapter_failed" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });

    expect(result.wakesEmitted).toBe(0);
    expect(await countRecoveryWakes(companyId)).toBe(0);
  });

  it("does not wake an out-of-scope adapter (Phase-1 claude_local only)", async () => {
    const { companyId } = await seedLatchedAgent({ adapterType: "codex_local" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });

    expect(result.wakesEmitted).toBe(0);
    expect(await countRecoveryWakes(companyId)).toBe(0);
  });

  it("enqueues exactly one wake after the window, is idempotent, and propagates the episode-origin run id", async () => {
    const { companyId, agentId, latchRunId } = await seedLatchedAgent({ retryNotBefore: PAST });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });
    expect(first.wakesEmitted).toBe(1);
    expect(await countRecoveryWakes(companyId)).toBe(1);

    // P1 propagation hook: the enqueued recovery run must carry the episode-origin run id
    // so the cap counts across the whole episode, not per re-latched run. Assert on the
    // latest run for the agent (status-independent — the background executor may already
    // have picked the queued run up).
    const [recoveryRun] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1);
    expect((recoveryRun?.contextSnapshot as Record<string, unknown>)?.agentLatchRecoverySourceRunId).toBe(latchRunId);

    // Re-running the sweep must not emit a second wake (active recovery run already exists).
    const second = await heartbeat.reconcileAgentLatchRecovery({ now: NOW });
    expect(second.wakesEmitted).toBe(0);
    expect(await countRecoveryWakes(companyId)).toBe(1);
  });

  it("is bounded: stops waking after maxAttempts even as each retry produces a NEW failed run, and escalates exactly once", async () => {
    const maxAttempts = 3;
    const { companyId, agentId, latchRunId } = await seedLatchedAgent({ retryNotBefore: PAST, maxAttempts });
    const heartbeat = heartbeatService(db);

    // backoffBaseMinutes=60: attempt N requires now >= retryNotBefore + 2^(N-1)*60m.
    // Advance `now` generously each episode so the backoff window is always satisfied and
    // the only thing that can stop the loop is the hard cap.
    const sweepAt = (episode: number) => new Date(NOW.getTime() + episode * 30 * 24 * 60 * 60 * 1000);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const r = await heartbeat.reconcileAgentLatchRecovery({ now: sweepAt(attempt) });
      expect(r.wakesEmitted).toBe(1);
      // The recovery wake "ran" and re-latched as a brand-new failed run carrying R1.
      await simulateReLatch(companyId, agentId, latchRunId, attempt);
    }

    expect(await countRecoveryWakes(companyId)).toBe(maxAttempts);

    // Cap reached: no more wakes, escalate exactly once.
    const exhausted = await heartbeat.reconcileAgentLatchRecovery({ now: sweepAt(maxAttempts + 1) });
    expect(exhausted.wakesEmitted).toBe(0);
    expect(exhausted.escalated).toBe(1);

    // Subsequent sweeps neither wake nor re-escalate.
    const afterExhausted = await heartbeat.reconcileAgentLatchRecovery({ now: sweepAt(maxAttempts + 2) });
    expect(afterExhausted.wakesEmitted).toBe(0);
    expect(afterExhausted.escalated).toBe(0);

    expect(await countRecoveryWakes(companyId)).toBe(maxAttempts);
    const escalations = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "agent_latch_recovery_exhausted"),
        ),
      );
    expect(escalations.length).toBe(1);
  });
});
