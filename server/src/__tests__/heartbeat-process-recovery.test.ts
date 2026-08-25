import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companySkills,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import * as adapters from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterTestEnvironment = vi.hoisted(() => vi.fn(async () => ({
  status: "pass" as const,
  checks: [],
})));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
      testEnvironment: mockAdapterTestEnvironment,
    })),
  };
});

import {
  heartbeatService,
  isRecordedChildAlive,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
} from "../services/heartbeat.ts";
import {
  isRecordedFromPriorBootEpoch,
  isRecordedGroupTerminable,
  snapToCanonicalClockTicks,
} from "../services/process-identity.ts";
import {
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
} from "../services/recovery/index.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.trim().split(/\s+/);
        const state = fields[2];
        if (state === "Z") return false;
      } catch {
        // If procfs is unavailable or transiently unreadable, fall back to kill(0) probe.
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
        ),
      );

    if (activeRuns.length === 0) return;

    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by heartbeat-process-recovery test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, runIds));

    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  // Spawn a detached process-group leader that STAYS ALIVE for the duration of the
  // test. Keeping the leader (and therefore the process-group id) resident is the
  // root fix for this test's historical flakiness: the previous fixture let the
  // leader exit immediately and reused leader.pid as BOTH processPid and
  // processGroupId, so on a busy host the freed pid could be recycled before
  // reapOrphanedRuns() probed it -- flipping isProcessAlive(processPid) true and
  // skipping the reap (and the descendant-group cleanup) entirely.
  //
  // We instead model the "parent pid is already gone" condition with the
  // unrecyclable sentinel pid 999_999_999 (matching the sibling orphan-reaper
  // fixtures), while this real, live process group stands in for the surviving
  // descendant group the reaper must terminate. No real pid we reference is ever
  // dead-and-recyclable while a probe could observe it.
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        // Keep the leader resident so its pid (== the process-group id) cannot be
        // recycled before the reaper terminates the whole group.
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  const descendantPid = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const onData = (chunk: unknown) => {
      stdout += String(chunk);
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        leader.stdout?.off("data", onData);
        resolve(parsed);
      }
    };
    leader.stdout?.on("data", onData);
    leader.once("error", reject);
    leader.once("exit", (code, signal) =>
      reject(
        new Error(
          `Orphan process-group leader exited before reporting its descendant pid (code=${code}, signal=${signal})`,
        ),
      ),
    );
  });

  const processGroupId = leader.pid ?? null;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    leader.kill("SIGKILL");
    throw new Error(`Failed to establish orphaned process-group leader pid: ${processGroupId}`);
  }

  // The leader is detached and intentionally outlives this call; don't let it keep
  // the test runner's event loop alive. It is terminated by the reaper (via the
  // group kill) and, as a backstop, by the afterEach cleanup that SIGKILLs leaderPid.
  leader.unref();

  return {
    // Parent run pid modeled as already gone, via an unrecyclable sentinel so the
    // reaper deterministically takes the descendant-process-group cleanup path.
    processPid: 999_999_999,
    processGroupId,
    leaderPid: processGroupId,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(costEvents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Re-delete every table that holds a (non-cascading) company_id FK before
      // retrying `companies`. A continuation/recovery path under test can emit a
      // late, fire-and-forget continuation-summary write (documents +
      // document_revisions, see issue-continuation-summary.ts) that lands after
      // the earlier child-table deletes above but before this final delete. Both
      // documents.company_id and document_revisions.company_id reference
      // companies.id WITHOUT `onDelete: cascade`, so such a straggler row would
      // otherwise trip `document_revisions_company_id_companies_id_fk` and
      // red-leg unrelated PRs in the serialized server shard (DEE-635).
      await db.delete(companySkills);
      await db.delete(documentRevisions);
      await db.delete(documents);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processStartedAt?: Date | null;
    lastOutputAt?: Date | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false
        ? input?.contextSnapshot ?? {}
        : { ...(input?.contextSnapshot ?? {}), issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processStartedAt: input?.processStartedAt ?? null,
      lastOutputAt: input?.lastOutputAt ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(environments).values({
      id: environmentId,
      companyId: input.companyId,
      name: "Local test environment",
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
    });

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
    title?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: input.title ?? "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function expectSourceScopedStrandedRecoveryAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    cause?: string;
    kind?: string;
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: input.kind ?? "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.agentId,
      returnOwnerAgentId: input.agentId,
      cause: input.cause ?? "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
    });
    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      retryReason: input.retryReason ?? null,
    });
    expect(action.nextAction).toContain(
      input.kind === "missing_disposition" ? "valid issue disposition" : "Restore a live execution path",
    );

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, input.issueId),
      ));
    expect(recoveryIssues).toHaveLength(0);

    const recoveryWakeup = await waitForValue(async () => {
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, input.agentId));
      return wakeups.find((wakeup) => {
        const payload = wakeup.payload as Record<string, unknown> | null;
        return payload?.issueId === input.issueId &&
          payload?.sourceIssueId === input.issueId &&
          payload?.recoveryActionId === action.id &&
          payload?.strandedRunId === input.runId;
      }) ?? null;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.objectContaining({
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
    await waitForHeartbeatIdle(db);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("finalizes a run whose recorded pid was reused after a restart (DEE-662)", async () => {
    // A live process holds the recorded pid, but the run recorded its child
    // start in a previous incarnation (before this process booted), so the live
    // pid must be a reused/unrelated process — the original child is gone.
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, agentId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");

    // DEE-662 M3: a reused-pid reap must not just finalize — it must re-queue a
    // retry and rewire the issue's executionRunId so work resumes (mirrors the
    // dead-pid path), not strand the issue on the dead run.
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("finalizes a run whose live pid started after the recorded child via the /proc start-time gate (DEE-662 gate 2)", async () => {
    // Recorded child start is recent (AFTER this process booted, so the
    // boot-epoch gate cannot fire), but the live pid's observed /proc start
    // post-dates it by more than the skew tolerance — so the start-time gate
    // (gate 2) is the deciding signal. Driven deterministically via the
    // identityProcStartMs seam rather than wall-clock process age.
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const recordedMs = Date.now();
    const { runId, agentId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(recordedMs),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({
      // Live pid appears to have started 60s after the recorded child -> reused.
      identityProcStartMs: () => recordedMs + 60_000,
    });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("keeps a genuinely-alive child whose /proc start matches the recorded child (DEE-662 gate 2 no-regression)", async () => {
    // Same recent recorded start, but the live pid's observed start is within
    // tolerance of it -> identity-consistent -> must NOT be finalized.
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const recordedMs = Date.now();
    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(recordedMs),
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({
      identityProcStartMs: () => recordedMs + 500, // within the 30s skew tolerance
      detachedFinalizeHorizonMs: 60 * 60 * 1000,
    });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
  });

  it("force-finalizes a detached run silent beyond the horizon despite a live pid (DEE-662)", async () => {
    // The recorded pid is genuinely alive and identity-consistent, but the run
    // has been silently `process_detached` past the horizon — forward progress
    // must win over bare liveness.
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(),
      lastOutputAt: new Date(Date.now() - 60_000),
      runErrorCode: "process_detached",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ detachedFinalizeHorizonMs: 1_000 });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
  });

  it("keeps a detached run with a live, identity-consistent pid within the horizon (DEE-662 no-regression)", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(),
      lastOutputAt: new Date(),
      runErrorCode: "process_detached",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ detachedFinalizeHorizonMs: 60 * 60 * 1000 });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      contextSnapshot: {
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")(
    "reaps orphaned descendant process groups when the parent pid is already gone",
    async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    cleanupPids.add(orphan.leaderPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    await expect(waitForPidExit(orphan.descendantPid, 20_000)).resolves.toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    },
    30_000,
  );

  it("blocks the issue when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });

    const blockedIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(blockedIssue?.status).toBe("blocked");
    expect(blockedIssue?.executionRunId).toBeNull();
    expect(blockedIssue?.checkoutRunId).toBeNull();
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("blocks failed recovery work in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.contextSnapshot).toMatchObject({
      codexTransientFallbackMode: "same_session",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("uses the selected provider fallback adapter type for execute-time adapter selection", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    await db
      .update(agents)
      .set({ adapterType: "claude_local" })
      .where(eq(agents.id, agentId));
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          providerFallbackSelection: {
            id: "codex-local",
            adapter: "openai-codex-local",
            adapterConfig: {
              fallbackHint: "codex",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const getServerAdapter = vi.mocked(adapters.getServerAdapter);
    getServerAdapter.mockClear();
    mockAdapterExecute.mockClear();
    mockAdapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Configured fallback adapter execution path validated.",
      provider: "test",
      model: "test-model",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    expect(getServerAdapter).toHaveBeenCalledWith("codex_local");
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    const firstExecution = mockAdapterExecute.mock.calls[0]?.[0];
    expect(firstExecution?.config).toMatchObject({ fallbackHint: "codex" });
    const executedRun = await heartbeat.getRun(runId);
    expect(executedRun?.status).toBe("succeeded");
  });

  it("applies provider fallback adapterConfig even when fallback stays on the same adapter", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          providerFallbackSelection: {
            id: "claude-code-aflabox",
            adapter: "anthropic-claude-code",
            account: "aflabox",
            adapterConfig: {
              fallbackHint: "aflabox",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const getServerAdapter = vi.mocked(adapters.getServerAdapter);
    getServerAdapter.mockClear();
    mockAdapterExecute.mockClear();
    const observedConfig: Record<string, unknown> = {};
    mockAdapterExecute.mockImplementation(async (ctx) => {
      if (ctx.config && typeof ctx.config === "object" && !Array.isArray(ctx.config)) {
        Object.assign(observedConfig, ctx.config);
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Fallback adapter config for same adapter was consumed.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    expect(getServerAdapter).toHaveBeenCalledWith("claude_local");
    expect(observedConfig.fallbackHint).toBe("aflabox");
  });

  it("falls back from Claude auth-required failure to the next provider in order", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    await db
      .update(agents)
      .set({
        adapterType: "claude_local",
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
          providerFallback: {
            chain: [
              { id: "claude-code-personal", adapter: "claude_local", enabled: true, account: "personal" },
              { id: "codex-local", adapter: "codex_local", enabled: true },
            ],
          },
        },
      })
      .where(eq(agents.id, agentId));
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          providerFallbackSelection: {
            id: "claude-code-personal",
            adapter: "claude_local",
            account: "personal",
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const getServerAdapter = vi.mocked(adapters.getServerAdapter);
    getServerAdapter.mockClear();
    mockAdapterExecute.mockClear();
    mockAdapterExecute
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Claude session is not authenticated",
        summary: "Claude auth failure triggers fallback.",
        errorCode: "claude_auth_required",
        provider: "test",
        model: "test-model",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Fallback run succeeded after auth-required failure.",
        provider: "test",
        model: "test-model",
      });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const fallbackRun = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const hasSelection = (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        "providerFallbackSelection" in value;
      return rows.find((row) =>
        row.id !== runId &&
        hasSelection(row.contextSnapshot)
      ) ?? null;
    }, 8_000);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("claude_auth_required");
    expect(fallbackRun).not.toBeNull();
    expect(fallbackRun?.contextSnapshot).toMatchObject({
      providerFallbackSelection: {
        id: "codex-local",
        adapter: "codex_local",
      },
    });
  }, 60_000);

  it("treats a string grok probe as required and runs adapter probe checks", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    await db
      .update(agents)
      .set({ adapterType: "claude_local" })
      .where(eq(agents.id, agentId));
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          providerFallbackSelection: {
            id: "grok-local",
            adapter: "xai-grok-local",
            probe: "which grok >/dev/null 2>&1",
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const getServerAdapter = vi.mocked(adapters.getServerAdapter);
    getServerAdapter.mockClear();
    mockAdapterExecute.mockClear();
    mockAdapterTestEnvironment.mockClear();
    mockAdapterExecute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "forced failure after probe check",
      summary: "Grok probe-gated fallback run attempted.",
      provider: "test",
      model: "test-model",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    expect(getServerAdapter).toHaveBeenCalledWith("grok_local");
    expect(mockAdapterTestEnvironment).toHaveBeenCalledOnce();
    expect(mockAdapterTestEnvironment.mock.calls[0]?.[0]).toMatchObject({
      adapterType: "grok_local",
      config: expect.objectContaining({}),
    });
  });

  it("does not auto-checkout a blocked issue on issue_assigned wake", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockedIssueId = randomUUID();
    const wakeRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date("2026-05-25T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Blocked task",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      status: "queued",
      runId: wakeRunId,
      requestedAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: wakeRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const heartbeat = heartbeatService(db);
    let releaseRun: ((result: {
      exitCode: number;
      signal: string | null;
      timedOut: boolean;
      errorMessage: string | null;
      summary: string;
      provider: string;
      model: string;
    }) => void) | null = null;

    mockAdapterExecute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
    );

    await heartbeat.resumeQueuedRuns();

    const runStarted = await waitForValue(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeRunId))
        .then((rows) => rows[0] ?? null);
      if (run?.status === "running") {
        return run;
      }
      return null;
    }, 5_000);

    // claimQueuedRun stamps status="running" before executeRun reaches
    // adapter.execute; wait for the mock to actually capture releaseRun so the
    // promise can be resolved below.
    const releaseHandle = await waitForValue(async () => releaseRun, 5_000);

    const runningIssueStatus = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0] ?? null);

    expect(runStarted).not.toBeNull();
    expect(releaseHandle).not.toBeNull();
    expect(runningIssueStatus?.status).toBe("blocked");
    expect(runningIssueStatus?.checkoutRunId).toBeNull();

    releaseRun?.({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Blocked issue test run.",
      provider: "test",
      model: "test-model",
    });

    const runSettled = await waitForRunToSettle(heartbeat, wakeRunId, 5_000);
    expect(runSettled?.status).toBe("succeeded");

    const finalIssueStatus = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0] ?? null);
    expect(finalIssueStatus?.status).toBe("blocked");
  });

  it("queues one finish-handoff wake when a successful run leaves in-progress work without a next action", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented the backend detector, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented the backend detector, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);
    expect(handoffWakeups[0]?.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: runId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.authorType).toBe("system");
    expect(handoffComment?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    });
    expect(handoffComment?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Required action",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "run_link", runId }),
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          ]),
        }),
      ]),
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_required")).toBe(true);
  });

  it("requeues a missing-disposition handoff when the previous corrective wake was cancelled", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const idempotencyKey = `finish_successful_run_handoff:${issueId}:${runId}:1`;
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "finish_successful_run_handoff",
      payload: {
        issueId,
        sourceRunId: runId,
        handoffRequired: true,
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      },
      status: "cancelled",
      idempotencyKey,
      requestedAt: new Date("2026-03-19T00:00:01.000Z"),
      finishedAt: new Date("2026-03-19T00:00:02.000Z"),
      updatedAt: new Date("2026-03-19T00:00:02.000Z"),
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented recovery handling, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented recovery handling, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      const requeued = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return requeued.length > 1 ? requeued : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(2);
    expect(handoffWakeups.filter((wakeup) => wakeup.status === "cancelled")).toHaveLength(1);
    expect(handoffWakeups.some((wakeup) => wakeup.status !== "cancelled")).toBe(true);
  });

  it("queues one missing-disposition handoff for artifact-producing successful runs left in progress", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Drafted the Phase 3 test plan but did not choose a final issue disposition.",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Regression test plan",
        format: "markdown",
        latestBody: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Regression test plan",
        format: "markdown",
        body: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "report",
        provider: "test",
        externalId: "phase-3-report",
        title: "Phase 3 regression notes",
        status: "ready",
        summary: "Successful run produced a visible artifact.",
        createdByRunId: ctx.runId,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Created comments, a plan document, and a work product without choosing a disposition.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);
    const classifiedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(classifiedRun?.status ?? settledRun?.status).toBe("succeeded");
    expect(classifiedRun?.livenessState).toBe("advanced");
    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toHaveLength(1);
    expect(comments.some((comment) => comment.body.startsWith("Drafted the Phase 3 test plan"))).toBe(true);

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(1);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("redacts secret-bearing successful-run detected progress before handoff disclosure", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const bearerSecret = "live-bearer-token-value";
    const apiKeySecret = "sk-testsuccessfulhandoffsecret";
    const redactedDetectedSummary = redactDetectedSuccessfulRunProgressSummaryForBoard(
      `Next action noted: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      { enabled: false },
    );
    expect(redactedDetectedSummary).toContain("***REDACTED***");
    expect(redactedDetectedSummary).not.toContain(bearerSecret);
    expect(redactedDetectedSummary).not.toContain(apiKeySecret);

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Made progress but left the issue open.",
      resultJson: {
        message: `Next action: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      },
      provider: "test",
      model: "test-model",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    const wakeupPayloadText = JSON.stringify(handoffWakeups[0]?.payload ?? {});
    expect(wakeupPayloadText).not.toContain(bearerSecret);
    expect(wakeupPayloadText).not.toContain(apiKeySecret);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.body).not.toContain(bearerSecret);
    expect(handoffComment?.body).not.toContain(apiKeySecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(bearerSecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(apiKeySecret);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const handoffActivity = activity.find((event) => event.action === "issue.successful_run_handoff_required");
    expect(handoffActivity).toBeTruthy();
    const activityDetailsText = JSON.stringify(handoffActivity?.details ?? {});
    expect(activityDetailsText).not.toContain(bearerSecret);
    expect(activityDetailsText).not.toContain(apiKeySecret);
  });

  it("escalates an exhausted failed successful-run handoff without using generic continuation recovery first", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "adapter_failed",
      runError: "Authorization: Bearer sk-test-successful-handoff-secret",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      missingDisposition: "clear_next_step",
      latestRunStatus: "failed",
      latestRunErrorCode: "adapter_failed",
      recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-successful-handoff-secret");

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0]?.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(comments[0]?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery owner",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Recovery action", value: recoveryAction.id }),
            expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CodexCoder" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
      ]),
    });
    expect(comments[0]?.body).not.toContain("sk-test-successful-handoff-secret");
    expect(JSON.stringify(comments[0]?.metadata ?? {})).not.toContain("sk-test-successful-handoff-secret");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_escalated")).toBe(true);
  });

  it("escalates an exhausted successful handoff run that still leaves no disposition", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      latestRunStatus: "succeeded",
      missingDisposition: "clear_next_step",
    });
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(wakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
    });
    expect(runs[0]?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(unblockedWakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
      });
      expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-recovery-secret");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("blocks an already stranded recovery issue without creating a recovery child", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const sourceIssueId = randomUUID();
    const sourceRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original source issue",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue from previous adapter failure",
        parentId: sourceIssueId,
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
        originRunId: sourceRunId,
        originFingerprint: [
          "stranded_issue_recovery",
          companyId,
          sourceIssueId,
          sourceRunId,
        ].join(":"),
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]).toMatchObject({
      id: issueId,
      status: "blocked",
      parentId: sourceIssueId,
      originId: sourceIssueId,
      originRunId: sourceRunId,
    });
    expect(recoveryIssues[0]?.checkoutRunId).toBeNull();
    expect(recoveryIssues[0]?.executionRunId).toBeNull();

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recoveryIssues[0]?.identifier}]`);
    expect(comments[0]?.body).toContain("Next action:");
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });

  it("does not status-only recover Chief Executive Officer sweep log tickets", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
      retryReason: "issue_continuation_needed",
      title: "ELI-BOARD-CEO-SWEEP-LOG",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.issueIds).not.toContain(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.map((row) => row.id)).toEqual([runId]);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ));
    expect(actions).toHaveLength(0);
  });

  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("suppresses stranded_assigned_issue when the assignee commented recently and an open child is in review", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    // Recent assignee-agent comment (event-driven heartbeat pattern from DEE-349 DM).
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "Heartbeat: still waiting on child review (DEE-349 shape).",
    });

    // Open child issue in_review (PR-E/F gated on HPA/V/E in DEE-349 shape).
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      parentId: issueId,
      title: "Routed child review gate",
      status: "in_review",
      priority: "medium",
      issueNumber: 99,
      identifier: `${issuePrefix}-99`,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.issueIds).not.toContain(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(recoveryActions).toHaveLength(0);

    // Sanity: the assignee comment we seeded is still the only non-system comment.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBe(agentId);
    void runId;
  });

  it("suppresses stranded_assigned_issue when the assignee commented recently and an active blockedBy issue is open", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "Heartbeat: waiting on platform blocker.",
    });

    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Active platform blocker",
      status: "in_progress",
      priority: "medium",
      issueNumber: 77,
      identifier: `${issuePrefix}-77`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.issueIds).not.toContain(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("still fires stranded_assigned_issue when only a recent assignee comment exists without an open child or blocker", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "Heartbeat-only liveness; nothing actually pending.",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
  });

  it("still fires stranded_assigned_issue when an open child exists but the assignee has not commented recently", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      parentId: issueId,
      title: "Open child without assignee liveness",
      status: "in_review",
      priority: "medium",
      issueNumber: 88,
      identifier: `${issuePrefix}-88`,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recoveryAction.evidence).toMatchObject({
      latestRunErrorCode: "adapter_exit_code",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("reuses the raced stranded recovery issue when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.attemptCount).toBeGreaterThanOrEqual(1);
    const recoveries = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, issueId),
      ));
    expect(recoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("blocks stranded recovery issues in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("blocked");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure details were withheld from the issue thread");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("re-enqueues recovery when the latest in-progress continuation made progress but left no live path", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });

  it("blocks stranded in-progress work after a productive continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("automatically retried continuation");
    expect(comments[0]?.body).toContain("still has no live execution path");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("allows one productive-terminal recovery after regular continuation recovery made progress", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });
});

describe("isRecordedChildAlive (DEE-662 pid-identity)", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
  const recorded = new Date(NOW - 60_000); // child recorded 60s before "now"
  const selfStartMs = () => NOW - 5 * 60_000; // this process booted 5m ago

  it("returns false for an invalid or dead pid", () => {
    expect(isRecordedChildAlive(0, recorded)).toBe(false);
    expect(isRecordedChildAlive(123, recorded, { isAlive: () => false })).toBe(false);
  });

  it("cannot judge identity without a recorded start, so reports alive", () => {
    expect(isRecordedChildAlive(123, null, { isAlive: () => true })).toBe(true);
  });

  it("flags a reused pid via the boot-epoch gate (recorded child predates this process)", () => {
    const preBoot = new Date(NOW - 10 * 60_000); // older than selfStart (5m)
    expect(
      isRecordedChildAlive(58, preBoot, {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => null,
      }),
    ).toBe(false);
  });

  it("flags a reused pid via the /proc start-time gate (live pid started after the child was recorded)", () => {
    expect(
      isRecordedChildAlive(58, recorded, {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => NOW, // started 60s after `recorded`
      }),
    ).toBe(false);
  });

  it("reports a genuinely-alive, identity-consistent child as alive", () => {
    expect(
      isRecordedChildAlive(58, recorded, {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => recorded.getTime() + 500, // within tolerance
      }),
    ).toBe(true);
  });

  it("absorbs small clock skew within tolerance", () => {
    expect(
      isRecordedChildAlive(58, recorded, {
        isAlive: () => true,
        selfStartMs: () => recorded.getTime() + 1_000, // recorded ~1s before boot
        procStartMs: () => recorded.getTime() + 1_000,
        toleranceMs: 30_000,
      }),
    ).toBe(true);
  });
});

describe("isRecordedFromPriorBootEpoch (DEE-662 H2 — termination reuse guard)", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
  const selfStartMs = () => NOW - 5 * 60_000; // this process booted 5m ago

  it("flags a recorded child that predates this boot (pod-restart PID/PGID reuse — suppress signalling)", () => {
    expect(
      isRecordedFromPriorBootEpoch(new Date(NOW - 10 * 60_000), { selfStartMs }),
    ).toBe(true);
  });

  it("does NOT flag a same-incarnation start (preserve descendant cleanup)", () => {
    expect(
      isRecordedFromPriorBootEpoch(new Date(NOW - 60_000), { selfStartMs }),
    ).toBe(false);
  });

  it("does NOT flag inconclusive input (no recorded start) — keep existing cleanup", () => {
    expect(isRecordedFromPriorBootEpoch(null, { selfStartMs })).toBe(false);
    expect(isRecordedFromPriorBootEpoch(new Date(NOW), { selfStartMs: () => Number.NaN })).toBe(false);
  });
});

describe("isRecordedGroupTerminable (DEE-662 H2 — group reuse guard)", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
  const recorded = new Date(NOW - 60_000);
  const selfStartMs = () => NOW - 5 * 60_000;

  it("rejects a group whose recorded start is from a prior boot (pod-restart PGID reuse)", () => {
    expect(
      isRecordedGroupTerminable(58, new Date(NOW - 10 * 60_000), {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => NOW,
      }),
    ).toBe(false);
  });

  it("rejects a same-incarnation group whose live leader pid was reused (started after recorded)", () => {
    expect(
      isRecordedGroupTerminable(58, recorded, {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => recorded.getTime() + 5 * 60_000, // leader started well after recorded
      }),
    ).toBe(false);
  });

  it("allows a group whose live leader pid matches the recorded child", () => {
    expect(
      isRecordedGroupTerminable(58, recorded, {
        isAlive: () => true,
        selfStartMs,
        procStartMs: () => recorded.getTime() + 500, // within tolerance
      }),
    ).toBe(true);
  });

  it("allows a descendant-only group whose leader pid is already dead (legit cleanup)", () => {
    expect(
      isRecordedGroupTerminable(58, recorded, {
        isAlive: () => false, // leader gone, but the group itself is still alive
        selfStartMs,
        procStartMs: () => null,
      }),
    ).toBe(true);
  });

  it("rejects an invalid process group id", () => {
    expect(isRecordedGroupTerminable(0, recorded, { isAlive: () => true })).toBe(false);
  });
});

describe("snapToCanonicalClockTicks (DEE-662 H1)", () => {
  it("returns the exact canonical value for near-canonical derived rates", () => {
    expect(snapToCanonicalClockTicks(100)).toBe(100);
    expect(snapToCanonicalClockTicks(99)).toBe(100); // within 10%
    expect(snapToCanonicalClockTicks(108)).toBe(100);
    expect(snapToCanonicalClockTicks(250)).toBe(250);
    expect(snapToCanonicalClockTicks(1000)).toBe(1000);
    expect(snapToCanonicalClockTicks(940)).toBe(1000);
  });

  it("refuses to resolve a non-canonical / noisy derived rate (skip gate 2 -> horizon)", () => {
    // The dangerous case: a noisy startup derivation that is NOT close to any
    // real CLK_TCK must return null rather than be trusted verbatim (which would
    // scale absolute start times by hours and false-finalize a live child).
    expect(snapToCanonicalClockTicks(150)).toBeNull();
    expect(snapToCanonicalClockTicks(200)).toBeNull();
    expect(snapToCanonicalClockTicks(60)).toBeNull();
    expect(snapToCanonicalClockTicks(500)).toBeNull();
    expect(snapToCanonicalClockTicks(0)).toBeNull();
    expect(snapToCanonicalClockTicks(-100)).toBeNull();
    expect(snapToCanonicalClockTicks(Number.NaN)).toBeNull();
  });
});
