import { randomUUID, createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentPeerGrants,
  authUsers,
  companies,
  createDb,
  issueComments,
  issues,
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
import {
  peerIssueService,
  PEER_ISSUE_DEFAULT_RATE_CAP_24H,
} from "../services/peer-issues.js";
import { peerGrantService } from "../services/peer-grants.js";

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

async function makeCompany(db: ReturnType<typeof createDb>, name: string) {
  return db
    .insert(companies)
    .values({
      name: `${name}-${randomUUID()}`,
      issuePrefix: name.slice(0, 3).toUpperCase() + randomUUID().slice(0, 3).toUpperCase(),
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function makeAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  role = "general",
  name = "Agent",
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function makeGrant(
  db: ReturnType<typeof createDb>,
  agentId: string,
  targetCompanyId: string,
  scopes: string[],
  overrides: { expiresAt?: Date | null; revokedAt?: Date | null } = {},
) {
  return db
    .insert(agentPeerGrants)
    .values({
      agentId,
      targetCompanyId,
      scopes,
      grantedByUserId: "board",
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("peer-issue service (spec §6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof peerIssueService>;
  let grants!: ReturnType<typeof peerGrantService>;
  let source!: Awaited<ReturnType<typeof makeCompany>>;
  let target!: Awaited<ReturnType<typeof makeCompany>>;
  let sourceAgent!: Awaited<ReturnType<typeof makeAgent>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-peer-issues-");
    db = createDb(tempDb.connectionString);
    svc = peerIssueService(db);
    grants = peerGrantService(db);
    await ensureSystemPeerIssueUser(db);
  }, 30_000);

  beforeEach(async () => {
    source = await makeCompany(db, "Source");
    target = await makeCompany(db, "Target");
    sourceAgent = await makeAgent(db, source.id, "ceo", "Source CEO");
    // Always make a CEO in target so wake_peer_issue can resolve it.
    await makeAgent(db, target.id, "ceo", "Target CEO");
  });

  afterEach(async () => {
    await db.delete(peerIssueAudits);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentPeerGrants);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.delete(authUsers).where(eq(authUsers.id, SYSTEM_PEER_ISSUE_USER_ID));
    await tempDb?.cleanup();
  });

  it("PASS: authorized agent with peer_issue:create grant creates issue + audit row", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    const result = await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-1",
      sourceCallbackUrl: "https://source.example/issues/SRC-1",
      title: "Peer issue from source",
      body: "context",
      acceptanceCriteria: "do the thing",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: hashKey("create-1"),
    });
    expect(result.replayed).toBe(false);
    if (!result.replayed) {
      expect(result.issue.companyId).toBe(target.id);
      expect(result.audit.targetIssueId).toBe(result.issue.id);
      expect(result.audit.sourceAgentId).toBe(sourceAgent.id);
    }
  });

  it("REFUSE: agent without any grant is rejected on create", async () => {
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-2",
        sourceCallbackUrl: "https://source.example/issues/SRC-2",
        title: "Nope",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("nogrant"),
      }),
    ).rejects.toThrow(/No active peer_issue:create grant/);
  });

  it("REFUSE: expired grant cannot create peer issue", async () => {
    const expired = new Date(Date.now() - 60_000);
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"], { expiresAt: expired });
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-3",
        sourceCallbackUrl: "https://source.example/issues/SRC-3",
        title: "Expired grant",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("expired"),
      }),
    ).rejects.toThrow(/No active peer_issue:create grant/);
  });

  it("REFUSE: revoked grant cannot create peer issue", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"], {
      revokedAt: new Date(Date.now() - 1_000),
    });
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-4",
        sourceCallbackUrl: "https://source.example/issues/SRC-4",
        title: "Revoked grant",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("revoked"),
      }),
    ).rejects.toThrow(/No active peer_issue:create grant/);
  });

  it("REFUSE: peer_issue:comment grant cannot create issues", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:comment"]);
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-5",
        sourceCallbackUrl: "https://source.example/issues/SRC-5",
        title: "Wrong scope",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("wrongscope"),
      }),
    ).rejects.toThrow(/No active peer_issue:create grant/);
  });

  it("REFUSE: guardrailAck missing required key is rejected", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-6",
        sourceCallbackUrl: "https://source.example/issues/SRC-6",
        title: "Missing ack",
        acceptanceCriteria: "should fail",
        guardrailAck: { noSecrets: true } as never,
        idempotencyKey: hashKey("noack"),
      }),
    ).rejects.toThrow(/guardrailAck/);
  });

  it("REFUSE: source identity spoofing (sourceCompanyId != agent.companyId) is rejected", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: target.id, // lie about source
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-7",
        sourceCallbackUrl: "https://source.example/issues/SRC-7",
        title: "Spoof",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("spoof"),
      }),
    ).rejects.toThrow(/sourceCompanyId does not match/);
  });

  it("PASS: idempotency replay returns original audit/response without creating a second issue", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    const key = hashKey("idem-1");
    const first = await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-8",
      sourceCallbackUrl: "https://source.example/issues/SRC-8",
      title: "First",
      acceptanceCriteria: "ok",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    const second = await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-8",
      sourceCallbackUrl: "https://source.example/issues/SRC-8",
      title: "First",
      acceptanceCriteria: "ok",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: key,
    });
    expect(second.replayed).toBe(true);
    const issueCount = await db.select().from(issues).where(eq(issues.companyId, target.id));
    expect(issueCount).toHaveLength(1);
  });

  it("PASS: peer_issue:comment grant lets agent comment on target-owned issue", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create", "peer_issue:comment"]);
    const created = await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-9",
      sourceCallbackUrl: "https://source.example/issues/SRC-9",
      title: "For comment",
      acceptanceCriteria: "ok",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: hashKey("for-comment-create"),
    });
    expect(created.replayed).toBe(false);
    if (created.replayed) throw new Error("expected fresh create");
    const commentResult = await svc.comment(
      target.id,
      created.issue.identifier,
      sourceAgent.id,
      {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-9",
        sourceCallbackUrl: "https://source.example/issues/SRC-9",
        body: "follow up from source",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("comment-1"),
      },
    );
    expect(commentResult.replayed).toBe(false);
  });

  it("REFUSE: comment route refuses cross-company issue identifier", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:comment"]);
    // Create an issue in a DIFFERENT third company; identifier won't match target.
    const other = await makeCompany(db, "Other");
    const [otherIssue] = await db
      .insert(issues)
      .values({
        companyId: other.id,
        title: "Other co's issue",
        status: "todo",
      })
      .returning();
    await expect(
      svc.comment(target.id, otherIssue!.identifier, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-10",
        sourceCallbackUrl: "https://source.example/issues/SRC-10",
        body: "wrong owner",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("wrong-owner"),
      }),
    ).rejects.toThrow(/Target issue does not belong to target company/);
  });

  it("REFUSE: hitting the default 24h rate cap fails the 21st create", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    expect(PEER_ISSUE_DEFAULT_RATE_CAP_24H).toBe(20);
    for (let i = 0; i < PEER_ISSUE_DEFAULT_RATE_CAP_24H; i++) {
      await svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: `SRC-RC-${i}`,
        sourceCallbackUrl: `https://source.example/issues/SRC-RC-${i}`,
        title: `Rate cap ${i}`,
        acceptanceCriteria: "ok",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey(`rate-cap-${i}`),
      });
    }
    await expect(
      svc.create(target.id, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-RC-OVER",
        sourceCallbackUrl: "https://source.example/issues/SRC-RC-OVER",
        title: "Over cap",
        acceptanceCriteria: "should fail",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: hashKey("rate-cap-over"),
      }),
    ).rejects.toThrow(/rate cap exceeded/);
  });

  it("REFUSE: cross-action idempotencyKey reuse rejected (create key used for comment)", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create", "peer_issue:comment"]);
    const sharedKey = hashKey("cross-action-key");
    const created = await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-XA",
      sourceCallbackUrl: "https://source.example/issues/SRC-XA",
      title: "Issue for cross-action test",
      acceptanceCriteria: "ok",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: sharedKey,
    });
    expect(created.replayed).toBe(false);
    if (created.replayed) throw new Error("expected fresh create");
    // Re-using the same key for a comment should be rejected.
    await expect(
      svc.comment(target.id, created.issue.identifier, sourceAgent.id, {
        sourceCompanyId: source.id,
        sourceAgentId: sourceAgent.id,
        sourceIssueIdentifier: "SRC-XA",
        sourceCallbackUrl: "https://source.example/issues/SRC-XA",
        body: "cross-action misuse",
        guardrailAck: GUARDRAIL_ACK,
        idempotencyKey: sharedKey,
      }),
    ).rejects.toThrow(/previously used for a peer issue create/);
  });

  it("PASS: concurrent same-key creates produce exactly one target issue + one audit row (race regression)", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    const sharedKey = hashKey("concurrent-race");
    const callArgs = {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-RACE",
      sourceCallbackUrl: "https://source.example/issues/SRC-RACE",
      title: "Concurrent race winner",
      acceptanceCriteria: "exactly one issue + one audit",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: sharedKey,
    } as const;
    const results = await Promise.allSettled([
      svc.create(target.id, sourceAgent.id, { ...callArgs }),
      svc.create(target.id, sourceAgent.id, { ...callArgs }),
      svc.create(target.id, sourceAgent.id, { ...callArgs }),
    ]);
    // Every settled result must be fulfilled (no 500); at least one must be a fresh
    // create, the rest must be replays — and total target-company issues == 1.
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.create>>> => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(results.length);
    const fresh = fulfilled.filter((r) => r.value.replayed === false);
    const replays = fulfilled.filter((r) => r.value.replayed === true);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.length + replays.length).toBe(results.length);
    // The durable artifact CEO called out: exactly one target-company issue exists
    // for this idempotencyKey after the race resolves.
    const targetIssuesRemaining = await db.select().from(issues).where(eq(issues.companyId, target.id));
    expect(targetIssuesRemaining).toHaveLength(1);
    const auditRows = await db.select().from(peerIssueAudits).where(eq(peerIssueAudits.idempotencyKey, sharedKey));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.targetIssueId).toBe(targetIssuesRemaining[0]!.id);
  });

  it("REFUSE: revoke with wrong targetCompanyId cannot affect another company's grant", async () => {
    const otherSource = await makeAgent(db, target.id, "general", "Target Agent");
    // Create a grant on an UNRELATED third company.
    const third = await makeCompany(db, "Third");
    await makeAgent(db, third.id, "ceo", "Third CEO");
    const victimGrant = await makeGrant(db, otherSource.id, third.id, ["peer_issue:create"]);
    // Now try to revoke victimGrant using target.id as the scoped company.
    await expect(
      peerGrantService(db).revoke(victimGrant.id, target.id),
    ).rejects.toThrow(/not found/);
    // Verify the grant is still active.
    const stillActive = await db
      .select()
      .from(agentPeerGrants)
      .where(eq(agentPeerGrants.id, victimGrant.id))
      .then((rows) => rows[0]!);
    expect(stillActive.revokedAt).toBeNull();
  });

  it("PASS: listAudits returns inbound rows for target and outbound rows for source", async () => {
    await makeGrant(db, sourceAgent.id, target.id, ["peer_issue:create"]);
    await svc.create(target.id, sourceAgent.id, {
      sourceCompanyId: source.id,
      sourceAgentId: sourceAgent.id,
      sourceIssueIdentifier: "SRC-LA",
      sourceCallbackUrl: "https://source.example/issues/SRC-LA",
      title: "Audit row",
      acceptanceCriteria: "ok",
      guardrailAck: GUARDRAIL_ACK,
      idempotencyKey: hashKey("audit-list"),
    });
    const inbound = await svc.listAudits(target.id, "inbound");
    const outbound = await svc.listAudits(source.id, "outbound");
    expect(inbound).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    expect(inbound[0]!.id).toBe(outbound[0]!.id);
  });
});
