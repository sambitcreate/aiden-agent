# Paired project cloning, 2026-10-21

- Implementation branch adds desktop-only workspace-clone-v1 through POST /workspaces mode clone. Requires manage+browse and approved folder selection. Provisional contract revision 37 must be reclaimed from main before merge.
- Source must be a local repository-root workspace. Root .env/.dev.vars ignored UTF-8 files are opt-in, 16 max, 128 KiB each, 512 KiB total. Contents never enter renderer or idempotency receipts. Source and destination file operations pin directory/file identities, use no-follow traversal and exclusive private creation.
- Existing workspace intake stages clones, suppresses hooks/prompts and refuses occupied destinations. Selected files arrive before publication. Request closure cancels, clone deadline 90 seconds. Root policy rechecked before publication and registration; no guarantee against all moved-open-inode effects.
- UI opens from new-chat machine menu, browses target approved folders, defaults every environment choice off, blocks while cloning, offers Stop, then opens new remote project. Draft carries only when remote draft is empty; local source remains saved.
- Initial implementation verification passed local remote/peer/clone/native/consent/onboarding tests, CI policy and inventory, typecheck and lint. iOS shared-fixture XCTest passed on an owned temporary simulator; Android phase-0 fixture suite passed 9 tests. That initial head passed 1066 Remote tests and 170 remote-chat tests. Rendered the real dialog with synthetic IPC in Chrome in light, dark and compact views. Independent review is complete after the corrections below; hosted CI is pending. No physical paired-machine or packaged-app acceptance performed.

## Independent review corrections

- Pin source root identity before Git/ignore awaits. Replacement symlink and real-directory fixtures both reject before content transfer. A read never adopts a new root via realpath after eligibility.
- Carry the staged child device/inode and expected destination through intake registration, actual workspace-application assertCurrent, storage mutation admission and duplicate-existing fallback. Published-child substitution fixtures reject, preserve moved clone and unrelated replacement, and never register an outside workspace.
- Stop/unmount during a delayed folder-selection reply suppresses all subsequent clone IPC. Existing main pending-before-host-lookup test also stays in force.
- Guarantees remain bounded by local moved-open-inode and partial-write effects; no permanent containment or whole-workflow atomicity claim.

Correction verification at 61de864d59df72f59cebca70ea72b99e3ceed728: 49 focused service/IPC/dialog tests, 64 intake tests, 1070 Remote tests and 15 CI registry tests passed, along with typecheck and scoped lint. Independent re-review passed, including the 49 focused tests.

The correction head initially passed 169/170 remote-chat tests; its one allowed focused rerun reproduced the missing partial-text assertion in remote-bot-chat-view.test.tsx. Parent reproduced the same failure on unchanged origin/main 45c221326. Review identified a fixture whose unfinished paragraph reveal deadline matched the query deadline. Fixture-only commit 1454502b1 terminates that paragraph; parent verified the complete remote-chat suite passes 170/170 on CI-pinned Node 22 afterward. Original failure logs remain under /tmp/aiden-clone-review-chat.log and /tmp/aiden-clone-review-remote-bot-rerun.log. Hosted CI and publication remain separate from these local results.
