import { describe, expect, it } from "vitest";
import {
  AGENT_LATCH_RECOVERY_REASON,
  DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS,
  buildAgentLatchRecoveryIdempotencyKey,
  computeAgentLatchRecoveryBackoffMinutes,
  decideAgentLatchRecovery,
} from "./agent-latch-recovery.js";

const claudeLocalAgent = {
  id: "agent-1",
  companyId: "company-1",
  status: "error",
  adapterType: "claude_local",
} as any;

// A retry window that has comfortably elapsed relative to `now`.
const now = new Date("2026-06-01T10:00:00.000Z");
const retryElapsed = new Date("2026-06-01T09:00:00.000Z");
const retryFuture = new Date("2026-06-01T11:00:00.000Z");

function base(overrides: Record<string, unknown> = {}) {
  return {
    agent: claudeLocalAgent,
    latchRunId: "run-latch-1",
    errorFamily: "transient_upstream",
    retryNotBefore: retryElapsed,
    now,
    priorAttempts: 0,
    idempotentWakeExists: false,
    enabled: true,
    ...overrides,
  };
}

describe("decideAgentLatchRecovery", () => {
  it("enqueues a system re-wake when a claude_local agent is latched on a cleared transient", () => {
    const decision = decideAgentLatchRecovery(base());
    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildAgentLatchRecoveryIdempotencyKey({ agentId: "agent-1", latchRunId: "run-latch-1", nextAttempt: 1 }),
    );
    expect(decision.idempotencyKey.startsWith(`${AGENT_LATCH_RECOVERY_REASON}:`)).toBe(true);
  });

  it("ships dark: skips when the feature flag is disabled", () => {
    const decision = decideAgentLatchRecovery(base({ enabled: false }));
    expect(decision).toEqual({ kind: "skip", reason: "agent latch recovery is disabled by policy" });
  });

  it("is Phase-1 claude_local-scoped: skips other sessioned local adapters", () => {
    const decision = decideAgentLatchRecovery(base({ agent: { ...claudeLocalAgent, adapterType: "codex_local" } }));
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toContain("out of Phase-1 scope");
  });

  it("crash-loop guard: never wakes a non-transient (permanent) latch", () => {
    for (const family of ["adapter_failed", "config_error", "auth_permanent", "model_rejection", null]) {
      const decision = decideAgentLatchRecovery(base({ errorFamily: family }));
      expect(decision.kind).toBe("skip");
      if (decision.kind === "skip") expect(decision.reason).toContain("crash-loop guard");
    }
  });

  it("never wakes before the retry window has elapsed", () => {
    const decision = decideAgentLatchRecovery(base({ retryNotBefore: retryFuture }));
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toContain("has not elapsed");
  });

  it("refuses to wake when the retry window is unknown", () => {
    const decision = decideAgentLatchRecovery(base({ retryNotBefore: null }));
    expect(decision).toEqual({ kind: "skip", reason: "transient retry window is unknown; refusing to wake early" });
  });

  it("applies exponential backoff between re-attempts", () => {
    expect(computeAgentLatchRecoveryBackoffMinutes(60, 0)).toBe(0);
    expect(computeAgentLatchRecoveryBackoffMinutes(60, 1)).toBe(60);
    expect(computeAgentLatchRecoveryBackoffMinutes(60, 2)).toBe(120);
    expect(computeAgentLatchRecoveryBackoffMinutes(60, 3)).toBe(240);
    // attempt 1 already used: window+60m backoff not yet elapsed -> skip
    const tooSoon = decideAgentLatchRecovery(
      base({ priorAttempts: 1, retryNotBefore: new Date("2026-06-01T09:30:00.000Z"), backoffBaseMinutes: 60 }),
    );
    expect(tooSoon.kind).toBe("skip");
    if (tooSoon.kind === "skip") expect(tooSoon.reason).toContain("backoff");
  });

  it("is bounded: escalates once when the attempt cap is exhausted, then stops", () => {
    const decision = decideAgentLatchRecovery(base({ priorAttempts: DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS }));
    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.attempt).toBe(DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS);
    expect(decision.maxAttempts).toBe(DEFAULT_MAX_AGENT_LATCH_RECOVERY_ATTEMPTS);
    expect(decision.comment).toContain("exhausted");
  });

  it("is idempotent: skips when a wake already exists for the attempt", () => {
    const decision = decideAgentLatchRecovery(base({ idempotentWakeExists: true }));
    expect(decision).toEqual({ kind: "skip", reason: "an agent latch recovery wake already exists for this attempt" });
  });

  it("reuses pause/terminated suppressors verbatim", () => {
    for (const status of ["paused", "terminated"]) {
      const decision = decideAgentLatchRecovery(base({ agent: { ...claudeLocalAgent, status } }));
      expect(decision.kind).toBe("skip");
      if (decision.kind === "skip") expect(decision.reason).toContain("suppresses automatic recovery");
    }
    const held = decideAgentLatchRecovery(base({ pauseHoldSuppressed: true }));
    expect(held).toEqual({ kind: "skip", reason: "automatic recovery suppressed by pause hold" });
  });

  it("skips agents that are not actually error-latched", () => {
    for (const status of ["idle", "running", "active"]) {
      const decision = decideAgentLatchRecovery(base({ agent: { ...claudeLocalAgent, status } }));
      expect(decision.kind).toBe("skip");
      if (decision.kind === "skip") expect(decision.reason).toContain("is not an error latch");
    }
  });
});
