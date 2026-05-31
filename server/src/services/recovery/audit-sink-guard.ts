import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLabels, labels } from "@paperclipai/db";
import { AUDIT_SINK_LABEL_NAME } from "@paperclipai/shared";

/**
 * Returns true when the given issue carries the reserved `audit-sink` label
 * for its company. Audit-sink issues are append-only logs (e.g. the CEO
 * sweep log) — every recovery code path must consult this helper and
 * short-circuit so the platform never wakes the assignee or restores the
 * issue status as a recovery side effect.
 *
 * The predicate joins `issue_labels` -> `labels` on the reserved name; no
 * identifier-substring fallback. The reserved label name is exported from
 * `@paperclipai/shared` so blueprints and future callers stay in sync.
 *
 * See `docs/specs/2026-05-26-audit-sink-recovery-exemption.md`.
 */
export async function isAuditSinkIssue(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: issueLabels.issueId })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(
      and(
        eq(issueLabels.companyId, companyId),
        eq(issueLabels.issueId, issueId),
        eq(labels.companyId, companyId),
        eq(labels.name, AUDIT_SINK_LABEL_NAME),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Reserved title suffix for permanent audit-sink / sweep-log issues. Any issue
 * whose (trimmed, upper-cased) title ends with this suffix is treated as a
 * permanent sink even if it has not (yet) been tagged with the reserved
 * `audit-sink` label. This generalizes the original `-CEO-SWEEP-LOG`-only
 * heuristic so analogous board sinks (e.g. an Eli-board sweep log) are covered
 * by the same durable rule rather than a per-instance patch.
 *
 * The label remains the authoritative, queryable mechanism; this suffix is a
 * belt-and-suspenders fallback for sinks created before the label was applied.
 */
export const PERMANENT_SINK_TITLE_SUFFIX = "-SWEEP-LOG";

/**
 * Pure, synchronous predicate: does this title/description pair identify a
 * permanent sink by its reserved title shape? Exported for direct unit testing
 * and for callers that already hold the issue row and want to avoid a DB round
 * trip when the title alone is conclusive.
 *
 * Matches when either:
 *  - the title ends with the reserved `-SWEEP-LOG` suffix, or
 *  - the title still contains a `SWEEP-LOG` token AND the description self-
 *    describes as an audit sink (softer fallback for sinks whose title carries
 *    trailing context after the token).
 */
export function matchesPermanentSinkTitle(
  title: string | null | undefined,
  description: string | null | undefined,
): boolean {
  const normalizedTitle = (title ?? "").trim().toUpperCase();
  if (normalizedTitle.length === 0) return false;
  if (normalizedTitle.endsWith(PERMANENT_SINK_TITLE_SUFFIX)) return true;
  const normalizedDescription = (description ?? "").toLowerCase();
  return normalizedTitle.includes("SWEEP-LOG") && normalizedDescription.includes("audit sink");
}

/**
 * Durable permanent-sink predicate that every recovery code path which could
 * re-block, re-open, or re-wake an issue must consult. An issue is a permanent
 * sink when it either carries the reserved `audit-sink` label OR matches the
 * reserved sweep-log title shape (see {@link matchesPermanentSinkTitle}).
 *
 * Permanent sinks are append-only logs with no forward work by design; the
 * `source_scoped_recovery_action` stranded-recovery sweep must never flip them
 * `in_progress -> blocked` or queue an owner wake for them.
 *
 * The title check is evaluated first (cheap, no I/O) and short-circuits before
 * the label lookup. See
 * `docs/specs/2026-05-31-permanent-sink-recovery-exemption.md`.
 */
export async function isPermanentSinkIssue(
  db: Db,
  companyId: string,
  issue: { id: string; title: string | null; description: string | null },
): Promise<boolean> {
  if (matchesPermanentSinkTitle(issue.title, issue.description)) return true;
  return isAuditSinkIssue(db, companyId, issue.id);
}
