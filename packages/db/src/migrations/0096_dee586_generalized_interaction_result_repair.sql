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
-- DATA-PRESERVING: each repair merges (||) onto the existing result — it backfills version:1
-- and ONLY rewrites the specific field that is invalid (outcome / answers / createdTasks /
-- skippedClientKeys). A row whose sole fault is a missing version keeps all its real data.
--
-- Validity predicates mirror packages/shared/src/validators/issue.ts:
--   requestConfirmationResultSchema (version literal 1 + outcome in 6-value enum)
--   askUserQuestionsResultSchema    (version literal 1 + answers array)
--   suggestTasksResultSchema        (version literal 1)
--
-- Scope boundary (deliberate, narrow blast radius on the control plane): the predicates
-- check the schema's REQUIRED + structural (type-level) shape — version literal, the
-- request_confirmation outcome enum, and array-typedness of answers/createdTasks/skippedClientKeys.
-- They do NOT mirror element-level/nested zod rules (e.g. a createdTasks entry missing a valid
-- issueId uuid, a non-uuid commentId), which are not safely expressible in SQL and risk
-- FALSE-POSITIVE repair (destroying real data) far more than the false-negative they'd prevent.
-- Such a version-present-but-nested-invalid row has never been observed; if one ever is, it is
-- already safe (the DEE-582 read-guard degrades it instead of 400-ing) and is a fresh finding,
-- not a brick. This matches 0095's intentionally-narrow stance.
--
-- Pending rows normally carry result = NULL and self-heal on the terminal-expire overwrite
-- (expirePendingForTerminalIssue). A pending row with a non-null malformed result is corrupt;
-- we reset it to NULL (the valid pending shape) rather than fabricate a resolution.

-- 1) request_confirmation: backfill version; replace only a missing/out-of-enum outcome
UPDATE "issue_thread_interactions"
SET "result" =
      -- Preserve existing fields; backfill version; only override outcome when it is
      -- missing / out-of-enum (don't clobber a valid recorded outcome or its reason).
      COALESCE("result", '{}'::jsonb)
      || jsonb_build_object('version', 1)
      || CASE
           WHEN "result" ->> 'outcome' IN
             ('accepted','rejected','cancelled','superseded_by_comment','stale_target','issue_terminal_status')
           THEN '{}'::jsonb
           ELSE jsonb_build_object(
             'outcome', CASE "status"
               WHEN 'accepted'  THEN 'accepted'
               WHEN 'rejected'  THEN 'rejected'
               WHEN 'cancelled' THEN 'cancelled'
               WHEN 'expired'   THEN 'issue_terminal_status'
               ELSE 'cancelled'          -- answered/failed/other -> safe terminal
             END,
             'reason', 'Backfilled by DEE-586 generalized interaction-result repair (outcome was missing/out-of-enum).'
           )
         END,
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
--> statement-breakpoint

-- 2) ask_user_questions: backfill version; reset only a non-array answers field
UPDATE "issue_thread_interactions"
SET "result" =
      -- Preserve existing fields; backfill version; only reset answers (to an empty
      -- cancelled shape) when the recorded answers are not a valid array, so real
      -- user answers that merely lack version:1 are kept.
      COALESCE("result", '{}'::jsonb)
      || jsonb_build_object('version', 1)
      || CASE
           WHEN jsonb_typeof("result" -> 'answers') = 'array'
           THEN '{}'::jsonb
           ELSE jsonb_build_object(
             'answers', '[]'::jsonb,
             'cancelled', true,
             'cancellationReason', 'Backfilled by DEE-586 generalized interaction-result repair (answers were missing/not an array).'
           )
         END,
    "updated_at" = now()
WHERE "kind" = 'ask_user_questions'
  AND "status" <> 'pending'
  AND "result" IS NOT NULL
  AND (
    ("result" ->> 'version') = '1'
    AND jsonb_typeof("result" -> 'answers') = 'array'
  ) IS NOT TRUE;
--> statement-breakpoint

-- 3) suggest_tasks: backfill version; coerce only a non-array createdTasks/skippedClientKeys
UPDATE "issue_thread_interactions"
SET "result" =
      -- Preserve existing fields; backfill version; only coerce createdTasks /
      -- skippedClientKeys to [] when they are present but not arrays, so real
      -- created-task data that merely lacks version:1 is kept.
      COALESCE("result", '{}'::jsonb)
      || jsonb_build_object('version', 1)
      || CASE WHEN "result" -> 'createdTasks' IS NOT NULL AND jsonb_typeof("result" -> 'createdTasks') <> 'array'
           THEN jsonb_build_object('createdTasks', '[]'::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN "result" -> 'skippedClientKeys' IS NOT NULL AND jsonb_typeof("result" -> 'skippedClientKeys') <> 'array'
           THEN jsonb_build_object('skippedClientKeys', '[]'::jsonb) ELSE '{}'::jsonb END,
    "updated_at" = now()
WHERE "kind" = 'suggest_tasks'
  AND "status" <> 'pending'
  AND "result" IS NOT NULL
  AND (
    ("result" ->> 'version') = '1'
    AND ("result" -> 'createdTasks' IS NULL OR jsonb_typeof("result" -> 'createdTasks') = 'array')
    AND ("result" -> 'skippedClientKeys' IS NULL OR jsonb_typeof("result" -> 'skippedClientKeys') = 'array')
  ) IS NOT TRUE;
--> statement-breakpoint

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
       AND ("result" ->> 'version') = '1'
       AND ("result" -> 'createdTasks' IS NULL OR jsonb_typeof("result" -> 'createdTasks') = 'array')
       AND ("result" -> 'skippedClientKeys' IS NULL OR jsonb_typeof("result" -> 'skippedClientKeys') = 'array'))
  ) IS NOT TRUE;
