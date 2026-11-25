# t3a-workspaces — Track 3 (work), part A

Scope: concepts 15 Workspaces, 16 Workspace detail, 8 Workspace run, 17 Git review, and the blank Workspace Settings sheet bug.
Repo: `ios-new-direction` worktree = origin/main `d476bc35d`. All paths are relative to the repo root. `iOS/` = `ios/AidenOnTheGo/`, `And/` = `android/app/src/main/java/sbtbiswas/AidenOnTheGo/`.

## Headline findings

1. **Blank sheet bug, root cause confirmed.**
   - `iOS/Features/Workspace/AidenWorkspaceDetailView.swift:32-34` keeps two pieces of state: `isShowingSettings` and `settingsContext`.
   - `:47-61` sets both in one action.
   - `.sheet(isPresented:)` at `:62-74` builds its content from a captured `settingsContext` that is still nil, so `if let` renders nothing.
   - Fix: `.sheet(item:)` with an Identifiable wrapper. This is phase 0 work: S size, low risk.
2. **The workspace `git` summary is in the contract but never sent.**
   - It is declared in OpenAPI (`protocol/aiden-remote/v1/openapi.json:11100`) and in the fixture.
   - Both clients decode it: iOS `Networking/AidenRemoteClient.swift` ~547-630 (`AidenWorkspaceGitSummary`), and Android `And/models/AidenWorkspaceEnvironment.kt:53`. Android already renders it at `And/features/workspaces/AidenWorkspaceShellScreen.kt:554,615-619`.
   - The demo hosts serve it (`iOS/Features/Remote/Demo/AidenDemoHosts.swift:809`).
   - The server never fills it: `projectAidenRemoteWorkspace` at `main/services/aiden-remote-workspaces.ts:102-125` has no `git` key.
   - So concept 15's "main · 3 changes" works in demo mode and fails on real hosts, on both iOS and Android.
   - Because the field is already in the schema, the fix is server behavior only: populate it from the cached `GitService.info()` (`main/services/git.ts:2578`). It needs **no new field and no new decoder on either client**.
3. **Concept 16's "Ask / Auto / Full" control and concept 17's per-file checkboxes go beyond the current contracts.**
   - The phone has only the tiers full/ask/none. PATCH accepts `permission` only (`main/services/aiden-remote-workspaces.ts:169-201`).
   - Commit accepts only `scope: all-reviewed | staged-reviewed` (`main/services/aiden-remote-git.ts:476-515`). The desktop has no per-file commit either (`main/services/git.ts:515-521`, `GitCommitMode = "staged"|"all"`).
   - The faithful versions are described below.
4. **Concept 16's "Terminal" tile has no Remote route.** No terminal route exists in `main/services/aiden-remote-router.ts`; the workspace routes are files (`:655`) and git (`:4220-4298`). Drop it, or replace it with Settings.
5. **Concept 8 is mostly composition of existing pieces.**
   - Activity summary: `AidenAgentActivityPresentation.summary` at `iOS/Models/AidenChat.swift:1866-1930`.
   - Elapsed time: `AidenTurnElapsed` at `iOS/Features/Chat/AidenTranscriptPolish.swift:8-40`.
   - Per-step `lineChanges`: `iOS/Models/AidenChat.swift:426-429,955`.
   - Task progress chip and sheet: `iOS/Models/AidenChatProgress.swift:172-340`.
   - Steer/queue: `AidenStreamInputMode` at `iOS/Models/AidenChat.swift:3265-3300`.
   - Stop: `AidenChatViewModel.stop()` at `iOS/Features/Chat/AidenChatViewModel.swift:2466` calls `/streams/:streamId/cancel` (`main/services/aiden-remote-router.ts:704`).
   - The one new piece is a client-derived "files changed" card. "12 of 40 *tests*" has no source; tasks are the faithful substitute.

---

## Concept 15 — Workspaces (list)

### 1. Entry and views
- The tab shell is `iOS/Features/Shell/AidenWorkspacesTabView.swift:35-98`.
  - With no installations it shows `AidenNoComputersEmptyView(surface: .workspaces)`.
  - Otherwise it shows `AidenWorkspacesDirectoryView` with the `AidenConnectionNotice` inset (`:102-142`).
- Route resolution is at `:144-158`; archived and `noWorkspace` workspaces are excluded. The route view is at `:161-214`.
- The list itself is `iOS/Features/Workspace/AidenWorkspaceDirectoryView.swift` (623 lines).

### 2. Live today
- **Data**
  - `coordinator` workspaces come from `GET /workspaces`, through `AidenRemoteWorkspacesService.list()` at `main/services/aiden-remote-workspaces.ts:285-299`.
  - Archive state is device-local (`workspaceArchiveStore`, footer copy at `AidenWorkspaceDirectoryView.swift:127-168`).
- **Layout**
  - Plain `List` with card rows using `AidenListCardPosition` (`:103-125`).
  - Multi-machine sections with `AidenMachineStrip` (`:56-101`).
  - "Archived Workspaces" is a NavigationLink, or a DisclosureGroup when the list is shown beside another pane (`:127-168`).
  - `.searchable(...).searchToolbarBehavior(.minimize)` (`:170-201`).
  - Toolbar: search, a plus menu (New Workspace / New Managed Scratch / Add Folder, `:339-361`), and `AidenNewWorkComposeButton`.
- **Row** (`AidenWorkspaceRow`, `:558-595`)
  - Icon: hammer, folder, or folder.badge.questionmark.
  - Detail: `permission.title · (branchName ?? git?.branch)`.
  - Swipe actions and a context menu with Rename/Archive/Remove (`:476-556`).
- **States**
  - Empty: ContentUnavailableView "No Workspaces".
  - Offline/connecting notice.
  - Loading via refreshable.

### 3. Concept delta
| # | Concept | Live | Faithful version |
|---|---|---|---|
| a | Active / Archived segmented control under the large title | NavigationLink card plus footer | Segmented `Picker` bound to the local archive store. Keep the footer sentence as the Archived segment's caption. Android already has this (`And/features/workspaces/AidenWorkspaceShellScreen.kt:93,498`). |
| b | Row detail `branch · N changes` | `permission · branch` (branch only for managed worktrees on real hosts) | `git.branch · N changes`, falling back to `branchName`. Permission moves to concept 16. Needs the server to fill `git` (headline 2). |
| c | Row title is the repo name | Workspace name | Keep the workspace name. A user can rename a workspace, and `repositoryName` is only sent for managed worktrees. |
| d | Single plus at top right; hamburger at top left | plus + compose + search | Shell track (T1A drawer). Keep search: concept 15 drops it, but iOS search over name/repo/branch (`:28-43`) is useful. Fold compose into the plus menu only if T1A removes per-tab compose. |
| e | Tab bar with a red Inbox dot | — | T1A. The AGENTS soft-status rule applies to badge styling. |

### 4. Gap class
- a: UI-only.
- b: server behavior plus cross-platform verification. No new field and no revision bump are needed, because the field already exists. Android benefits automatically.
- c: none.
- d, e: other track.

### 5. Implementation steps
1. **Server**
   - Make `projectAidenRemoteWorkspace` accept an optional `git?: {isRepo, branch?, uncommitted?}`.
   - In `list()` and `get()` (`main/services/aiden-remote-workspaces.ts:285-307`), add an injected `gitInfo?: (folderPath) => Promise<GitInfo>` option. Wire it in the host to `GitService.info()`, which is cached and coalesced (`.memory/git-display-read-performance.md`).
   - Bound it with an overall timeout so one slow repo cannot stall the list. Omit `git` on timeout or error. Skip `noWorkspace` and folderless workspaces.
   - Apply the same change in the `packages/cli` server wiring, since the CLI bundles `main/services`.
   - **Tests:** extend the existing workspaces service test with a fake `gitInfo` that returns a repo, a non-repo and a rejection. Assert the projected `git` and its absence. Also assert that a slow `gitInfo` still returns the list.
   - **Revision:** not required. The key is already in OpenAPI and fixtures, and both clients decode it optionally. If the owner wants discoverability, claim the next revision at merge time.
2. **iOS UI**
   - Add `AidenWorkspaceListScope { active, archived }` state to `AidenWorkspaceDirectoryView`.
   - Replace the Archived link and DisclosureGroup with a segmented `Picker` in a list header. Show the archived rows when `.archived` is selected.
   - Change `AidenWorkspaceRow.detail` to show branch · changes, using a pluralized "1 change"/"N changes" string.
3. **Demo:** already serves `git`. Add an archived workspace to `AidenDemoContent.workspacesJSON()` (`AidenDemoHosts.swift:796-812`) so the Archived segment has content.
4. **Tests**
   - XCUITest in `AidenShellUITests`: open Workspaces and check that the "Aiden Agent" row shows "feature/mobile · 2 changes". Archive a workspace, switch to Archived, see it, then Unarchive.
   - Unit test the row-detail builder: it prefers `git.branch`, omits a zero count, and falls back to `branchName`.

### 6. Effort and risk
- Effort: S (UI) + S/M (server).
- Risk: git status cost on large lists. Mitigate with the cached `info()` and the timeout.
- Dependency: T1A for the top bar and tab bar.

---

## Blank Workspace Settings sheet (bug)

### Root cause
`AidenWorkspaceDetailView.swift`:
- `:52-53` set `settingsContext = Self.settingsContext(...)` and then `isShowingSettings = settingsContext != nil` in the same transaction.
- `.sheet(isPresented:)` at `:62-74` evaluates its content closure with the stale optional, so `if let settingsContext` is false and the sheet is empty.
- `AidenRemoteRequestContext` is Equatable and Hashable but not Identifiable.

### Fix
- Add `private struct AidenWorkspaceSettingsPresentation: Identifiable { let context: AidenRemoteRequestContext; var id: AidenRemoteRequestContext { context } }`. `id` can be the context itself because it is Hashable.
- Replace the two `@State`s with `@State private var settingsPresentation: AidenWorkspaceSettingsPresentation?`.
- The menu action sets `settingsPresentation = Self.settingsContext(...).map(...)`.
- `.sheet(item: $settingsPresentation) { AidenWorkspaceSettingsView(..., context: $0.context, onRemoved: { settingsPresentation = nil; ... }) }`.
- `.onChange(of: owner)` and `.onChange(of: coordinator.defaultInstanceId)` (`:77-83`) set it to nil.
- Concept 16 moves Settings out of the overflow and promotes Files/Git, so this fix should land first and on its own (phase 0).

### Test
XCUITest in `AidenShellUITests`, on the demo "Aiden Agent" workspace:
1. Tap "Workspace menu", then "Workspace Settings".
2. Assert that the "Workspace Settings" nav title and the Name text field exist.
3. Cancel, reopen, and assert again.

The reopen step covers the regression.

---

## Concept 16 — Workspace detail

### 1. Entry and views
- `AidenWorkspaceRouteView` (`iOS/Features/Shell/AidenWorkspacesTabView.swift:161-214`, `.id(workspace.revision)`) leads to `AidenWorkspaceDetailView` (97 lines).
- That view wraps `AidenWorkspaceChatsView` (`iOS/Features/Chat/AidenChatsView.swift`, 184 lines).
- Model: `AidenWorkspaceChatsModel` (`iOS/Features/Chat/AidenWorkspaceChatsModel.swift`, 339 lines).
- Settings: `iOS/Features/Workspace/AidenWorkspaceSettingsView.swift` (235 lines).

### 2. Live today
- **Data**
  - `GET /workspaces/:id/chats`, via `remoteClient(for:).chats(workspaceId:)` (`AidenWorkspaceChatsModel.swift:94`). It is cache-first with authoritative admission.
- **Layout**
  - Inline nav title.
  - Header section with the name in `.title2.bold()` and `Label(permission.detail, "checkmark.shield")`.
  - Chats section of `AidenListRowLayout` rows with a `bubble.left` glyph, `AidenForkableChatTitle` and `AidenRelativeTimestampView`; swipe to rename/delete.
  - Empty state "No Chats".
  - Toolbar: ⋯ ("Workspace menu", containing only Workspace Settings) and "New chat" (`model.create()` then `onOpenChat`).
- **Files and Git**
  - They are hidden inside the Settings sheet as "Workspace tools" (`AidenWorkspaceSettingsView.swift:79-97`), both disabled when `!hasFolder`.
  - Files: `AidenWorkspaceFilesView`, `iOS/Features/Remote/AidenWorkspaceEnvironmentView.swift:493`.
  - Git: `AidenWorkspaceGitView`, `:1205`.
- **Permission**
  - Picker in Settings with the titles "Full access / Ask before actions / No access" (`:216-235`).
  - It saves through `PATCH /workspaces/:id` (`updateWorkspaceOutcome`).

### 3. Concept delta
| # | Concept | Faithful version |
|---|---|---|
| a | Large title is the repo name, with the branch under it | Large title is the workspace name. The subtitle is `git.branch ?? branchName` (from headline 2) using `.navigationSubtitle`. |
| b | Three tiles: Files / Git / Terminal | Files and Git tiles (UI-only; push the existing views). Terminal: **no route**. Replace it with a **Settings** tile, which also gives the fixed sheet a visible entry, or use two tiles. |
| c | Segmented "Ask / Auto / Full" | The phone can write only the tiers `full/ask/none` (`parsePatch`, `aiden-remote-workspaces.ts:169-201`). "Auto" is not a phone-writable state. **Option A (UI-only, recommended now):** segmented "Full / Ask / None" with short labels for the existing tiers. Keep the long detail text as a caption, and keep it confirmation-gated (`confirmedForeground`). **Option B (server and cross-platform):** expose the per-workspace `approvalMode` (`Use global / Ask / Auto / Never ask`, `renderer/shared/approval-mode.ts` `APPROVAL_MODES`) as a projection field plus a PATCH key, with a new revision for iOS, Android and fixtures. Caveat for A: `legacyWorkspaceTier` (`approval-mode.ts:283-290`) reads "full" for any mode that runs without a card. Writing `full` while the desktop's mode is Ask may read back as `ask`; verify the round-trip before shipping (open question 2). |
| d | Chats card with a running dot and short dates ("1d") | Running state is client-only. Join on chat id with `/chat-summaries` `rowState` (working, needs_approval, needs_input; `.memory/chat-row-states.md`), which the home model already holds (`iOS/Features/Workspace/AidenHomeModel.swift:65`). Use the shared row-status glyph from the Inbox (T1A) rather than a new dot. Short dates: a compact style of `AidenRelativeTimestampView`. |
| e | Bottom composer "Ask about aiden-agent" (+, mic) | Client model. Embed `AidenComposerSurface` (`iOS/Features/Conversation/AidenComposerSurface.swift`) with a workspace-scoped session. On send, `model.create()`, then post the first message and `onOpenChat`. This duplicates the toolbar "New chat"; drop that button. Coordinate with T1B (composer/slider) so the new-chat path is shared, not forked. |
| f | ⋯ menu | Keep it, holding Rename, Archive and Remove (from the list's context menu) plus Settings. |

### 4. Gap class
- a: UI-only, given headline 2's server fix.
- b: UI-only. Terminal is a server and cross-platform feature that is out of scope.
- c: Option A is UI-only; Option B is a server contract change (`main/services/aiden-remote-workspaces.ts` projection and `parsePatch`, OpenAPI `Workspace`, plus the fixture and a revision in `main/services/aiden-remote-protocol.ts`) and cross-platform.
- d: client state.
- e: client model, dependent on T1B.
- f: UI-only.

### 5. Implementation steps
1. Extract `AidenWorkspaceToolTiles` in `iOS/Features/Workspace/` (new file). It is a 2–3 column grid of squircle tiles using the shared button treatment, `docs/design-guide.md`.
   - Tiles disable with the reason "This workspace has no folder" when `!hasFolder`.
   - They push `AidenWorkspaceFilesView` and `AidenWorkspaceGitView` with the same arguments as `AidenWorkspaceSettingsView.swift:79-97`. Remove the "Workspace tools" section there, or keep it as a duplicate (open question 4).
2. Extract `AidenWorkspaceModePicker`.
   - A segmented `Picker` over `AidenWorkspacePermission`.
   - Changes are written through a confirmation dialog and `coordinator.updateWorkspaceOutcome`, reusing the Settings save path. Factor its save into a shared `AidenWorkspacePatchAction`.
3. Restructure `AidenWorkspaceChatsView`:
   - Header: the tiles and the mode picker.
   - Chats section: a "Chats" card with row-status glyphs and short timestamps.
   - Make the nav title large, with the branch as `navigationSubtitle`.
4. Add the bottom composer (after T1B lands its shared session).
5. **Demo:** the "Aiden Agent" workspace already has `git` and chats. Add `rowState: "working"` on one `workspace_app` chat so the running glyph shows in the workspace list (`AidenDemoHosts.swift:1142-1147` already has working rows; make sure one belongs to `workspace_app`).
6. **Tests**
   - XCUITest: the workspace detail shows Files and Git. Tap Git and the "Git" title appears.
   - Change the mode to Ask, confirm, and see the selection stick after a demo reply.
   - The running chat row exposes the "Working" accessibility value.
   - Unit test the summary-join helper: rowState mapping and a missing summary leading to idle.

### 6. Effort and risk
- Effort: M overall.
  - Tiles and header: S.
  - Mode picker: S (Option A) or M+ (Option B, cross-platform).
  - Composer: M (depends on T1B).
- Risk: the tier round-trip (c) and losing the long permission explanation. Keep it as a caption.

---

## Concept 8 — Workspace run (running coding chat)

### 1. Entry and views
- `AidenChatDetailView` (`iOS/Features/Chat/AidenChatDetailView.swift`; the scaffold is at `:645`, `AidenTranscriptScaffold(dock:)`).
- `AidenTranscriptScaffold` (`iOS/Features/Conversation/AidenTranscriptScaffold.swift:10-25`) sets `.navigationSubtitle(machine ?? "")`.
- Transcript: `AidenChronologicalTranscript.swift` (tool-step groups `AidenToolStepGroupView` at `:158`), with `AidenChatRows.swift:411` and `AidenLiveResponseView.swift:160` both rendering `AidenActivityFeed`.
- Dock: `AidenChatDock` (`iOS/Features/Conversation/AidenChatDock.swift`), which contains `AidenComposerSurface`.
- Approvals: `AidenTypedApprovalCard.swift` (in the transcript). Questions use `AidenDecisionDock` (`AidenDecisionDock.swift:1-23`; "Approvals are not here: they stay in the transcript").

### 2. Live today
- **Activity**
  - `AidenActivityFeed` (`AidenActivityFeed.swift:3-80`) shows a collapsible headline from `AidenAgentActivityPresentation.summary(timeline)`. Examples: "Explored 3 files, edited 2 files, ran 1 command" (`iOS/Models/AidenChat.swift:1866-1930`, matching the desktop).
  - It shows the last three steps while running and shimmers the active step.
  - Per-step `+a −d` comes from `lineChanges` (`AidenActivityFeed.swift:215`).
  - "Worked for 2m 14s" is a separate settled footer, `AidenTurnElapsed.workedForLabel` (`AidenTranscriptPolish.swift:20-22`), built from Mac timeline timestamps. Live shows "Working for …" (`:36-38`).
- **Progress**
  - `AidenChatProgressControls` (`iOS/Models/AidenChatProgress.swift:172`, mounted at `AidenChatDetailView.swift:1042`) shows a task chip ("N of M", active task) and an agents chip, which open `AidenChatProgressSheet` (`:340`).
  - Data comes from `/chats/:id/progress/events` (`main/services/aiden-remote-router.ts:687`).
- **Stop and steer**
  - Stop is `AidenComposerStopButton` (`AidenComposerSurface.swift:296-298,359`), wired to `model.stop()` (`AidenChatViewModel.swift:2466`), which calls `POST /streams/:streamId/cancel` (`router.ts:704`).
  - The busy-send pill switches Steer/Queue: `AidenStreamInputMode` (`AidenChat.swift:3265-3300`, "Add guidance without stopping" / "Run after this response"), `AidenChatComposer.swift:52,284`, posted to `/streams/:streamId/inputs` (`router.ts:705`).
  - Older hosts show `AidenDockCopy.noRunInput` (`AidenChatDock.swift:56`).
  - Placeholder: "Message Aiden" (`AidenChatComposer.swift:38`).
- **Header:** the chat title with the machine name as subtitle (multi-machine only).

### 3. Concept delta
| # | Concept | Faithful version |
|---|---|---|
| a | Subtitle "⑂ aiden-agent · fix/pairing-timeout" | `workspace name · branch`. The chat's `workspaceId` (`AidenChat.swift:2415`) resolves to an `AidenWorkspace` in the coordinator, with `git.branch ?? branchName`. Keep the machine name when more than one machine is paired: "Mac Studio · aiden-agent · fix/…", truncating the middle. Client-only. Applies only to workspace chats, not `noWorkspace` or Bot chats. |
| b | Collapsed pill "Worked 2m 14s · read 3 files, ran tests, edited 2 ›" | Combine the existing summary with elapsed time: "Working 1m 02s · …" while live and "Worked 2m 14s · …" when settled. Use the existing desktop-matching clauses ("Explored 3 files, ran 1 command, edited 2 files"), not invented ones like "ran tests". Duration comes only from the Mac timeline (`AidenTurnElapsed`), and the separate footer goes away to avoid saying it twice. **Cross-platform:** the summary string is shared desktop/iOS/Android (`And/models/AidenChat.kt:838`, `And/features/chat/AidenTranscriptPolish.kt:75`). Change the header composition on both phones together; leave the `summary()` text alone. |
| c | "2 files changed +18 −4" card with per-file rows and Review / Commit | **New, client-derived** `AidenRunChangesCard`. Group this turn's `write_file`/`edit_file` steps by `target` and sum `lineChanges`. Show it only for settled or active workspace chats with a folder and ≥1 change. Label it "Edited 2 files" because it counts this run's edits, not the working tree, which may hold other changes. **Review** pushes `AidenWorkspaceGitView`, using the `AidenWorkspaceGitTarget` deep link (`AidenWorkspaceEnvironmentView.swift:1176-1203`), with the file preselected. **Commit** must not commit directly: the server requires a reviewed `snapshotId` and `confirmedForeground` (`aiden-remote-git.ts:476-515`), so it opens the Git view's commit sheet (`:1471-1516`). Show Commit only when the device holds `git:write` (`router.ts:4220-4298`) and `review.capability.allowed` (`.memory/phone-git-commit-permission.md`). Use no decorative card border; use the palette's success and danger tokens for +/−. |
| d | "Running tests · 12 of 40 · Details" | No test-count source exists. Restyle the existing task chip as a single status line: `activeTask.title · completed of total` and "Details", which opens `AidenChatProgressSheet`. Hide it when there is no task list. Client UI only. |
| e | Composer "Steer or add a follow-up", mic, stop | Placeholder while running: "Steer or add a follow-up" when the host accepts run input; otherwise keep `noRunInput`. Stop and mic exist. Keep the Steer/Queue pill (it carries the semantics). Owned by T1B; this track just consumes it. |
| f | Approvals (scope brief) | Already in the transcript (`AidenTypedApprovalCard`). No delta beyond styling consistency. Keep the soft-status fills and no badge borders. |
| g | Header ⋯ | Existing chat menu. No delta. |

### 4. Gap class
- a, d: UI and client state.
- b: UI, cross-platform (Android header parity).
- c: client model plus UI. It touches shared transcript/activity UI, so the Android equivalent goes beside `And/features/chat/AidenChatDetailScreen.kt:2492` (`lineChanges` rendering).
- e: other track (T1B).
- f, g: none.
- **No server contract change for concept 8.**

### 5. Implementation steps
1. `iOS/Features/Chat/AidenRunChanges.swift` (new):
   - A pure `AidenRunChanges.from(timeline:) -> [(path, additions, deletions)]` that takes the latest `edit_file`/`write_file` per target, ignoring blocked and cancelled steps (as `summary` does).
   - `AidenRunChangesCard` view.
   - Mount it under the assistant message whose timeline has changes, in `AidenChatRows.swift` near `:411`.
2. Add `AidenAgentActivityPresentation.headline(timeline:now:)` that prefixes the elapsed time. Use it in the `AidenActivityFeed` header (`:26-34`) and drop the duplicate "Worked for" footer row (`AidenChatRows.swift:339`).
3. Restyle the task chip as a line (`AidenChatProgress.swift:172-330`).
4. Add the subtitle helper `AidenChatContextSubtitle(chat:, workspace:, machine:)` in `AidenTranscriptScaffold` (`:24`).
5. **Android parity in the same PR:**
   - `AidenRunChanges` in Kotlin, next to `And/models/AidenChat.kt` summary.
   - Card in `AidenChatDetailScreen.kt`.
   - Header elapsed prefix in `AidenTranscriptPolish.kt`.
   - Android UI must use the M3 Expressive layer (memory).
6. **Demo**
   - Extend the coding chat fixture (`AidenDemoHosts.swift:1306-1325`, "Rename the onboarding assets") with `edit_file` steps carrying `lineChanges` and a task progress snapshot.
   - Add a `running` coding chat for the `busy` scenario of `AidenStateMatrix` (`ios/AidenOnTheGoUITests/AidenStateMatrix.swift:13`).
7. **Tests**
   - Unit (`AidenOnTheGoTests`): `AidenRunChanges` sums per file, keeps the last write of a re-edited file, excludes blocked and cancelled steps, and returns empty for a chat without edits.
   - Unit: the headline uses Mac timestamps; there is no duration while the timeline is missing.
   - XCUITest: open the coding chat, see "Edited 2 files" and tap Review, landing on the Git view with the file. Commit opens the commit sheet and does not commit.
   - Android JVM test for the same pure function, and a rendered test for the card.

### 6. Effort and risk
- Effort: M (iOS) + M (Android parity).
- Risk:
  - "Edited N files" vs the working tree. Copy must not claim they are uncommitted.
  - Duplicate elapsed labels during the transition.
- Dependencies: T1B (composer placeholder and steer), T2A (any shared transcript restyle).

---

## Concept 17 — Git review (`AidenWorkspaceGitView`)

### 1. Entry and views
- Today it is reached only through Settings → Workspace tools → Git (`AidenWorkspaceSettingsView.swift:79-97`), and by the deep link `AidenWorkspaceGitTarget` (`AidenWorkspaceEnvironmentView.swift:1176-1203`).
- View: `:1205-1579`. Model: `AidenWorkspaceGitModel` at `:856`.

### 2. Live today
- **Routes** (`main/services/aiden-remote-router.ts:4220-4298`)
  - Read (`git:read`): GET `review`, POST `diff`, GET `branches`, GET `push-capability`, POST `compare`, POST `comparison-diff`, GET `worktrees`.
  - Write (`git:write`, with an idempotency-key header): POST `branches`, `checkout`, `commit`, `push`, `worktrees`, and DELETE managed-worktree.
  - Projections: `main/services/aiden-remote-git.ts:49-58`.
- **Layout**
  - Grouped list: Repository (Branch, Changes, `:1244-1247`).
  - Working changes (`:1248-1266`): file buttons with a status letter tinted `.green/.red/.orange`, which are **raw system colors**, plus `+a −d` (`:1541-1565`). Also the hidden-changes note.
  - Compare (`:1269`).
  - Actions (`:1275-1296`): "Commit reviewed changes", "Push reviewed commit", "Compare branch".
  - Branches with checkout and New Branch (`:1298-1315`).
  - Managed worktrees (`:1317-1323`).
  - Status and Retry (`:1325-1345`).
- **Commit sheet** (`:1471-1516`): message, "Staged changes only" toggle, Review Commit, then the confirmation "Commit the reviewed snapshot?".
- **Diff sheet** (`:1518-1539`): plain monospaced text with no line coloring.
- **Demo:** `AidenDemoHosts` serves no git routes (brief). Live shot 17 used scratch data.

### 3. Concept delta
| # | Concept | Faithful version |
|---|---|---|
| a | Branch as a large title; totals "+86 −23" | Large title "Git" with the branch as subtitle, or the branch as title with the workspace as subtitle. Totals are summed client-side from review files `additions`/`deletions`. If any file lacks stats (`unavailableStats`), show the totals as "≥" or omit them. |
| b | Per-file checkboxes, one unchecked | **Not supported:** commit takes only `all-reviewed`/`staged-reviewed` and there is no per-file commit on desktop either. Faithful: a **read-only list** with each file's staged state shown as a leading glyph. Where staging differs, a segmented "All changes / Staged only" control maps to the existing `scope`. True per-file selection would need a server contract change (a new `paths[]` commit scope in `aiden-remote-git.ts:476-515`, `git.ts` `GitCommitMode`, OpenAPI, a revision, iOS, Android and fixtures) **plus** desktop parity. Recommend deferring it (open question 3). |
| c | Inline commit-message field plus a full-width Commit button | UI-only. Move the message field and primary button inline at the bottom (safe-area bar). Keep the snapshot review step: tapping Commit runs the existing review, then the confirmation. Text field: filled input with no focus accent border (AGENTS). |
| d | ⋯ menu | Move Compare, Branches (checkout or new), Push and Worktrees into the ⋯ menu or a secondary "More" page. UI-only. |
| e | Status colors | Replace `.green/.red/.orange` (`:1541-1565`, `:1581-1600`) with `aidenPalette` success, danger and warning tokens, as soft fills or icons only. |
| f | Diff viewer | Line coloring for `+`/`-`/`@@` lines using soft token fills, monospaced, with horizontal scroll. UI-only. A shared `AidenDiffText` is also used by concept 8's Review. |

### 4. Gap class
- a, c, d, e, f: UI-only.
- b: UI-only (faithful version) or a server contract change plus cross-platform (true per-file selection; deferred).
- Android `AidenGitScreen.kt` already has commit message and staged-only checkbox (`:474-518`). It needs no change unless b is pursued.

### 5. Implementation steps
1. Split `AidenWorkspaceGitView` into:
   - `AidenGitReviewScreen`: header, file list, inline composer.
   - `AidenGitMoreMenu`: the existing actions and branches sections, moved.
   - Keep `AidenWorkspaceGitModel` unchanged.
2. Extract `AidenDiffText` (shared with concept 8) and `AidenGitFileRow` (token colors and stats).
3. Inline commit bar: bind the message and scope picker to the existing commit flow (`:1471-1516` logic stays, minus the sheet).
4. **Demo:** add git routes to `AidenDemoHosts` (review, diff, branches, push-capability, commit with a snapshot) for `workspace_app`, matching `aiden-remote-git.ts` projections. This also unblocks App Store screenshots and the XCUITests.
5. **Tests**
   - XCUITest: open Git from the workspace tile and see "+N −M" totals and file rows.
   - Tap a file and the diff shows.
   - Type a message, tap Commit, see the confirmation, and confirm; the demo reply shows the committed state.
   - Without `git:write`, Commit is disabled with the reason.
   - Existing `AidenWorkspaceEnvironmentTests` (unit) stay. Add a totals unit test covering missing stats.

### 6. Effort and risk
- Effort: M.
- Risk:
  - The commit snapshot semantics must survive the inline move.
  - Demo routes must not drift from the server. Validate demo JSON against the contract fixtures if a helper exists.
- Dependency: concept 16 tiles (the entry point).

---

## Shared components to extract
- `AidenWorkspaceSettingsPresentation` (Identifiable sheet item). Reuse it for any context-scoped sheet with the same pattern; grep `.sheet(isPresented:` paired with an optional context.
- `AidenWorkspaceToolTiles`: squircle tile grid.
- `AidenWorkspaceModePicker` and `AidenWorkspacePatchAction`: shared PATCH-with-confirmation used by Settings and detail.
- `AidenWorkspaceRowDetail`: branch · changes formatter, shared by the list and the detail subtitle.
- `AidenChatRowStatusGlyph`: from the Inbox (T1A); reused in workspace chats.
- `AidenRunChanges` with `AidenRunChangesCard` (iOS and Android).
- `AidenDiffText` and `AidenGitFileRow`: Git review and Run Review.
- `AidenChatContextSubtitle`: workspace · branch (· machine).

## Phase order
0. **Bug fix:** `.sheet(item:)` and its XCUITest. Ship alone.
1. **Server:** fill the workspace `git` summary (cached `info()`, bounded), with service tests. Verify iOS and Android render it. No revision is needed.
2. **Concept 15:** Active/Archived segment, row detail, demo archived workspace, tests.
3. **Concept 17:** demo git routes first, then the Git review restyle (inline commit, ⋯ menu, tokens, diff coloring).
4. **Concept 16:** tiles (Files/Git/Settings), the Option A mode picker, row status, subtitle. Add the composer after T1B.
5. **Concept 8:** `AidenRunChanges` card, headline with elapsed time, progress line, subtitle — iOS and Android in one PR.
6. (Deferred, owner decision) Option B per-workspace approval mode; per-file commit; Terminal.

## Open questions for the owner
1. **Terminal tile:** drop it (recommended; there is no Remote route) or plan a terminal route? A terminal route is a large, security-sensitive server and cross-platform feature.
2. **Mode control:** ship Option A (Full / Ask / None tiers, UI-only) now, or invest in Option B (per-workspace Use global / Ask / Auto / Never ask, revision bump on iOS, Android and fixtures)? Also confirm the tier round-trip: does writing `full` while the desktop mode is Ask read back as `full`?
3. **Per-file commit checkboxes:** accept the faithful version (read-only list plus All/Staged scope), or add per-path commit on server and desktop?
4. Should Files and Git stay duplicated in Settings → Workspace tools once they are tiles on the detail page?
5. Concept 8's "Commit" on the run card: is opening the reviewed commit sheet acceptable, or should Commit be hidden on phones without `git:write`? The plan hides it.
6. Should the activity pill's duration replace the separate "Worked for" footer on both phones, and on desktop for parity?
