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
