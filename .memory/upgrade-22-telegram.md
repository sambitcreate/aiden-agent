# Telegram final preview recovery — 2026-09-19

HTML draft previews are persisted Telegram messages. Finalization edits their first
chunk, then sends any remaining chunks, attachments, and requested voice replies.
Previously Telegram's HTTP 400 `message is not modified` response escaped that
edit and aborted final delivery even though the first chunk already existed.
A deleted or otherwise uneditable preview also caused the final reply to be lost.

`deliverHtmlReply` now treats only a typed Telegram 400 unchanged-message response
as success. A typed 400 `message to edit not found` or `message can't be edited`
sends one replacement to the original chat/topic with the same HTML, preview
policy, and applicable buttons. Other failures propagate without speculative
resends, including 429, malformed markup, server and transport errors.

Investigation also identified fragile long-HTML chunk splitting (non-pre tags and
entities can cross hard boundaries); this independent problem is deferred. Bot
routing already captures binding snapshots and validates backing ownership;
profile mutation fences have existing coverage and were not changed.

Read-only reference lessons, no implementation copied:
- Hermes MIT, commit `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`,
  `plugins/platforms/telegram/adapter.py`, SHA256
  `b9af348ea5b82333ff3ba172e6e201f17dd59e93cb19f52018075b3e58a40965`:
  unchanged edits are successful no-ops; finalization owns remaining delivery.
- OMP MIT, commit `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`,
  `packages/coding-agent/src/session/queued-messages.ts`, SHA256
  `8137361db48900889dc9907c37ed855c18443fd9c85d4bacdc846b2ac342d030`:
  queued content and terminal answers have distinct lifecycle semantics.

Validation: eight new cases in the already registered service-core suite. Three
regression cases failed on baseline `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`;
five negative cases passed. With the fix, all 193 `test:telegram` tests, repository
type-check, scoped ESLint and `git diff --check` pass. No UI, shared native
contract, setup or durable feature change; no onboarding/native suite update is
needed. No bot credentials or live Telegram calls. Hosted CI and central
independent review are separate pending gates.
