# Settings → Storage

**Status:** in review (2026-11-04). Desktop only. No Aiden Remote revision.

## Why

Aiden accumulates disk in places a person cannot see: a managed worktree per branch, a snapshot beside each removed-but-dirty worktree, one transcript file per chat plus its images and private per-chat history, artifact snapshots, generated images, diagnostic journals, terminal scrollback, downloaded voice models and agent runtimes, and Bot computer images. Until now the only visible number was **Settings → About → Diagnostics**, which covers the diagnostic journal alone, and the only cleanup was a manual folder deletion the app did not audit.

Claude Desktop's `/storage` page is the model: one total, a breakdown by category, and cleanup that names what it will remove.

## Outcome

- **Settings → Storage** (section id `storage`, App group) shows the total, a stacked category bar with a legend, and the largest worktrees and threads with a per-row delete.
- A **server-side endpoint** returns sizes per category plus the largest items, computed in the background and cached. The UI never waits on a scan.
- **Three cleanups** — remove unused worktrees, delete inactive threads, clear logs — each previewing what it removes and how much it frees before the person confirms.
- **Hard safety rules**: never remove a worktree with uncommitted or unpushed work, or one attached to an active thread; never delete a pinned, owned, or in-use thread.
- Tests for the size computation and for the safety rules.

## Non-goals

- **iOS and Android.** The measured profile lives on the desktop host, the removal paths are desktop-owned, and a read-only phone view would cost a new Remote revision plus two native screens for a number a phone cannot act on. Note in the PR body.
- **Deleting caches or downloads.** Caches hold paired-device state, approvals and Bot bindings that are expensive to lose and cheap in bytes; downloads are multi-gigabyte runtimes the person would have to fetch again. Both are measured so the total is honest, neither is offered.
- **Scratch workspaces and shared memory.** `~/aiden/<slug>` and `~/.aiden/memory` live outside the profile (the latter is shared with the CLI), so they are outside the total rather than half-measured.
- **Archiving threads.** "Archive" in the request is met by deletion behind an explicit review; a reversible archive would need a new chat state, a sidebar surface, and phone parity. Recorded as a follow-up.

## Design

### Inventory

`main/services/storage-profile-inventory.ts` is the single list mapping a user-data path to a category. The scanner walks only those paths, so a new store can never be measured or cleared by accident, and adding one is a one-line change with a category decision attached.

Seven categories: worktrees, worktree snapshots, threads, artifacts, logs, caches, downloads. Caches and downloads are measured but never actionable.

### Scan

`main/services/storage-usage.ts` owns a cached `StorageReport` and a single in-flight scan.

- `report()` returns the cache synchronously and starts a scan when it is missing or older than `STORAGE_SCAN_STALE_MS` (60 s).
- A finished scan broadcasts `storage:changed` `{ kind: "scan-finished" }`; the page re-reads.
- `refresh()` awaits the same in-flight scan, so pressing **Measure again** twice does not start two walks.
- The walk shares one `StorageScanBudget` across every measurement (400k entries, 64 GiB, 20 s). Hitting a bound stops the walk and sets `scan.truncated`, and the page says the total is a minimum. A silent undercount would be worse than an honest one.
- Symlinks are never followed (`lstat`, skip), so a workspace link cannot pull an unrelated volume into the total.
- A worktree is measured only inside `worktrees/`; a record pointing elsewhere reports zero.

### Classification

`main/services/storage-usage-core.ts` is a pure module over already-read facts, which is what makes the safety rules testable without Electron, Git, or a profile.

`worktreeProtectionReason` returns the first block, most conservative first: `unknown-git-state`, `active`, `changing`, `uncommitted`, `unpushed`. `unknown-git-state` leading the order is deliberate: a Git read that failed must never be read as "clean".

`threadProtectionReason` returns `owned`, `active`, or `pinned`.

### Preview and cleanup

`planStorageCleanup` builds a preview purely from a report: `items` (what will be removed, each with bytes) and `skipped` (what is kept, each with a reason). The window only chooses which unprotected items are offered; naming an item explicitly skips the window but not the protection rules.

`storage:cleanup` rebuilds the plan, then re-checks each target against live facts immediately before deleting:

- Worktrees: re-read `git status` and the unpushed count, plus `isChatBusy` for every chat on that workspace and `workspaceMutationGate`.
- Threads: `llmClient.isChatBusy` and a fresh Inbox pin snapshot.
- Anything that became protected is reported as `skipped`, never deleted.

Deletion uses Aiden's own paths, so their existing invariants still apply:

- `workspaceWorktreeApplicationService.remove` (which itself snapshots dirty work and refuses on unknown ignored files, and runs through the workspace mutation gate, terminal shutdown, schedule pause, and operation cancellation).
- `chatApplicationService.remove` (which deletes the chat's images, subagent history, staged display and generative-UI artifacts, Pi effect and compaction journals, sourced memory, and pull-request links with it).
- The diagnostics owner for logs, the same path `diagnostics:delete` uses, plus terminal scrollback files.

### Unpushed commits

`gitService.managedWorktreeUnpushedCommits` counts what a branch has that no remote holds: with an upstream, `rev-list --count <upstream>..refs/heads/<branch>`; without one, `rev-list --count refs/heads/<branch> --not <every refs/remotes ref>` (so a fresh clone where `main` is not checked out still counts as pushed). A read that fails returns 0 and the caller treats Git as unreadable, which protects the worktree.

## Renderer

`renderer/components/settings/storage-settings.tsx`, one `FieldSet` per area, following `docs/settings-design-system.md`: shared page heading from `settings-view.tsx`, `FieldSet`/`Field` rows, the shared `Select`, `Badge`, `Button` and `AlertDialog`, chart series tokens for the bar, no decorative borders, and the neutral focus ring. Details in [settings-design-system.md](../settings-design-system.md#storage).

## Mobile

Out of scope, deliberately. See Non-goals.

## Follow-ups

- A reversible **archive** for threads (new chat state, sidebar surface, phone parity, one Remote revision).
- Extending the page to a paired Mac's storage over Aiden Remote (the host runs the scan; the phone shows it read-only), which is the only way the phone could act.
- Offering cache clearing once the paired-device and approval stores can be re-seeded without a re-pair.
