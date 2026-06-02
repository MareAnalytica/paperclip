import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled-retry reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ELI-913 stale scheduled_retry checkout reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const THRESHOLD_MS = 15 * 60 * 1000;
  const NOW = new Date("2026-06-02T13:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-eli913-reaper-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWedge(input: {
    runStatus?: string;
    scheduledRetryAt: Date | null;
    issueStatus?: string;
    holdCheckout?: boolean;
    holdExecution?: boolean;
    lockedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lockedAt = input.lockedAt ?? new Date("2026-06-02T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus ?? "scheduled_retry",
      scheduledRetryAt: input.scheduledRetryAt,
      scheduledRetryAttempt: 3,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId },
      createdAt: lockedAt,
      updatedAt: lockedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wedged by scheduled_retry",
      status: input.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: input.holdCheckout === false ? null : runId,
      executionRunId: input.holdExecution === false ? null : runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: lockedAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId, runId, lockedAt };
  }

  it("reaps an overdue scheduled_retry run holding an issue checkout and clears the lock", async () => {
    const scheduledRetryAt = new Date(NOW.getTime() - 30 * 60 * 1000); // overdue 30m > 15m threshold
    const { runId, issueId, agentId } = await seedWedge({
      scheduledRetryAt,
      lockedAt: new Date(NOW.getTime() - 70 * 60 * 1000),
    });

    const result = await heartbeat.reapStaleScheduledRetryCheckouts({ now: NOW });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toContain(runId);
    expect(result.issueIds).toContain(issueId);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("reaper_stale_scheduled");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();
    // assignee + status preserved so the work can be re-dispatched cleanly
    expect(issue?.assigneeAgentId).toBe(agentId);
    expect(issue?.status).toBe("in_progress");

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => (e.message ?? "").includes("reaped"))).toBe(true);
  });

  it("does not reap a near-due (future) scheduled_retry run", async () => {
    const scheduledRetryAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    const { runId, issueId } = await seedWedge({ scheduledRetryAt });
    const result = await heartbeat.reapStaleScheduledRetryCheckouts({ now: NOW });
    expect(result.reaped).toBe(0);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not reap an overdue retry that is still within the staleness threshold", async () => {
    const scheduledRetryAt = new Date(NOW.getTime() - 5 * 60 * 1000); // overdue 5m < 15m threshold
    const { runId } = await seedWedge({ scheduledRetryAt });
    const result = await heartbeat.reapStaleScheduledRetryCheckouts({ now: NOW });
    expect(result.reaped).toBe(0);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
  });

  it("does not reap a running run that holds a checkout", async () => {
    const scheduledRetryAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const { runId } = await seedWedge({ runStatus: "running", scheduledRetryAt });
    const result = await heartbeat.reapStaleScheduledRetryCheckouts({ now: NOW });
    expect(result.reaped).toBe(0);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]);
    expect(run?.status).toBe("running");
  });

  it("scan(includeAll) surfaces hold + retry-age metrics for CEO sweeps without mutating", async () => {
    const scheduledRetryAt = new Date(NOW.getTime() - 5 * 60 * 1000); // not yet stale
    const lockedAt = new Date(NOW.getTime() - 25 * 60 * 1000);
    const { runId, issueId } = await seedWedge({ scheduledRetryAt, lockedAt });

    const all = await heartbeat.scanStaleScheduledRetryCheckouts({ now: NOW, includeAll: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.issueId).toBe(issueId);
    expect(all[0]?.runId).toBe(runId);
    expect(all[0]?.holdKind).toBe("checkout");
    expect(all[0]?.overdueBeyondThreshold).toBe(false);
    expect(all[0]?.scheduledRetryAgeMs).toBe(5 * 60 * 1000);
    expect(all[0]?.checkoutHoldDurationMs).toBe(25 * 60 * 1000);

    // reap-only scan (default) excludes the not-yet-stale checkout
    const staleOnly = await heartbeat.scanStaleScheduledRetryCheckouts({ now: NOW });
    expect(staleOnly).toHaveLength(0);

    // and the reaper leaves it untouched
    const result = await heartbeat.reapStaleScheduledRetryCheckouts({ now: NOW });
    expect(result.reaped).toBe(0);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]);
    expect(run?.status).toBe("scheduled_retry");
    void THRESHOLD_MS;
  });
});
