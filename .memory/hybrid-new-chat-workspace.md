# Hybrid new chat and composer context — 2026-10-15

Planned, not implemented. Plan: `docs/plans/hybrid-new-chat-workspace-plan.md`. Prototype: `docs/plans/assets/hybrid-new-chat-prototype.html`.

## Decisions (owner-approved direction)
- The owner chose the "Hybrid" option over a Codex-style chip bar and a T3-style "ask first" picker. ⌘N stays an instant draft in the workspace being viewed. Choosing or adding a workspace happens inside the draft: from the headline name, the composer chip, or ⌘⇧N "New chat in…".
- The owner explicitly asked for **progressive disclosure**:
  - Git and PR controls must not appear for folders that aren't git repos.
  - The PR chip appears only for a GitHub remote when there is something to open (branch ahead, linked or pending), and never on a draft.
  - The machine chip appears only with paired Macs.
- After the first send the composer top bar shrinks to branch + PR instead of fully collapsing. The workspace is not repeated there because the header `WorkspaceChip` (`chat-top-bar.tsx`) already shows it. For a folder that isn't a git repo the bar is hidden.
- "New worktree" becomes a draft setting (base branch, from origin, auto `aiden/<slug>` name). It is created on first send through the existing managed path, with an idempotency key per draft. This replaces today's create-on-pick with a typed name.

## Findings that motivated it
- `ChatPullRequestsChip` renders unconditionally in the composer context bar. It reads "Pull Requests" even on drafts and plain folders.
- The whole bar is hidden after the first message (`autoHideComposerContext`).
- ⌘O is already `workspace.openPreferredEditor`, so Open folder uses ⌘⇧O. ⌘⇧N is free.
- Remote worktree creation (`aiden-remote-git`) is used by the phones. Creating worktrees on send for remote targets needs a Remote revision plus iOS and Android work (plan Phase 5).

## Phase 2 main process (implemented 2026-10-15; UI pending)
- `main/services/workspace-intake.ts` (pure `parseWorkspacePathInput`, inspect/open/previewClone/clone service), `main/services/git-clone-runner.ts` (spawned `git clone`), `main/handlers/workspace-intake.ts` (DI handler registration, wired from `registerWorkspaceHandlers`), shared contract and `parseCloneUrl` in `renderer/shared/workspace-intake.ts`.
- Channels: `workspaces:inspectPath`, `workspaces:openPath`, `workspaces:clonePreview`, `workspaces:clone`, `workspaces:cloneCancel`; progress notification `workspaces:clone-progress` goes only to the requesting document, and a reload cancels the clone.
- Repository detection while typing is a `.git` stat only: no Git process runs on user-typed folders (a hostile repo config such as `core.fsmonitor` could otherwise execute).
- Opening registers through `workspaceApplicationService.createFromFolder`, the same path as the native picker; an already registered folder (matched by realpath) is returned instead. Create makes one folder, never intermediates.
- Clone base: `~/projects` when it exists, else home (no existing setting). Clone runs `git -c core.hooksPath=/dev/null -c protocol.{ext,fd,file}.allow=never clone --progress -- <url> <dest>` in a new session (no TTY), `GIT_TERMINAL_PROMPT=0`, 16 KiB stderr tail, 60 min timeout. Accepted URLs: https, ssh://, scp-like `user@host:path`, GitHub `owner/repo`; https credentials in the URL are refused.
- Tests clone a local bare repo through the runner's `extraConfig` seam (`url.file://….insteadOf` + `protocol.file.allow=always`); the production IPC path has no way to pass config.
