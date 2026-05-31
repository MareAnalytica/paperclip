-- DEE-570: Repair operator-corrupted interaction outcomes that predate the enum constraint.
--
-- Symptom: a stored issue_thread_interactions.result has outcome="declined", which is NOT in the
-- platform enum {accepted|rejected|cancelled|superseded_by_comment|stale_target|issue_terminal_status}
-- (packages/shared/src/validators/issue.ts requestConfirmationResultSchema) and is missing version:1.
-- result is jsonb and is zod-parsed on READ by hydrateInteraction()
-- (server/src/services/issue-thread-interactions.ts), so this one bad row makes
-- GET /api/issues/{id}/interactions and any PATCH that auto-resolves pending interactions return 400,
-- blocking DEE-441 (PR #17 already merged at c3a545da) from transitioning to `done`.
--
-- Fix semantics: "declined" most closely matches a superseded confirmation -> superseded_by_comment.
--
-- IDEMPOTENT / FORWARD-ONLY: matched by the corrupt predicate, not by id. After it runs no row has
-- result->>'outcome' = 'declined', so re-runs match nothing and are no-ops. The single jsonb_set chain
-- also backfills version:1. COALESCE guards a NULL result.
--
-- Scoped intentionally to outcome='declined' rows only (minimal blast radius on the control plane);
-- raise a separate finding if other version-less request_confirmation rows are observed to 400.
UPDATE "issue_thread_interactions"
SET "result" = jsonb_set(
                 jsonb_set(COALESCE("result", '{}'::jsonb), '{outcome}', '"superseded_by_comment"'::jsonb, true),
                 '{version}', '1'::jsonb, true
               )
WHERE "result" ->> 'outcome' = 'declined';
