// Contract C cross-run breaker — the persistent accumulator arm (ELI-964).
//
// `provider-unresponsive-breaker.ts` holds the PURE decision core
// (`resolveProviderUnresponsiveRecovery`): given an already-resolved consecutive
// hang count it decides failover / retry_same / escalate. This module supplies
// that count from the durable `issue_recovery_actions` accumulator and performs
// the escalate side-effect (promote the accumulator row to a typed operator
// recovery action), so the heartbeat wire-in shrinks to: accumulate → cooldown →
// audit. Keeping the DB-touching orchestration here makes the precise N-bound
// behaviour unit-testable against an embedded Postgres without standing up the
// full heartbeat service.
//
// Coexistence model (the flagged `issue_recovery_actions_active_source_uq`
// risk). That partial unique index permits only ONE active/escalated recovery
// row per (company, sourceIssue), so a provider-health accumulator cannot share
// the per-issue slot with a stranded-issue recovery action. We resolve the
// collision by YIELDING rather than relaxing the invariant: the breaker claims
// the slot only when it is free or already its own provider-health row. If a
// different-cause action (e.g. `stranded_assigned_issue`) is active on the same
// issue, that issue is already in operator recovery, so we never overwrite it
// (preserving the ELI-776 §3 audit trail) and fall back to the cooldown-only
// first-vs-repeat proxy count for the audit event. Source-less timer/system runs
// (no issueId) have no per-issue row and likewise use the proxy + cooldown skip.

import type { IssueRecoveryAction, IssueRecoveryActionOwnerType } from "@paperclipai/shared";
import {
  resolveProviderUnresponsiveRecovery,
  type ProviderHealthAuditEvent,
  type ProviderUnresponsiveRecoveryDecision,
} from "./provider-unresponsive-breaker.js";

/** The subset of `issueRecoveryActionService` this module needs. */
export interface ProviderUnresponsiveAccumulatorStore {
  getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null>;
  upsertSourceScoped(input: {
    companyId: string;
    sourceIssueId: string;
    kind: "provider_unhealthy";
    ownerType?: IssueRecoveryActionOwnerType;
    ownerAgentId?: string | null;
    previousOwnerAgentId?: string | null;
    returnOwnerAgentId?: string | null;
    cause: string;
    fingerprint: string;
    evidence?: Record<string, unknown>;
    nextAction: string;
    wakePolicy?: Record<string, unknown> | null;
    monitorPolicy?: Record<string, unknown> | null;
    maxAttempts?: number | null;
    lastAttemptAt?: Date | null;
  }, expectation: { expectCause: string; expectFingerprint: string }): Promise<IssueRecoveryAction | null>;
  escalateSourceScoped(input: {
    companyId: string;
    sourceIssueId: string;
    actionId: string;
    ownerType?: IssueRecoveryActionOwnerType;
    ownerAgentId?: string | null;
    nextAction?: string;
    wakePolicy?: Record<string, unknown> | null;
    evidence?: Record<string, unknown>;
  }): Promise<IssueRecoveryAction | null>;
  resolveActiveForIssue(input: {
    companyId: string;
    sourceIssueId: string;
    actionId?: string | null;
    status: "resolved" | "cancelled";
    outcome: "restored" | "delegated" | "false_positive" | "blocked" | "escalated" | "cancelled";
    resolutionNote?: string | null;
  }): Promise<IssueRecoveryAction | null>;
}

export const PROVIDER_UNRESPONSIVE_CAUSE = "provider_unresponsive" as const;

/**
 * The (agent, provider) fingerprint for a provider-unresponsive accumulator row.
 * Scoped under (company, issue) by the row's `sourceIssueId`; the `cause` +
 * `fingerprint` pair distinguishes it from a stranded-issue recovery action.
 */
export function providerUnresponsiveFingerprint(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  provider: string;
}): string {
  return `${PROVIDER_UNRESPONSIVE_CAUSE}:${input.companyId}:${input.issueId}:${input.agentId}:${input.provider}`;
}

export interface AccumulateProviderUnresponsiveHangInput {
  companyId: string;
  /** Work issue the hung run was processing, or null for a source-less timer/system run. */
  issueId: string | null;
  agentId: string;
  provider: string;
  account?: string | null;
  model?: string | null;
  runId: string;
  /** Ordered enabled fallback-chain provider ids for the same model. */
  chainProviderIds: readonly string[];
  /** Provider ids currently cooling down (ELI-855/856 store). */
  cooledDownProviderIds: ReadonlySet<string>;
  /** `recovery.maxUnresponsiveRetriesPerProvider`. */
  maxUnresponsiveRetriesPerProvider: number;
  now?: Date;
}

export interface AccumulateProviderUnresponsiveHangResult {
  attempt: number;
  attemptSource: "accumulator" | "proxy";
  decision: ProviderUnresponsiveRecoveryDecision;
  audit: ProviderHealthAuditEvent;
  /** The escalated operator recovery action, when this hang reached the bound. */
  escalated: IssueRecoveryAction | null;
}

/**
 * Source the precise consecutive cross-run hang count from the accumulator,
 * decide the bounded recovery action, and — on `escalate` — promote the
 * accumulator to a typed operator recovery action (run adapter CLI health check
 * / pin a healthy provider) instead of re-queuing the hung pair. Routes to an
 * operator decision, never an auto-cancel (ELI-776 §2). Idempotent across repeat
 * hangs: once escalated, the count is not re-incremented and exactly one operator
 * action is opened.
 */
export async function accumulateProviderUnresponsiveHang(
  store: ProviderUnresponsiveAccumulatorStore,
  input: AccumulateProviderUnresponsiveHangInput,
): Promise<AccumulateProviderUnresponsiveHangResult> {
  const now = input.now ?? new Date();
  const bound = input.maxUnresponsiveRetriesPerProvider;
  const proxyAttempt = input.cooledDownProviderIds.has(input.provider) ? 2 : 1;

  let attempt = proxyAttempt;
  let attemptSource: "accumulator" | "proxy" = "proxy";
  let accumulator: IssueRecoveryAction | null = null;
  let alreadyEscalated = false;

  if (input.issueId) {
    const fingerprint = providerUnresponsiveFingerprint({
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      provider: input.provider,
    });
    const existing = await store.getActiveForIssue(input.companyId, input.issueId);
    const isOurs =
      !!existing &&
      existing.cause === PROVIDER_UNRESPONSIVE_CAUSE &&
      existing.fingerprint === fingerprint;

    if (existing && !isOurs) {
      // A competing non-provider recovery action owns the slot — yield.
      attempt = proxyAttempt;
    } else if (existing && isOurs && existing.status === "escalated") {
      // Already escalated to an operator — do not re-queue, do not re-count.
      accumulator = existing;
      alreadyEscalated = true;
      attempt = existing.attemptCount;
      attemptSource = "accumulator";
    } else {
      // Atomic re-arm: the predicate makes the write yield (return null) if a
      // competing stranded action claimed the slot between the outer read above
      // and this write, so we never clobber it (ELI-975).
      accumulator = await store.upsertSourceScoped({
        companyId: input.companyId,
        sourceIssueId: input.issueId,
        kind: "provider_unhealthy",
        ownerType: "agent",
        ownerAgentId: input.agentId,
        previousOwnerAgentId: input.agentId,
        returnOwnerAgentId: input.agentId,
        cause: PROVIDER_UNRESPONSIVE_CAUSE,
        fingerprint,
        evidence: {
          provider: input.provider,
          account: input.account ?? null,
          model: input.model ?? null,
          lastRunId: input.runId,
          lastIssueId: input.issueId,
        },
        nextAction:
          "Provider unresponsive (no-output hang); next root run will skip it. No operator action required unless this escalates.",
        wakePolicy: null,
        monitorPolicy: null,
        maxAttempts: bound > 0 ? bound : null,
        lastAttemptAt: now,
      }, { expectCause: PROVIDER_UNRESPONSIVE_CAUSE, expectFingerprint: fingerprint });
      if (accumulator) {
        attempt = accumulator.attemptCount;
        attemptSource = "accumulator";
      } else {
        // Raced into a competing recovery action — yield to it.
        attempt = proxyAttempt;
      }
    }
  }

  const { decision, audit } = resolveProviderUnresponsiveRecovery({
    provider: input.provider,
    attempt,
    maxUnresponsiveRetriesPerProvider: bound,
    chainProviderIds: input.chainProviderIds,
    cooledDownProviderIds: input.cooledDownProviderIds,
    account: input.account ?? null,
    model: input.model ?? null,
    issueId: input.issueId ?? null,
  });

  let escalated: IssueRecoveryAction | null = null;
  if (decision.actionTaken === "escalate" && accumulator && !alreadyEscalated && input.issueId) {
    const operatorNextAction =
      `Provider \`${input.provider}\` is unresponsive across ${attempt} consecutive runs with no healthy fallback. ` +
      "Run the adapter CLI health check or pin a healthy provider, then resolve this recovery action.";
    escalated = await store.escalateSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      actionId: accumulator.id,
      ownerType: "board",
      ownerAgentId: null,
      nextAction: operatorNextAction,
      wakePolicy: { type: "board_escalation", reason: "provider_unresponsive_bound_reached" },
      evidence: {
        ...accumulator.evidence,
        provider: input.provider,
        account: input.account ?? null,
        model: input.model ?? null,
        attempt,
        bound,
        lastRunId: input.runId,
        lastIssueId: input.issueId,
        breakerDecision: decision.actionTaken,
      },
    });
  }

  return { attempt, attemptSource, decision, audit, escalated };
}

/**
 * Break the consecutive-hang streak when the provider recovers. A run that
 * completes WITHOUT a no-output hang on the same (agent, provider) pair proves
 * the provider is responsive again, so its active accumulator is resolved
 * (outcome `restored`). Scoped to the provider the run actually used so a
 * failover to a healthy alternative does not clear the hung provider's
 * accumulator. Returns the resolved action, or null when there was nothing to
 * clear.
 *
 * Escalated-action lifecycle (ELI-975 secondary item — decided: keep self-heal).
 * `getActiveForIssue` returns both `active` and `escalated` rows, so when a row
 * has already escalated to a board/operator owner and a later run then succeeds
 * on the same (agent, provider), this self-heals it to `resolved`/`restored`.
 * That is intentional: it is honest (the provider demonstrably recovered),
 * avoids a stale operator escalation lingering on the board, and preserves the
 * audit trail (the escalation + its resolution stay on the row, ELI-776 §3 —
 * the row is resolved, never deleted). We deliberately do NOT require explicit
 * operator closure once escalated; the resolutionNote records the auto-recovery.
 */
export async function resolveProviderUnresponsiveAccumulatorOnRecovery(
  store: ProviderUnresponsiveAccumulatorStore,
  input: { companyId: string; issueId: string | null; agentId: string; provider: string; runId: string },
): Promise<IssueRecoveryAction | null> {
  if (!input.issueId) return null;
  const existing = await store.getActiveForIssue(input.companyId, input.issueId);
  if (!existing || existing.cause !== PROVIDER_UNRESPONSIVE_CAUSE) return null;
  const fingerprint = providerUnresponsiveFingerprint({
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    provider: input.provider,
  });
  if (existing.fingerprint !== fingerprint) return null;
  return store.resolveActiveForIssue({
    companyId: input.companyId,
    sourceIssueId: input.issueId,
    actionId: existing.id,
    status: "resolved",
    outcome: "restored",
    resolutionNote: `Provider ${input.provider} responded on run ${input.runId}; consecutive-hang streak cleared.`,
  });
}
