# Sidebar chat-row context glyphs (2026-10-09)

Branch `worktree-sidebar-status-icons`, desktop only, with no Remote contract change. The design came from a deep dive into t3code's sidebar and the Codex and Claude Code sidebars.

## Decision
- Worktree, PR and connection indicators belong to **chat rows** and appear only when they apply. Workspace and remote-project group rows show a plain `Folder` icon: no `FolderGit2`, no PR indicator, and no globe at rest. The branch and host stay in the group subtitle.
- Trailing order on a chat row: `[shortcut kbd][worktree][PR][row status / unread]`. The remote chat rows' existing globe (`RemoteHostMarker`) is the connection glyph.

## Implementation
- `ChatPullRequestService.sidebar(chatIds)` and IPC `pullRequests:sidebar` return `ChatSidebarPullRequests` for each chat: the best linked PR from cached snapshots (`resolveCurrentPullRequest(links, {})`) and the dismissed ref keys. They **never call GitHub**.
- `parseSidebarChatIds` keeps only safe, unique ids and refuses anything over `MAX_SIDEBAR_PULL_REQUEST_CHATS` (500). The newest 500 chats are asked about; older chats show no linked-PR glyph.
- `useSidebarChatPullRequests(sortedIds)` is a single query, invalidated by `chats:pull-requests-changed` in `root-view.tsx`.
- **Live branch reads:**
  - `ChatRowContextGlyphs` reads `useGitPullRequestStatus` only for rows marked `live`, which means indented rows inside an expanded workspace group.
  - The workspace must also be a managed worktree whose linked PR is not already merged.
  - This matches the old group indicator's polling footprint. The chronological view makes no GitHub reads.
- **`sidebarRowPullRequest` merge rules:**
  - A linked PR beats the branch PR.
  - A branch PR whose ref the chat dismissed never shows, matching how `current()` honours dismissals.
  - "Same PR" means the same `host/repository#number`, taken from the discovered URL.
  - A merged PR never regresses.
  - Checks come only from a live branch read. Snapshot-only checks are dropped because snapshots refresh only when the PR rail opens.
- Glyphs are `role="img"` with an `aria-label` and `title`, never controls, because they sit inside the row `<button>`.
- **Tone:** `data-tone` is failing (red), pending (warning) or passing (green) only for an open, ready PR with a check result. Everything else is neutral (`text-tertiary`). No checks reported does not read as passing.
- `SidebarListItem`'s trailing span is `gap-1 empty:hidden`.

## Known limits / follow-ups
- A linked-only PR state can be stale, for example "open" after it merged, until the chat's rail refreshes the snapshot.
- The sidebar resolver uses no branch context, so a chat with two open linked PRs can show a different one than the rail, which prefers the PR on the checked-out branch.
- Dropped from the old workspace indicator: the checks popover, Refresh, and the error and rate-limit glyphs. The PR rail holds those.
- Ideas from t3code: visibility-leased PR reads (IntersectionObserver), cross-fading status into hover actions, and a richer hover card.

Related: [[chat-row-states]], [[chat-pull-requests]].
