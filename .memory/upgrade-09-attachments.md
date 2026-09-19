# Upgrade 09: composer attachment completion

Aiden baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

Attachment picker/drop/paste completion previously used the model captured at request start and appended without rechecking the current draft. Browser annotations and failed-send recovery can add attachments during I/O, making the initial count/byte reservation stale. Unmounted composers could also emit late errors and refocus a shared input ref.

`ComposerAttachmentOperation` now fences success, errors, cleanup, deferred focus, and the clipboard preparation-to-IPC boundary. Unmount invalidates the generation. `acceptComposerAttachments` uses current retained attachments and latest committed model support at completion, preserves existing entries, deduplicates IDs, and bounds new entries by remaining count and UTF-8/image byte capacity. Overflow gets existing toast/status feedback. Already-dispatched main reads retain their existing bounded admission; this change does not abort filesystem I/O.

Source learning (original implementation; no source copied): Waku `src/app/composer.rs` at `6d433e875d57091906ec0770d8bb9ffc9aa29b83` binds background clipboard persistence to the captured draft owner. Prime Agent `packages/coding-agent/src/modes/interactive/interactive-mode.ts` at `c5991bc853d27754aed345c13ff4d2e05c40f1f4` preserves attachment identity through queue restoration. Hermes `gateway/platforms/signal.py` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf` checks attachment size before accepting fetched media.

Regression coverage includes capacity consumed during I/O, failed-send restore, UTF-8 byte boundaries, current model support, duplicate IDs, unmount, stale cleanup, and deferred focus. New tests are registered in test and test:coverage. This is a renderer lifecycle fix: no shared/native contracts, visual geometry, onboarding capability, or plan status changes. Interactive Electron/OS picker acceptance remains unperformed.

Pullfrog follow-up: established chats keep text editable during pending sends. All attachment admission now checks `sendPendingRef` synchronously, including browser annotation delivery, so failure restoration cannot merge an in-flight payload with newly ingested files. A mounted production Composer regression reproduces the old 23/20 count overflow and verifies both count and full-byte-budget restoration, picker/drop/paste rejection, and browser annotation rejection. Peripheral UI and IPC are isolated in the fixture; the real send/restore/admission implementation is mounted.
