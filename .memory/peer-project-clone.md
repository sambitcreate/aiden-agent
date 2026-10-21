# Paired project cloning, 2026-10-21

- Implementation branch adds desktop-only workspace-clone-v1 through POST /workspaces mode clone. Requires manage+browse and approved folder selection. Provisional contract revision 37 must be reclaimed from main before merge.
- Source must be a local repository-root workspace. Root .env/.dev.vars ignored UTF-8 files are opt-in, 16 max, 128 KiB each, 512 KiB total. Contents never enter renderer or idempotency receipts. Source and destination file operations pin directory/file identities, use no-follow traversal and exclusive private creation.
- Existing workspace intake stages clones, suppresses hooks/prompts and refuses occupied destinations. Selected files arrive before publication. Request closure cancels, clone deadline 90 seconds. Root policy rechecked before publication and registration; no guarantee against all moved-open-inode effects.
- UI opens from new-chat machine menu, browses target approved folders, defaults every environment choice off, blocks while cloning, offers Stop, then opens new remote project. Draft carries only when remote draft is empty; local source remains saved.
- Local remote/peer/clone/native/consent/onboarding tests, CI policy and inventory, typecheck and lint pass. iOS shared-fixture XCTest passed on an owned temporary simulator; Android phase-0 fixture suite passed 9 tests. Full Remote suite passed 1066 tests and remote-chat suite passed170 tests. Rendered the real dialog with synthetic IPC in Chrome in light, dark and compact views. Independent review and hosted CI are pending. No physical paired-machine or packaged-app acceptance performed.

## Independent review corrections

- Pin source root identity before Git/ignore awaits. Replacement symlink and real-directory fixtures both reject before content transfer. A read never adopts a new root via realpath after eligibility.
- Carry the staged child device/inode and expected destination through intake registration, actual workspace-application assertCurrent, storage mutation admission and duplicate-existing fallback. Published-child substitution fixtures reject, preserve moved clone and unrelated replacement, and never register an outside workspace.
- Stop/unmount during a delayed folder-selection reply suppresses all subsequent clone IPC. Existing main pending-before-host-lookup test also stays in force.
- Guarantees remain bounded by local moved-open-inode and partial-write effects; no permanent containment or whole-workflow atomicity claim.

Correction verification:49 focused service/IPC/dialog tests,64 intake tests,1070 Remote tests and CI registry15 tests passed, along with typecheck and scoped lint. The broader remote-chat run failed one existing live-frame test in remote-bot-chat-view.test.tsx, and its one allowed focused rerun also failed while waiting for the partial text. Parent owns baseline triage; logs remain under /tmp/aiden-clone-review-chat.log and /tmp/aiden-clone-review-remote-bot-rerun.log.
