import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issueRecoveryActions,
  issueRelations,
  issues,
  labels,
} from "@paperclipai/db";
import { AUDIT_SINK_LABEL_NAME } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres audit-sink exemption tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("audit-sink recovery exemption", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-audit-sink-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // The recovery-action resolve route fires `heartbeat.wakeup` as
    // fire-and-forget. Those writes can land mid-teardown — both as FK
    // violations on `heartbeat_runs`/`heartbeat_run_events` and as
    // deadlocks on the `issues` checkout-clear UPDATE. CI (parallel
    // suites, slower scheduler) widens the race window vs local runs.
    //
    // Give the background work a beat to settle, then TRUNCATE the test
    // tables with CASCADE in a retry loop so any single statement that
    // races a late insert restarts from the top. We TRUNCATE in one
    // statement so a deadlock on any one table aborts the whole attempt
    // cleanly instead of leaving the schema half-cleared.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        // `companies` cascades to everything used by the test through the
        // existing FK chain; we name explicit tables that the recovery
        // path may also touch so a future schema split still cleans up.
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

  async function seedCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `AS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Audit Sink Co",
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

  async function seedAuditSinkLabel(companyId: string) {
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: AUDIT_SINK_LABEL_NAME,
      color: "#888888",
    });
    return labelId;
  }

  async function labelIssue(companyId: string, issueId: string, labelId: string) {
    await db.insert(issueLabels).values({ companyId, issueId, labelId });
  }

  async function seedAssignedTodoIssue(input: {
    companyId: string;
    agentId: string;
    prefix: string;
    issueNumber: number;
    title: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "todo",
      priority: "low",
      assigneeAgentId: input.agentId,
      assigneeUserId: null,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
    });
    return issueId;
  }

  it("reconcileStrandedAssignedIssues skips audit-sink issues and processes non-sink controls", async () => {
    const { companyId, agentId, prefix } = await seedCompanyWithAgent();
    const auditLabelId = await seedAuditSinkLabel(companyId);

    const sinkIssueId = await seedAssignedTodoIssue({
      companyId,
      agentId,
      prefix,
      issueNumber: 1,
      title: "Audit sink — pinned log",
    });
    await labelIssue(companyId, sinkIssueId, auditLabelId);

    const controlIssueId = await seedAssignedTodoIssue({
      companyId,
      agentId,
      prefix,
      issueNumber: 2,
      title: "Ordinary stranded todo work",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // The audit-sink candidate must be skipped before any branch runs; the
    // non-sink control must take the assignment-dispatch path.
    expect(result.assignmentDispatched).toBe(1);
    expect(result.issueIds).toEqual([controlIssueId]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const wakeupRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeupRows).toHaveLength(1);
    expect((wakeupRows[0]?.payload as { issueId?: string } | null)?.issueId).toBe(controlIssueId);

    const recoveryRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sinkIssueId));
    expect(recoveryRows).toHaveLength(0);

    const sinkIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sinkIssueId))
      .then((rows) => rows[0]);
    expect(sinkIssue?.status).toBe("todo"); // unchanged
    expect(sinkIssue?.assigneeAgentId).toBe(agentId); // unchanged
  });

  it("POST /recovery-actions/resolve suppresses status restore + wake for audit-sink target while allowing the control through", async () => {
    const { companyId, agentId, prefix } = await seedCompanyWithAgent();
    const auditLabelId = await seedAuditSinkLabel(companyId);

    // Audit-sink issue, blocked, with an active recovery action.
    const sinkIssueId = randomUUID();
    await db.insert(issues).values({
      id: sinkIssueId,
      companyId,
      title: "Audit sink — pinned log",
      status: "blocked",
      priority: "low",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await labelIssue(companyId, sinkIssueId, auditLabelId);

    // Control: ordinary issue, blocked, with an active recovery action.
    const controlIssueId = randomUUID();
    await db.insert(issues).values({
      id: controlIssueId,
      companyId,
      title: "Ordinary blocked work",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });

    const recoverySvc = issueRecoveryActionService(db);
    const sinkAction = await recoverySvc.upsertSourceScoped({
      companyId,
      sourceIssueId: sinkIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "audit-sink:fp",
      evidence: {},
      nextAction: "Resolve the audit-sink recovery action.",
      wakePolicy: { type: "wake_owner" },
    });
    const controlAction = await recoverySvc.upsertSourceScoped({
      companyId,
      sourceIssueId: controlIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "control:fp",
      evidence: {},
      nextAction: "Resolve the recovery action.",
      wakePolicy: { type: "wake_owner" },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);

    // Resolve against the audit-sink target — status MUST remain blocked, no
    // wake queued, resolutionNote carries the suppression marker, and the
    // activity log records suppressionReason.
    const sinkResolved = await request(app)
      .post(`/api/issues/${sinkIssueId}/recovery-actions/resolve`)
      .send({
        actionId: sinkAction.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Operator wants this back in flight.",
      })
      .expect(200);

    expect(sinkResolved.body.issue).toMatchObject({
      id: sinkIssueId,
      status: "blocked", // unchanged: suppressed
    });
    expect(sinkResolved.body.recoveryAction).toMatchObject({
      id: sinkAction.id,
      status: "resolved",
      outcome: "restored",
    });
    expect(sinkResolved.body.recoveryAction.resolutionNote).toContain("suppressed: audit-sink issue");

    const sinkIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sinkIssueId))
      .then((rows) => rows[0]);
    expect(sinkIssue?.status).toBe("blocked");

    // The route fires `heartbeat.wakeup` as fire-and-forget. Give any
    // background wake a brief window to land before asserting it did not
    // fire for the audit-sink target.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sinkWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_recovery_action_restored"),
        ),
      );
    expect(sinkWakeups).toHaveLength(0);

    const sinkResolvedActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, sinkIssueId),
          eq(activityLog.action, "issue.recovery_action_resolved"),
        ),
      );
    expect(sinkResolvedActivity).toHaveLength(1);
    expect(sinkResolvedActivity[0]?.details).toMatchObject({
      suppressionReason: "audit_sink_target",
    });

    // Resolve against the non-sink control — status MUST flip to todo and a
    // wake MUST be queued.
    await request(app)
      .post(`/api/issues/${controlIssueId}/recovery-actions/resolve`)
      .send({
        actionId: controlAction.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Operator restored the control.",
      })
      .expect(200);

    const controlIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, controlIssueId))
      .then((rows) => rows[0]);
    expect(controlIssue?.status).toBe("todo");

    const controlResolvedActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, controlIssueId),
          eq(activityLog.action, "issue.recovery_action_resolved"),
        ),
      );
    expect(controlResolvedActivity).toHaveLength(1);
    expect(controlResolvedActivity[0]?.details).not.toHaveProperty("suppressionReason");
  });
});
