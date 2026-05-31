import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, issueLabels, issues, labels } from "@paperclipai/db";
import { AUDIT_SINK_LABEL_NAME } from "@paperclipai/shared";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isPermanentSinkIssueById } from "../services/recovery/audit-sink-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres permanent-sink by-id exemption tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

// DEE-655 (follow-up to DEE-631): the `successful_run_missing_state` recovery
// cause is emitted from heartbeat's run-completion handlers
// (`handleRunLivenessContinuation` ~4319, `handleSuccessfulRunHandoff` ~4502),
// which both guarded with the label-only `isAuditSinkIssue`. The stranded
// `source_scoped_recovery_action` path (recovery/service.ts) already consulted
// the durable `isPermanentSinkIssue` (audit-sink label OR reserved `-SWEEP-LOG`
// title shape). That asymmetry meant an un-labeled `-SWEEP-LOG` sink was exempt
// from the stranded sweep but NOT from the successful-run handoff nudge.
//
// Both heartbeat guards now call `isPermanentSinkIssueById`, so every
// `SourceScopedRecoveryCause` path consults the SAME predicate. These cases pin
// that by-id predicate against a real Postgres: an un-labeled `-SWEEP-LOG` sink
// is treated as a permanent sink (→ both guards early-return, no nudge), an
// `audit-sink`-labeled issue is too, and an ordinary issue is not (→ nudge still
// fires). The behavioural assertion for the stranded path lives in
// `recovery-permanent-sink-exemption.test.ts`; the pure title-shape cases live
// in `permanent-sink-title-guard.test.ts`.
describeEmbeddedPostgres("isPermanentSinkIssueById (DEE-655 handoff/liveness guard parity)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permanent-sink-byid-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await db.execute(sql`
          truncate table
            issue_labels,
            labels,
            issues,
            agents,
            companies
          restart identity cascade
        `);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `PS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Permanent Sink Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    prefix: string;
    issueNumber: number;
    title: string;
    description?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      description: input.description ?? null,
      status: "in_progress",
      priority: "low",
      assigneeAgentId: input.agentId,
      assigneeUserId: null,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
    });
    return issueId;
  }

  async function applyAuditSinkLabel(companyId: string, issueId: string) {
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: AUDIT_SINK_LABEL_NAME,
    });
    await db.insert(issueLabels).values({
      companyId,
      issueId,
      labelId,
    });
  }

  it("treats an un-labeled -SWEEP-LOG sink as a permanent sink (the DEE-651/DEE-567 recurrence shape)", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      issueNumber: 1,
      title: `${prefix}-CEO-SWEEP-LOG`,
      description: "Heartbeat audit sink. Append-only; no forward work by design.",
    });
    expect(await isPermanentSinkIssueById(db, companyId, issueId)).toBe(true);
  });

  it("treats an audit-sink-labelled issue as a permanent sink even without the title shape", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      issueNumber: 2,
      title: "DEE-567 CEO heartbeat sweep audit log",
    });
    await applyAuditSinkLabel(companyId, issueId);
    expect(await isPermanentSinkIssueById(db, companyId, issueId)).toBe(true);
  });

  it("does not treat an ordinary in_progress issue as a permanent sink (handoff nudge still fires)", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      issueNumber: 3,
      title: "Ordinary stranded in_progress work",
    });
    expect(await isPermanentSinkIssueById(db, companyId, issueId)).toBe(false);
  });

  it("returns false for an issue id that does not exist for the company", async () => {
    const { companyId } = await seedCompany();
    expect(await isPermanentSinkIssueById(db, companyId, randomUUID())).toBe(false);
  });

  it("scopes the lookup to the company (a sink in another company is not matched)", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const sinkInA = await seedIssue({
      companyId: a.companyId,
      agentId: a.agentId,
      prefix: a.prefix,
      issueNumber: 4,
      title: `${a.prefix}-CEO-SWEEP-LOG`,
      description: "audit sink",
    });
    // Same issue id, wrong company → no row → false.
    expect(await isPermanentSinkIssueById(db, b.companyId, sinkInA)).toBe(false);
    // Correct company → true.
    expect(await isPermanentSinkIssueById(db, a.companyId, sinkInA)).toBe(true);
  });
});
