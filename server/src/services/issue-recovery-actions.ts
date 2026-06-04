import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
};

/**
 * Optional atomic coexistence guard for `upsertSourceScoped` (ELI-975). When
 * supplied, the upsert only mutates the active per-issue row when that row
 * already carries the same `(cause, fingerprint)` identity. If a competing
 * different-cause action holds the single active slot, the upsert yields
 * (returns `null`) instead of repurposing/clobbering the competing row, which
 * preserves the ELI-776 §3 audit trail. The predicate is evaluated *inside*
 * `runExclusiveUpsert`'s per-key lock (on the inner re-read and in the UPDATE
 * `where` clause), so the read-then-act is atomic even if a competing row is
 * inserted between a caller's outer read and this write.
 */
export type UpsertSourceScopedExpectation = {
  expectCause: string;
  expectFingerprint: string;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: Db) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    expectation?: UpsertSourceScopedExpectation,
    error?: unknown,
  ): Promise<IssueRecoveryAction | null> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1, expectation);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
    expectation?: UpsertSourceScopedExpectation,
  ): Promise<IssueRecoveryAction | null> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      // Atomic coexistence guard (ELI-975): when the caller declares the
      // identity it expects to own, refuse to repurpose a competing active row.
      // This re-read sits inside the per-key lock, so a stranded action inserted
      // between the caller's outer read and this write is observed here and the
      // provider arm yields instead of clobbering it (and vice versa).
      if (
        expectation &&
        (existing.cause !== expectation.expectCause ||
          existing.fingerprint !== expectation.expectFingerprint)
      ) {
        return null;
      }
      const updateWhere = [
        eq(issueRecoveryActions.id, existing.id),
        inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
      ];
      if (expectation) {
        updateWhere.push(eq(issueRecoveryActions.cause, expectation.expectCause));
        updateWhere.push(eq(issueRecoveryActions.fingerprint, expectation.expectFingerprint));
      }
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? existing.evidence,
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: existing.attemptCount + 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
          outcome: null,
          resolutionNote: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(and(...updateWhere))
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount, expectation);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? null,
          returnOwnerAgentId: input.returnOwnerAgentId ?? null,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: input.evidence ?? {},
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, expectation, error);
    }
  }

  /**
   * Upsert the single active source-scoped recovery action for an issue.
   *
   * Without an `expectation`, the active per-issue row (whatever its cause) is
   * re-armed in place — the legacy single-slot behaviour. With an
   * `expectation`, the write is gated on the row's `(cause, fingerprint)`
   * identity and returns `null` when a competing different-cause action owns the
   * slot, making the coexistence guard atomic for the provider / stranded arms
   * (ELI-975).
   */
  function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction>;
  function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    expectation: UpsertSourceScopedExpectation,
  ): Promise<IssueRecoveryAction | null>;
  function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    expectation?: UpsertSourceScopedExpectation,
  ): Promise<IssueRecoveryAction | null> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input, 0, expectation));
  }

  /**
   * Promote an already-active recovery action to `escalated` and (re)route it to
   * a typed operator owner. Used by the Contract C provider-unresponsive breaker
   * (ELI-964): once the consecutive cross-run hang count exceeds the bound and no
   * healthy alternative exists, the accumulator row stops re-queuing the hung
   * pair and becomes an operator recovery action (run adapter CLI health check /
   * pin a healthy provider). `escalated` stays inside the active status set, so
   * the source-scoped slot keeps pointing at this row — the breaker never opens a
   * second active row for the same issue, and a subsequent identical hang reads
   * the same persisted `attemptCount` instead of resetting it.
   *
   * Never auto-cancels the live run (ELI-776 §2): it only re-owns the recovery
   * action to a board/operator decision. The `where` clause is scoped to the
   * active row id so it is idempotent across repeat hangs.
   */
  async function escalateSourceScoped(input: {
    companyId: string;
    sourceIssueId: string;
    actionId: string;
    ownerType?: IssueRecoveryActionOwnerType;
    ownerAgentId?: string | null;
    ownerUserId?: string | null;
    previousOwnerAgentId?: string | null;
    nextAction?: string;
    wakePolicy?: Record<string, unknown> | null;
    monitorPolicy?: Record<string, unknown> | null;
    evidence?: Record<string, unknown>;
  }): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const patch: Partial<IssueRecoveryActionRow> = {
      status: "escalated",
      updatedAt: now,
    };
    if (input.ownerType !== undefined) patch.ownerType = input.ownerType;
    if (input.ownerAgentId !== undefined) patch.ownerAgentId = input.ownerAgentId;
    if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
    if (input.previousOwnerAgentId !== undefined) patch.previousOwnerAgentId = input.previousOwnerAgentId;
    if (input.nextAction !== undefined) patch.nextAction = input.nextAction;
    if (input.wakePolicy !== undefined) patch.wakePolicy = input.wakePolicy;
    if (input.monitorPolicy !== undefined) patch.monitorPolicy = input.monitorPolicy;
    if (input.evidence !== undefined) patch.evidence = input.evidence;

    const [updated] = await db
      .update(issueRecoveryActions)
      .set(patch)
      .where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
          eq(issueRecoveryActions.id, input.actionId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .returning();
    return updated ? toReadModel(updated) : null;
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveForIssue,
    escalateSourceScoped,
    upsertSourceScoped,
  };
}
