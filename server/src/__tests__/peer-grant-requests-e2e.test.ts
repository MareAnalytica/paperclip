// ELI-388 — end-to-end (HTTP route-level) coverage for the CEO-gated peer-ticket flow.
//
// The service-level behaviours are unit-tested in peer-grant-requests.test.ts. This suite
// drives the *real* Express routes (peer-grant-requests + peer-issues act path) against a
// real embedded-postgres database so the request -> CEO decision -> scoped grant -> act
// pipeline is exercised exactly as a deployed cluster would run it. It locks in the items
// ELI-379 §9.6 calls out that only manifest at the HTTP boundary or across the full chain:
//   - route-level eligibility (403 for a non-allowlisted company),
//   - anti-spam dedupe replay (no duplicate card),
//   - approve/reject authz rejecting *board* and non-CEO actors (the route only accepts a
//     source-company CEO agent),
//   - approve -> act happy path and reject path through the act endpoint,
//   - single-use exhaustion observed through the act endpoint,
//   - TTL clamp,
//   - the full provenance chain peer_grant_requests -> agent_peer_grants -> peer_issue_audits
//     -> target issue.
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
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
  peerIssueAudits,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ensureSystemPeerIssueUser,
  SYSTEM_PEER_ISSUE_USER_ID,
} from "../services/peer-issue-system-user.js";
import { peerGrantRequestRoutes } from "../routes/peer-grant-requests.js";
import { peerIssueRoutes } from "../routes/peer-issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const GUARDRAIL_ACK = {
  noSecrets: true as const,
  noEnvMutation: true as const,
  noAgentMutation: true as const,
  noBoardEscalation: true as const,
};

function hashKey(seed: string) {
  return createHash("sha256").update(seed).digest("hex");
}

type Actor = Record<string, unknown>;

function agentActor(agentId: string, companyId: string): Actor {
  // runId is null: these acts come over an agent key with no heartbeat_runs row, and
  // activity_log.run_id carries an FK to heartbeat_runs.
  return { type: "agent", agentId, companyId, source: "agent_key", runId: null };
}

function boardActor(companyId: string): Actor {
  return {
    type: "board",
    userId: `board-${randomUUID()}`,
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

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

describeEmbeddedPostgres("ELI-388 peer-grant CEO-gate end-to-end (HTTP routes + real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  // Mutable actor swapped per request so one app instance can speak as the requester,
  // the CEO, a board user, or a foreign agent.
  let currentActor: Actor = { type: "none" };

  let source!: Awaited<ReturnType<typeof makeCompany>>;
  let target!: Awaited<ReturnType<typeof makeCompany>>;
  let requester!: Awaited<ReturnType<typeof makeAgent>>;
  let ceo!: Awaited<ReturnType<typeof makeAgent>>;
  let sourceIssue!: Awaited<ReturnType<typeof makeIssue>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-peer-grant-e2e-");
    db = createDb(tempDb.connectionString);
    await ensureSystemPeerIssueUser(db);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { actor: Actor }).actor = currentActor;
      next();
    });
    app.use("/api", peerGrantRequestRoutes(db));
    app.use("/api", peerIssueRoutes(db));
    app.use(errorHandler);
  }, 30_000);

  beforeEach(async () => {
    source = await makeCompany(db, "Source");
    await db
      .update(companies)
      .set({
        policies: {
          peerGrantPolicy: {
            selfServiceEnabled: true,
            selfServiceSourceCompanyAllowlist: [source.id],
          },
        },
      })
      .where(eq(companies.id, source.id));
    target = await makeCompany(db, "Target");
    requester = await makeAgent(db, source.id, "general", "Requester");
    ceo = await makeAgent(db, source.id, "ceo", "Source CEO");
    // Target needs a CEO so the peer_issue_arrived wake can resolve a recipient.
    await makeAgent(db, target.id, "ceo", "Target CEO");
    sourceIssue = await makeIssue(db, source.id, `SRC-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    currentActor = { type: "none" };
    await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await db.delete(activityLog).where(eq(activityLog.actorId, SYSTEM_PEER_ISSUE_USER_ID));
    await tempDb?.cleanup();
  });

  function requestBody(overrides: Record<string, unknown> = {}) {
    return {
      sourceCompanyId: source.id,
      sourceIssueIdentifier: sourceIssue.identifier!,
      scopes: ["peer_issue:create"],
      reason: "File a schema-drift ticket in target per source issue",
      ...overrides,
    };
  }

  function actBody(overrides: Record<string, unknown> = {}) {
    return {
      sourceCompanyId: source.id,
      sourceIssueIdentifier: sourceIssue.identifier!,
      sourceCallbackUrl: `https://source.example/issues/${sourceIssue.identifier}`,
      title: "Peer issue from source",
      body: "context",
      acceptanceCriteria: "do the thing",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: hashKey(`act-${randomUUID()}`),
      ...overrides,
    };
  }

  async function openRequest(): Promise<string> {
    currentActor = agentActor(requester.id, source.id);
    const res = await request(app)
      .post(`/api/companies/${target.id}/peer-grant-requests`)
      .send(requestBody());
    expect(res.status).toBe(202);
    return res.body.requestId as string;
  }

  async function approveRequest(requestId: string) {
    currentActor = agentActor(ceo.id, source.id);
    const res = await request(app)
      .post(`/api/peer-grant-requests/${requestId}/approve`)
      .send({});
    expect(res.status).toBe(200);
    return res;
  }

  describe("eligibility (§5.1-5.2)", () => {
    it("allowlisted Eli-only source: 202 pending + CEO woken", async () => {
      currentActor = agentActor(requester.id, source.id);
      const res = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send(requestBody());

      expect(res.status).toBe(202);
      expect(res.body.status).toBe("pending");
      expect(res.body.requestId).toBeTruthy();
      expect(res.body.interactionId).toBeTruthy();
      expect(res.body.wokeApproverIds).toContain(ceo.id);
    });

    it("non-allowlisted company: 403 (default-closed, no card)", async () => {
      const other = await makeCompany(db, "Other"); // no peerGrantPolicy => closed
      const otherAgent = await makeAgent(db, other.id, "general", "Other Agent");
      const otherIssue = await makeIssue(db, other.id, `OTH-${randomUUID().slice(0, 8)}`);
      currentActor = agentActor(otherAgent.id, other.id);

      const res = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send({
          sourceCompanyId: other.id,
          sourceIssueIdentifier: otherIssue.identifier!,
          scopes: ["peer_issue:create"],
          reason: "should be rejected",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/self-service/i);
      const rows = await db.select().from(peerGrantRequests);
      expect(rows).toHaveLength(0);
    });

    it("source identity spoof (body sourceCompanyId != actor company): 403", async () => {
      currentActor = agentActor(requester.id, source.id);
      const res = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send(requestBody({ sourceCompanyId: target.id }));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/must match/i);
    });
  });

  describe("anti-spam dedupe (§5.2)", () => {
    it("second identical request replays the open card, no duplicate row/card", async () => {
      currentActor = agentActor(requester.id, source.id);
      const first = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send(requestBody());
      expect(first.status).toBe(202);

      currentActor = agentActor(requester.id, source.id);
      const second = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send(requestBody());

      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.requestId).toBe(first.body.requestId);
      expect(second.body.interactionId).toBe(first.body.interactionId);

      const rows = await db.select().from(peerGrantRequests);
      expect(rows).toHaveLength(1);
      const cards = await db.select().from(issueThreadInteractions);
      expect(cards).toHaveLength(1);
    });
  });

  describe("decision authz (§5.3): only source-company CEO may approve/reject", () => {
    it("board actor is rejected from approve (route requires an agent)", async () => {
      const requestId = await openRequest();
      currentActor = boardActor(source.id);
      const res = await request(app).post(`/api/peer-grant-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(403);

      const row = await db
        .select()
        .from(peerGrantRequests)
        .where(eq(peerGrantRequests.id, requestId))
        .then((r) => r[0]!);
      expect(row.status).toBe("pending");
      const grants = await db.select().from(agentPeerGrants);
      expect(grants).toHaveLength(0);
    });

    it("board actor is rejected from reject (route requires an agent)", async () => {
      const requestId = await openRequest();
      currentActor = boardActor(source.id);
      const res = await request(app).post(`/api/peer-grant-requests/${requestId}/reject`).send({});
      expect(res.status).toBe(403);
      const row = await db
        .select()
        .from(peerGrantRequests)
        .where(eq(peerGrantRequests.id, requestId))
        .then((r) => r[0]!);
      expect(row.status).toBe("pending");
    });

    it("non-CEO agent in the source company is rejected from approve", async () => {
      const requestId = await openRequest();
      currentActor = agentActor(requester.id, source.id); // requester is role 'general'
      const res = await request(app).post(`/api/peer-grant-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/ceo/i);
    });

    it("CEO of another company cannot approve a foreign request", async () => {
      const requestId = await openRequest();
      const otherCo = await makeCompany(db, "Other");
      const otherCeo = await makeAgent(db, otherCo.id, "ceo", "Other CEO");
      currentActor = agentActor(otherCeo.id, otherCo.id);
      const res = await request(app).post(`/api/peer-grant-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/source company/i);
    });

    it("source-company CEO approve succeeds and mints a grant", async () => {
      const requestId = await openRequest();
      const res = await approveRequest(requestId);
      expect(res.body.status).toBe("approved");
      expect(res.body.grantId).toBeTruthy();
      expect(res.body.wokeRequester).toBe(true);
    });
  });

  describe("approve -> act happy path & reject path", () => {
    it("approve then act: requester creates a target issue through the act endpoint", async () => {
      const requestId = await openRequest();
      await approveRequest(requestId);

      currentActor = agentActor(requester.id, source.id);
      const act = await request(app)
        .post(`/api/companies/${target.id}/peer-issues`)
        .send(actBody({ idempotencyKey: hashKey("happy-act") }));

      expect(act.status).toBe(201);
      expect(act.body.peerAuditId).toBeTruthy();

      const targetIssues = await db.select().from(issues).where(eq(issues.companyId, target.id));
      expect(targetIssues).toHaveLength(1);
    });

    it("reject then act: no grant minted, act endpoint returns 403", async () => {
      const requestId = await openRequest();
      currentActor = agentActor(ceo.id, source.id);
      const rejectRes = await request(app)
        .post(`/api/peer-grant-requests/${requestId}/reject`)
        .send({ reason: "not now" });
      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.status).toBe("rejected");
      expect(await db.select().from(agentPeerGrants)).toHaveLength(0);

      currentActor = agentActor(requester.id, source.id);
      const act = await request(app)
        .post(`/api/companies/${target.id}/peer-issues`)
        .send(actBody({ idempotencyKey: hashKey("rejected-act") }));
      expect(act.status).toBe(403);
      expect(act.body.error).toMatch(/no active peer_issue:create grant/i);
    });
  });

  describe("single-use exhaustion & TTL clamp (§3, §5.5, §8 O1)", () => {
    it("single-use grant authorizes exactly one act; the second act is 403", async () => {
      const requestId = await openRequest();
      await approveRequest(requestId);

      currentActor = agentActor(requester.id, source.id);
      const first = await request(app)
        .post(`/api/companies/${target.id}/peer-issues`)
        .send(actBody({ idempotencyKey: hashKey("single-use-1"), sourceIssueIdentifier: sourceIssue.identifier! }));
      expect(first.status).toBe(201);

      currentActor = agentActor(requester.id, source.id);
      const second = await request(app)
        .post(`/api/companies/${target.id}/peer-issues`)
        .send(actBody({ idempotencyKey: hashKey("single-use-2") }));
      expect(second.status).toBe(403);
      expect(second.body.error).toMatch(/no active peer_issue:create grant/i);
    });

    it("approve clamps the minted grant TTL to policy max", async () => {
      await db
        .update(companies)
        .set({
          policies: {
            peerGrantPolicy: {
              selfServiceEnabled: true,
              selfServiceSourceCompanyAllowlist: [source.id],
              maxGrantTtlSeconds: 100,
              maxGrantUses: 2,
            },
          },
        })
        .where(eq(companies.id, source.id));

      currentActor = agentActor(requester.id, source.id);
      const create = await request(app)
        .post(`/api/companies/${target.id}/peer-grant-requests`)
        .send(requestBody({ requestedTtlSeconds: 99_999, requestedUses: 999 }));
      expect(create.status).toBe(202);

      await approveRequest(create.body.requestId);

      const grant = await db
        .select()
        .from(agentPeerGrants)
        .then((rows) => rows[0]!);
      expect(grant.maxUses).toBe(2);
      const ttlMs = grant.expiresAt!.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(100_000 + 5_000);
    });
  });

  describe("full audit chain (§7): peer_grant_requests -> agent_peer_grants -> peer_issue_audits -> target issue", () => {
    it("links the request, the minted grant, the act audit, and the created target issue", async () => {
      const requestId = await openRequest();
      const approveRes = await approveRequest(requestId);
      const grantId = approveRes.body.grantId as string;

      currentActor = agentActor(requester.id, source.id);
      const act = await request(app)
        .post(`/api/companies/${target.id}/peer-issues`)
        .send(actBody({ idempotencyKey: hashKey("audit-chain") }));
      expect(act.status).toBe(201);

      // Link 1: request row points at the minted grant.
      const reqRow = await db
        .select()
        .from(peerGrantRequests)
        .where(eq(peerGrantRequests.id, requestId))
        .then((r) => r[0]!);
      expect(reqRow.status).toBe("approved");
      expect(reqRow.grantId).toBe(grantId);

      // Link 2: the grant of record exists and is scoped to (requester, target).
      const grantRow = await db
        .select()
        .from(agentPeerGrants)
        .where(eq(agentPeerGrants.id, grantId))
        .then((r) => r[0]!);
      expect(grantRow.agentId).toBe(requester.id);
      expect(grantRow.targetCompanyId).toBe(target.id);
      expect(grantRow.grantedByUserId).toBe(`agent:${ceo.id}`);

      // Link 3: the act audit references the same grant and the created target issue.
      const auditRow = await db
        .select()
        .from(peerIssueAudits)
        .where(eq(peerIssueAudits.targetCompanyId, target.id))
        .then((r) => r[0]!);
      expect(auditRow.grantId).toBe(grantId);
      expect(auditRow.sourceCompanyId).toBe(source.id);
      expect(auditRow.sourceIssueIdentifier).toBe(sourceIssue.identifier);

      // Link 4: the target issue exists in the target company and is the audit's target.
      const targetIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, auditRow.targetIssueId))
        .then((r) => r[0]!);
      expect(targetIssue.companyId).toBe(target.id);
      expect(auditRow.targetIssueIdentifier).toBe(targetIssue.identifier);

      // Identity of the full chain in one assertion.
      expect(reqRow.grantId).toBe(auditRow.grantId);
      expect(auditRow.targetIssueId).toBe(targetIssue.id);

      // Activity-log provenance on the source company for both lifecycle phases.
      const sourceActions = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, source.id));
      const actions = sourceActions.map((row) => row.action);
      expect(actions).toContain("peer_grant_request.created");
      expect(actions).toContain("peer_grant_request.approved");
      expect(actions).toContain("issue.peer_created");
    });
  });
});
