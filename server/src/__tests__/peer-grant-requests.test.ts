import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
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
