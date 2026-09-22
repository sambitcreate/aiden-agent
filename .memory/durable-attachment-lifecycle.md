# Durable attachment lifecycle — 2026-09-22

Based on current origin/main c8c09e0d239dd596a68b7a5d5719d543399d077b, not the program coordinator's older checkout.

## Verified scope

Codex PR https://github.com/openai/codex/pull/45579 (merged 19286b8, September 15) copies current thread attachment memberships into durable forks. Aiden differs: attachments are validated inline message bytes and `copyVisibleHistory` already persists independent bytes through the selected assistant turn. Extended the existing copy test to remove the original chat and reload both copy and fork from disk. No new file store, filesystem paths, fork wire IDs, or retained draft attachments were needed.

Remote pending upload handles already use 32 random bytes, strict opaque syntax, device/chat ownership, one-use consumption, expiry, and capacity accounting. Verified gap: desktop/Bot/remote chat deletion did not clear pending upload bytes; uploads paused at an awaited chat lookup could finish after deletion/device revocation.

## Implementation

The production RemoteChatService and shared ChatApplicationService use one process-local remote attachment store. Deletion synchronously closes upload admission and invalidates pending reads, clears retained uploads when the durable deletion tombstone requires roll-forward, and releases its gate only alongside generation admission. Failed preflight preserves existing uploads; failures after tombstone keep admission closed. Revocation invalidates pending upload leases; the existing router authorization fence and drain reject new requests and settle admitted mutations before cleanup. No historical device identity set is retained. Awaiting requests retain their capacity slots until their finally blocks settle: their closures still hold parsed bytes, so early release would allow unbounded accumulation. No network endpoints, schemas, transcript UI, onboarding capability, credentials, or draft-store persistence changed.

## Question-answer attachment assessment

Read September 8 and 15 Notion digests; verified current upstream https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/question-attachments.md (currently 100 files across answers, not the dated digest's 8). Source clones locally were older than the research, so upstream was checked directly. PR #122 was fetched and inspected: renderer questionnaire restyling only, deliberately unchanged tool/IPC contract. Aiden's `AskUserAnswerV1` remains text/options/multi selections; native remote clients have no matching questionnaire upload capability. Adding answer attachments needs coordinated question-owned upload/admission, answer projection, feature negotiation, all-client tests, and ephemeral draft separation. This task assesses that work only and preserves #122; no duplicate composer implementation.

## Validation

Existing test files extended (already registered in package scripts): remote upload revocation and deletion races, cross-device chat cleanup/capacity isolation, durable deletion failure boundaries, clone/fork survival after deleting source. iOS and Android upload/delete consumers inspected: same opaque-ID HTTP contract, no implementation change required. Sol medium blast-radius and adversarial reviews completed; existing router authorization/drain was verified to cover pre-lease revocation. Final checks and PR status recorded in task/PR.

Hosted verify caught the existing subagent deletion source-contract test matching the old one-line `if (releaseAdmission) finishDeletion()` literally. Updated it to assert the conditional block releases attachment admission followed by generation admission after the pending-tombstone check. No production behavior change was needed.

Pullfrog found that the extra revoked-device Set would outlive the registry's 128-entry pruning. Removed that unnecessary set and its direct-call-after-revoke test. Production uploads are tracked by router authorization through completion; state revocation blocks acquisitions and drains mutations before cleanup. Sol re-review confirmed this resolution. Active service leases remain invalidated, bounded, and released on settlement.
