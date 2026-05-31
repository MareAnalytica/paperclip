-- DEE-586: generalized, idempotent, forward-only repair of malformed
-- issue_thread_interactions.result rows (DEE-441 recurrence class).
--
-- Relationship to 0095_repair_declined_interaction_outcome (DEE-570):
--   0095 repaired ONLY the legacy request_confirmation rows with outcome='declined'
--   (the DEE-441 instance) and explicitly invited a follow-up for "other version-less
--   request_confirmation rows". This migration is that follow-up: a STRICT SUPERSET that
--   normalizes ANY non-pending row whose `result` fails its kind's zod schema (missing
--   version, out-of-enum outcome, missing required fields), across all three kinds.
--   It is a no-op on rows 0095 already repaired and on healthy rows; composition with
--   0095 is order-safe.
--
-- Why this matters: result is jsonb and is zod-parsed on READ by hydrateInteraction()
-- (server/src/services/issue-thread-interactions.ts). The DEE-582 read-guard now degrades
-- such a row to null instead of 400-ing, but a degraded row lingers (unparseableResult);
-- this cleans the data so reads return the real outcome and terminal transitions are sound.
--
-- Validity predicates mirror packages/shared/src/validators/issue.ts:
--   requestConfirmationResultSchema (version literal 1 + outcome in 6-value enum)
--   askUserQuestionsResultSchema    (version literal 1 + answers array)
--   suggestTasksResultSchema        (version literal 1)
--
-- Pending rows normally carry result = NULL and self-heal on the terminal-expire overwrite
-- (expirePendingForTerminalIssue). A pending row with a non-null malformed result is corrupt;
-- we reset it to NULL (the valid pending shape) rather than fabricate a resolution.

-- 1) request_confirmation: non-pending, malformed result -> status-aware valid outcome
UPDATE "issue_thread_interactions"
SET "result" = jsonb_build_object(
      'version', 1,
      'outcome', CASE "status"
        WHEN 'accepted'  THEN 'accepted'
        WHEN 'rejected'  THEN 'rejected'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'expired'   THEN 'issue_terminal_status'
        ELSE 'cancelled'          -- answered/failed/other -> safe terminal
      END,
      'reason', 'Backfilled by DEE-586 generalized interaction-result repair (original result failed requestConfirmationResultSchema).'
    ),
    "updated_at" = now()
WHERE "kind" = 'request_confirmation'
  AND "status" <> 'pending'
  AND "result" IS NOT NULL
  -- IS NOT TRUE (not NOT (...)) so rows missing version/outcome — where the predicate is
  -- NULL under SQL three-valued logic, e.g. the ELI-795 {"reason":...} shape — are still swept.
  AND (
    ("result" ->> 'version') = '1'
    AND "result" ->> 'outcome' IN
      ('accepted','rejected','cancelled','superseded_by_comment','stale_target','issue_terminal_status')
  ) IS NOT TRUE;

-- 2) ask_user_questions: non-pending, malformed result -> cancelled-shape valid result
UPDATE "issue_thread_interactions"
SET "result" = jsonb_build_object(
      'version', 1,
      'answers', '[]'::jsonb,
      'cancelled', true,
      'cancellationReason', 'Backfilled by DEE-586 generalized interaction-result repair (original result failed askUserQuestionsResultSchema).',
      'summaryMarkdown', NULL
    ),
    "updated_at" = now()
WHERE "kind" = 'ask_user_questions'
  AND "status" <> 'pending'
  AND "result" IS NOT NULL
  AND (
    ("result" ->> 'version') = '1'
    AND jsonb_typeof("result" -> 'answers') = 'array'
  ) IS NOT TRUE;

-- 3) suggest_tasks: non-pending, malformed result -> empty valid result
UPDATE "issue_thread_interactions"
SET "result" = jsonb_build_object(
      'version', 1,
      'createdTasks', '[]'::jsonb,
      'skippedClientKeys', '[]'::jsonb,
      'rejectionReason', 'Backfilled by DEE-586 generalized interaction-result repair (original result failed suggestTasksResultSchema).'
    ),
    "updated_at" = now()
WHERE "kind" = 'suggest_tasks'
  AND "status" <> 'pending'
  AND "result" IS NOT NULL
  AND (
    ("result" ->> 'version') = '1'
  ) IS NOT TRUE;

-- 4) pending rows with a non-null malformed result -> reset to the valid pending shape (NULL)
UPDATE "issue_thread_interactions"
SET "result" = NULL,
    "updated_at" = now()
WHERE "status" = 'pending'
  AND "result" IS NOT NULL
  AND (
    ("kind" = 'request_confirmation'
       AND ("result" ->> 'version') = '1'
       AND "result" ->> 'outcome' IN
         ('accepted','rejected','cancelled','superseded_by_comment','stale_target','issue_terminal_status'))
    OR ("kind" = 'ask_user_questions'
       AND ("result" ->> 'version') = '1'
       AND jsonb_typeof("result" -> 'answers') = 'array')
    OR ("kind" = 'suggest_tasks'
       AND ("result" ->> 'version') = '1')
  ) IS NOT TRUE;
