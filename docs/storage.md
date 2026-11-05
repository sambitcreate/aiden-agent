# Storage

Settings → Storage (section id `storage`, App group) answers two questions: how much disk Aiden uses on this computer, and what can safely be cleared. It is desktop-only; phones show nothing for it yet (see [Mobile](#mobile)).

The page has three parts: a total with the category bar, an expandable list of the largest items, and the cleanup actions.

## Categories

Each category is a set of directories under Aiden's device-local user-data profile (`app.getPath("userData")`). `main/services/storage-profile-inventory.ts` is the only list of them; the scanner walks nothing else, so a new store must be added there deliberately.

| Category | Contains |
| --- | --- |
| Worktrees | `worktrees/` — the managed checkouts Aiden creates per branch. |
| Worktree snapshots | `worktree-snapshots/` — restorable snapshots kept when Aiden removed a worktree that had uncommitted work. |
| Threads | `chats/` (transcripts and their `images/`), `pi-compaction-sessions/`, `pi-runtime-effects.json`, `subagent-runs/` and `subagent-runs-v2/`, `tool-output-spills.json`, `display-image-artifacts.json`, `generative-ui-artifacts.json`, `chat-pull-requests/`, `chat-folders/`, `follow-through/`, `interrupted-waits.json`, `chat-triage.json`, `chat-read-markers.json`, `first-message-worktrees.json`, `bots/`, `memory/`. |
| Artifacts | `workspace-artifacts/`, `create-images/`, `studio-assets/`, `design-projects/`. |
| Logs and diagnostics | `logs/`, `Crashpad/`, `terminal-history/`. |
| Caches | `browser/`, `background-jobs/`, `devices/`, `aiden-live/`, `acp/`, `pi-upgrade-rollout/`, `provider-login-device-id/`, `telegram-inbox/`, `telegram-bot-outbox/`, `bot-avatar-store/`. Measured, never offered for deletion. |
| Downloads | `voice-models/`, `parakeet-models/`, `form-fill-model/`, `bot-computers/`. |

Two things are deliberately outside the profile and therefore outside the total: scratch workspaces (`~/aiden/<slug>`), which belong to the person's home folder, and Bot memory in `~/.aiden/memory` shared with the CLI.

Caches are measured but never deleted: removing them silently loses paired-device state, approvals, and Bot bindings while reclaiming almost nothing. Downloads are left alone because re-downloading a multi-gigabyte runtime is worse than the space it frees.

## How a scan works

`main/services/storage-usage.ts` owns the scan. A read never waits on it:

1. `storage:report` returns the cached snapshot immediately (idle on the first read).
2. When the cache is missing or older than 60 seconds, a scan starts in the background and `storage:changed` (`{ kind: "scan-started" | "scan-finished" }`) tells the page to re-read.
3. The page's **Measure again** button calls `storage:refresh`, which awaits that same scan.

The walk is bounded by `DEFAULT_STORAGE_SCAN_LIMITS` (400,000 entries, 64 GiB, 20 seconds) shared across every measurement. Hitting a bound stops the walk and sets `scan.truncated`, and the page says the total is a minimum instead of pretending it is exact. Symlinks are never followed, so a workspace link cannot make Aiden report bytes it did not write; an unreadable directory is a hole in the total, not a failed scan.

A worktree's size is measured only when its path is inside `worktrees/`; a record pointing elsewhere reports zero rather than walking an unrelated directory.

A thread's own bytes are its transcript plus the chat images it names by content hash. An image used by several chats counts once in the category total (from the whole `chats/` directory) and once in each thread that names it, so per-thread numbers can add up to more than the category — that is intended.

## Safety rules

Two pure functions decide everything: `worktreeProtectionReason` and `threadProtectionReason`, in `renderer/shared/storage.ts` so the page, the tests, and main share one definition. Both return the first blocking reason, or null when the item is removable.

A worktree is kept when:

- its Git state could not be read (`unknown-git-state`) — the scan failing must never read as "clean";
- a chat on it is generating or waiting (`active`);
- Aiden is creating or removing it (`changing`);
- `git status` reports changed or untracked files (`uncommitted`);
- the branch has commits no remote holds (`unpushed`). A branch with an upstream counts commits it is ahead by; a branch with no upstream counts the commits no remote-tracking ref contains.

A thread is kept when:

- another Aiden surface owns it — a Bot's conversation or a Design project (`owned`);
- it is generating or waiting (`active`);
- it is pinned in the Inbox (`pinned`).

The inactivity window only decides *which* unprotected items are offered. An item named explicitly (the per-row delete button) skips the window but not the protection rules.

## Cleanup

`storage:preview` returns exactly what an action would remove, each item with its size, plus everything it deliberately leaves behind and why. `storage:cleanup` takes the action and the ids the preview listed:

1. It rebuilds the same plan from a fresh report.
2. It re-checks each target against live facts immediately before deleting: Git for worktrees, `llmClient.isChatBusy` and the Inbox pins for threads.
3. It deletes through Aiden's own paths — `workspaceWorktreeApplicationService.remove` for a worktree (which still refuses if local work appears) and `chatApplicationService.remove` for a chat (which removes the chat's images, subagent history, staged artifacts, compaction journal, sourced memory and pull-request links with it).
4. Anything that became protected is reported as skipped, never deleted.

That second check is why a worktree edited between the review dialog and the confirmation is kept: the preview is advice, and the live re-read is the decision.

**Clear logs** removes the diagnostic journal, crash dumps, and terminal scrollback through the diagnostics owner (`diagnostics:delete` uses the same path). Chats, settings, credentials, and projects are untouched.

Every action drops the cache and starts a new scan, so the page shows the result of what it just did.

## Protocol

| Channel | Purpose |
| --- | --- |
| `storage:report` | Cached report; starts a background scan when stale. |
| `storage:refresh` | Await a fresh scan. |
| `storage:preview` | `StorageCleanupRequest` → `StorageCleanupPreview`. |
| `storage:cleanup` | `StorageCleanupRequest` → `StorageCleanupResult`. |
| `storage:changed` | Notification: `{ kind: "scan-started" \| "scan-finished" }`. |

Every handler requires the active renderer document. `parseStorageCleanupRequest` rejects an unknown action, an inactivity window outside `STORAGE_INACTIVE_DAYS`, and any id that is not a non-empty bounded string.

## Mobile

Aiden On The Go does not show disk usage. The scan measures the desktop host's profile, which phones cannot free space on, and the removal paths are desktop-owned. Exposing a read-only view would need a new Aiden Remote revision and an iOS/Android screen; it is out of scope here.

## Tests

- `main/services/storage-usage-core.test.ts` — measured bytes with a real temp directory, symlinks, budget truncation, category ordering, byte formatting, and every protection and planning rule, including that naming a protected item explicitly still keeps it. The protection functions themselves live in `renderer/shared/storage.ts` and are asserted here.
- `main/services/storage-usage.test.ts` — the service over injected ports: a cold read never waits on a walk, the cache is reused, worktrees and threads are classified from Git and activity facts, and cleanup refuses worktrees and chats that gain local work or a live run after the preview.
- `renderer/components/settings/storage-settings.test.ts` — the page: total, bar, largest items, the review dialog's contents, what cleanup sends, and the scan states.

Run them with `npm run test:storage`.
