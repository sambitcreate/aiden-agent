# Settings → Storage

**Status:** in review (2026-11-04; reworked 2026-11-05). Desktop only. No Aiden Remote revision.

## Why

Aiden accumulates disk in places a person cannot see: a managed worktree per branch, a snapshot beside each removed-but-dirty worktree, one transcript file per chat plus its images and private per-chat history, artifact snapshots, generated images, diagnostic journals, terminal scrollback, downloaded voice models and agent runtimes, and Bot computer images. Until now the only visible number was **Settings → About → Diagnostics**, which covers the diagnostic journal alone, and the only cleanup was a manual folder deletion the app did not audit.

Claude Desktop's `/storage` page is the model: one total, a breakdown by category, and cleanup that names what it will remove.

## Outcome

- **Settings → Storage** (section id `storage`, App group) shows the total and a stacked category bar, a **What’s using space** card with one row per category and its action, and the largest worktrees and chats with a per-row remove or delete.
- A **server-side endpoint** returns sizes per category plus the largest items, computed in the background and cached. The UI never waits on a scan.
- **Cleanups**: review unused worktrees, delete one chat at a time, clear the browser cache (sign-ins kept), and clear logs. Each previews what it removes and how much it frees before the person confirms. Voice models and Bot computers link to the settings page that owns them.
- **Hard safety rules**: never remove a worktree with uncommitted or unpushed work, one a chat is using, or one a scheduled task runs in; never delete a pinned, owned, or in-use chat.
- Tests for the size computation and for the safety rules.

## Non-goals

- **iOS and Android.** The measured profile lives on the desktop host, the removal paths are desktop-owned, and a read-only phone view would cost a new Remote revision plus two native screens for a number a phone cannot act on. Note in the PR body.
- **Deleting app state or downloads from this page.** Paired-device state, approvals and Bot bindings are expensive to lose and cheap in bytes, so they stay in Other app data with no action. Voice models and Bot computers are removed from their own settings pages (Manage ›), which know how to remove them safely. Only the browser's cache is cleared here, through each browser session.
- **Deleting chats in bulk.** Owner decision (2026-11-05): chats are deleted one at a time, from their own row. `delete-threads` must name exactly one chat.
- **Scratch workspaces and shared memory.** `~/aiden/<slug>` and `~/.aiden/memory` live outside the profile (the latter is shared with the CLI), so they are outside the total rather than half-measured.
- **Archiving threads.** "Archive" in the request is met by deletion behind an explicit review; a reversible archive would need a new chat state, a sidebar surface, and phone parity. Recorded as a follow-up.

## Design

### Inventory

The scanner measures every top-level entry of the user-data profile, so the total is the whole profile. `STORAGE_PROFILE_LAYOUT` in `main/services/storage-profile-inventory.ts` only maps a top-level name to the category it is shown under; anything unnamed is Other app data. Naming an entry never makes it removable.

Nine categories: chats, logs and diagnostics, artifacts and images, browser data, voice and helper models, Bot computers, saved work from removed worktrees, other app data, and worktrees.

### Scan

`main/services/storage-usage.ts` owns a cached `StorageReport` and a single in-flight scan.

- `report()` returns the cache synchronously and starts a scan when it is missing or older than `STORAGE_SCAN_STALE_MS` (60 s).
- A finished scan broadcasts `storage:changed` `{ kind: "scan-finished" }`; the page re-reads.
- `refresh()` awaits the same in-flight scan, so pressing **Measure again** twice does not start two walks.
- Sizes are allocated blocks, not file length, so sparse Bot computer disks are not overstated, and a hard-linked file counts once per scan.
- The walk shares one `StorageScanBudget` across every measurement (1M entries, 20 s). Hitting a bound stops the walk; a skipped folder (unreadable or too deep) leaves a hole but the walk goes on. Either sets `scan.truncated`, and the page says some sizes are a minimum, marking each partly measured item "At least". Every worktree and chat is still listed. A silent undercount would be worse than an honest one.
- Symlinks are never followed (`lstat`, skip), so a workspace link cannot pull an unrelated volume into the total.
- Each worktree is measured once, last. A worktree is measured only inside `worktrees/`; a record pointing elsewhere is listed at zero.
- A chat's size is its transcript plus the pictures no other chat uses, which is what deleting it frees.

### Classification

The protection rules (`worktreeProtectionReason`, `threadProtectionReason`) and the classifiers live in `renderer/shared/storage.ts`, and the planner in `main/services/storage-usage-core.ts` is a pure module over already-read facts — which is what makes the safety rules testable without Electron, Git, or a profile.

`worktreeProtectionReason` returns the first block, most conservative first: `unknown-git-state`, `unknown-routines`, `active`, `changing`, `uncommitted`, `unpushed`, `routine`. The unknown reasons lead deliberately: a Git or scheduled-task read that failed must never be read as "clean".

`threadProtectionReason` returns `owned`, `active`, or `pinned`.

### Preview and cleanup

`planStorageCleanup` builds a preview purely from a report: `items` (what will be removed, each with bytes) and `skipped` (what is kept, each with a reason). The window only chooses which unprotected items are offered; naming an item explicitly skips the window but not the protection rules.

`storage:cleanup` rebuilds the plan, then re-checks each target against live facts immediately before deleting:

- Worktrees: re-read `git status` and the unpushed count, the scheduled tasks, plus `isChatBusy` for every chat on that workspace and `workspaceMutationGate`.
- Chats: `llmClient.isChatBusy`, a fresh Inbox pin snapshot, and the chat's owner.
- Anything that became protected is reported as `skipped`, never deleted.

Deletion uses Aiden's own paths, so their existing invariants still apply:

- `workspaceWorktreeApplicationService.remove` (which itself snapshots dirty work and refuses on unknown ignored files, and runs through the workspace mutation gate, terminal shutdown, schedule pause, and operation cancellation).
- `chatApplicationService.remove` (which deletes the chat's images, subagent history, staged display and generative-UI artifacts, Pi effect and compaction journals, sourced memory, and pull-request links with it).
- The diagnostics owner for logs, the same path `diagnostics:delete` uses, plus terminal scrollback files.
- Each browser session for the cache (`clearCache`, `clearCodeCaches`, shader cache): the app's own session, the built-in browser's profiles, every Bot's browser, and Aiden partitions left on disk by a deleted profile or Bot. The offered amount counts only those sessions' cache folders. Cookies and site storage stay.

Cleanups run one at a time. Removing a worktree deletes its branch only when the branch still points where Aiden created it; a branch with commits stays.

### Unpushed commits

`gitService.managedWorktreeUnpushedCommits` counts what a branch has that no remote holds: with an upstream, `rev-list --count <upstream>..refs/heads/<branch>`; without one, `rev-list --count refs/heads/<branch> --not <every refs/remotes ref>` (so a fresh clone where `main` is not checked out still counts as pushed). A read that fails returns 0 and the caller treats Git as unreadable, which protects the worktree.

## Renderer

`renderer/components/settings/storage-settings.tsx`, one `FieldSet` per area, following `docs/settings-design-system.md`: shared page heading from `settings-view.tsx`, `FieldSet`/`Field` rows, the shared `Select`, `Badge`, `Button` and `AlertDialog`, chart series tokens for the bar, no decorative borders, and the neutral focus ring. Details in [settings-design-system.md](../settings-design-system.md#storage).

## Mobile

Out of scope, deliberately. See Non-goals.

## Follow-ups

- A reversible **archive** for threads (new chat state, sidebar surface, phone parity, one Remote revision).
- Extending the page to a paired Mac's storage over Aiden Remote (the host runs the scan; the phone shows it read-only), which is the only way the phone could act.
- Offering cleanup for other app data once the paired-device and approval stores can be re-seeded without a re-pair.
