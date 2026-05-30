import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-status exemption tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal-status recovery exemption", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-status-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // The recovery-action resolve route fires `heartbeat.wakeup` as
    // fire-and-forget; give background work a beat to settle, then TRUNCATE the
    // test tables with CASCADE in a retry loop so a late insert that races
    // teardown restarts the cleanup from the top. Mirrors the audit-sink
    // exemption suite's teardown.
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

  async function seedCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `TS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Status Co",
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

  function boardApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("POST /recovery-actions/resolve treats a terminal source issue as a no-op while restoring the non-terminal control", async () => {
    const { companyId, agentId, prefix } = await seedCompanyWithAgent();

    // Terminal target: a `done` issue that still carries an active recovery
    // action. Resolving it must NOT flip it back into an active state.
    const doneIssueId = randomUUID();
    await db.insert(issues).values({
      id: doneIssueId,
      companyId,
      title: "Closed work with a lingering recovery action",
      status: "done",
      priority: "low",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    // Control: ordinary blocked issue with an active recovery action.
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
    const doneAction = await recoverySvc.upsertSourceScoped({
      companyId,
      sourceIssueId: doneIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "terminal:fp",
      evidence: {},
      nextAction: "Resolve the recovery action.",
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

    const app = boardApp();

    // Resolve against the terminal target with a restore status — status MUST
    // remain `done`, no wake queued, resolutionNote carries the suppression
    // marker, and the activity log records the terminal suppressionReason.
    const doneResolved = await request(app)
      .post(`/api/issues/${doneIssueId}/recovery-actions/resolve`)
      .send({
        actionId: doneAction.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Recovery owner attempted a restore.",
      })
      .expect(200);

    expect(doneResolved.body.issue).toMatchObject({
      id: doneIssueId,
      status: "done", // unchanged: suppressed
    });
    expect(doneResolved.body.recoveryAction).toMatchObject({
      id: doneAction.id,
      status: "resolved",
      outcome: "restored",
    });
    expect(doneResolved.body.recoveryAction.resolutionNote).toContain("suppressed: terminal issue status");

    const doneIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, doneIssueId))
      .then((rows) => rows[0]);
    expect(doneIssue?.status).toBe("done");

    // The route fires `heartbeat.wakeup` as fire-and-forget. Give any
    // background wake a brief window to land before asserting it did not fire
    // for the terminal target.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const terminalWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_recovery_action_restored"),
        ),
      );
    expect(terminalWakeups).toHaveLength(0);

    const doneResolvedActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, doneIssueId),
          eq(activityLog.action, "issue.recovery_action_resolved"),
        ),
      );
    expect(doneResolvedActivity).toHaveLength(1);
    expect(doneResolvedActivity[0]?.details).toMatchObject({
      suppressionReason: "terminal_status_target",
    });

    // The terminal target must not generate an `issue.updated` status flip.
    const doneStatusFlips = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, doneIssueId),
          eq(activityLog.action, "issue.updated"),
        ),
      );
    expect(doneStatusFlips).toHaveLength(0);

    // The recovery action row must be cleared, not lingering active.
    const lingeringDoneActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.sourceIssueId, doneIssueId),
          eq(issueRecoveryActions.status, "active"),
        ),
      );
    expect(lingeringDoneActions).toHaveLength(0);

    // Resolve against the non-terminal control — status MUST flip to todo and
    // NO suppression marker is recorded.
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
