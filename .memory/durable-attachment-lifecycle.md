# Durable attachment lifecycle — 2026-09-22

Based on current origin/main c8c09e0d239dd596a68b7a5d5719d543399d077b, not the program coordinator's older checkout.

## Verified scope

Codex PR https://github.com/openai/codex/pull/45579 (merged 19286b8, September 15) copies current thread attachment memberships into durable forks. Aiden differs: attachments are validated inline message bytes and `copyVisibleHistory` already persists independent bytes through the selected assistant turn. Extended the existing copy test to remove the original chat and reload both copy and fork from disk. No new file store, filesystem paths, fork wire IDs, or retained draft attachments were needed.

Remote pending upload handles already use 32 random bytes, strict opaque syntax, device/chat ownership, one-use consumption, expiry, and capacity accounting. Verified gap: desktop/Bot/remote chat deletion did not clear pending upload bytes; uploads paused at an awaited chat lookup could finish after deletion/device revocation.

## Implementation

The production RemoteChatService and shared ChatApplicationService use one process-local remote attachment store. Deletion synchronously closes upload admission and invalidates pending reads, clears retained uploads when the durable deletion tombstone requires roll-forward, and releases its gate only alongside generation admission. Failed preflight preserves existing uploads; failures after tombstone keep admission closed. Revocation invalidates pending upload leases and remembers the revoked device identity to fence requests authenticated before revocation that enter the service later. Device IDs are not reused. Awaiting requests retain their capacity slots until their finally blocks settle: their closures still hold parsed bytes, so early release would allow unbounded accumulation. No network endpoints, schemas, transcript UI, onboarding capability, credentials, or draft-store persistence changed.

## Question-answer attachment assessment

Read September 8 and 15 Notion digests; verified current upstream https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/question-attachments.md (currently 100 files across answers, not the dated digest's 8). Source clones locally were older than the research, so upstream was checked directly. PR #122 was fetched and inspected: renderer questionnaire restyling only, deliberately unchanged tool/IPC contract. Aiden's `AskUserAnswerV1` remains text/options/multi selections; native remote clients have no matching questionnaire upload capability. Adding answer attachments needs coordinated question-owned upload/admission, answer projection, feature negotiation, all-client tests, and ephemeral draft separation. This task assesses that work only and preserves #122; no duplicate composer implementation.

## Validation

Existing test files extended (already registered in package scripts): remote upload revocation and deletion races, cross-device chat cleanup/capacity isolation, durable deletion failure boundaries, clone/fork survival after deleting source. iOS and Android upload/delete consumers inspected: same opaque-ID HTTP contract, no implementation change required. Sol medium blast-radius review clear; adversarial review's pre-lease revocation finding fixed and re-reviewed. Final checks and PR status recorded in task/PR.

Review correction: the router already tracks authenticated upload mutations and waits for them to drain before completing device revocation. The revoked-device tombstone is defense at the service/direct-call boundary, not a demonstrated HTTP bypass. The confirmed product gap is chat deletion cleanup/admission. The existing combined validation fixture now uses another live device for MIME/path validation after revoking its original device.
