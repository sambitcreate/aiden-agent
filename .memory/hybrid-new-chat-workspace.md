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
- Review fixes (b0a374868): repo names may not start with `.` (a `.git` name would make the clone base a repo with the remote's config, e.g. `core.fsmonitor`), and destinations with any `.git` component are refused. Clone claims its destination with a non-recursive mkdir (adopting only an empty folder), cleanup empties only that folder and `rmdir`s it only if Aiden created it, and in-flight clones are keyed on realpath(parent) + case-folded name so aliases report busy.

## Phase 4: entry points (implemented 2026-10-15, branch `claude/workspace-creation-patterns-581b17`)
- `chat.newIn` ("New chat in…", ⌘⇧N, native File menu, palette, Settings) opens the command palette in `newChatIn` mode: workspaces by latest chat activity (`renderer/lib/new-chat-workspaces.ts`, managed worktrees left out, current marked), plus **Open folder…** (native picker → draft there). Path rows, Clone and ⌥↵ are Phases 2/3.
- All new-chat entry points go through `openNewChatIn` in `renderer/main/root-view.tsx`, exposed to the sidebar and palette via `renderer/lib/new-chat-actions.tsx`. It reuses an open empty draft (`findReusableChatDraft` in `chat-draft.ts`; content reported by `chat-pane.tsx` through `setChatDraftHasContent`), selects the workspace, and asks the composer for focus (`requestChatDraftComposerFocus` / `subscribeChatDraftComposerFocus`, which also covers a pane that mounts after navigation).
- Only mounted drafts exist (unmounted ones are discarded), so "reuse" means the draft currently open. ⌘N already used the viewed chat's workspace (chat-pane syncs the active workspace), so its default did not change.
- Sidebar: chevron beside New Agent (`SidebarPrimaryNav.onNewChatIn`), hover/focus **+** on local workspace rows ("New chat in <name>"), italic "New chat" draft row (`data-draft-chat=<id>`) in the projects view only, hidden while searching and once the real chat is listed. Opening a draft expands its workspace.
- `chat.newIn` is listed after `chat.search` in `COMMANDS`: cmdk kept a stale DOM order after a disabled-only query and selected the barely matching New chat in… for "Search chats" (pre-existing palette quirk, exposed by chat-shell-interactions e2e).
- A saved custom `chat.new` binding of ⌘⇧N is reset to ⌘N by the existing repair policy (defaults win).
