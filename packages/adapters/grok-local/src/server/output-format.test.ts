import { beforeEach, describe, expect, it, vi } from "vitest";

const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import {
  GROK_OUTPUT_FORMAT_FALLBACK,
  __resetGrokOutputFormatCacheForTests,
  parseGrokOutputFormats,
  resolveGrokOutputFormat,
  selectGrokOutputFormat,
} from "./output-format.js";

// Real-world clap `--help` blocks from the two grok CLI builds that have skewed
// in production (DEE-707 / ELI-918). Eli-safety is a hard requirement: the probe
// MUST select `stream-json` for the build that lacks `streaming-json`.
const GROK_0_2_13_HELP = [
  "Options:",
  "      --cwd <CWD>            Working directory",
  "  -o, --output-format <OUTPUT_FORMAT>",
  "          Output format for results",
  "          [possible values: plain, json, streaming-json]",
  "      --resume <SESSION_ID>  Resume a saved session",
].join("\n");

const ELI_918_HELP = [
  "Options:",
  "  -o, --output-format <OUTPUT_FORMAT>",
  "          Output format for results",
  "          [possible values: text, json, stream-json]",
].join("\n");

function helpResult(stdout: string) {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
}

describe("parseGrokOutputFormats", () => {
  it("extracts the possible values advertised for --output-format (grok 0.2.13)", () => {
    expect(parseGrokOutputFormats(GROK_0_2_13_HELP)).toEqual(["plain", "json", "streaming-json"]);
  });

  it("extracts the possible values advertised for --output-format (ELI-918 build)", () => {
    expect(parseGrokOutputFormats(ELI_918_HELP)).toEqual(["text", "json", "stream-json"]);
  });

  it("handles the inline clap layout", () => {
    const inline = "  -o, --output-format <OUTPUT_FORMAT>  Output format [possible values: plain, json, streaming-json]";
    expect(parseGrokOutputFormats(inline)).toEqual(["plain", "json", "streaming-json"]);
  });

  it("returns [] when --output-format is absent or has no possible-values list", () => {
    expect(parseGrokOutputFormats("Usage: grok [OPTIONS]")).toEqual([]);
    expect(parseGrokOutputFormats("  --output-format <OUTPUT_FORMAT>  Output format")).toEqual([]);
    expect(parseGrokOutputFormats("")).toEqual([]);
  });

  it("does not pick up a possible-values list belonging to an earlier flag", () => {
    const help = [
      "      --permission-mode <MODE>  [possible values: ask, dontAsk]",
      "  -o, --output-format <OUTPUT_FORMAT>  [possible values: plain, json, streaming-json]",
    ].join("\n");
    expect(parseGrokOutputFormats(help)).toEqual(["plain", "json", "streaming-json"]);
  });
});

describe("selectGrokOutputFormat (Eli-safety: both vocabularies)", () => {
  it("prefers streaming-json for grok 0.2.13", () => {
    expect(selectGrokOutputFormat(["plain", "json", "streaming-json"])).toBe("streaming-json");
  });

  it("keeps stream-json for the ELI-918 build (no streaming-json advertised)", () => {
    expect(selectGrokOutputFormat(["text", "json", "stream-json"])).toBe("stream-json");
  });

  it("falls back to json only when neither streaming flavor is offered", () => {
    expect(selectGrokOutputFormat(["plain", "json"])).toBe("json");
  });

  it("falls back to the historical literal when nothing matches or list is empty", () => {
    expect(selectGrokOutputFormat([])).toBe(GROK_OUTPUT_FORMAT_FALLBACK);
    expect(selectGrokOutputFormat(["plain", "yaml"])).toBe(GROK_OUTPUT_FORMAT_FALLBACK);
  });
});

describe("resolveGrokOutputFormat (probe + cache + fallback)", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
    __resetGrokOutputFormatCacheForTests();
  });

  const baseParams = {
    runId: "run-1",
    target: null,
    command: "grok",
    cwd: "/tmp/project",
    env: {},
  };

  it("selects streaming-json against grok 0.2.13", async () => {
    runProcessMock.mockResolvedValue(helpResult(GROK_0_2_13_HELP));
    await expect(resolveGrokOutputFormat({ ...baseParams, cacheKey: "grok@0.2.13" })).resolves.toBe("streaming-json");
    expect(runProcessMock).toHaveBeenCalledWith("run-1", null, "grok", ["--help"], expect.any(Object));
  });

  it("selects stream-json against the ELI-918 build (Eli-safe)", async () => {
    runProcessMock.mockResolvedValue(helpResult(ELI_918_HELP));
    await expect(resolveGrokOutputFormat({ ...baseParams, cacheKey: "grok@eli" })).resolves.toBe("stream-json");
  });

  it("falls back to the historical literal when the probe throws", async () => {
    runProcessMock.mockRejectedValue(new Error("spawn failed"));
    await expect(resolveGrokOutputFormat({ ...baseParams, cacheKey: "grok@broken" })).resolves.toBe(
      GROK_OUTPUT_FORMAT_FALLBACK,
    );
  });

  it("memoizes per binary and does not re-probe", async () => {
    runProcessMock.mockResolvedValue(helpResult(GROK_0_2_13_HELP));
    await resolveGrokOutputFormat({ ...baseParams, cacheKey: "grok@cache" });
    await resolveGrokOutputFormat({ ...baseParams, cacheKey: "grok@cache" });
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });
});
