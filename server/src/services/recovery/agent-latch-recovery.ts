import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents } from "@paperclipai/db";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const AGENT_LATCH_RECOVERY_REASON = RECOVERY_REASON_KINDS.agentLatchRecovery;
export const DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS = 3;
export const DEFAULT_AGENT_LATCH_RECOVERY_BACKOFF_BASE_MINUTES = 60;

// Phase-1 scope (CEO binding condition 1, DEE-678): claude_local only. Generalizing
// to the other sessioned local adapters (codex_local, ...) is an explicit follow-up
// after this self-heals in dev, so we keep the scope set narrow on purpose.
export const AGENT_LATCH_RECOVERY_ADAPTERS = new Set<string>(["claude_local"]);

// MANDATORY safety gate (CEO binding condition 3): only a transient upstream latch
// is auto-recoverable. `adapter_failed` / config / auth-permanent / model-rejection
// latches MUST NOT be re-woken, otherwise auto-recovery becomes a crash loop. This is
// the same family string returned by `readHeartbeatRunErrorFamily` in heartbeat.ts, so
// the classifier stays a single shared source of truth — the caller computes it and
// passes it in, mirroring how `decideRunLivenessContinuation` receives `livenessState`.
const RECOVERABLE_ERROR_FAMILY = "transient_upstream";

// Agent statuses that suppress automatic recovery verbatim (CEO binding condition 6).
const RECOVERY_SUPPRESSING_AGENT_STATUSES = new Set<string>(["paused", "terminated"]);

// Statuses that represent a genuinely-issued recovery attempt. Critically this INCLUDES
// `claimed` and `failed`: a recovery wake that was dispatched and then failed (the
// transient had not actually cleared) MUST still count toward the cap/backoff, otherwise
// failed attempts never advance `priorAttempts` and the bounded crash-loop guard is
// defeated. `cancelled` / `coalesced` / `skipped` are excluded because those wakes were
// nullified, merged into another wake, or never dispatched, so they did not consume an
// attempt. Used for BOTH the per-attempt idempotency guard and the prior-attempt counter.
const ISSUED_ATTEMPT_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution", "completed", "failed"];

type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status" | "adapterType">;

export type AgentLatchRecoveryDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
    }
  | {
      kind: "skip";
      reason: string;
    };

export function readAgentLatchRecoveryAttempt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

// Exponential backoff over the transient retry window. The window gate already holds
// the wake until `retryNotBefore`; backoff additionally spaces out *re-attempts* so a
// still-latched agent is not hammered once-per-tick (CEO binding condition 5).
export function computeAgentLatchRecoveryBackoffMinutes(baseMinutes: number, priorAttempts: number): number {
  const safeBase =
    Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes : DEFAULT_AGENT_LATCH_RECOVERY_BACKOFF_BASE_MINUTES;
  const attempts = readAgentLatchRecoveryAttempt(priorAttempts);
  // attempt 0 -> no extra wait (wake right at retryNotBefore); attempt 1 -> base; 2 -> 2*base; ...
  return attempts <= 0 ? 0 : safeBase * 2 ** (attempts - 1);
}

export function buildAgentLatchRecoveryIdempotencyKey(input: {
  agentId: string;
  latchRunId: string;
  nextAttempt: number;
}): string {
  return [
    AGENT_LATCH_RECOVERY_REASON,
    input.agentId,
    input.latchRunId,
    String(input.nextAttempt),
  ].join(":");
}

export async function findExistingAgentLatchRecoveryWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, ISSUED_ATTEMPT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// Count prior agent-latch-recovery wakes already issued for this (agent, latching run).
// This is the bounded-retry counter: distinct attempts for the same latch share the
// same `latchRunId`, so the cap applies per latch episode, not per agent lifetime.
export async function countPriorAgentLatchRecoveryWakes(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    latchRunId: string;
  },
): Promise<number> {
  const prefix = [AGENT_LATCH_RECOVERY_REASON, input.agentId, input.latchRunId].join(":");
  const rows = await db
    .select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        inArray(agentWakeupRequests.status, ISSUED_ATTEMPT_WAKE_STATUSES),
      ),
    );
  return rows.filter((row) => typeof row.idempotencyKey === "string" && row.idempotencyKey.startsWith(`${prefix}:`))
    .length;
}

/**
 * Pure decision for auto-recovering a `claude_local` agent latched in `status="error"`
 * after a transient upstream failure (e.g. a Claude session/usage cap) has cleared.
 *
 * Deliberately IO-free and deterministic so every CEO binding condition (DEE-678) is a
 * unit test: scope, disabled-by-default, transient-only safety gate, never-before-window,
 * cap+backoff+escalate-once, pause/terminated suppression, idempotency.
 */
export function decideAgentLatchRecovery(input: {
  agent: AgentRow | null;
  latchRunId: string | null;
  errorFamily: string | null;
  retryNotBefore: Date | null;
  now: Date;
  priorAttempts: number;
  idempotentWakeExists: boolean;
  enabled: boolean;
  pauseHoldSuppressed?: boolean;
  maxAttempts?: number;
  backoffBaseMinutes?: number;
}): AgentLatchRecoveryDecision {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS;
  const backoffBaseMinutes = input.backoffBaseMinutes ?? DEFAULT_AGENT_LATCH_RECOVERY_BACKOFF_BASE_MINUTES;

  // Ship dark (CEO binding condition 2): opt-in, disabled by default.
  if (!input.enabled) {
    return { kind: "skip", reason: "agent latch recovery is disabled by policy" };
  }

  const { agent } = input;
  if (!agent) return { kind: "skip", reason: "agent not found" };

  // Phase-1 scope (condition 1).
  if (!AGENT_LATCH_RECOVERY_ADAPTERS.has(agent.adapterType)) {
    return { kind: "skip", reason: `adapter ${agent.adapterType} is out of Phase-1 scope` };
  }

  // Reuse pause/terminated + pause-hold suppressors verbatim (condition 6).
  if (RECOVERY_SUPPRESSING_AGENT_STATUSES.has(agent.status)) {
    return { kind: "skip", reason: `agent status ${agent.status} suppresses automatic recovery` };
  }
  if (input.pauseHoldSuppressed) {
    return { kind: "skip", reason: "automatic recovery suppressed by pause hold" };
  }

  // Only act on a genuine error latch.
  if (agent.status !== "error") {
    return { kind: "skip", reason: `agent status ${agent.status} is not an error latch` };
  }

  if (!input.latchRunId) {
    return { kind: "skip", reason: "no latching run identified" };
  }

  // MANDATORY safety gate (condition 3): transient_upstream only. This is the crash-loop
  // guard — a permanent latch (adapter_failed/config/auth/model-rejection) must stay dark.
  if (input.errorFamily !== RECOVERABLE_ERROR_FAMILY) {
    return {
      kind: "skip",
      reason: `latch cause ${input.errorFamily ?? "unknown"} is not a recoverable transient (crash-loop guard)`,
    };
  }

  // Never wake before the retry window (condition 4); refuse if the window is unknown.
  if (!input.retryNotBefore) {
    return { kind: "skip", reason: "transient retry window is unknown; refusing to wake early" };
  }
  const priorAttempts = readAgentLatchRecoveryAttempt(input.priorAttempts);

  // Bounded + escalate-once (condition 5): the cap is terminal, so it is checked
  // *before* the backoff window — otherwise the ever-growing backoff would suppress the
  // one escalation notice a human needs, and the latch would go silently dark.
  if (priorAttempts >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: priorAttempts,
      maxAttempts,
      comment: [
        "Bounded agent latch auto-recovery exhausted",
        "",
        `- Agent: \`${agent.id}\` (\`${agent.adapterType}\`)`,
        `- Latching run: \`${input.latchRunId}\``,
        `- Attempts used: ${priorAttempts}/${maxAttempts}`,
        "- Latch cause: `transient_upstream` (session/usage cap that should have cleared by now)",
        "- Next action: a human or manager should inspect the agent — the transient is not clearing on its own; auto-recovery is now stopped to avoid an infinite re-wake loop.",
      ].join("\n"),
    };
  }

  // Never wake before the retry window + exponential backoff for re-attempts (condition 4/5).
  const backoffMs = computeAgentLatchRecoveryBackoffMinutes(backoffBaseMinutes, priorAttempts) * 60_000;
  const effectiveNotBefore = input.retryNotBefore.getTime() + backoffMs;
  if (input.now.getTime() < effectiveNotBefore) {
    return { kind: "skip", reason: "transient retry window (with backoff) has not elapsed" };
  }

  const nextAttempt = priorAttempts + 1;
  const idempotencyKey = buildAgentLatchRecoveryIdempotencyKey({
    agentId: agent.id,
    latchRunId: input.latchRunId,
    nextAttempt,
  });
  if (input.idempotentWakeExists) {
    return { kind: "skip", reason: "an agent latch recovery wake already exists for this attempt" };
  }

  const payload = withRecoveryModelProfileHint(
    {
      agentId: agent.id,
      sourceRunId: input.latchRunId,
      latchErrorFamily: RECOVERABLE_ERROR_FAMILY,
      recoveryAttempt: nextAttempt,
      maxRecoveryAttempts: maxAttempts,
      instruction:
        "Your previous run latched in error on a transient upstream limit that has since cleared. Resume your assigned work; if you are still rate/session limited, end cleanly and the bounded recovery will retry after backoff.",
    },
    "normal_model",
  );

  return {
    kind: "enqueue",
    nextAttempt,
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryModelProfileHint(
      {
        agentId: agent.id,
        wakeReason: AGENT_LATCH_RECOVERY_REASON,
        agentLatchRecoveryAttempt: nextAttempt,
        agentLatchRecoveryMaxAttempts: maxAttempts,
        agentLatchRecoverySourceRunId: input.latchRunId,
        agentLatchRecoveryErrorFamily: RECOVERABLE_ERROR_FAMILY,
      },
      "normal_model",
    ),
  };
}
