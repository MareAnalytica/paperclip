import { describe, expect, it } from "vitest";
import {
  PERMANENT_SINK_TITLE_SUFFIX,
  matchesPermanentSinkTitle,
} from "../services/recovery/audit-sink-guard.js";

// Pure, postgres-free coverage for the generalized permanent-sink title shape.
// DEE-631: the original heuristic only matched `-CEO-SWEEP-LOG`, so analogous
// board sinks (e.g. an Eli-board sweep log) fell through and were re-blocked on
// every recovery cycle. These cases pin the generalized `-SWEEP-LOG` suffix and
// the softer description fallback.
describe("matchesPermanentSinkTitle", () => {
  it("matches the original CEO sweep-log suffix", () => {
    expect(matchesPermanentSinkTitle("DEE-CEO-SWEEP-LOG", null)).toBe(true);
  });

  it("matches analogous board sweep-log suffixes (the DEE-631 recurrence)", () => {
    expect(matchesPermanentSinkTitle("ELI-BOARD-SWEEP-LOG", null)).toBe(true);
    expect(matchesPermanentSinkTitle("ELI-CEO-SWEEP-LOG", null)).toBe(true);
    expect(matchesPermanentSinkTitle("DEE-SWEEP-LOG", "")).toBe(true);
  });

  it("is case- and whitespace-insensitive on the title", () => {
    expect(matchesPermanentSinkTitle("  dee-ceo-sweep-log  ", null)).toBe(true);
  });

  it("matches the softer token+description fallback when the suffix carries trailing context", () => {
    expect(
      matchesPermanentSinkTitle(
        "DEE-SWEEP-LOG (heartbeat audit sink)",
        "This is the heartbeat audit sink for CEO sweeps.",
      ),
    ).toBe(true);
  });

  it("does not match ordinary work issues", () => {
    expect(matchesPermanentSinkTitle("Platform: fix recovery loop", null)).toBe(false);
    expect(matchesPermanentSinkTitle("Sweep the logs directory", "clean up old logs")).toBe(false);
    // Token present but description does not self-describe as an audit sink.
    expect(matchesPermanentSinkTitle("DEE-SWEEP-LOG-ROTATION plan", "rotate the sweep logs")).toBe(false);
  });

  it("treats empty / nullish titles as non-sink", () => {
    expect(matchesPermanentSinkTitle(null, "audit sink")).toBe(false);
    expect(matchesPermanentSinkTitle("", "audit sink")).toBe(false);
    expect(matchesPermanentSinkTitle("   ", null)).toBe(false);
  });

  it("exports the reserved suffix used by the predicate", () => {
    expect(PERMANENT_SINK_TITLE_SUFFIX).toBe("-SWEEP-LOG");
  });
});
