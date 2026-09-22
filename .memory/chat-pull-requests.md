# Durable chat PR links — 2026-09-22

Work continues on existing PR #184 (`devin/1789864248-chat-pull-requests`), isolated review branch `feature/durable-chat-pr-review`. Current main merged, preserving both papercuts entries. Desktop many-PR implementation is separate from native Remote chat contracts and managed worktree lifecycle.

Never normalize a supplied malformed expectedHeadSha to omission. Unknown creates remain pending even after an empty lookup; absence from a list does not establish that a mutation failed. Save link + settle intent atomically. Recovery uses the durable host/repository, independent of chat workspace changes. Same-target pending intents block repeat creates. Post-push identity comes from the frozen endpoint used by Git, never gh's inferred default repository. Unlink dismissal is durable and suppresses current-PR rediscovery until explicit relink.

Two requested Sol medium reviews identified empty-list retries, split link/intent publication, selected-remote routing, and source IPC mismatch; all remediated with focused coverage. Final verification tracked in docs/plans/chat-pull-requests-plan.md and PR #184.

Follow-up review fixes: store settlement checks that the operation is still pending inside the serialized write, preventing stale completions from undoing unlink. Unknown/retargeted/advanced-head attempts can be explicitly cleared only after a confirmation to check GitHub first. Within-repository create destination is named in the dialog; cross-fork upstream creation remains manual.

Local verification: full npm test 6,825 pass/1 skipped/0 fail; focused final suite 87 pass; IPC 14 pass; type-check and build pass. Future-schema and malformed-intent files remain write-protected. PR #184 hosted CI is tracked separately; do not infer pending checks passed.
