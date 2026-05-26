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

  async function insertIssue(companyId: string, status: string, id = randomUUID()) {
    const identifier = `BLK-${(++identifierCounter).toString(36).toUpperCase()}`;
    await db.insert(issues).values({
      id,
      companyId,
      identifier,
      title: `Issue ${identifier}`,
      status,
      priority: "medium",
    });
    return { id, identifier };
  }

  async function insertComment(
    companyId: string,
    issueId: string,
    body: string,
    agentId?: string,
    createdAt?: Date,
  ) {
    const values: typeof issueComments.$inferInsert = {
      id: randomUUID(),
      companyId,
      issueId,
      body,
      authorAgentId: agentId ?? null,
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
    const { id: issueId, identifier } = await insertIssue(companyId, "blocked");
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

  it("extracts namedUnblockOwner from agent:// mention in comment", async () => {
    const { companyId } = await setup();
    const { id: issueId } = await insertIssue(companyId, "blocked");
    const targetUuid = randomUUID();
    await insertComment(companyId, issueId, `Routed to agent://${targetUuid} for action`);

    const result = await svc.listBlockedQueue(companyId);
    expect(result[0].namedUnblockOwner).toBe(`agent://${targetUuid}`);
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
});
