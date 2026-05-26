import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-queue tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.listBlockedQueue", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocked-queue-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;
  let identifierCounter = 0;
  async function setup() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `BLK${prefixCounter++}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "ceo",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(
    companyId: string,
    status: string,
    options: { id?: string; assigneeAgentId?: string | null; hiddenAt?: Date; originKind?: string } = {},
  ) {
    const id = options.id ?? randomUUID();
    const identifier = `BLK-${(++identifierCounter).toString(36).toUpperCase()}`;
    const values: typeof issues.$inferInsert = {
      id,
      companyId,
      identifier,
      title: `Issue ${identifier}`,
      status,
      priority: "medium",
      assigneeAgentId: options.assigneeAgentId ?? null,
    };
    if (options.hiddenAt) values.hiddenAt = options.hiddenAt;
    if (options.originKind) values.originKind = options.originKind;
    await db.insert(issues).values(values);
    return { id, identifier };
  }

  async function insertComment(
    companyId: string,
    issueId: string,
    body: string,
    agentId?: string,
    createdAt?: Date,
    userId?: string,
  ) {
    const values: typeof issueComments.$inferInsert = {
      id: randomUUID(),
      companyId,
      issueId,
      body,
      authorAgentId: agentId ?? null,
      authorUserId: userId ?? null,
    };
    if (createdAt) values.createdAt = createdAt;
    await db.insert(issueComments).values(values);
  }

  async function insertApprovalLink(companyId: string, issueId: string, status: "pending" | "approved") {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "board_decision",
      status,
      payload: {},
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
    });
    return approvalId;
  }

  it("returns empty array for company with no blocked issues", async () => {
    const { companyId } = await setup();
    await insertIssue(companyId, "todo");
    await insertIssue(companyId, "in_progress");
    const result = await svc.listBlockedQueue(companyId);
    expect(result).toEqual([]);
  });

  it("returns blocked issues with correct projection", async () => {
    const { companyId, agentId } = await setup();
    const { id: issueId, identifier } = await insertIssue(companyId, "blocked", { assigneeAgentId: agentId });
    await insertComment(companyId, issueId, "Please unblock this so we can proceed", agentId);

    const result = await svc.listBlockedQueue(companyId);
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.identifier).toBe(identifier);
    expect(item.priority).toBe("medium");
    expect(item.lastAuthor?.agentId).toBe(agentId);
    expect(item.lastAuthor?.type).toBe("agent");
    expect(item.lastCommentClass).toBe("unblock-ask");
    expect(item.unresolvedInteractionIds).toEqual([]);
    expect(typeof item.ageMinutesSinceLastComment).toBe("number");
  });

  it("excludes non-blocked issues", async () => {
    const { companyId } = await setup();
    await insertIssue(companyId, "todo");
    await insertIssue(companyId, "done");
    const { id: blockedId } = await insertIssue(companyId, "blocked");

    const result = await svc.listBlockedQueue(companyId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(blockedId);
  });

  it("includes unresolvedInteractionIds for pending approvals only", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const pendingId = await insertApprovalLink(companyId, issueId, "pending");
    await insertApprovalLink(companyId, issueId, "approved");

    const result = await svc.listBlockedQueue(companyId);
    expect(result).toHaveLength(1);
    expect(result[0].unresolvedInteractionIds).toEqual([pendingId]);
  });

  it("classifies bounce comment correctly", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    await insertComment(companyId, issueId, "Bouncing this back, refusing to proceed");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].lastCommentClass).toBe("bounce");
  });

  it("classifies progress comment correctly", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    await insertComment(companyId, issueId, "PR merged, waiting for next step");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].lastCommentClass).toBe("progress");
  });

  it("returns null lastAuthor and other for issue with no comments", async () => {
    const { companyId } = await setup();
    await insertIssue(companyId, "blocked");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].lastAuthor).toBeNull();
    expect(result[0].lastCommentClass).toBe("other");
    expect(result[0].ageMinutesSinceLastComment).toBeNull();
  });

  it("extracts namedUnblockOwner from agent:// mention by CEO author", async () => {
    const { companyId, agentId: ceoAgentId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const targetUuid = randomUUID();
    await insertComment(companyId, issueId, `Routed to agent://${targetUuid} for action`, ceoAgentId);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBe(`agent://${targetUuid}`);
  });

  it("ignores agent:// mention when commenter is neither CEO nor assignee (F2)", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const randomAgent = randomUUID();
    await db.insert(agents).values({
      id: randomAgent,
      companyId,
      name: "Random Agent",
      role: "general",
      status: "idle",
    });
    const targetUuid = randomUUID();
    await insertComment(companyId, issueId, `Routed to agent://${targetUuid}`, randomAgent);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBeNull();
  });

  it("extracts namedUnblockOwner from agent:// mention by issue assignee (F2)", async () => {
    const { companyId } = await setup();
    const assigneeId = randomUUID();
    await db.insert(agents).values({
      id: assigneeId,
      companyId,
      name: "Assignee Agent",
      role: "general",
      status: "idle",
    });
    const { id: issueId } = await insertIssue(companyId, "blocked", { assigneeAgentId: assigneeId });
    const targetUuid = randomUUID();
    await insertComment(companyId, issueId, `agent://${targetUuid} please take it`, assigneeId);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBe(`agent://${targetUuid}`);
  });

  it("resolves bare @Name mention against agent roster (F2 tier 2)", async () => {
    const { companyId, agentId: ceoAgentId } = await setup();
    const targetId = randomUUID();
    await db.insert(agents).values({
      id: targetId,
      companyId,
      name: "Platform Engineer",
      role: "general",
      status: "idle",
    });
    const { id: issueId } = await insertIssue(companyId, "blocked");
    await insertComment(companyId, issueId, "Please @platform-engineer take this", ceoAgentId);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBe(`agent://${targetId}`);
  });

  it("falls back to owner: line when no agent mention present (F6)", async () => {
    const { companyId, agentId: ceoAgentId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    await insertComment(
      companyId,
      issueId,
      "Update on status.\n\nowner: ops-on-call\n\nPlease pick up.",
      ceoAgentId,
    );

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBe("ops-on-call");
  });

  it("recognises user-authored comments (F6)", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    await insertComment(companyId, issueId, "Holding for review", undefined, undefined, "user-7");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].lastAuthor?.type).toBe("user");
    expect(result[0].lastAuthor?.userId).toBe("user-7");
    expect(result[0].lastAuthor?.agentId).toBeNull();
  });

  it("returns multiple pending approvals on the same issue (F6)", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const a1 = await insertApprovalLink(companyId, issueId, "pending");
    const a2 = await insertApprovalLink(companyId, issueId, "pending");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].unresolvedInteractionIds).toHaveLength(2);
    expect(new Set(result[0].unresolvedInteractionIds)).toEqual(new Set([a1, a2]));
  });

  it("returns empty unresolvedInteractionIds when no approvals exist (F6)", async () => {
    const { companyId } = await setup();
    await insertIssue(companyId, "blocked");

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].unresolvedInteractionIds).toEqual([]);
  });

  it("excludes hidden and routine-execution issues (F3)", async () => {
    const { companyId } = await setup();
    const { id: keepId } = await insertIssue(companyId, "blocked");
    await insertIssue(companyId, "blocked", { hiddenAt: new Date() });
    await insertIssue(companyId, "blocked", { originKind: "routine_execution" });

    const result = await svc.listBlockedQueue(companyId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(keepId);
  });

  it("uses the most recent comment body for classification", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    await insertComment(companyId, issueId, "Please unblock", undefined, earlier);
    await insertComment(companyId, issueId, "PR merged, done", undefined, later);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].lastCommentClass).toBe("progress");
  });

  it("isolates blocked queues across companies", async () => {
    const { companyId: c1 } = await setup();
    const { companyId: c2 } = await setup();
    await insertIssue(c1, "blocked");
    await insertIssue(c2, "todo");

    const r1 = await svc.listBlockedQueue(c1);
    const r2 = await svc.listBlockedQueue(c2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
  });

  it("orders results by ageMinutesSinceLastComment desc", async () => {
    const { companyId } = await setup();
    const { id: youngerId } = await insertIssue(companyId, "blocked");
    const { id: olderId } = await insertIssue(companyId, "blocked");
    const now = Date.now();
    await insertComment(companyId, youngerId, "recent", undefined, new Date(now - 5 * 60_000));
    await insertComment(companyId, olderId, "old", undefined, new Date(now - 60 * 60_000));

    const result = await svc.listBlockedQueue(companyId);
    expect(result.map((r) => r.id)).toEqual([olderId, youngerId]);
  });

  it("namedUnblockOwner uses per-issue eligible-author (F7-N1): latest comment by another blocked-issue's assignee does not mask THIS issue's assignee comment", async () => {
    const { companyId, agentId: ceoAgentId } = await setup();
    const assigneeA = randomUUID();
    const assigneeB = randomUUID();
    await db.insert(agents).values({
      id: assigneeA,
      companyId,
      name: "Assignee A",
      role: "general",
      status: "idle",
    });
    await db.insert(agents).values({
      id: assigneeB,
      companyId,
      name: "Assignee B",
      role: "general",
      status: "idle",
    });
    const { id: issueB } = await insertIssue(companyId, "blocked", { assigneeAgentId: assigneeB });
    await insertIssue(companyId, "blocked", { assigneeAgentId: assigneeA });

    const targetUuid = randomUUID();
    const now = Date.now();
    // Earlier: assignee B (eligible for issue B) names a target.
    await insertComment(
      companyId,
      issueB,
      `agent://${targetUuid} please take it`,
      assigneeB,
      new Date(now - 10 * 60_000),
    );
    // Later: assignee A (NOT eligible for issue B, but eligible for issue A) comments on issue B.
    // Pre-F7-N1 the eligible-author subquery used a global author set,
    // so rn=1 returned this comment and the JS filter dropped it without falling back
    // to the prior assignee-B comment, leaving namedUnblockOwner=null.
    await insertComment(
      companyId,
      issueB,
      "just a status note from A",
      assigneeA,
      new Date(now - 1 * 60_000),
    );

    const result = await svc.listBlockedQueue(companyId);
    const itemB = result.find((r) => r.id === issueB);
    expect(itemB?.namedUnblockOwner).toBe(`agent://${targetUuid}`);
    // Sanity: latest-comment projection still reflects the actual newest comment regardless of author.
    expect(itemB?.lastAuthor?.agentId).toBe(assigneeA);
    void ceoAgentId;
  });

  it("handles 200 blocked issues with p95 latency under 200ms", async () => {
    const { companyId, agentId } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const { id } = await insertIssue(companyId, "blocked");
      ids.push(id);
      await insertComment(companyId, id, "Please unblock this", agentId);
    }

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const rows = await svc.listBlockedQueue(companyId);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      expect(rows).toHaveLength(200);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(200);
  }, 60_000);

  it("handles 50 issues x 30 comments each with p95 under 200ms (F4)", async () => {
    const { companyId, agentId } = await setup();
    const ids: string[] = [];
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      const { id } = await insertIssue(companyId, "blocked", { assigneeAgentId: agentId });
      ids.push(id);
      for (let j = 0; j < 30; j++) {
        await insertComment(
          companyId,
          id,
          `comment ${j} for issue ${i}`,
          agentId,
          new Date(start + i * 1000 + j),
        );
      }
    }

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const rows = await svc.listBlockedQueue(companyId);
      samples.push(performance.now() - t0);
      expect(rows).toHaveLength(50);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(200);
  }, 120_000);
});
