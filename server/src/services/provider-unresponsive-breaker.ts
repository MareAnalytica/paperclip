// Cross-run repeated-hang circuit breaker for adapter-invoke hangs.
// Contract C of the ELI-947 silence-watchdog remediation tree (ticket ELI-952).
//
// Context. Contract A (ELI-950) gives a hung invocation a typed, fail-fast
// errorCode (`adapter_no_output_timeout` + `errorMeta.noOutput`); Contract B
// (ELI-951, `isProviderFallbackEligibleError` §3) lets that hang advance the
// provider-fallback chain *when it lands on a non-primary hop*. Neither bounds
// the failure **across runs**: when a fresh run re-picks the same (agent,
// provider) pair and it hangs again, the within-run hop state resets and the
// detect -> re-queue -> hang loop repeats until manual intervention — exactly the
// "no infinite loops" invariant the silence-watchdog (ELI-945/946) was meant to
// protect. The ELI-855 cooldown store skips a *limited* provider on a new root
// run, but keys one self-expiring window per (company, provider) with no
// consecutive-hang counter, so it cannot bound a *recurring* hang.
//
// This module is the breaker's pure decision core. Given the consecutive
// cross-run unresponsive-hang count for an (issue, provider) pair and whether a
// healthy alternative provider exists, it decides whether to fail over to the
// alternative, retry the same pair (bounded), or escalate to a typed operator
// recovery action. No I/O: the recovery service composes it with the
// `issue_recovery_actions` accumulator (whose `attemptCount` + active-fingerprint
// unique index keep the count from resetting on re-pickup of an identical hang)
// and the ELI-855 cooldown store (the skip-in-fallback mechanism).
//
// Policy shape mirrors the eli-board blueprint `policies.providerFallback
// .providerHealth.recovery` surface (spec `eli-board.provider-health.v1`,
// ELI-961, PR #208). Re-derived here, not imported: the blueprint repo ships the
// spec and a reference decision; the platform runtime owns its enforcement copy.

/** The bounded action the breaker takes for a recurring (issue, provider) hang. */
export type ProviderUnresponsiveAction = "failover" | "retry_same" | "escalate";

export interface ProviderUnresponsiveRecoveryInput {
  /** Public provider id of the hung (agent, provider) pair, e.g. "grok-local". */
  provider: string;
  /**
   * 1-based count of consecutive cross-run `provider_unresponsive` hangs for
   * this (issue, provider) pair, **including the current one**. Sourced from the
   * persisted `issue_recovery_actions.attemptCount` so a re-picked identical hang
   * increments rather than resets. A non-finite or `<= 0` value is treated as the
   * first hang (`1`).
   */
  attempt: number;
  /**
   * A healthy alternative provider for the same model (the next chain entry not
   * in cooldown / disabled), or `null` when every alternative is unavailable.
   * When present the breaker always fails over to it rather than sitting on the
   * hung pair — never re-route to a known-hung provider when a healthy one exists.
   */
  healthyAlternative: string | null;
  /**
   * The loop-breaker bound (`recovery.maxUnresponsiveRetriesPerProvider`): the
   * max consecutive same-pair retries permitted before escalation. `<= 0`
   * disables the bound (no breaker) — `retry_same` is then unbounded, which is
   * only safe when no fail-fast deadline is armed (the disabled default posture).
   */
  maxUnresponsiveRetriesPerProvider: number;
}

export interface ProviderUnresponsiveRecoveryDecision {
  actionTaken: ProviderUnresponsiveAction;
  /** Provider to route to: the healthy alternative on `failover`, else the same hung provider. */
  targetProvider: string;
  /** The normalised 1-based attempt the decision was made on (echoed for audit). */
  attempt: number;
}

function normalizeAttempt(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

function normalizeBound(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Decide the bounded recovery action for a recurring cross-run adapter-invoke
 * hang. Pure and deterministic. Invariants (mirroring blueprint spec §5 /
 * ELI-952 acceptance):
 *
 *   1. A healthy alternative present ⇒ `failover` to it, regardless of attempt
 *      count — never sit on a cooled-down/hung provider when a healthy one exists.
 *   2. No alternative, `attempt <= bound` ⇒ bounded `retry_same` (the provider may
 *      recover after its cooldown).
 *   3. No alternative, `attempt > bound` ⇒ `escalate` (open a typed operator
 *      recovery action — CLI health/pin). NEVER `retry_same` once the bound is
 *      reached: that is the no-infinite-loop guarantee.
 *   4. Bound disabled (`<= 0`) ⇒ `retry_same` is unbounded (breaker off).
 */
export function decideUnresponsiveRecovery(
  input: ProviderUnresponsiveRecoveryInput,
): ProviderUnresponsiveRecoveryDecision {
  const attempt = normalizeAttempt(input.attempt);
  const bound = normalizeBound(input.maxUnresponsiveRetriesPerProvider);
  const alternative = input.healthyAlternative?.trim();

  // (1) Healthy alternative wins unconditionally.
  if (alternative) {
    return { actionTaken: "failover", targetProvider: alternative, attempt };
  }

  // (4) Breaker disabled ⇒ unbounded retry-same.
  if (bound <= 0) {
    return { actionTaken: "retry_same", targetProvider: input.provider, attempt };
  }

  // (2) Within the bound ⇒ bounded retry-same. (3) Bound reached ⇒ escalate.
  if (attempt <= bound) {
    return { actionTaken: "retry_same", targetProvider: input.provider, attempt };
  }
  return { actionTaken: "escalate", targetProvider: input.provider, attempt };
}

// ---------------------------------------------------------------------------
// Audit event (blueprint spec §4). Every fail-fast / failover / retry-same /
// escalate decision emits one structured event onto the runtime audit trail so
// the detect -> re-queue -> hang loop is observable without a watchdog forensic
// dive: a run of `retry_same` for one (issueId, provider) capped by a single
// `escalate` is the breaker working; an unbounded run is the bug.
// ---------------------------------------------------------------------------

export type ProviderHealthAuditAction = "fail_fast" | "failover" | "retry_same" | "escalate";

export interface ProviderHealthAuditEvent {
  event: "provider_health_decision";
  provider: string;
  account: string | null;
  model: string | null;
  reason: "provider_unresponsive";
  attempt: number;
  actionTaken: ProviderHealthAuditAction;
  issueId: string | null;
  /** Resolved client-side deadline that fired (ms), when known. Omitted otherwise. */
  timeoutMs?: number;
}

export function buildProviderHealthAuditEvent(input: {
  provider: string;
  account?: string | null;
  model?: string | null;
  attempt: number;
  actionTaken: ProviderHealthAuditAction;
  issueId?: string | null;
  timeoutMs?: number | null;
}): ProviderHealthAuditEvent {
  const event: ProviderHealthAuditEvent = {
    event: "provider_health_decision",
    provider: input.provider,
    account: input.account ?? null,
    model: input.model ?? null,
    reason: "provider_unresponsive",
    attempt: normalizeAttempt(input.attempt),
    actionTaken: input.actionTaken,
    issueId: input.issueId ?? null,
  };
  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    event.timeoutMs = Math.floor(input.timeoutMs);
  }
  return event;
}

/** Map a breaker decision to its audit `actionTaken`. */
export function auditActionForDecision(action: ProviderUnresponsiveAction): ProviderHealthAuditAction {
  return action;
}

// ---------------------------------------------------------------------------
// Runtime composer (spec §3.3 + §3.4). The pure core above decides given an
// already-resolved `healthyAlternative`; this composer derives that alternative
// from the live fallback chain and the ELI-855/856 cooldown set the runtime
// hands it, then returns the decision paired with its §4 audit event. Still pure
// and deterministic — the recovery service supplies the cross-run `attempt`
// (from `issue_recovery_actions.attemptCount`) and the cooldown snapshot.
// ---------------------------------------------------------------------------

export interface ProviderUnresponsiveRecoveryComposeInput {
  /** The hung (agent, provider) pair's provider id. */
  provider: string;
  /** Cross-run consecutive `provider_unresponsive` hang count (1-based, incl. current). */
  attempt: number;
  /** Loop-breaker bound from `recovery.maxUnresponsiveRetriesPerProvider`. */
  maxUnresponsiveRetriesPerProvider: number;
  /**
   * Ordered enabled fallback-chain provider ids for the same model. The first
   * entry that is neither the hung provider nor currently in cooldown is the
   * healthy alternative. Order is preserved so failover follows chain priority.
   */
  chainProviderIds: readonly string[];
  /** Provider ids currently unhealthy / cooling down (ELI-855/856 store). */
  cooledDownProviderIds: ReadonlySet<string>;
  // Non-secret audit routing identities; defaulted to null when unknown.
  account?: string | null;
  model?: string | null;
  issueId?: string | null;
  timeoutMs?: number | null;
}

/**
 * Resolve the healthy alternative from the chain + cooldown set, decide the
 * bounded recovery action, and build the matching §4 audit event. The chosen
 * alternative is the first enabled chain provider that is neither the hung
 * provider nor in cooldown — exactly the provider the ELI-855 root-run skip
 * (`pickRootRunProviderSelection`) would land on next.
 */
export function resolveProviderUnresponsiveRecovery(
  input: ProviderUnresponsiveRecoveryComposeInput,
): { decision: ProviderUnresponsiveRecoveryDecision; audit: ProviderHealthAuditEvent } {
  const hung = input.provider.trim();
  const healthyAlternative =
    input.chainProviderIds.find(
      (id) => id && id !== hung && !input.cooledDownProviderIds.has(id),
    ) ?? null;

  const decision = decideUnresponsiveRecovery({
    provider: input.provider,
    attempt: input.attempt,
    healthyAlternative,
    maxUnresponsiveRetriesPerProvider: input.maxUnresponsiveRetriesPerProvider,
  });

  const audit = buildProviderHealthAuditEvent({
    provider: input.provider,
    account: input.account ?? null,
    model: input.model ?? null,
    attempt: decision.attempt,
    actionTaken: auditActionForDecision(decision.actionTaken),
    issueId: input.issueId ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });

  return { decision, audit };
}
