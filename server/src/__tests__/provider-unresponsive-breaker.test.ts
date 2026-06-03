import { describe, expect, it } from "vitest";

import {
  buildProviderHealthAuditEvent,
  decideUnresponsiveRecovery,
} from "../services/provider-unresponsive-breaker.ts";

// Contract C (ELI-952): the cross-run repeated-hang circuit breaker. The bound
// mirrors the blueprint `recovery.maxUnresponsiveRetriesPerProvider` default.
const BOUND = 2;

describe("decideUnresponsiveRecovery", () => {
  // Invariant 1 — a healthy alternative always wins, at any attempt count.
  it("fails over to a healthy alternative on the first hang", () => {
    expect(
      decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt: 1,
        healthyAlternative: "claude-code-personal",
        maxUnresponsiveRetriesPerProvider: BOUND,
      }),
    ).toEqual({ actionTaken: "failover", targetProvider: "claude-code-personal", attempt: 1 });
  });

  it("fails over to a healthy alternative even past the bound (never re-routes to the hung pair)", () => {
    // attempt = N+1 with a healthy alternative present ⇒ skip the provider.
    expect(
      decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt: BOUND + 1,
        healthyAlternative: "codex-local",
        maxUnresponsiveRetriesPerProvider: BOUND,
      }),
    ).toEqual({ actionTaken: "failover", targetProvider: "codex-local", attempt: BOUND + 1 });
  });

  // Invariant 2 — no alternative, within the bound ⇒ bounded retry-same.
  it("retries the same pair while within the bound when no alternative exists", () => {
    for (let attempt = 1; attempt <= BOUND; attempt++) {
      expect(
        decideUnresponsiveRecovery({
          provider: "grok-local",
          attempt,
          healthyAlternative: null,
          maxUnresponsiveRetriesPerProvider: BOUND,
        }),
      ).toEqual({ actionTaken: "retry_same", targetProvider: "grok-local", attempt });
    }
  });

  // Invariant 3 / ELI-952 acceptance — the N+1th identical hang opens recovery
  // (escalate) instead of re-routing to the same hung pair.
  it("escalates the N+1th identical hang when no alternative exists", () => {
    expect(
      decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt: BOUND + 1,
        healthyAlternative: null,
        maxUnresponsiveRetriesPerProvider: BOUND,
      }),
    ).toEqual({ actionTaken: "escalate", targetProvider: "grok-local", attempt: BOUND + 1 });
  });

  it("never returns retry_same once the bound is reached (no infinite loop)", () => {
    for (let attempt = BOUND + 1; attempt <= BOUND + 5; attempt++) {
      const decision = decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt,
        healthyAlternative: null,
        maxUnresponsiveRetriesPerProvider: BOUND,
      });
      expect(decision.actionTaken).toBe("escalate");
    }
  });

  // Invariant 4 — bound disabled ⇒ breaker off, unbounded retry-same.
  it("retries unbounded when the bound is disabled (0)", () => {
    expect(
      decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt: 99,
        healthyAlternative: null,
        maxUnresponsiveRetriesPerProvider: 0,
      }),
    ).toEqual({ actionTaken: "retry_same", targetProvider: "grok-local", attempt: 99 });
  });

  it("treats a non-finite or non-positive attempt as the first hang", () => {
    for (const attempt of [0, -3, Number.NaN]) {
      expect(
        decideUnresponsiveRecovery({
          provider: "grok-local",
          attempt,
          healthyAlternative: null,
          maxUnresponsiveRetriesPerProvider: BOUND,
        }),
      ).toEqual({ actionTaken: "retry_same", targetProvider: "grok-local", attempt: 1 });
    }
  });

  it("ignores a blank healthy-alternative string", () => {
    expect(
      decideUnresponsiveRecovery({
        provider: "grok-local",
        attempt: 1,
        healthyAlternative: "   ",
        maxUnresponsiveRetriesPerProvider: BOUND,
      }).actionTaken,
    ).toBe("retry_same");
  });
});

describe("buildProviderHealthAuditEvent", () => {
  it("emits the spec §4 shape with a known timeout", () => {
    expect(
      buildProviderHealthAuditEvent({
        provider: "grok-local",
        account: "grok-local-default",
        model: "grok-code",
        attempt: BOUND + 1,
        actionTaken: "escalate",
        issueId: "ELI-943",
        timeoutMs: 90000,
      }),
    ).toEqual({
      event: "provider_health_decision",
      provider: "grok-local",
      account: "grok-local-default",
      model: "grok-code",
      reason: "provider_unresponsive",
      attempt: BOUND + 1,
      actionTaken: "escalate",
      issueId: "ELI-943",
      timeoutMs: 90000,
    });
  });

  it("omits timeoutMs and null-fills routing identities when unknown (never leaks credentials)", () => {
    const event = buildProviderHealthAuditEvent({
      provider: "grok-local",
      attempt: 1,
      actionTaken: "failover",
    });
    expect(event).toEqual({
      event: "provider_health_decision",
      provider: "grok-local",
      account: null,
      model: null,
      reason: "provider_unresponsive",
      attempt: 1,
      actionTaken: "failover",
      issueId: null,
    });
    expect(event).not.toHaveProperty("timeoutMs");
  });
});
