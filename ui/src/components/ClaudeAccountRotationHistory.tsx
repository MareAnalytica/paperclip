import { useState } from "react";
import { ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";

// ELI-243 multi-account failover audit row, persisted to
// `resultJson.claudeAccountAttempts` by the claude_local adapter. Mirrors the
// adapter-side `ClaudeAccountAttempt` shape per spec
// docs/specs/2026-05-24-claude-multi-account-failover.md §3.3. The UI relies
// only on the subset rendered here; extra fields (configDir, timestamps) are
// tolerated and ignored.
export type ClaudeAccountAttemptOutcome =
  | "success"
  | "auth_required"
  | "config_dir_missing"
  | "skipped";

export interface ClaudeAccountAttempt {
  attemptIndex: number;
  label: string;
  outcome: ClaudeAccountAttemptOutcome;
  errorMessage?: string;
  advancedTo: string | null;
}

const KNOWN_OUTCOMES: readonly ClaudeAccountAttemptOutcome[] = [
  "success",
  "auth_required",
  "config_dir_missing",
  "skipped",
];

// `run.resultJson` is typed `Record<string, unknown> | null`, so the attempts
// array may be absent or malformed (older runs, non-claude adapters). This
// reads it defensively and returns null when there is nothing valid to render —
// callers render nothing on null, preserving the existing layout (no regression
// when the array is absent).
export function readClaudeAccountAttempts(
  resultJson: Record<string, unknown> | null | undefined,
): ClaudeAccountAttempt[] | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const raw = (resultJson as Record<string, unknown>).claudeAccountAttempts;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows: ClaudeAccountAttempt[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.label !== "string") continue;
    const outcome = KNOWN_OUTCOMES.includes(e.outcome as ClaudeAccountAttemptOutcome)
      ? (e.outcome as ClaudeAccountAttemptOutcome)
      : "skipped";
    rows.push({
      attemptIndex: typeof e.attemptIndex === "number" ? e.attemptIndex : rows.length,
      label: e.label,
      outcome,
      errorMessage: typeof e.errorMessage === "string" ? e.errorMessage : undefined,
      advancedTo: typeof e.advancedTo === "string" ? e.advancedTo : null,
    });
  }
  return rows.length > 0 ? rows : null;
}

const OUTCOME_LABELS: Record<ClaudeAccountAttemptOutcome, string> = {
  success: "Success",
  auth_required: "Auth required",
  config_dir_missing: "Config dir missing",
  skipped: "Skipped",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const OUTCOME_VARIANTS: Record<ClaudeAccountAttemptOutcome, BadgeVariant> = {
  success: "default",
  auth_required: "destructive",
  config_dir_missing: "destructive",
  skipped: "secondary",
};

// Renders the multi-account rotation audit trail as a compact, collapsible
// per-attempt table. Collapsed by default; expand on click (no design
// dependency on the existing login URL surface). Pass `defaultOpen` to expand
// initially (used by the exhaustion case so the failure detail is visible).
export function ClaudeAccountRotationHistory({
  attempts,
  defaultOpen = false,
}: {
  attempts: ClaudeAccountAttempt[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (attempts.length === 0) return null;

  const finalOutcome = attempts[attempts.length - 1]?.outcome ?? "skipped";

  return (
    <div className="rounded-md border border-border/70 bg-accent/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Claude account rotation</span>
        <span className="text-muted-foreground">
          {attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}
        </span>
        <Badge variant={OUTCOME_VARIANTS[finalOutcome]} className="ml-auto">
          {OUTCOME_LABELS[finalOutcome]}
        </Badge>
      </button>

      {open && (
        <div className="border-t border-border/70 px-3 py-2">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1 pr-3 font-medium">#</th>
                <th className="py-1 pr-3 font-medium">Account</th>
                <th className="py-1 pr-3 font-medium">Outcome</th>
                <th className="py-1 font-medium">Advanced to</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt, index) => (
                <tr
                  key={`${attempt.attemptIndex}-${attempt.label}-${index}`}
                  className="align-top border-t border-border/40"
                >
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-muted-foreground">
                    {attempt.attemptIndex}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="font-mono text-foreground break-all">{attempt.label}</div>
                    {attempt.errorMessage && (
                      <div className="mt-0.5 text-muted-foreground break-words">
                        {attempt.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <Badge variant={OUTCOME_VARIANTS[attempt.outcome]}>
                      {OUTCOME_LABELS[attempt.outcome]}
                    </Badge>
                  </td>
                  <td
                    className={cn(
                      "py-1.5",
                      attempt.advancedTo ? "font-mono text-foreground break-all" : "text-muted-foreground",
                    )}
                  >
                    {attempt.advancedTo ?? "— exhausted"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
