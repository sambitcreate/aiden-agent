# Storage

Settings → Storage (section id `storage`, App group) answers two questions: how much disk Aiden uses on this computer, and what can safely be cleared. It is desktop-only; phones show nothing for it yet (see [Mobile](#mobile)).

The page has four parts: the total with the category bar, **What’s using space** (one row per category with its action), **Largest worktrees**, and **Largest chats**.

## Categories

The scan measures every top-level entry of Aiden's device-local user-data profile (`app.getPath("userData")`), so the total covers the whole profile. `STORAGE_PROFILE_LAYOUT` in `main/services/storage-profile-inventory.ts` only decides which category an entry is shown under; anything it does not name is shown as **Other app data**, so a new store is always counted. Naming an entry there never makes it removable: each cleanup goes through the feature that owns the data.

| Category | Contains | Action on its row |
| --- | --- | --- |
| Chats | `chats/` (transcripts and their `images/`), `pi-compaction-sessions/`, `pi-runtime-effects.json`, `subagent-runs/` and `subagent-runs-v2/`, `tool-output-spills.json`, `display-image-artifacts.json`, `generative-ui-artifacts.json`, `chat-pull-requests/`, `chat-folders/`, `follow-through/`, `interrupted-waits.json`, `chat-triage.json`, `chat-read-markers.json`, `first-message-worktrees.json`, `bots/`, `memory/`. | None; each chat is deleted from its own row in Largest chats. |
| Logs and diagnostics | `logs/`, `Crashpad/`, `terminal-history/`. | **Clear…** |
| Artifacts and images | `workspace-artifacts/`, `create-images/`, `studio-assets/`, `design-projects/`. | None. |
| Browser data | `Partitions/` (the built-in browser's and Bots' browser profiles), `browser/` (recordings), and the app's own Chromium caches (`Cache/`, `Code Cache/`, `GPUCache/`). | **Clear cache…** |
| Voice and helper models | `voice-models/`, `parakeet-models/`, `form-fill-model/`. | **Manage ›** opens Settings → Voice. |
| Bot computers | `bot-computers/`. | **Manage ›** opens Settings → Bot computers. |
| Saved work from removed worktrees | `worktree-snapshots/`. | None. |
| Other app data | Everything else: settings, paired devices, agent runtimes, and Chromium's other top-level files. | None. |
| Worktrees | `worktrees/`, the managed checkouts Aiden creates per branch. | **Review…** |

A category with nothing on disk is not listed. **Manage ›** is shown only when that settings page exists on this computer (for example, Bot computers is Mac-only).

Two things are deliberately outside the profile and therefore outside the total: scratch workspaces (`~/aiden/<slug>`), which belong to the person's home folder, and Bot memory in `~/.aiden/memory` shared with the CLI.

## How a scan works

`main/services/storage-usage.ts` owns the scan. A read never waits on it:

1. `storage:report` returns the cached snapshot immediately (idle on the first read).
2. When the cache is missing or older than 60 seconds, a scan starts in the background and `storage:changed` (`{ kind: "scan-started" | "scan-finished" }`) tells the page to re-read.
3. The page's **Measure again** button calls `storage:refresh`, which awaits that same scan.

Sizes are disk use, not file length: a file counts its allocated blocks (`blocks × 512`, or its size where the platform reports no blocks), so a sparse Bot computer disk is not overstated. A file hard-linked into several places counts once per scan. Symlinks are never followed, so a workspace link cannot make Aiden report bytes it did not write; an unreadable directory makes the total a minimum, not a failed scan.

Each worktree is measured exactly once: the walk of `worktrees/` skips every managed worktree, and each is then measured on its own so the page can list its size. Worktrees are measured last because they are the largest and least predictable. A worktree whose record points outside `worktrees/` is listed at zero rather than walking an unrelated directory.

The walk shares one budget (`DEFAULT_STORAGE_SCAN_LIMITS`: 1,000,000 entries and 20 seconds). Hitting it stops the walk. A folder the walk has to skip (unreadable, or more than 24 levels deep) is a hole: the rest of the category is still measured. Either way `scan.truncated` is set, the page says "some sizes are a minimum", and any item that was not fully measured reads "At least …". Every worktree and chat is still listed, so a budget that runs out never hides one.

A chat's size is what deleting it would free: its transcript plus the pictures no other chat uses. A picture shared by several chats stays in the Chats category total but is not added to any one chat. The row also says how many pictures the chat has.

## Safety rules

Two pure functions decide everything: `worktreeProtectionReason` and `threadProtectionReason`, in `renderer/shared/storage.ts` so the page, the tests, and main share one definition. Both return the first blocking reason, or null when the item is removable.

A worktree is kept when:

- its Git state could not be read (`unknown-git-state`); a failed read must never read as "clean";
- Aiden could not read its scheduled tasks (`unknown-routines`); that keeps every worktree;
- a chat on it is generating or waiting (`active`);
- Aiden is creating or removing it (`changing`);
- `git status` reports changed or untracked files (`uncommitted`);
- the branch has commits no remote holds (`unpushed`). A branch with an upstream counts commits it is ahead by; a branch with no upstream counts the commits no remote-tracking ref contains;
- a scheduled task runs in it (`routine`).

A chat is kept when:

- another Aiden surface owns it, such as a Bot's conversation or a Design project (`owned`);
- it is generating or waiting (`active`);
- it is pinned in the Inbox (`pinned`). An unreadable Inbox store keeps every chat.

A kept row shows a gray **Kept** badge and the reason, and has no remove button.

## Cleanup

`storage:preview` returns exactly what an action would remove, each item with its size, plus everything it deliberately leaves behind and why. `storage:cleanup` takes the action and the ids the preview listed. Cleanups run one at a time.

1. It rebuilds the same plan from a fresh report.
2. It re-checks each target against live facts immediately before deleting: Git, scheduled tasks, and running chats for a worktree; `llmClient.isChatBusy`, the Inbox pins, and the chat's owner for a chat.
3. It deletes through Aiden's own paths: `workspaceWorktreeApplicationService.remove` for a worktree (which still refuses if local work appears) and `chatApplicationService.remove` for a chat (which removes the chat's images, subagent history, staged artifacts, compaction journal, sourced memory and pull-request links with it).
4. Anything that became protected is reported as skipped, never deleted.

That second check is why a worktree edited between the review dialog and the confirmation is kept: the preview is advice, and the live re-read is the decision.

The actions:

- **Review…** (worktrees) opens a dialog listing the worktrees unused for the chosen time (an **Unused for** picker: 7, 14, 30 or 90 days, default 14), their sizes, and a Kept list with reasons. A worktree row's **Remove…** removes just that one; naming an item skips the time window but not the protection rules. Removing a worktree deletes its branch only when nothing was ever committed on it (the branch still points where Aiden created it); a branch with commits stays in the repository.
- **Delete…** on a chat row deletes that one chat. There is no bulk chat delete: `parseStorageCleanupRequest` rejects `delete-threads` unless it names exactly one chat.
- **Clear cache…** empties cached pages, compiled scripts and GPU shaders for the app's own session, the built-in browser's profiles, every Bot's browser, and any Aiden partition a deleted profile or Bot left on disk (`aiden-browser-*` and `aiden-bot-*` under `Partitions/`). It goes through each browser session (`clearCache`, `clearCodeCaches`, and the shader cache), so cookies, local storage and sign-ins stay and open tabs keep working. The amount it offers counts only those sessions' cache folders, never another partition's. The button is off when nothing is cached.
- **Clear…** (logs) removes the diagnostic journal, crash dumps, and terminal scrollback through the diagnostics owner (`diagnostics:delete` uses the same path). Chats, settings, credentials, and projects are untouched.

Every action drops the cache and starts a new scan, so the page shows the result of what it just did.

## Protocol

| Channel | Purpose |
| --- | --- |
| `storage:report` | Cached report; starts a background scan when stale. |
| `storage:refresh` | Await a fresh scan. |
| `storage:preview` | `StorageCleanupRequest` → `StorageCleanupPreview`. |
| `storage:cleanup` | `StorageCleanupRequest` → `StorageCleanupResult`. |
| `storage:changed` | Notification: `{ kind: "scan-started" \| "scan-finished" }`. |

Every handler requires the active renderer document. `parseStorageCleanupRequest` rejects an unknown action, an inactivity window outside `STORAGE_INACTIVE_DAYS`, any id that is not a non-empty bounded string, and a chat delete that does not name exactly one chat.

## Mobile

Aiden On The Go does not show disk usage. The scan measures the desktop host's profile, which phones cannot free space on, and the removal paths are desktop-owned. Exposing a read-only view would need a new Aiden Remote revision and an iOS/Android screen; it is out of scope here.

## Tests

- `main/services/storage-usage-core.test.ts`: measured bytes with a real temp directory (sparse files, hard links counted once, symlinks, excluded paths), budget truncation, category ordering, byte formatting, and every protection and planning rule, including that naming a protected item still keeps it, that there is no chat sweep, and that a chat delete must name one chat.
- `main/services/storage-usage.test.ts`: the service over injected ports: a cold read never waits on a walk, the cache is reused, unnamed profile entries land in Other app data, each worktree is measured once and still listed when the budget runs out, a picture shared by two chats is not added to either, scheduled tasks keep a worktree, Clear cache calls the browser owner, and cleanup refuses worktrees and chats that gain local work or a live run after the preview.
- `renderer/components/settings/storage-settings.test.ts`: the page: total, rows and their actions, kept reasons, the review dialog's contents, the ids each cleanup sends, Manage links, and the scanning, truncated and failed states.

Run them with `npm run test:storage`.
