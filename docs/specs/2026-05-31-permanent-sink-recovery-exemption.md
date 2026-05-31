# Permanent-sink recovery exemption (DEE-631)

## Problem

`source_scoped_recovery_action` (the stranded / missing-disposition recovery
sweep in `reconcileStrandedAssignedIssues`) re-blocks a permanent `in_progress`
audit-sink issue on **every** handoff/heartbeat cycle:

1. The sink is flipped `in_progress -> blocked`, an active
   `source_scoped_recovery_action` row is created, and its owner is woken.
2. The owner restores the sink to `in_progress`.
3. Next cycle, the platform re-blocks it.

This is the recurrence of [DEE-569](https://github.com/MareAnalytica/paperclip).
DEE-569 fixed the **restore side** (`POST /recovery-actions/resolve` no longer
re-opens a terminal/audit-sink source) and shipped two narrow exemptions in the
stranded sweep:

- `isAuditSinkIssue` — keyed on the reserved `audit-sink` **label** (durable).
- `isChiefExecutiveOfficerSweepLogIssue` — keyed on a title that ends with
  `-CEO-SWEEP-LOG` (per-instance heuristic).

The recurrence is the **gap between those two**: a permanent sink that has not
(yet) been tagged with the `audit-sink` label and whose title does not match the
narrow `-CEO-SWEEP-LOG` suffix — e.g. an analogous **Eli-board** sweep-log sink —
falls through both guards and is re-blocked indefinitely. The fix must be a
durable, general rule, not another per-instance title literal.

## Fix

A single durable predicate, `isPermanentSinkIssue`, now decides sink-ness for
every `source_scoped_recovery_action` path. An issue is a permanent sink when it
**either**:

- carries the reserved `audit-sink` label (`isAuditSinkIssue` — authoritative,
  queryable mechanism), **or**
- matches the reserved sweep-log **title shape** (`matchesPermanentSinkTitle`):
  the title ends with `-SWEEP-LOG` (generalized from `-CEO-SWEEP-LOG` so all
  board sinks are covered), or still contains a `SWEEP-LOG` token while the
  description self-describes as an `audit sink`.

The label remains the authoritative mechanism; the title shape is a
belt-and-suspenders fallback for sinks created before the label was applied.

### Where it is enforced (defense in depth)

1. **`reconcileStrandedAssignedIssues`** — the two former checks
   (`isAuditSinkIssue` + `isChiefExecutiveOfficerSweepLogIssue`) are replaced by
   one `isPermanentSinkIssue` guard at the top of the candidate loop, so a sink
   is skipped before any escalation branch can run.
2. **`escalateStrandedAssignedIssue`** — the single chokepoint that flips an
   issue to `blocked`, creates the `source_scoped_recovery_action`, and queues
   the owner wake now short-circuits (`return null`, treated as a skip by every
   caller) if the target is a permanent sink. Even a future caller that reaches
   this chokepoint without the top-of-loop guard can no longer re-block a sink.

## Why this respects the recovery invariants

- **Productive work continues** — the predicate only matches append-only sinks
  (reserved label or reserved title shape); ordinary work issues are unaffected
  and still escalated when their execution path is lost.
- **Only real blockers stop work** — a permanent sink has no forward work by
  design, so suppressing its escalation removes a false blocker, it does not hide
  a real one.
- **No infinite loops** — removing the create-side re-block breaks the
  block→restore→re-block cycle that burned one recovery run per heartbeat.

## Operational follow-up (durable mechanism)

The authoritative fix for any specific sink is the `audit-sink` **label**. The
title-shape fallback guarantees coverage in the meantime, but operators should
apply the `audit-sink` label to existing sinks (the DeepSee CEO sweep log and the
analogous Eli-board sink) so sink-ness is queryable and independent of title
wording. Tagging is a data action on each board and is tracked separately from
this platform change.

## Regression coverage

- `server/src/__tests__/permanent-sink-title-guard.test.ts` — pure, postgres-free
  unit coverage for `matchesPermanentSinkTitle`: pins the `-CEO-SWEEP-LOG` case,
  the generalized board suffixes (`-SWEEP-LOG`, the DEE-631 recurrence), the
  description fallback, and the negative cases for ordinary work.
- `server/src/__tests__/recovery-permanent-sink-exemption.test.ts` — embedded-
  Postgres test proving that an `in_progress` sink identified by the `-SWEEP-LOG`
  title shape alone (no label) with a failed continuation run is skipped (stays
  `in_progress`, no recovery action, no wake), while an ordinary `in_progress`
  issue in the identical failed-continuation state is still escalated to
  `blocked` with an active recovery action.
- `server/src/__tests__/recovery-audit-sink-exemption.test.ts` and
  `recovery-terminal-status-exemption.test.ts` (DEE-569) continue to pass,
  confirming the label and resolve-route behavior are unchanged.
