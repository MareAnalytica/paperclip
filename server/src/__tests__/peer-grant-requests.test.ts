import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentPeerGrants,
  agents,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
  peerGrantRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  peerGrantRequestService,
  resolvePeerGrantPolicy,
  computePeerGrantDedupeKey,
  PEER_GRANT_POLICY_DEFAULTS,
} from "../services/peer-grant-requests.js";
import { peerGrantService } from "../services/peer-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function makeCompany(
  db: ReturnType<typeof createDb>,
  name: string,
  policies: Record<string, unknown> | null = null,
) {
  return db
    .insert(companies)
    .values({
      name: `${name}-${randomUUID()}`,
      issuePrefix: name.slice(0, 3).toUpperCase() + randomUUID().slice(0, 3).toUpperCase(),
      policies,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function makeAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  role: string,
  name: string,
) {
  return db
    .insert(agents)
    .values({ companyId, name, role })
    .returning()
    .then((rows) => rows[0]!);
}

async function makeIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  identifier: string,
) {
  return db
    .insert(issues)
    .values({ companyId, title: `Issue ${identifier}`, identifier })
    .returning()
    .then((rows) => rows[0]!);
}

describe("resolvePeerGrantPolicy (unit, no DB)", () => {
  it("defaults closed when no policies present", () => {
    expect(resolvePeerGrantPolicy(null)).toEqual(PEER_GRANT_POLICY_DEFAULTS);
    expect(resolvePeerGrantPolicy({})).toEqual(PEER_GRANT_POLICY_DEFAULTS);
  });

  it("merges a partial peerGrantPolicy block over defaults", () => {
    const resolved = resolvePeerGrantPolicy({
      peerGrantPolicy: { selfServiceEnabled: true, selfServiceSourceCompanyAllowlist: ["abc"] },
    });
    expect(resolved.selfServiceEnabled).toBe(true);
    expect(resolved.selfServiceSourceCompanyAllowlist).toEqual(["abc"]);
    expect(resolved.approverRole).toBe("ceo");
    expect(resolved.allowedScopes).toEqual(["peer_issue:create", "peer_issue:comment"]);
  });

  it("filters unknown scopes out of allowedScopes", () => {
    const resolved = resolvePeerGrantPolicy({
      peerGrantPolicy: { allowedScopes: ["peer_issue:create", "bogus"] },
    });
    expect(resolved.allowedScopes).toEqual(["peer_issue:create"]);
  });

  it("dedupeKey is stable regardless of scope order", () => {
    const a = computePeerGrantDedupeKey({ sourceCompanyId: "s", targetCompanyId: "t", requestedByAgentId: "g", scopes: ["peer_issue:create", "peer_issue:comment"] });
    const b = computePeerGrantDedupeKey({ sourceCompanyId: "s", targetCompanyId: "t", requestedByAgentId: "g", scopes: ["peer_issue:comment", "peer_issue:create"] });
    expect(a).toBe(b);
  });
});

describeEmbeddedPostgres("peerGrantRequestService.create (spec §5.1-5.2, §6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof peerGrantRequestService>;
  let source!: Awaited<ReturnType<typeof makeCompany>>;
  let target!: Awaited<ReturnType<typeof makeCompany>>;
  let requester!: Awaited<ReturnType<typeof makeAgent>>;
  let approver!: Awaited<ReturnType<typeof makeAgent>>;
  let sourceIssue!: Awaited<ReturnType<typeof makeIssue>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-peer-grant-requests-");
    db = createDb(tempDb.connectionString);
    svc = peerGrantRequestService(db);
  }, 30_000);

  beforeEach(async () => {
    // Eli-only self-service: source company opts in and allowlists itself.
    source = await makeCompany(db, "Source");
    await db
      .update(companies)
      .set({ policies: { peerGrantPolicy: { selfServiceEnabled: true, selfServiceSourceCompanyAllowlist: [source.id] } } })
      .where(eq(companies.id, source.id));
    target = await makeCompany(db, "Target");
    requester = await makeAgent(db, source.id, "general", "Requester");
    approver = await makeAgent(db, source.id, "ceo", "Source CEO");
    sourceIssue = await makeIssue(db, source.id, `SRC-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    // The approver wake creates a heartbeat_runs/wakeup/run_events tree; CASCADE
    // truncation from companies clears all FK-linked rows without hand-ordering.
    await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function baseInput() {
    return {
      sourceCompanyId: source.id,
      requestedByAgentId: requester.id,
      sourceIssueIdentifier: sourceIssue.identifier!,
      scopes: ["peer_issue:create"],
      reason: "File a schema-drift ticket in target per SRC issue",
    };
  }

  it("PASS: creates pending request, emits ceo_actionable card on source issue, logs, wakes CEO", async () => {
    const result = await svc.create(target.id, baseInput());

    expect(result.replayed).toBe(false);
    expect(result.request.status).toBe("pending");
    expect(result.request.sourceCompanyId).toBe(source.id);
    expect(result.request.targetCompanyId).toBe(target.id);
    expect(result.interactionId).toBeTruthy();
    expect(result.wokeApproverIds).toContain(approver.id);
    // requester (non-CEO) is not woken as an approver even if it were a CEO.
    expect(result.wokeApproverIds).not.toContain(requester.id);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, result.interactionId!))
      .then((rows) => rows[0]!);
    expect(interaction.issueId).toBe(sourceIssue.id);
    expect(interaction.companyId).toBe(source.id);
    expect(interaction.kind).toBe("request_confirmation");
    expect((interaction.payload as Record<string, unknown>).decisionClass).toBe("ceo_actionable");

    // Request row is linked back to the interaction.
    expect(result.request.interactionId).toBe(interaction.id);

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "peer_grant_request.created"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.companyId).toBe(source.id);
    expect((logs[0]!.details as Record<string, unknown>).targetCompanyId).toBe(target.id);
  });

  it("ANTI-SPAM: a second identical request replays the open card, no duplicate row", async () => {
    const first = await svc.create(target.id, baseInput());
    const second = await svc.create(target.id, baseInput());

    expect(second.replayed).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    expect(second.interactionId).toBe(first.interactionId);

    const rows = await db.select().from(peerGrantRequests);
    expect(rows).toHaveLength(1);
    const cards = await db.select().from(issueThreadInteractions);
    expect(cards).toHaveLength(1);
  });

  it("ELIGIBILITY: rejects when source company is not self-service enabled", async () => {
    const other = await makeCompany(db, "Other"); // no peerGrantPolicy => default closed
    const otherAgent = await makeAgent(db, other.id, "general", "Other Agent");
    const otherIssue = await makeIssue(db, other.id, `OTH-${randomUUID().slice(0, 8)}`);
    await expect(
      svc.create(target.id, {
        sourceCompanyId: other.id,
        requestedByAgentId: otherAgent.id,
        sourceIssueIdentifier: otherIssue.identifier!,
        scopes: ["peer_issue:create"],
        reason: "should be rejected",
      }),
    ).rejects.toThrow(/self-service/i);
  });

  it("SCOPE: rejects a scope not permitted by policy", async () => {
    await db
      .update(companies)
      .set({ policies: { peerGrantPolicy: { selfServiceEnabled: true, selfServiceSourceCompanyAllowlist: [source.id], allowedScopes: ["peer_issue:create"] } } })
      .where(eq(companies.id, source.id));
    await expect(
      svc.create(target.id, { ...baseInput(), scopes: ["peer_issue:comment"] }),
    ).rejects.toThrow(/not permitted/i);
  });

  it("CROSS-COMPANY: rejects a same-company target", async () => {
    await expect(
      svc.create(source.id, baseInput()),
    ).rejects.toThrow(/cross-company/i);
  });

  it("SOURCE ISSUE: rejects when sourceIssueIdentifier is outside the source company", async () => {
    const foreignIssue = await makeIssue(db, target.id, `TGT-${randomUUID().slice(0, 8)}`);
    await expect(
      svc.create(target.id, { ...baseInput(), sourceIssueIdentifier: foreignIssue.identifier! }),
    ).rejects.toThrow(/source company/i);
  });
});

describeEmbeddedPostgres("peerGrantRequestService approve/reject/list (spec §5.3-5.4, §7)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof peerGrantRequestService>;
  let grants!: ReturnType<typeof peerGrantService>;
  let source!: Awaited<ReturnType<typeof makeCompany>>;
  let target!: Awaited<ReturnType<typeof makeCompany>>;
  let requester!: Awaited<ReturnType<typeof makeAgent>>;
  let approver!: Awaited<ReturnType<typeof makeAgent>>;
  let sourceIssue!: Awaited<ReturnType<typeof makeIssue>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-peer-grant-decisions-");
    db = createDb(tempDb.connectionString);
    svc = peerGrantRequestService(db);
    grants = peerGrantService(db);
  }, 30_000);

  beforeEach(async () => {
    source = await makeCompany(db, "Source");
    await db
      .update(companies)
      .set({ policies: { peerGrantPolicy: { selfServiceEnabled: true, selfServiceSourceCompanyAllowlist: [source.id] } } })
      .where(eq(companies.id, source.id));
    target = await makeCompany(db, "Target");
    requester = await makeAgent(db, source.id, "general", "Requester");
    approver = await makeAgent(db, source.id, "ceo", "Source CEO");
    sourceIssue = await makeIssue(db, source.id, `SRC-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function openRequestId(scopes = ["peer_issue:create"]): Promise<string> {
    const result = await svc.create(target.id, {
      sourceCompanyId: source.id,
      requestedByAgentId: requester.id,
      sourceIssueIdentifier: sourceIssue.identifier!,
      scopes,
      reason: "File a schema-drift ticket in target",
    });
    return result.request.id;
  }

  it("APPROVE: mints a single-use scoped grant, links grantId, resolves card, logs, wakes requester", async () => {
    const requestId = await openRequestId();
    const result = await svc.approve(requestId, { agentId: approver.id });

    expect(result.request.status).toBe("approved");
    expect(result.request.grantId).toBeTruthy();
    expect(result.request.decidedByAgentId).toBe(approver.id);
    expect(result.grant).not.toBeNull();
    expect(result.grant!.agentId).toBe(requester.id);
    expect(result.grant!.targetCompanyId).toBe(target.id);
    expect(result.grant!.scopes).toEqual(["peer_issue:create"]);
    expect(result.grant!.maxUses).toBe(1); // policy default single-use
    expect(result.grant!.expiresAt).toBeTruthy();
    expect(result.grant!.grantedByUserId).toBe(`agent:${approver.id}`);

    // Grant of record exists in agent_peer_grants.
    const grantRows = await db
      .select()
      .from(agentPeerGrants)
      .where(eq(agentPeerGrants.id, result.grant!.id));
    expect(grantRows).toHaveLength(1);

    // Decision card driven to a terminal (accepted) state.
    const card = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, result.request.interactionId!))
      .then((rows) => rows[0]!);
    expect(card.status).toBe("accepted");

    // Activity-logged approved on the source company.
    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "peer_grant_request.approved"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.companyId).toBe(source.id);
    expect((logs[0]!.details as Record<string, unknown>).grantId).toBe(result.grant!.id);

    expect(result.wokeRequester).toBe(true);
  });

  it("APPROVE→ACT: minted grant authorizes exactly one act (single-use exhaustion)", async () => {
    const requestId = await openRequestId();
    await svc.approve(requestId, { agentId: approver.id });

    const first = await grants.findActiveGrant(requester.id, target.id, "peer_issue:create");
    expect(first).not.toBeNull();
    const second = await grants.findActiveGrant(requester.id, target.id, "peer_issue:create");
    expect(second).toBeNull();
  });

  it("APPROVE clamps TTL/uses to policy max", async () => {
    await db
      .update(companies)
      .set({ policies: { peerGrantPolicy: {
        selfServiceEnabled: true,
        selfServiceSourceCompanyAllowlist: [source.id],
        maxGrantTtlSeconds: 100,
        maxGrantUses: 2,
      } } })
      .where(eq(companies.id, source.id));
    const result = await svc.create(target.id, {
      sourceCompanyId: source.id,
      requestedByAgentId: requester.id,
      sourceIssueIdentifier: sourceIssue.identifier!,
      scopes: ["peer_issue:create"],
      reason: "wants a lot",
      requestedTtlSeconds: 99999,
      requestedUses: 999,
    });
    const approved = await svc.approve(result.request.id, { agentId: approver.id });
    expect(approved.grant!.maxUses).toBe(2);
    const ttlMs = approved.grant!.expiresAt!.getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(100_000 + 5_000);
    expect(ttlMs).toBeGreaterThan(0);
  });

  it("AUTHZ: a non-CEO agent in the source company cannot approve", async () => {
    const requestId = await openRequestId();
    await expect(svc.approve(requestId, { agentId: requester.id })).rejects.toThrow(/ceo/i);
    const row = await db.select().from(peerGrantRequests).where(eq(peerGrantRequests.id, requestId)).then((r) => r[0]!);
    expect(row.status).toBe("pending");
  });

  it("AUTHZ: a CEO of another company cannot approve a foreign request", async () => {
    const requestId = await openRequestId();
    const otherCo = await makeCompany(db, "Other");
    const otherCeo = await makeAgent(db, otherCo.id, "ceo", "Other CEO");
    await expect(svc.approve(requestId, { agentId: otherCeo.id })).rejects.toThrow(/source company/i);
  });

  it("REJECT: records rejection, mints no grant, logs, wakes requester", async () => {
    const requestId = await openRequestId();
    const result = await svc.reject(requestId, { agentId: approver.id }, { decisionNote: "not now" });

    expect(result.request.status).toBe("rejected");
    expect(result.request.grantId).toBeNull();
    expect(result.request.decisionNote).toBe("not now");
    expect(result.grant).toBeNull();

    const grantRows = await db.select().from(agentPeerGrants);
    expect(grantRows).toHaveLength(0);

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "peer_grant_request.rejected"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.companyId).toBe(source.id);

    const card = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, result.request.interactionId!))
      .then((rows) => rows[0]!);
    expect(card.status).toBe("rejected");

    expect(result.wokeRequester).toBe(true);
  });

  it("IDEMPOTENCY: deciding an already-decided request is a conflict", async () => {
    const requestId = await openRequestId();
    await svc.approve(requestId, { agentId: approver.id });
    await expect(svc.approve(requestId, { agentId: approver.id })).rejects.toThrow(/already/i);
    await expect(svc.reject(requestId, { agentId: approver.id })).rejects.toThrow(/already/i);
  });

  it("NOT FOUND: deciding an unknown request id", async () => {
    await expect(svc.approve(randomUUID(), { agentId: approver.id })).rejects.toThrow(/not found/i);
  });

  it("LIST: source direction is the originating-company inbox; status filter applies", async () => {
    const approvedId = await openRequestId(["peer_issue:create"]);
    await svc.approve(approvedId, { agentId: approver.id });
    const pendingId = await openRequestId(["peer_issue:comment"]);

    const all = await svc.list(source.id, { direction: "source" });
    expect(all.map((r) => r.id).sort()).toEqual([approvedId, pendingId].sort());

    const pendingOnly = await svc.list(source.id, { direction: "source", status: "pending" });
    expect(pendingOnly.map((r) => r.id)).toEqual([pendingId]);

    const fromTarget = await svc.list(target.id, { direction: "target" });
    expect(fromTarget.map((r) => r.id).sort()).toEqual([approvedId, pendingId].sort());

    // The target company is not the source, so its "source" inbox is empty.
    const targetSourceInbox = await svc.list(target.id, { direction: "source" });
    expect(targetSourceInbox).toHaveLength(0);
  });
});
