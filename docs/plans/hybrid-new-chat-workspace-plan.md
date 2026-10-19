# Hybrid new chat: workspace choice and progressive composer context

Status: Phases 1–4 merged in PR #491 (2026-10-15) and shipped in 0.57.0. Phase 5
(paired Macs and phones) is still open. The owner approved the Hybrid direction
after comparing it with T3 Code and the ChatGPT Codex app.

Interactive prototype:
[`assets/hybrid-new-chat-prototype.html`](assets/hybrid-new-chat-prototype.html).
It is static HTML; open it in a browser. It is a design aid, not a component
source.

## Goal

1. **Keep starting a chat instant.** ⌘N keeps opening a draft immediately, with
   no prompt.
2. **Make choosing or adding a workspace easy from inside that draft.** The
   draft shows where it will run. The user can change the workspace, open or
   clone a folder, or choose a worktree without leaving the composer.
3. **Show composer context only when it applies.** The composer's top bar shows
   a chip only when it applies to this folder and this point in the chat.
4. **Create worktrees on first send.** Choosing "New worktree" on a draft
   creates nothing. The worktree is created when the first message is sent, so
   abandoned drafts no longer leave worktrees behind.

## Research summary

- **T3 Code** (`~/projects/opp/t3code`):
  - Every entry point opens a client-side draft. The thread, branch and worktree
    are created on first send (`ChatView.tsx` bootstrap → `ws.ts`).
  - With several projects, `mod+n` opens a "New thread in…" picker, and
    `mod+shift+n` creates the thread in the current project.
  - The draft headline ("What should we build in [project]?") is a project
    switcher.
  - The composer offers Current checkout / New worktree / Previous worktree, a
    base branch with "start from origin", and an environment picker that appears
    only when there is more than one environment.
  - Add project accepts a typed path (missing folders are created), a Git URL or
    a GitHub repo.
- **Codex app** (screenshots taken 2026-10-15):
  - A chip row above the composer holds Project ▾, Work in ▾ (This computer /
    Cloud / Remote) and a ⚙ menu (New worktree toggle, Branch, Environment).
  - The project menu has search, a list and **New project**, which opens a
    dialog for a name plus source folders, each on a chosen host.
  - The last project is remembered. With no project chosen, the chat has no
    project.

## Today

**Workspace binding**
- ⌘N, sidebar **New Agent**, `/new`, the palette and the workspace row ⋯ menu
  all call `openNewChat`, which makes a draft in the active workspace
  (`renderer/main/root-view.tsx`, `renderer/lib/chat-draft.ts`).
- The chat is bound to the workspace on first send
  (`main/services/chat-first-message-commit.ts`).

**Composer top bar** (`composer.tsx` ~L1857, `ComposerContextBar` in
`composer-context-bar.tsx`)
- It shows the workspace picker, then a static "Local" label (or the machine
  picker), then `GitBranchPicker` (git repos only), then
  `ChatPullRequestsChip`.
- **The PR chip has no visibility condition.** It reads "Pull Requests" on every
  draft, including plain folders and scratch chats.
- After the first user message the whole bar collapses
  (`autoHideComposerContext`, on by default, in Appearance), PR chip included.

**Workspace picker** (`workspace-picker.tsx`)
- A flat searchable list with no recents.
- It cannot open a folder or clone.
- "Don't work in a workspace" creates a scratch folder under `~/aiden`.
- Worktree workspaces appear next to their repos.

**Worktrees** (`git-branch-picker.tsx`, `/worktree`)
- "Isolated worktree" asks for a typed branch name and creates the managed
  worktree straight away from the current branch, through
  `git:createWorktree` → `workspaceWorktreeApplicationService.create`.
- It also registers the worktree as a workspace, so an abandoned draft leaves a
  worktree behind.

**Window header** (`chat-top-bar.tsx`, `.memory/chat-top-bar.md`)
- Already has a `WorkspaceChip` with the name, branch or "Not a Git
  repository", and GitHub links.

## Decisions

### 1. Defaults

**What ⌘N opens**
- ⌘N, **New Agent** and `/new` open a draft in the workspace of the chat being
  viewed. If no chat is being viewed, they use the last active workspace (the
  `aiden-agent.workspaceId` fallback, as today).
- If that workspace already has an empty draft, it is reused and focused.
- A draft with text or attachments is never reused.

**Remembered per workspace**
- The git mode (This checkout / New worktree), defaulting to This checkout.
- The base branch for new worktrees, defaulting to the repo's default branch.
- "Start from origin", defaulting to on when a remote exists.

**Draft headline**
- Reads "What should we build in **[workspace]**?". Clicking the name opens the
  workspace menu.
- A scratch chat reads "What's on your mind?".

### 2. Composer top bar: when each chip is shown

| Chip | Shown when | Hidden when |
| --- | --- | --- |
| Workspace | Draft | After the first send. The header `WorkspaceChip` already shows it. |
| Machine | A paired Mac is online, or the draft targets a paired Mac | No paired Macs. This removes the static "Local" label. |
| Branch | The folder is a readable git repo | Plain folder, scratch chat, folder missing, or workspace access off |
| Changes count (on the branch chip) | Uncommitted changes in this checkout | Clean checkout, or New worktree chosen |
| Pull request | GitHub remote **and** any of: branch ahead of base, a linked PR, a pending create intent | Plain folder, no GitHub remote, or nothing to open yet. It never shows on a draft. |

**Draft, git repo:**

```
[📁 workspace ▾] [💻 machine ▾]?  ……  [⎇ main ③ ▾]
```

With New worktree chosen, the branch chip uses the soft note fill:
`[🌲 New worktree · from main ▾]`.

**After the first send:**
- For a git repo, the bar shrinks to a one-line summary:
  `[⎇ aiden/fix-login]  ……  [⤴ Create PR | #482 · Open | Merged]`.
- For anything else, the bar is hidden.
- The workspace can no longer be changed.
- The branch chip keeps today's guarded git actions
  (`gitMutationBlockedReason`).

**`autoHideComposerContext`** becomes a choice between **Summary** (the new
default) and **Hidden**. The control stays in Settings → Appearance and follows
`docs/settings-design-system.md`.

**Motion**
- Chips enter and leave with the shared popup motion: 200 ms, fade plus a 4 px
  rise.
- Reduce Motion removes the transition.
- A PR chip that appears mid-chat is announced politely ("Pull request
  available") and takes no focus.

### 3. Workspace menu

The menu opens with its search field focused. From top to bottom:

1. **Recent:** up to 5 workspaces by latest chat activity, with relative times.
   - **All workspaces (n)** appears only when there are more than 5.
   - Typing searches all workspaces.
   - Worktree workspaces are left out; they live in the branch menu.
2. **Path rows:** when the query starts with `/`, `~` or `.`.
   - The folder exists → **Open \<path\>**.
   - Only the parent exists → **Create folder and open**.
   - Otherwise an inline error.
   - A path that is already a workspace selects it.
   - Path checks go through a new validated main-process call; the renderer
     never reads the filesystem.
3. **Actions**, always at the bottom:
   - **Open folder…** (⌘⇧O; ⌘O stays "Open workspace in preferred editor"), using
     the existing native dialog.
   - **Clone repository…** turns the menu into a URL field and an editable
     destination, defaulting to `<clone base>/<repo>`. The clone runs only when
     the user presses Clone, shows progress in the menu, and selects the result
     when it finishes.
   - **Scratch chat** replaces "Don't work in a workspace". It keeps today's
     `~/aiden` behaviour until a folderless chat is decided separately.

Choosing a workspace:
- keeps the draft's text, attachments and model;
- resets the git mode to the remembered value for that workspace;
- returns focus to the composer.

@-mentions that don't resolve in the new workspace get a soft warning.

### 4. Branch menu and worktrees created on send

This menu appears only for git repos. **Work in** is a radio group at the top:

- **This checkout:** shows the current branch and the change count, then the
  list of branches.
  - Picking a branch checks it out immediately, as today.
  - With uncommitted changes, the other branches are disabled. A note offers
    **Use a new worktree instead**.
- **New worktree:**
  - **Start from** lists base branches as radios.
  - **Start from origin/\<base\>** appears only when a remote exists.
  - **Branch name** defaults to Auto. The name is `aiden/<slug of the first
    message>`, made unique if needed, and can be edited.
  - Nothing touches disk until the first send.
- **Existing worktrees** (shown only if the repo has any): one row each, most
  recent first. Picking one moves the draft to that worktree's workspace.

**On first send in New worktree mode** (`chat-first-message-commit.ts`):

1. The message appears straight away, with an inline progress row: fetching
   origin, then creating `<branch>`, then ready.
2. Main runs the existing managed creation path
   (`workspaceWorktreeApplicationService.create`) with the base ref, the
   from-origin flag and the resolved name. All of today's guarantees are kept:
   hooks disabled, free-space check, `.worktreeinclude` provisioning.
3. The chat is saved in the new worktree workspace.
4. If creation fails, the chat stays a draft. The progress row offers **Retry**
   and **Run in this checkout instead**, and cancelling puts the text back in
   the composer.
5. Creation is idempotent per draft, so double sends and retries create at most
   one worktree.

**`/worktree`** in a draft switches the mode to New worktree. In a chat that
has already started, it keeps today's create-and-open behaviour.

### 5. Entry points

| Entry | Result |
| --- | --- |
| ⌘N, **New Agent**, `/new` | Instant draft (§1) |
| ⌘⇧N (new `chat.newIn`), or the chevron next to **New Agent** | **New chat in…** palette: recent workspaces (current one marked), path rows, Open folder, Clone. ↵ opens a draft; ⌥↵ opens it with New worktree selected. |
| Hover **+** on a sidebar workspace row | Draft in that workspace (today this is only in the ⋯ menu) |
| Headline workspace name, composer workspace chip | Workspace menu (§3) |

An open draft shows in the sidebar as an italic **New chat** row under its
workspace. The row moves when the draft switches workspace.

### 6. What happens immediately and what waits for the first send

| Action | Immediately | On first send |
| --- | --- | --- |
| New draft | Draft in memory, plus the sidebar row | Chat saved |
| Switch workspace or choose an existing worktree | Draft moves | — |
| New worktree, base branch, name | Draft fields only | Fetch (optional), create, register, save |
| Checkout (This checkout) | `git checkout`, guarded as today | — |
| Open folder or path | Workspace registered; a new folder is created only after choosing Create | — |
| Clone | `git clone` with the user's credentials, after pressing Clone | — |

Clone is a deliberate network action, comparable to a git push. It adds no
background or startup network calls.

## Phases

Each phase is its own PR off `main` and runs its narrow suites before review.

### Phase 1: Top-bar visibility (desktop renderer only, no contract change)

**Changes**
- A pure `composerContextChips(state)` in `renderer/lib/` decides which chips
  to show from workspace, git status, remote kind, paired hosts, stage and PR
  state.
- `composer.tsx` renders from that function.
  - The "Local" label goes when there are no paired Macs.
  - `ChatPullRequestsChip` renders only when its condition holds. It needs a
    cheap "branch ahead of base" signal from the existing git status read; if
    that read doesn't have it, start with linked or pending PRs only.
- `ComposerContextBar` gains the summary variant. The
  `autoHideComposerContext` setting becomes Summary / Hidden, migrating `true`
  to Summary and `false` to always-full. *(Check with the owner during review.)*
- The change count moves onto the branch chip.

**Tests**
- Unit tests for `composerContextChips`, written as a truth table over fixtures
  (not a copy of the implementation).
- Extend `tests/e2e/chat-top-bar.spec.ts` (or a sibling composer spec) with:
  - plain folder: only the workspace chip;
  - git repo with no remote: branch chip, no PR chip;
  - GitHub repo, after send, with a linked PR: summary plus PR chip;
  - no paired host: no machine label.
- Register new files in `package.json` and `scripts/ci-test-registry.json`.

### Phase 2: Workspace menu

**Changes**
- `workspace-picker.tsx`: recents, the All workspaces group, path rows, Open
  folder, the Clone sub-view, the renamed Scratch chat, worktree workspaces left
  out.
- The headline workspace name becomes a trigger for the same menu
  (`chat-pane.tsx`, near the empty state ~L3090).
- Main process:
  - `workspaces:inspectPath` returns exists / parent-exists / is-git /
    already-registered, after normalising and validating the path.
  - `workspaces:clone` takes a URL and a destination, runs `git clone` with no
    hooks and a bounded output, and reports progress events.
  - Both get parse/validate handler tests and IPC register-and-invoke tests.
- Onboarding: the workspace step mentions Open folder and Clone. Review the
  feature-tour tile.

### Phase 3: Branch menu and worktrees created on send

**Changes**
- `renderer/lib/chat-draft.ts`: add `gitMode`, `baseRef`, `fromOrigin` and
  `branchName?` to drafts, plus the per-workspace mode memory.
- `git-branch-picker.tsx`: the Work in radio group, the New worktree fields, and
  the escape hatch for uncommitted changes.
- `git:createWorktree` / `workspaceWorktreeApplicationService.create` accept a
  base ref, from-origin and an auto-name request. Existing callers keep working.
- `chat-first-message-commit.ts` creates the worktree before saving the chat,
  using an idempotency key per draft, with recoverable failure states.
- The progress row in the transcript reuses the activity-row styling.

**Tests**
- Main-service tests:
  - a send that succeeds creates one worktree;
  - a retry after a failure creates no duplicate;
  - a failure leaves no chat saved;
  - a name collision gets a unique name.
- An e2e flow covering draft → New worktree → send → summary chip shows the new
  branch.

### Phase 4: Entry points

- Add the `chat.newIn` command (⌘⇧N, native menu, palette, Settings
  keybindings) and a "New chat in…" mode in `command-palette.tsx`.
- Sidebar: the split chevron next to New Agent, the hover **+** on workspace
  rows, and the italic draft row. Reuse empty drafts.
- Add Playwright coverage for each entry point and for focus returning to the
  composer.

### Phase 5: Paired Macs and phones

- Desktop drafts on a paired Mac (`/host/$hostId/new`) get the same top-bar
  rules and workspace menu, fed by the host's project list.
- Creating worktrees on send for remote targets changes the new-chat contract
  in `aiden-remote-git` and the native clients.
  - It needs a Remote protocol revision, claimed at merge as `AGENTS.md`
    requires.
  - It needs updates to the iOS and Android new-chat flows.
  - Until then, phones keep the explicit worktree creation they use today.
- Mobile UI parity (the summary strip and the PR chip rules) is tracked here and
  planned when Phase 1 lands.

## Edge cases

- **Folder missing:** the workspace chip shows a warning, and sending is blocked
  with **Locate…** or **Remove**.
- **Repo with no commits yet:** the branch chip reads "No commits yet", and New
  worktree is disabled.
- **Detached HEAD:** the chip shows the short SHA. New worktree works from any
  base.
- **Workspace access off:** the git chips are hidden and the workspace chip
  says so, matching the header rule.
- **The folder becomes a repo during a draft** (for example `git init`
  elsewhere): the branch chip appears on the next git status refresh or focus.
- **A paired Mac goes offline during a draft:** the machine chip shows Offline
  and sending is blocked. Switching to This Mac keeps the text.

## Accessibility

- Chips are buttons with `aria-haspopup` and labels that include their state
  ("Workspace: aiden-agent", "Branch: new worktree from main").
- Work in is a `radiogroup`.
- Esc closes any menu and returns focus to the composer, which is never lost.
- Neutral `focus-visible` rings on chips. Menu search fields get no accent
  focus ring, per `AGENTS.md`.
- Status uses soft fills: the note fill for New worktree, the warning fill for
  the change count, and the PR colour for the PR chip. No coloured borders.

## Open questions

1. Should ⌘N use the workspace being viewed (proposed) or the last one a
   message was sent from?
2. Should a This checkout branch switch also wait until send? (Proposed: no. A
   checkout is a deliberate git action.)
3. Should the PR chip cover GitLab and other hosts, or stay GitHub-only as
   today?
4. Should the summary strip show the diff size (+12 −3) once the agent edits
   files? This overlaps with the Quick View Changes card.
5. Should a truly folderless chat replace the scratch folder? That was option D
   in the comparison; it would be a separate plan.

## Out of scope

- Projects with several source folders (Codex's model).
- Cloud execution.
- Automatic setup scripts (still open in the managed-worktree plan).
- Drag-and-drop of folders.
