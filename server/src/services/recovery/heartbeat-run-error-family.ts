import type { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";

// Single shared source of truth for the heartbeat-run error-family classifier
// (DEE-680 / CEO binding condition 3). Both the per-run finalization path in
// `heartbeat.ts` and the periodic `agent-latch-recovery` sweep in `recovery/service.ts`
// must classify a latch identically — otherwise the auto-recovery crash-loop guard
// could disagree with the path that set the latch. Extracted here (instead of being
// re-derived in the sweep) so there is exactly one definition; `heartbeat.ts` imports
// these rather than keeping a private copy.

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readHeartbeatRunErrorFamily(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const persistedFamily = readNonEmptyString(resultJson.errorFamily);
  if (persistedFamily) return persistedFamily;

  if (run.errorCode === "codex_transient_upstream" || run.errorCode === "claude_transient_upstream") {
    return "transient_upstream";
  }
  return null;
}

export function readTransientRetryNotBeforeFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const value = resultJson.retryNotBefore ?? resultJson.transientRetryNotBefore;
  if (!(typeof value === "string" || typeof value === "number" || value instanceof Date)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readTransientRecoveryContractFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  return readHeartbeatRunErrorFamily(run) === "transient_upstream"
    ? {
        errorFamily: "transient_upstream" as const,
        retryNotBefore: readTransientRetryNotBeforeFromRun(run),
      }
    : null;
}
