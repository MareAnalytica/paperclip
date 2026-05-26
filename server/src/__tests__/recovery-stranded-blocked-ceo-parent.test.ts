import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  instanceSettings,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stranded_blocked_ceo_parent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const THRESHOLD_MINUTES = 30;

function expectedIdempotencyKey(issueId: string, blockedAtEpochMs: number, windowIndex: number) {
  return createHash("sha256")
    .update(`stranded_blocked_ceo_parent:${issueId}:${blockedAtEpochMs}:${windowIndex}`)
    .digest("hex");
}

describeEmbeddedPostgres("recoveryService.reconcileStrandedBlockedCeoParents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-blocked-ceo-parent-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { strandedBlockedCeoParentThresholdMinutes: THRESHOLD_MINUTES },
    }).onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        experimental: { strandedBlockedCeoParentThresholdMinutes: THRESHOLD_MINUTES },
        updatedAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  async function seedScenario(opts: {
    ceoRole?: boolean;
    blockedMinutesAgo?: number;
    childStatus?: "todo" | "in_progress" | "in_review" | "blocked" | "done" | null;
  } = {}) {
    const ceoRole = opts.ceoRole ?? true;
    const blockedMinutesAgo = opts.blockedMinutesAgo ?? THRESHOLD_MINUTES + 5;
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const prefix = `SB${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "CEO Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: ceoRole ? "Mission Owner" : "Coder",
      role: ceoRole ? "ceo" : "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: ceoRole ? { role: "ceo" } : {},
      permissions: {},
    });

    const blockedAt = new Date(Date.now() - blockedMinutesAgo * 60 * 1000);
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "CEO parent issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: ceoId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      updatedAt: blockedAt,
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "issue.updated",
      entityType: "issue",
      entityId: parentIssueId,
      details: { status: "blocked", _previous: { status: "in_progress" } },
      createdAt: blockedAt,
    });

    if (opts.childStatus !== null) {
      const status = opts.childStatus ?? "todo";
      await db.insert(issues).values({
        id: childIssueId,
        companyId,
        title: "routine child",
        status,
        priority: "medium",
        parentId: parentIssueId,
        issueNumber: 2,
        identifier: `${prefix}-2`,
      });
    }

    const [parentIssue] = await db.select().from(issues).where(eq(issues.id, parentIssueId));
    return { companyId, ceoId, parentIssueId, childIssueId, parentIssue: parentIssue!, blockedAt };
  }

  it("emits exactly one wake with the correct reason and idempotencyKey + audit row", async () => {
    const { companyId, ceoId, parentIssueId, blockedAt } = await seedScenario();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedBlockedCeoParents();
    expect(result.wakesEmitted).toBe(1);
    expect(result.evaluated).toBe(1);
    expect(result.issueIds).toContain(parentIssueId);

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [calledAgentId, opts] = enqueueWakeup.mock.calls[0]!;
    expect(calledAgentId).toBe(ceoId);
    expect(opts?.reason).toBe("stranded_blocked_ceo_parent");
    expect(opts?.idempotencyKey).toBe(expectedIdempotencyKey(parentIssueId, blockedAt.getTime(), 1));
    expect(opts?.payload).toMatchObject({
      issueId: parentIssueId,
      recoveryCause: "stranded_blocked_ceo_parent",
      windowIndex: 1,
    });

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, parentIssueId),
          eq(activityLog.action, "issue.stranded_blocked_ceo_parent_evaluated"),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.details).toMatchObject({
      kind: "stranded_blocked_ceo_parent.evaluated",
      outcome: "wake_emitted",
      windowIndex: 1,
      thresholdMinutes: THRESHOLD_MINUTES,
      routineChildCount: 1,
    });
  });

  it("skips when an open request_board_approval is still within SLA and no routine children remain", async () => {
    const { companyId, parentIssueId } = await seedScenario({ childStatus: null });

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: null,
      payload: { title: "test" },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId: parentIssueId,
      approvalId,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedBlockedCeoParents();
    expect(result.wakesEmitted).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, parentIssueId),
          eq(activityLog.action, "issue.stranded_blocked_ceo_parent_evaluated"),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.details).toMatchObject({
      outcome: "skipped",
      skipReason: "no_routine_children",
    });
  });

  it("is idempotent within the same threshold window", async () => {
    const { parentIssueId, blockedAt } = await seedScenario();
    const enqueueWakeup = vi.fn(async (agentId: string, opts: any) => {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId: (await db.select().from(issues).where(eq(issues.id, parentIssueId)).limit(1))[0]!.companyId,
        agentId,
        status: "queued",
        source: opts.source,
        triggerDetail: opts.triggerDetail,
        reason: opts.reason,
        idempotencyKey: opts.idempotencyKey,
        payload: opts.payload,
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId ?? null,
      });
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });

    const first = await recovery.reconcileStrandedBlockedCeoParents();
    expect(first.wakesEmitted).toBe(1);
    const second = await recovery.reconcileStrandedBlockedCeoParents();
    expect(second.wakesEmitted).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, expectedIdempotencyKey(parentIssueId, blockedAt.getTime(), 1)));
    expect(wakes).toHaveLength(1);
  });

  it("emits a second wake after the threshold window rolls over", async () => {
    const { parentIssueId, blockedAt } = await seedScenario({ blockedMinutesAgo: THRESHOLD_MINUTES + 5 });
    const calls: Array<{ key: string | undefined; windowIndex: number | undefined }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, opts: any) => {
      calls.push({ key: opts.idempotencyKey, windowIndex: opts.payload?.windowIndex });
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId: (await db.select().from(issues).where(eq(issues.id, parentIssueId)).limit(1))[0]!.companyId,
        agentId,
        status: "queued",
        source: opts.source,
        triggerDetail: opts.triggerDetail,
        reason: opts.reason,
        idempotencyKey: opts.idempotencyKey,
        payload: opts.payload,
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId ?? null,
      });
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });

    const first = await recovery.reconcileStrandedBlockedCeoParents();
    expect(first.wakesEmitted).toBe(1);
    expect(calls[0]?.windowIndex).toBe(1);

    const rolledBlockedAt = new Date(blockedAt.getTime() - THRESHOLD_MINUTES * 60 * 1000);
    await db.update(issues).set({ updatedAt: rolledBlockedAt }).where(eq(issues.id, parentIssueId));
    await db
      .update(activityLog)
      .set({ createdAt: rolledBlockedAt })
      .where(and(eq(activityLog.entityId, parentIssueId), eq(activityLog.action, "issue.updated")));

    const second = await recovery.reconcileStrandedBlockedCeoParents();
    expect(second.wakesEmitted).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.windowIndex).toBe(2);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });

  it("does not wake when the assignee is not CEO-like", async () => {
    const { parentIssueId } = await seedScenario({ ceoRole: false });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedBlockedCeoParents();
    expect(result.wakesEmitted).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result.skippedReasons.assignee_not_ceo_role).toBe(1);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, parentIssueId),
          eq(activityLog.action, "issue.stranded_blocked_ceo_parent_evaluated"),
        ),
      );
    expect(auditRows).toHaveLength(0);
  });
});
