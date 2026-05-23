# Interaction confirmation governance fix plan

## Problem recap

Observed on Eli Board:

- ELI-162 and ELI-167 reached `done` while their linked GitHub PRs (#30 and #32) were still open.
- Pending `request_confirmation` rows were then auto-expired with `outcome=issue_terminal_status`, making it look like Brandon confirmations timed out.
- ELI-168 has two pending confirmations for the same handoff because the first request was superseded by a better scoped `decisionClass=human_only` request, but creators only had an `ask_user_questions` cancel endpoint.
- Telegram issue-level commands cannot resolve ELI-168 because multiple pending interactions match the same issue.

## Target behavior

1. **Universal cancellation**: board users can cancel any pending issue interaction (`suggest_tasks`, `ask_user_questions`, `request_confirmation`) with an audit reason. The result shape must be kind-appropriate and preserve compatibility with existing validators.
2. **Creator supersede path**: the creator of a pending interaction can supersede/cancel their own interaction, so agents can replace a first-pass confirmation without leaving duplicate actionable prompts. This path should be explicit and auditable.
3. **Terminal status guard**: an issue cannot transition to `done`/`cancelled` while it has pending issue-thread interactions unless the request explicitly resolves/cancels/supersedes those interactions first. Terminal status should not silently expire confirmations and bypass the decision gate.
4. **PR gate awareness**: if the issue is being closed but its comments/interaction payloads reference open GitHub PRs, the issue should stay `in_review` / review-gated rather than `done`. In this PR we implement the enforceable interaction guard first; open-PR status checks can be a follow-up because they require GitHub integration at issue-update time.
5. **Operational cleanup**: repair the affected Eli Board rows so ELI-162/ELI-167 are not `done` while PRs are open, cancel the stale ELI-168 first-pass confirmation, and keep the newest ELI-168 handoff as the single pending actionable confirmation.

## Implementation plan

- Add shared result schema support for cancelled `request_confirmation` results.
- Replace the service method `cancelQuestions` with `cancelInteraction`, supporting all interaction kinds.
- Update the cancel route to call `cancelInteraction`, log kind-appropriate reason fields, and keep continuation wakeups.
- Permit agent creators to cancel their own pending interactions; board users can cancel any interaction in accessible companies.
- Add a pre-update guard in the issue PATCH route: before transitioning to a closed status, fetch pending interactions; if any exist, return 409 with interaction ids/kinds and require explicit resolution.
- Keep the old post-terminal expiry catch-up path for legacy rows that are already terminal, but stop creating new bypasses.
- Add focused route tests first: request-confirmation cancel succeeds; creator-agent cancel succeeds; non-creator-agent cancel is forbidden; closing with pending interaction is rejected.
- Run targeted vitest and typecheck.
- Open a PR against `brandon/update-latest-paperclip`.
- Get independent review, fix findings, then deploy and run live API/DB end-to-end checks.
