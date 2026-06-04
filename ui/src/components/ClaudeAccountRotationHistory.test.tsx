import { describe, expect, it } from "vitest";
import { readClaudeAccountAttempts } from "./ClaudeAccountRotationHistory";

describe("readClaudeAccountAttempts", () => {
  it("returns null when resultJson is null/undefined or has no attempts", () => {
    expect(readClaudeAccountAttempts(null)).toBeNull();
    expect(readClaudeAccountAttempts(undefined)).toBeNull();
    expect(readClaudeAccountAttempts({})).toBeNull();
    expect(readClaudeAccountAttempts({ claudeAccountAttempts: [] })).toBeNull();
    expect(readClaudeAccountAttempts({ summary: "ok" })).toBeNull();
  });

  it("parses a well-formed rotation-then-success trail", () => {
    const rows = readClaudeAccountAttempts({
      claudeAccountAttempts: [
        { attemptIndex: 0, label: "primary", outcome: "auth_required", errorMessage: "Not logged in", advancedTo: "secondary" },
        { attemptIndex: 1, label: "secondary", outcome: "success", advancedTo: null },
      ],
    });
    expect(rows).toEqual([
      { attemptIndex: 0, label: "primary", outcome: "auth_required", errorMessage: "Not logged in", advancedTo: "secondary" },
      { attemptIndex: 1, label: "secondary", outcome: "success", errorMessage: undefined, advancedTo: null },
    ]);
  });

  it("tolerates extra adapter fields and ignores malformed rows", () => {
    const rows = readClaudeAccountAttempts({
      claudeAccountAttempts: [
        { attemptIndex: 0, label: "primary", outcome: "success", advancedTo: null, configDir: "/x", startedAt: "t" },
        { outcome: "success" }, // no label -> dropped
        null,
        "garbage",
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.label).toBe("primary");
  });

  it("coerces unknown outcomes to skipped and backfills attemptIndex", () => {
    const rows = readClaudeAccountAttempts({
      claudeAccountAttempts: [{ label: "primary", outcome: "weird" }],
    });
    expect(rows?.[0]).toMatchObject({ attemptIndex: 0, outcome: "skipped", advancedTo: null });
  });
});
