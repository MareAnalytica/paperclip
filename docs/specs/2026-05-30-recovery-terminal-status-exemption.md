# Recovery terminal-status exemption (DEE-569)

## Problem

`source_scoped_recovery_action` (the missing-disposition recovery path) could
tight-loop an issue between `blocked` and `in_progress` roughly every ~30s,
consuming one CEO recovery run per cycle.

The observed incident (DEE-567, a `*-CEO-SWEEP-LOG` audit sink) was stopped by
the audit-sink label/title exemption shipped in ELI-344. But that exemption is
keyed on the reserved `audit-sink` label. It does not cover the more general
failure mode: an issue that has already reached a **terminal** disposition
(`done` / `cancelled`) can still be flipped back into an active state by a
recovery-action resolution that blindly applies `sourceIssueStatus`. Once
re-opened, the issue re-enters the missing-disposition recovery loop.

## Fix

A terminal status is itself a valid disposition. The recovery-action resolve
route (`POST /issues/:id/recovery-actions/resolve`) now treats a terminal source
issue the same way it treats an audit-sink target:

- The source-issue **status restore is suppressed** (`effectiveSourceIssueStatus`
  becomes `null`) when the issue is already `done`/`cancelled`. The status flip
  is a no-op; the closed issue stays closed.
- The **owner wake** that follows a `todo` restore is therefore not queued (it is
  gated on `effectiveSourceIssueStatus === "todo"`).
- The recovery action is still **resolved** with the requested outcome, so the
  active row is cleared instead of lingering.
- The resolution note records `suppressed: terminal issue status (<status>)` and
  the activity log records `suppressionReason: "terminal_status_target"`.

Audit-sink suppression takes precedence when both apply, preserving the existing
`audit_sink_target` marker and behavior.

### Concurrency

The terminal decision is **re-evaluated under a row lock inside the resolve
transaction**, not from the pre-transaction `getById()` snapshot. The route
issues `SELECT ... FOR UPDATE` on the issue row and re-reads its status before
deciding whether to apply `sourceIssueStatus`. This serializes against a
concurrent close (the exact scenario DEE-569 cares about: an operator marking the
issue `done` to stop the loop) so a close that commits after the snapshot can no
longer be undone by an in-flight recovery resolution.

`isTerminalIssueStatus` / `TERMINAL_ISSUE_STATUSES` are exported from
`@paperclipai/shared` so the route, the recovery service, and future callers
share one definition instead of duplicating the `done`/`cancelled` literal set.

## Why this is safe

The stranded-assignee reconcile (`reconcileStrandedAssignedIssues`) only selects
`todo`/`in_progress` issues, so a terminal issue is never escalated to `blocked`
in the first place. This change closes the complementary half of the loop: even
if an active recovery action lands on an issue that has since reached a terminal
state, resolving it can no longer re-open the issue.

## Regression coverage

`server/src/__tests__/recovery-terminal-status-exemption.test.ts` asserts that
resolving a recovery action against a `done` issue keeps it `done`, queues no
wake, records the `terminal_status_target` suppression marker, and still resolves
the recovery action — while a non-terminal control issue is restored and woken
as before.
