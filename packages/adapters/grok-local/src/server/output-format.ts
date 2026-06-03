import {
  type AdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";

/**
 * Grok's streaming-JSONL output mode is selected via `--output-format`, but the
 * accepted *value* has skewed across grok CLI builds: some advertise
 * `stream-json`, others `streaming-json`. Hardcoding either value breaks the
 * other build and silently kills continuation/fallback runs (DEE-707).
 *
 * We probe `grok --help` once per binary and pick the value the installed CLI
 * actually accepts, preferring the streaming JSONL formats (which the adapter's
 * JSONL parser understands) over non-streaming `json`. On any probe failure we
 * fall back to the historical literal so behavior never regresses.
 */
export const GROK_OUTPUT_FORMAT_FALLBACK = "stream-json";

// Highest-priority first. The streaming JSONL formats are the same wire format
// under different flag names across grok versions; `json` is the non-streaming
// last resort.
const GROK_OUTPUT_FORMAT_PREFERENCE = ["streaming-json", "stream-json", "json"] as const;

/**
 * Extract the `[possible values: ...]` advertised for `--output-format` from
 * `grok --help` output. Returns [] when the flag or its possible-values list is
 * not found (unexpected/older/newer help layouts).
 */
export function parseGrokOutputFormats(helpText: string): string[] {
  if (!helpText) return [];
  const flagIndex = helpText.indexOf("--output-format");
  if (flagIndex === -1) return [];
  const afterFlag = helpText.slice(flagIndex);
  const match = afterFlag.match(/\[possible values:\s*([^\]]+)\]/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Pick the best `--output-format` value the installed grok CLI accepts. Falls
 * back to {@link GROK_OUTPUT_FORMAT_FALLBACK} when none of the preferred values
 * are advertised (or the list is empty).
 */
export function selectGrokOutputFormat(availableValues: string[]): string {
  for (const candidate of GROK_OUTPUT_FORMAT_PREFERENCE) {
    if (availableValues.includes(candidate)) return candidate;
  }
  return GROK_OUTPUT_FORMAT_FALLBACK;
}

export interface ResolveGrokOutputFormatParams {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  command: string;
  /** Stable identity for the resolved binary; used as the cache key. */
  cacheKey: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec?: number;
}

const resolvedOutputFormatCache = new Map<string, string>();

/**
 * Resolve (and memoize per binary) the `--output-format` value to pass to grok.
 * Runs `grok --help` via the same execution target as the real run so it works
 * for local and remote targets alike. Any failure resolves to the safe fallback.
 */
export async function resolveGrokOutputFormat(params: ResolveGrokOutputFormatParams): Promise<string> {
  const cached = resolvedOutputFormatCache.get(params.cacheKey);
  if (cached) return cached;

  const env: Record<string, string> = Object.fromEntries(
    Object.entries(params.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  let selected = GROK_OUTPUT_FORMAT_FALLBACK;
  try {
    const probe = await runAdapterExecutionTargetProcess(
      params.runId,
      params.target,
      params.command,
      ["--help"],
      {
        cwd: params.cwd,
        env,
        timeoutSec: Math.max(1, params.timeoutSec ?? 20),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const available = parseGrokOutputFormats(`${probe.stdout}\n${probe.stderr}`);
    if (available.length > 0) {
      selected = selectGrokOutputFormat(available);
    }
  } catch {
    selected = GROK_OUTPUT_FORMAT_FALLBACK;
  }

  resolvedOutputFormatCache.set(params.cacheKey, selected);
  return selected;
}

/** Test-only: clear the per-binary resolution cache between cases. */
export function __resetGrokOutputFormatCacheForTests(): void {
  resolvedOutputFormatCache.clear();
}
