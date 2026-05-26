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
