import { describe, expect, it } from "vitest";
import {
  actionSeverity,
  hardestAction,
  resolveBindingCap,
  type CapEvaluation,
} from "./cap-precedence.js";

function cap(partial: Partial<CapEvaluation> & Pick<CapEvaluation, "capId" | "action">): CapEvaluation {
  return { scope: "company", currentPercent: 100, ...partial };
}

describe("action severity ordering (§2.3 rule 1)", () => {
  it("ranks hard_stop > pause_runs > pause_writes > require_approval > warn", () => {
    expect(actionSeverity("hard_stop")).toBeGreaterThan(actionSeverity("pause_runs"));
    expect(actionSeverity("pause_runs")).toBeGreaterThan(actionSeverity("pause_writes"));
    expect(actionSeverity("pause_writes")).toBeGreaterThan(actionSeverity("require_approval"));
    expect(actionSeverity("require_approval")).toBeGreaterThan(actionSeverity("warn"));
    expect(hardestAction("warn", "pause_runs")).toBe("pause_runs");
    expect(hardestAction("hard_stop", "pause_writes")).toBe("hard_stop");
  });
});

describe("resolveBindingCap", () => {
  it("hardest action wins regardless of percent (rule 1)", () => {
    const r = resolveBindingCap([
      cap({ capId: "a", scope: "agent", action: "warn", currentPercent: 99 }),
      cap({ capId: "b", scope: "company", action: "hard_stop", currentPercent: 40 }),
    ]);
    expect(r.binding?.capId).toBe("b");
    expect(r.action).toBe("hard_stop");
  });

  it("within the same action, highest currentPercent binds (rule 2)", () => {
    const r = resolveBindingCap([
      cap({ capId: "a", scope: "agent", action: "pause_writes", currentPercent: 82 }),
      cap({ capId: "b", scope: "project", action: "pause_writes", currentPercent: 95 }),
    ]);
    expect(r.binding?.capId).toBe("b");
    expect(r.action).toBe("pause_writes");
  });

  it("is deterministic on a full tie (stable by capId)", () => {
    const r = resolveBindingCap([
      cap({ capId: "z", action: "warn", currentPercent: 70 }),
      cap({ capId: "a", action: "warn", currentPercent: 70 }),
    ]);
    expect(r.binding?.capId).toBe("a");
  });

  it("returns every firing approval gate; gates do not cascade (rule 3)", () => {
    const r = resolveBindingCap([
      cap({
        capId: "proj",
        scope: "project",
        action: "require_approval",
        approvalGate: { approverRole: "manager" },
      }),
      cap({
        capId: "agent",
        scope: "agent",
        action: "require_approval",
        approvalGate: { approverRole: "ceo" },
      }),
    ]);
    expect(r.approvalGates).toHaveLength(2);
    expect(r.approvalGates.map((g) => g.capId).sort()).toEqual(["agent", "proj"]);
  });

  it("an approval-relaxed non-cluster cap stops binding and stops firing its gate", () => {
    const r = resolveBindingCap([
      cap({
        capId: "company",
        scope: "company",
        action: "require_approval",
        approvalGate: { approverRole: "ceo" },
        relaxed: true,
      }),
      cap({ capId: "agent", scope: "agent", action: "warn", currentPercent: 65 }),
    ]);
    expect(r.binding?.capId).toBe("agent");
    expect(r.action).toBe("warn");
    expect(r.approvalGates).toHaveLength(0);
  });

  it("the cluster cap is non-overridable even when relaxed (rule 4)", () => {
    const r = resolveBindingCap([
      cap({ capId: "cluster", scope: "cluster", action: "hard_stop", currentPercent: 100, relaxed: true }),
      cap({ capId: "company", scope: "company", action: "warn", currentPercent: 50 }),
    ]);
    // Despite relaxed=true, the cluster hard_stop still floors the action.
    expect(r.clusterFloorAction).toBe("hard_stop");
    expect(r.action).toBe("hard_stop");
  });

  it("the cluster floor lifts the applied action above a softer binding cap", () => {
    const r = resolveBindingCap([
      cap({ capId: "cluster", scope: "cluster", action: "pause_runs", currentPercent: 30 }),
      cap({ capId: "agent", scope: "agent", action: "warn", currentPercent: 99 }),
    ]);
    // agent (warn, 99%) is the most "binding" by percent within the contenders,
    // but the cluster floor (pause_runs) is non-overridable and wins the action.
    expect(r.clusterFloorAction).toBe("pause_runs");
    expect(r.action).toBe("pause_runs");
  });

  it("returns a null resolution when nothing fires", () => {
    const r = resolveBindingCap([]);
    expect(r.binding).toBeNull();
    expect(r.action).toBeNull();
    expect(r.approvalGates).toHaveLength(0);
    expect(r.clusterFloorAction).toBeNull();
  });
});
