import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres permanent-sink exemption tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DEE-631: a permanent `in_progress` sweep-log sink that carries the reserved
// `-SWEEP-LOG` title shape but NOT (yet) the `audit-sink` label was being
// flipped `in_progress -> blocked` by the `source_scoped_recovery_action` sweep
// on every cycle. The generalized title-shape guard must exempt it durably,
// while an ordinary `in_progress` issue in the same failed-continuation state is
// still escalated to `blocked`.
describeEmbeddedPostgres("permanent-sink recovery exemption (title shape)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permanent-sink-");
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
            issue_recovery_actions,
            issue_comments,
            issue_documents,
            issue_relations,
            issues,
            activity_log,
            heartbeat_run_events,
            heartbeat_runs,
            agent_wakeup_requests,
            agent_runtime_state,
            agents,
            company_skills,
            document_revisions,
            documents,
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

  async function seedCompanyWithCeo() {
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

  async function seedInProgressIssueWithFailedContinuation(input: {
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
    // A failed continuation run drives `didAutomaticRecoveryFail(... "issue_continuation_needed")`,
    // which is the branch that escalates an in_progress issue to `blocked`.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "failed",
      contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
    });
    return issueId;
  }

  it("skips a title-shaped permanent sink while still escalating an ordinary in_progress issue", async () => {
    const { companyId, agentId, prefix } = await seedCompanyWithCeo();

    // Permanent sink identified by the reserved `-SWEEP-LOG` title suffix only
    // (no `audit-sink` label) — the exact DEE-631 / Eli-board recurrence shape.
    const sinkIssueId = await seedInProgressIssueWithFailedContinuation({
      companyId,
      agentId,
      prefix,
      issueNumber: 1,
      title: `${prefix}-CEO-SWEEP-LOG`,
      description: "Heartbeat audit sink. Append-only; no forward work by design.",
    });

    // Ordinary control issue in the identical failed-continuation state.
    const controlIssueId = await seedInProgressIssueWithFailedContinuation({
      companyId,
      agentId,
      prefix,
      issueNumber: 2,
      title: "Ordinary stranded in_progress work",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Sink: untouched and skipped before any escalation branch.
    expect(result.issueIds).not.toContain(sinkIssueId);
    const sinkIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sinkIssueId))
      .then((rows) => rows[0]);
    expect(sinkIssue?.status).toBe("in_progress"); // NOT re-blocked

    const sinkRecoveryRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sinkIssueId));
    expect(sinkRecoveryRows).toHaveLength(0); // no source_scoped_recovery_action

    const sinkWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${sinkIssueId}`);
    expect(sinkWakeups).toHaveLength(0); // no owner wake

    // Control: escalated to blocked with an active recovery action.
    expect(result.issueIds).toContain(controlIssueId);
    const controlIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, controlIssueId))
      .then((rows) => rows[0]);
    expect(controlIssue?.status).toBe("blocked");

    const controlRecoveryRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, controlIssueId));
    expect(controlRecoveryRows.length).toBeGreaterThanOrEqual(1);
  });
});
