# Draft agent chats

Status: Implemented; pull-request CI and merge pending.

Ordinary desktop workspace chats stay transient until the first user message is durably saved. Opening New Agent, entering an empty workspace, or opening a fresh worktree must not install an empty chat or sidebar history entry. Leaving an unsent draft discards it. A committed message remains saved even if generation fails.

## Implementation

- Use an explicit renderer draft record with a stable future chat ID. Keep it outside persisted chat lists and query caches. Model, workspace, title, Computer Use, attachments and composer options remain local until Send.
- Freeze first-send input and settings while saving. Commit a complete nonempty chat through an additive desktop IPC, preserving existing workspace authority, attachment quotas, skill leases, turn admission and durability recovery.
- Store a private first-message receipt. Matching retries confirm the same message; mismatched identifier reuse fails. Reconciliation prevents a lost or uncertain receipt from duplicating a chat.
- Promote the draft in place using the same chat/component identity. Publish one sidebar entry and start generation once. Navigation wins over late completion; release a pending turn if its conversation is no longer open.
- Preserve existing Bot, Assistant, scheduled, Telegram and runtime child-agent lifecycles. Remote HTTP contracts remain unchanged; inspect native consumers and validate applicable shared contracts.

## Authorized legacy migration

The owner authorized deleting existing empty chats in this migration. At startup, after recovery and before clients can write, snapshot validated zero-message ordinary chats in registered workspaces. Exclude Bot/Assistant/Telegram conversations, scheduled task and run references, unreadable records, and chats with staged artifacts or private execution history. A message object counts as history even if its text is empty. Validated header-only Pi journals created by the old Todo snapshot read do not count as history; body records and uncertain journal state remain protected.

Persist the exact candidate set and per-chat fingerprints before deletion, recheck each candidate and fingerprint, and remove via the existing cross-store deletion service. Checkpoint progress and mark completion once. Interrupted migration resumes only original candidates; subsequent launches never sweep newer empty chats created through unchanged remote APIs. Unknown/corrupt migration state fails closed. If the initial candidate snapshot cannot be saved, startup stops before admitting writers; retry cannot sweep chats created after an unrecorded initial attempt.

## Verification gates

- Draft abandonment through all creation paths creates no chat payload or sidebar row.
- First send failure preserves composer payload; successful promotion persists one message and runs once.
- Duplicate submission, changed-payload retry, navigation during saving, workspace removal, document invalidation and post-install storage failure are covered.
- Migration deletes empty payload/index entries, preserves real history and special conversations, resumes safely, and runs once across restarts.
- Focused unit/contract tests, Electron draft/migration acceptance, TypeScript, lint and PR exact-head CI must pass before delivery.

No new setup capability or onboarding asset is introduced; this corrects the existing new-chat lifecycle.

## Local verification

The four Electron acceptance tests pass: draft abandonment and in-place promotion, one-time migration across restart, definite first-save failure and retry, and a delayed receipt after navigation. Shared Remote tests and a generic iOS build-for-testing also pass. Native iOS devices were offline and the local Android toolchain was unavailable; no physical-device acceptance is claimed. The PR checks are the source of truth for final exact-head CI.
