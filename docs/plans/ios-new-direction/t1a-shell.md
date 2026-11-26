# t1a-shell: Core shell and navigation, part A (concepts 1 Home, 7 Inbox, 2 Dock recents, 3 Drawer)

Repo: `ios-new-direction` @ d476bc35d (== origin/main), read-only. All paths below are relative to `ios/AidenOnTheGo/` unless they start with `docs/`, `android/` or `ios/`.

## 0. The IA decision (read this first)

The concept has two screens that both map to today's **Inbox** tab:
- **Home (01)**: greeting, Bot sprites, a "From your Bots" card, a composer and a dock.
- **Inbox (07)**: All / Needs you / Done triage with inline approval and question cards.

Today the Inbox tab is both things at once. It is the app's root (`Tab("Inbox"…)` at `Features/Shell/AidenAppShellView.swift:285`), and it lists Needs you, Updates, Earlier and Running (`Features/Shell/AidenInboxTabView.swift:60-139`).

**Proposed IA: four dock tabs, Chats · Bots · Workspaces · Inbox.** This follows the concept's order. There is no Search tab and no Settings tab.

| Concept surface | New home | Today's source |
|---|---|---|
| Home (01) | Root of a new **Chats** tab (`AidenAppTab.chats`). Shows the greeting, Bot sprites, a "From your Bots" digest of at most 3 rows, and the composer slot (owned by t1b). | Catch Up row, machine strip, `AidenHostStatusItem` and the compose button, all from the Inbox root (`AidenInboxTabView.swift:223-285`, `:463-469`; `AidenAppShellView.swift:571`) |
| Inbox (07) | The **Inbox** tab, which moves to the last dock slot and carries the red dot. It is triage only: segments All · Needs you · Done, and cards with inline actions. | `AidenUnifiedInbox` sections (`Models/AidenUnifiedInbox.swift:92+`), triage actions (`Features/Shell/AidenUnifiedInboxStore.swift:237-252`) |
| Dock recents (02) | Tapping the **already-selected** dock tab opens a popover of that tab's recent items. Running items show a spinner. | Running accessory and running sheet (`Features/Shell/AidenRunningAccessory.swift:54-210`) |
| Drawer (03) | A left drawer holding Pinned, Recents, the Settings gear, a Search field and a compose button. It replaces the Search tab and the Inbox "…" menu. | Search tab (`AidenAppShellView.swift:309-320`), Inbox toolbar menu with Settings, Scheduled and Usage (`AidenAppShellView.swift:552-575`) |

Why Home is a **Chats** tab and not a filter on Inbox:
- The concept's dock literally labels the first tab "Chats".
- The composer starts a new chat, so it belongs with chats, not triage.
- Inbox keeps a single job, which is triage. That makes its red dot meaningful (`.badge(inboxStore.needsYouCount)`, `AidenAppShellView.swift:290`).

Shell-level hooks for Aurora (Aurora rendering itself is 4B's job):
- **`AidenAmbientActivity`** (new, `Features/Shell/AidenAmbientActivity.swift`): an enum with cases `idle, working, listening, needsYou, done, failed`.
- **`AidenAmbientActivitySource`**: an `@Observable` derived only from data that already exists:
  - `inboxStore.hasRunningChats` (`AidenUnifiedInboxStore.swift:40`) gives working;
  - `needsYouCount` (`:37`) gives needsYou;
  - failed rows (`AidenChatSummary.lastRunFailed`, `Models/AidenChat.swift:2641+`; `AidenInboxRowStatus` Failed at `Features/Remote/AidenInboxViews.swift:80-82`) give failed;
  - a transition from running to not-running with no failure gives `done` for 2 s, then `idle`;
  - t1b's voice state gives listening (see §6).
- **Priority**: listening > needsYou > failed > working > done > idle. These are the Aurora spec states; the ordering is my proposal, and 4B can override it.
- **Environment key `\.aidenAmbientActivity`**: set once on the TabView, beside the existing `.environment(\.aidenTabsInSideRail…)` at `AidenAppShellView.swift:332`.
- **Background slot `.aidenAmbientBackground { … }`**: a shell `ZStack` layer drawn under the dock and the Home composer (bottom 400 pt, ignores the bottom safe area). The shell owns the slot and its placement; 4B supplies the view.
- **Opt-outs**: Reduce Motion and Low Power are already in the environment (`Config/AidenAppearance.swift:757`, `:764`). The slot passes them through and does not decide them.

---

## 1. Home (concept 01)

### 1.1 Entry point and views
- Today there is no separate Home. The app root is the Inbox tab (`AidenAppShellView.swift:285-295`), built by `ContentView.swift:218` (`AidenAppShellView(… routeRequest: $shellRoute, tabRequest: $shellTab)`).
- Root view: `AidenInboxTabRootView` (`Features/Shell/AidenInboxTabView.swift:412-512`):
  - nav title "Inbox" at `:462`;
  - `AidenHostStatusItem` ("N of M" computers) at `:463-469`, defined at `Features/Shell/AidenMachineChrome.swift:443-488`;
  - notice banner at `:483-511`.
- Toolbar: `inboxToolbar` (`AidenAppShellView.swift:552-575`), with a "…" `Menu` (Settings, Scheduled, Usage, `:555-562`) and `AidenNewWorkComposeButton` (`:571`, defined at `Features/Shell/AidenNewWorkChatFlow.swift:281-317`).

### 1.2 What's live
- **Layout**: a plain List with these rows:
  - the Catch Up row (`AidenInboxTabView.swift:223-255`);
  - machine rows (`:259-285`);
  - sections Running, Needs you, Updates and Earlier (`:119-139`, rows `:142-185`).
- **Data**:
  - `AidenUnifiedInboxStore` (`AidenUnifiedInboxStore.swift:27`) polls each paired machine through `refreshAll()` (`:133`).
  - Chat summaries come from the client's chat list. Bot rows come from the roster (`readHiddenMachinesBots` `:175`, `botSections()` `:201`).
  - Phones cannot use the host feed (`docs/aiden-remote-api-v1.md:399-403`), so polling is the only option.
- **Bot rows**: `AidenInboxBotRowView` (`AidenInboxTabView.swift:538-604`) draws **`AidenBotAvatarSymbol`** (`:607-621`), a circle with the initial letter. This violates the AGENTS.md / memory rule that Hi-bit is the only Bot avatar.
- **States**:
  - empty-state ContentUnavailableViews (`AidenInboxTabView.swift:357-398`);
  - `listState` (`AidenUnifiedInboxStore.swift:41`) for loading and failure;
  - `notice` (`:46`) for offline machines;
  - the reconnect banner (`ContentView.swift:198-207`).
- **Compose**: the "New chat" button opens `AidenNewAgentPopover`, plus a machine picker when there are several machines (`AidenNewWorkChatFlow.swift:281-317`). The workspace chooser sheet, the new-workspace alert and the creating overlay come from `aidenNewWorkPresentation` (`:378-380`).

### 1.3 Concept delta
| # | Concept | Live | Note / faithful version |
|---|---|---|---|
| H1 | Hamburger at top left opens the drawer | None | New; see §4 |
| H2 | Machine chip "● Studio Mac ⌄", centred | `AidenHostStatusItem` "N of M", which opens Computers | Chip = the default machine's name and status dot. Tapping it opens a menu of paired machines (reuse `AidenMachineRoster` `AidenMachineChrome.swift:44` and the picker inside `AidenNewWorkComposeButton`) plus "Manage computers…" (today's destination). Selection writes `coordinator.defaultInstanceId` (already observed at `AidenAppShellView.swift:436`). |
| H3 | Three Hi-bit sprites in a row | None | Show up to 3 Bots from the roster, ordered needs-you, then running, then most recent, drawn with `AidenBotSemanticAvatarView(…, state:)`. Depends on **PR #925** (open, `claude/hibit-sprite-avatars`), which turns that view into the sprite and adds `AidenBotAvatarState`. On main today the view takes `working: Bool` (`Features/Bots/AidenBotSemanticAvatarView.swift:120-126`). |
| H4 | "Good afternoon, Sambit" | None | **Contradiction**: the phone does not know the person's name. The Remote API forbids sending local usernames (`docs/aiden-remote-api-v1.md:128`). Faithful version: "Good afternoon" (time of day, local) with no name, *or* a device-local "What should Aiden call you?" field (see open questions). Do not pull the Mac's username. |
| H5 | "Your Bots worked while you were away" | Catch Up row ("N to catch up") | Subtitle shows only when the digest below has items newer than the last time Home was shown. Keep Catch Up as the digest's "See all" when items are unread (`AidenAppNavigation.startCatchUp` `Features/Shell/AidenAppNavigation.swift:629-660`). |
| H6 | "From your Bots" card: rows of avatar, Bot name, preview line and a "Needs you" chip; "See all" | Bot rows show the name and reason only. `AidenBotSummary` has **no preview text** (`Models/AidenBot.swift:323-340`). | Data: (a) Bots with `AidenBotAttention.needsYou` / `isRunning` (`Models/AidenUnifiedInbox.swift:27-49`) give the chip and reason; (b) the routine feed `GET /bots/routine-notifications?since=` (`Models/AidenBotRoutine.swift:649-712`, client `Networking/AidenRemoteClient.swift:3129`, already polled by `AidenBotRoutineNotifier` `Features/Remote/AidenScheduledRunNotifier.swift:273+`) gives `preview` ("start of the reply, redacted on the Mac") and `finishedAt`. A digest row = Bot attention ∪ latest routine notification per Bot. "See all" switches to the Inbox tab, with the filter set to Bots in triage. |
| H7 | Composer pinned above the dock: "+ Ask anything or hold to talk", mic, black voice button | Compose button opens a popover | **t1b owns the composer.** The shell provides the slot (§6). Concept detail to respect: the voice button is a filled primary action, which is fine. "+" opens attachments (t1b). |
| H8 | Dock: 4 icon tabs, label on the selected one only, red dot on Inbox | System tab bar: 4 labelled tabs, Search role, numeric badge | See §3. Keep the system TabView. Accept system labels (all labelled) unless the owner wants the custom dock (open question). A numeric badge is more accessible than a dot. Keep the badge and its accessibility value (`AidenAppShellView.swift:291-294`). **Decided 2026-11-25: the owner chose the custom dock at compact width** (`AidenDock`). It shows the dot; VoiceOver hears the count in the Inbox tab's name ("Inbox, 3 chats need you"), because a tab bar's value is its selection state. The sidebar at regular width keeps its numeric badge. |
| H9 | Light canvas, Aurora glow behind the composer and dock | None | Shell slot only (§0); 4B renders. |

### 1.4 Gap class
- H1, H2, H5, H7 slot, H8, H9 slot: **UI-only**.
- H3: **UI-only**, dependent on PR #925.
- H4: **client model/state** (device-local name) or nothing. A server profile field would be a **server contract** change; not recommended.
- H6:
  - **client model/state**: join roster attention with the routine-notification feed. A new `AidenHomeDigest` model; both feeds already exist.
  - If the owner wants a preview for *interactive* Bot replies (not just routines), that is a **server contract** change. The likely shape is an optional `lastActivityPreview` on the Bot summary (`AidenBotSummary` decode, `Models/AidenBot.swift:323`). It needs a protocol revision bump with iOS, Android and fixtures. Not needed for v1.
- Cross-platform: Android has no Home either. Its product areas are `BOTS, WORKSPACES` (`android/app/src/main/java/sbtbiswas/AidenOnTheGo/persistence/AidenProductNavigationStore.kt:11-14`). Android parity is a separate decision (open question); nothing here forces it.

### 1.5 Implementation steps
1. `Models/AidenHomeDigest.swift` (new):
   - `struct AidenHomeDigest { rows: [Row]; hasNewSince(Date) }`, built by a pure `make(roster:attention:routineNotifications:now:)`.
   - Rows are ordered needs-you, then running, then newest `finishedAt`, with a maximum of 3 rows. "See all" shows when there are more than 3.
2. `Features/Shell/AidenUnifiedInboxStore.swift`:
   - Add `var digest: AidenHomeDigest`, refreshed in `refreshAll()` (`:133`).
   - Fetch the routine feed per machine with the same `since` cursor that `AidenBotRoutineNotifier` keeps. Share a reader so the feed is not fetched twice per refresh. Do not advance the notifier's delivered-id set from Home.
3. `Features/Shell/AidenHomeView.swift` (new): the root of the Chats tab.
   - Contents: the greeting header (`AidenGreeting.make(date:name:)`, pure), `AidenBotSpriteRow`, `AidenFromYourBotsCard`, and `AidenHomeComposerSlot` (t1b's view goes here).
   - Loading: digest skeleton rows (house rule for optimistic phones).
   - Empty: no Bots → "Make your first Bot" (routes to Bots creation); no machines → reuse the existing no-computers CTA (`openAddComputer`).
4. `Features/Shell/AidenMachineChip.swift` (new): extract from `AidenHostStatusItem` (`AidenMachineChrome.swift:443-488`).
   - Keep accessibility id `aiden.machine-status` so `testTheStatusItemCountsMachinesAndOpensThem` (`AidenOnTheGoUITests/AidenShellUITests.swift:924`) can be updated rather than rewritten.
5. `Features/Shell/AidenAppShellView.swift`: add `Tab("Chats", …, value: .chats)` first, with `AidenHomeView` as its root (§5 covers the tab-enum migration).
6. Demo:
   - `Features/Remote/Demo/AidenDemoHosts.swift` and `AidenDemoBotUX.swift` do **not** serve `GET /bots/routine-notifications` today (grep finds no route). Add it with 2-3 items, at least one `failed`. Make sure ≥1 Bot needs you and ≥1 has a fresh routine preview.
   - `AidenOnTheGoUITests/AidenStateMatrix.swift:11-60`: add a `home` capture for scenarios `busy`, `empty` and `one`.
7. Tests (behavioral):
   - Unit `AidenHomeDigestTests`: ordering, the cap and "See all", the hasNewSince cutoff, and a Bot that both needs you and has a routine shows once.
   - Unit `AidenGreetingTests`: time-of-day buckets at boundaries; no name gives no trailing comma.
   - XCUITest `AidenShellUITests`:
     - `testHomeShowsDigestAndOpensBot`: tap a digest row → Bot chat opens on the Chats tab path.
     - `testHomeSeeAllOpensInbox`.
     - Update `testAllFourTabsExistInEveryScenario` (`:20`) for the new tab set.

### 1.6 Effort / risk / deps
- **M.** Risk: medium. Home duplicates Inbox information unless the digest stays capped and Bot-focused.
- Deps:
  - PR #925 (sprites);
  - t1b composer slot;
  - 4B Aurora view;
  - t3b Search, because Search moves into the drawer.

---

## 2. Inbox (concept 07)

### 2.1 Entry point and views
- Inbox tab (`AidenAppShellView.swift:285`) → `inboxList(selection:)` (`:483-506`) → `AidenInboxTabView` (`AidenInboxTabView.swift:60-116`).
- Rows: `AidenInboxRowView` (`Features/Remote/AidenInboxViews.swift:268`), `AidenInboxListRow` (`:584`) and `AidenInboxBotRowView` (`AidenInboxTabView.swift:538`).
- Swipe and context actions: `AidenInboxTabView.swift:189-207`, which call `AidenUnifiedInboxStore.perform` (`:237-252`): markRead/done/undone/snooze/wake/delete through `setTriage`.

### 2.2 What's live
- **Sections**: Running (when the accessory can't show), Needs you, Updates, Earlier (with overflow) (`Models/AidenUnifiedInbox.swift:92+`).
- **Buckets**: `needs_you, pinned, updates, earlier, working, snoozed, done`, rev 52 (`Models/AidenInbox.swift:6-14`). Tiers: approval=0, input=1 (`:152-154`).
- **Status chips**: Approval / Question / Failed / Done / Snoozed (`AidenInboxViews.swift:64-104`).
- **Approve/answer**: tapping a row opens the chat, and the approval card is answered there:
  - `AidenChatViewModel.respondToApproval(button:approvalID:)` (`Features/Chat/AidenChatViewModel.swift:2768`);
  - foreign runs: `respondToForeignApproval` (`Features/Chat/AidenChatViewModel+ForeignRuns.swift:589`).
- **Summaries carry no prompt detail**: `AidenChatSummary` has no command or question options (`Models/AidenChat.swift:2641+`; `docs/aiden-remote-api-v1.md:292-294`). `attentionSummary` exists only on the host-feed `run.state` (`docs/aiden-remote-api-v1.md:1104-1144`), which phones are refused (`:399-403`).
- **Filter**: there is a machine filter (`AidenUnifiedInboxStore.swift:51-53`, `AidenMachineFilter` `Models/AidenUnifiedInbox.swift:52-55`). There is no segment filter.
- **States**: the empty-state family at `AidenInboxTabView.swift:357-398`; "caught up" when only running items exist (`AidenRunningHome.leavesListEmpty`, `AidenRunningAccessory.swift:18-21`).

### 2.3 Concept delta
| # | Concept | Live | Note |
|---|---|---|---|
| I1 | Hamburger plus a large title "Inbox" plus an ellipsis menu (Mark all read, Filter by machine) | Large title, "…" holds Settings, Scheduled, Usage | Settings, Scheduled and Usage move to the drawer. The ellipsis keeps Inbox-only actions: Mark all read (loop over `perform(.markRead)`), machine filter (existing). |
| I2 | Segments All · Needs you · 2 · Done | Sections, no segments | A segmented `Picker` above the list. All = today's sections. Needs you = `inbox.needsYou`. Done = the triage `done` bucket. Note: Done needs `supportsTriage` (`AidenHostInboxSnapshot.supportsTriage`, `Models/AidenUnifiedInbox.swift:5-22`); on old hosts the segment is hidden. |
| I3 | Approval card: Bot or chat title, "wants to run", command preview in a code block, buttons Deny / Always / Allow once | A row with an "Approval" chip | Needs approval details on the phone. **Option A (client-only, recommended for v1)**: when a needs-approval card is visible, lazily load the pending approval. For a phone-started run: `GET /streams/{id}/approval` (`Networking/AidenRemoteClient.swift:3708`), answered with `POST /approvals/{id}/respond` (`:3737`). For any run: the `GET /chats/{id}/runs/current/events` SSE (`:3809`), whose `approval_required` event carries `{approvalId, summary, toolCallId, toolName, canAllow, scopes?}` (`docs/aiden-remote-api-v1.md:418-427`) and the rev-61 typed `card` (title, body `{format: command|text}`, buttons, `allowOnMac`; `docs/aiden-remote-api-v1.md:1335-1372`; `AidenRemoteRunApproval` `Networking/AidenRemoteContract.swift:3904`), answered with `POST /runs/{runId}/approvals/{approvalId}/respond` (`AidenRemoteClient.swift:3849`). Render buttons **from the card**, not the concept's fixed trio. Card buttons are Deny / Allow once / Allow in this chat / Always allow; show the first 3 inline and the rest under "More". `allowOnMac` cards show "Approve on your Mac" and no Allow button. **Option B (server contract)**: add an optional `pendingApproval: {approvalId, runId, card}` to chat summaries for phones. That is a protocol revision bump (next rev after main's) with iOS, Android and fixtures. Cheaper on the network, but cross-platform. |
| I4 | Question card: the question text plus quick-reply chips | "Question" chip | The same split. Question text and options come from the run's current events (`needs_input`). If the run does not expose options, chips fall back to "Reply…" (opens the chat with the composer focused). Do not invent options. |
| I5 | "Earlier today" section header | "Earlier" | Copy only: date-bucketed headers (Today / Earlier today / Yesterday / date). Keep the overflow behaviour. |
| I6 | Bot rows with sprite avatars | Initial-letter `AidenBotAvatarSymbol` | Replace with `AidenBotSemanticAvatarView(state:)`. Map `AidenBotAttention.reason` to `.waiting` or `.error`, and running to `.thinking` (PR #925 states). Delete `AidenBotAvatarSymbol`. |
| I7 | Cards with soft fills; the "Needs you" chip is a warning fill | List rows with chips | Use `AidenListCardPosition` / `aidenListCardRow` (used at `AidenRunningAccessory.swift:161,208`) for card grouping. Chips stay soft semantic fills, with **no coloured borders** (AGENTS.md). |
| I8 | No Catch Up row, no machine strip, no Running section | All present | Catch Up and the machine status move to Home (§1). Running moves to dock recents (§3). On iPad / regular width the Running section stays in Inbox, because there is no accessory (`AidenRunningHome.resolve`, `AidenRunningAccessory.swift:8-10`). |

### 2.4 Gap class
- I1, I2, I5, I7, I8: **UI-only**. I2's Done uses the existing triage model, so it is **client model/state** only to the extent of a `segment` filter in `AidenUnifiedInbox.make`.
- I3, I4, option A: **client model/state**. Add a per-row `AidenPendingPrompt` loader with cache and cancellation, plus scope gating (`runs:observe` / approval cards rev 61).
- I3, I4, option B: **server contract**. A summary field on `GET /chats` (and the workspace chat list) means a protocol revision bump and `docs/aiden-remote-api-v1.md` with iOS, Android and fixtures. Also **cross-platform**: Android's `features/workspaces/AidenInboxTriage.kt` / `AidenInboxViews.kt` would gain the same cards.
- I6: **UI-only**, depends on PR #925.

### 2.5 Implementation steps
1. `Models/AidenUnifiedInbox.swift`:
   - Add `enum AidenInboxSegment { all, needsYou, done }` and a pure `rows(for:)`.
   - Add a `done` collection built from the triage `done` bucket (today it is filtered out of the visible sections).
2. `Models/AidenPendingPrompt.swift` (new):
   - `enum AidenPendingPrompt { approval(AidenRemoteRunApproval-derived card), question(text, options), unavailable }`.
   - Decoding reuses the existing `AidenRemoteRunApproval` and `currentRunEvents` parsing. **Do not** add new wire types for option A.
3. `Features/Shell/AidenPendingPromptLoader.swift` (new, `@MainActor @Observable`):
   - Loads lazily on card `onAppear` and cancels on disappear.
   - Keeps at most N concurrent SSE reads (use the snapshot read; close after the first `approval_required` / `needs_input`).
   - Refreshes when the row's summary `updatedAt` changes.
4. `Features/Shell/AidenInboxPromptCard.swift` (new, shared component):
   - Header: sprite, title, time and machine chip.
   - Body: the command block (monospaced, filled surface) or the question text.
   - Buttons come from the card. Deny is a secondary action; Allow once is the primary filled action.
   - Answering is optimistic: the card collapses to "Allowed · Undo"-style status, and the row moves out of Needs you at once and reverts on failure (owner preference: phone actions instant).
5. `Features/Shell/AidenInboxTabView.swift`:
   - Add the segment picker. Swap Needs-you rows for `AidenInboxPromptCard` when the prompt has loaded, and keep today's row as a skeleton/fallback.
   - Remove the Catch Up and machine rows (they move to Home) and the Running section on compact.
   - Replace `AidenBotAvatarSymbol` (`:607-621`).
6. `Features/Shell/AidenAppShellView.swift`: `inboxToolbar` (`:552-575`) loses Settings, Scheduled and Usage (they move to the drawer) and the compose button (it moves to the Home composer and the drawer). It keeps the ellipsis menu with Mark all read and the machine filter.
7. Demo:
   - `AidenDemoHosts.swift` already has needs_approval and needs_input summary rows (`:1139-1160`) and the late-approval run "Fix the flaky upload test" / `npm run test:upload` (`:1077-1100`).
   - The demo already serves the current-events SSE for the late-approval run (`AidenDemoHosts.swift:690`, `:1081`) and its respond routes (`AidenDemoBotUX.swift:153`, `:158`). Extend it to the other needs_approval and needs_input rows, with a rev-61 card and a question with 2-3 options.
   - StateMatrix: add `inbox-needs-you` and `inbox-done` captures.
8. Tests:
   - Unit:
     - `AidenUnifiedInboxTests`: segments partition rows; Done is hidden without `supportsTriage`.
     - `AidenPendingPromptTests`: decode a real rev-61 fixture into buttons in card order; `allowOnMac` gives no allow button.
     - Loader cancellation: a disappeared card leaves no open stream.
   - XCUITest:
     - `testInboxApprovalCardAllowsOnce`: tap Allow once → the card leaves Needs you, and the demo host records the respond call with `scope=once`.
     - `testInboxQuestionChipReplies`.
     - `testInboxSegmentsFilter`.
     - Update `testInboxShowsNeedsYouUpdatesEarlierInOrder` (`AidenShellUITests.swift:334`) and `testCatchUpWalksEveryMachineThenFinishes` (`:151`, Catch Up now starts from Home).

### 2.6 Effort / risk / deps
- **L**: inline actions plus the loader. Option B would be L+ and cross-platform.
- Risk:
  - SSE fan-out from a list (battery and network); mitigate with visible-only loading and a cap.
  - Wrong-approval risk if a card goes stale; mitigate by sending the `approvalId` from the loaded card, so the server rejects a stale one with 409/404 → refresh.
- Deps: PR #925; the server's approval-card scopes (`approval:cards`); the owner's A-vs-B decision.

---

## 3. Dock recents (concept 02; live shots `02-running-accessory`, `02-running-chats`)

### 3.1 Entry point and views
- Live:
  - `AidenRunningAccessory` (`Features/Shell/AidenRunningAccessory.swift:54-132`) above the tab bar on iOS 26.1+, in compact width only (`AidenRunningHome.resolve` `:8-10`), via `aidenRunningAccessory` → `tabViewBottomAccessory(isEnabled:)` (`:217-227`; applied at `AidenAppShellView.swift:337-341`).
  - With several runs, a tap opens `AidenRunningChatsSheet` ("Running chats", medium/large detents, `:148-210`).
  - Update 2026-11-25 (Home header and dock, PR #934): the accessory no longer uses `tabViewBottomAccessory`. On a stack it sits in the dock's bottom bar above `AidenDock` on every iOS version, 26.0 included; beside the list it is the Inbox's first row (`AidenRunningHome.resolve(_:)`). A dock tab tapped again pops to its root (`AidenAppNavigation.selectFromDock`).
  - Update 2026-11-26 (dock recents, PR #934): the dock is concept 02's bare icons with a sliding pill, and the chosen tab tapped again at its root opens its recents (`AidenDockHost`, `AidenDockRecentsPopover`, `AidenDockRecents`). It differs from the steps in 3.3 below: there is no `AidenRecentsStore`, since every list is derived from the Inbox snapshots and the machines' workspace lists on the tap that opens it; the card is a transparent full-screen cover above the dock at compact width, not a sheet; and the running accessory and its sheet are unchanged.
- Tab reselect today calls `navigation.selectTabRoot` (`AidenAppNavigation.swift:544-554`) only when requested programmatically (`AidenAppShellView.swift:429-435`). A user reselecting the current tab gets the system pop-to-root.

### 3.2 What's live
- **Data**: `store.inbox.running` (`AidenRunningAccessory.swift:142,156`), oldest first.
- **Tap rule** (`AidenRunningSummary.tap`, `:47-49`): one run → open it; several → the sheet.
- **States**: hidden when nothing runs (`isEnabled` at `AidenAppShellView.swift:338`); the sheet's empty state is "Nothing's running" (`:170`).

### 3.3 Concept delta
| # | Concept | Live | Note |
|---|---|---|---|
| D1 | Tapping the **selected** dock icon opens a popover above the dock with that tab's last items (Workspaces: workspace names; running ones show a spinner) | Pop-to-root on reselect; running list is global | A per-tab recents popover. Detecting reselect: SwiftUI `TabView` has no reselect callback. Use a custom `Binding` on `navigation.tab` whose setter sees `new == current` and posts `reselect(tab)`. **Risk**: on iOS 26 the system may not call the setter for an unchanged value. Verify on device before committing; the fallback is a long-press context menu on the tab item (not available on system tabs), or the custom dock (D4). **Spike result (2026-11-24, Phase 1 step 3, iOS 27 simulator, iPhone): the setter is called with the unchanged value on every reselect** (Bots, Bots, Bots, Inbox, Inbox logged select, reselect, reselect, select, reselect). Still to check on a device and in the iPad sidebar. |
| D2 | Footer "+ New workspace chat" (per tab: New chat / New Bot / New workspace chat) | Compose button in the Inbox toolbar | Footer calls t1b's new-chat entry with the tab's context (§6). |
| D3 | Running items carry a spinner | Accessory and sheet | Merge: the running set feeds the popover's spinners. **Keep the accessory** on iOS 26.1 compact, because it is the only always-visible running signal and the dock popover needs a tap. Alternatively retire it once Aurora "working" carries the ambient signal (open question). Retire the separate sheet: when there are several runs, the accessory opens the Chats tab's recents popover filtered to running. |
| D4 | Dock: icon-only, label shown on the selected tab only, pill highlight | System Liquid Glass tab bar | **Recommend keeping the system TabView.** A custom dock loses `.sidebarAdaptable` (iPad sidebar, `AidenAppShellView.swift:327`), `tabBarMinimizeBehavior` (`:334`), the bottom accessory, the iPhone Duo side-rail behaviour (`AidenWindowReader` `:1474-1551`; `docs/plans/ios-iphone-duo-plan.md`) and system accessibility. The labels-only-on-selected look is a concept liberty; the system bar on iOS 26 already minimizes on scroll. **Decided 2026-11-25: built at compact width only.** Regular width keeps `.sidebarAdaptable`, so the iPad sidebar and the open Duo are unchanged. At compact width the dock rides in each screen's bottom bar, the running accessory moved from `tabViewBottomAccessory` into that bar above the dock, the dock stays put while a list scrolls (no minimize), and the tab bar's accessibility is rebuilt (tab-bar trait, selected trait, Inbox count in the name, Voice Control names, large content viewer). On the closed Duo the side rail keeps the status bar and the navigation bar's items; the tabs move to the dock. |
| D5 | Popover lists the 4-5 most recent items | No per-tab recents | Needs a recents source per tab:<br>- Chats: recent chats by activity (`AidenChatSummary` activity, already in the store snapshots, `AidenUnifiedInboxStore.swift:28`).<br>- Bots: roster ordered by last activity (`AidenBotConversationItem` / `AidenBotSummary` session state, `Models/AidenBot.swift:323-340`, `:763+`).<br>- Workspaces: `workspaceNames` in the snapshot (`Models/AidenUnifiedInbox.swift:5-22`) plus device-local last-opened.<br>- Inbox: none; reselect there jumps to the top / Needs you. |

### 3.4 Gap class
- D1-D4: **UI-only**. D1 carries platform risk.
- D5: **client model/state**. A device-local `AidenRecentsStore` in UserDefaults, keyed per machine `AidenHostObjectID`, records opens via `AidenAppNavigation.open/push`. No server change.
- Cross-platform: none required.

### 3.5 Implementation steps
1. `Features/Shell/AidenRecentsStore.swift` (new):
   - Records route opens from `AidenAppNavigation.open/pick/push` (`AidenAppNavigation.swift:359-729`).
   - Caps at 20 per tab and drops ids missing from the latest snapshot.
   - Pure `recents(for tab:, snapshots:, running:)`.
2. `Features/Shell/AidenDockRecentsPopover.swift` (new, shared): sections Running (with `AidenWorkingIndicator`, as at `AidenRunningAccessory.swift:91`) then Recent, plus a footer action. Sheet at compact width with a `.medium` detent (presentation reuse of `AidenRunningChatsSheet` `:181`); popover on regular.
3. `Features/Shell/AidenAppShellView.swift`:
   - Replace `TabView(selection: Bindable(navigation).tab)` (`:284`) with a reselect-aware binding.
   - Add `activeSheet = .dockRecents(tab)` (extend the sheet enum, `:350-365`).
   - Keep the `runningChats` sheet case only until the popover lands, then remove `AidenRunningChatsSheet`.
4. `AidenRunningAccessory.swift`: change `AidenRunningSummary.Tap.showAll` to open the Chats recents popover filtered to running.
5. Demo: `busy` already has several running chats (summary patterns `AidenDemoHosts.swift:1139-1160`). Add a StateMatrix capture `dock-recents-workspaces`.
6. Tests:
   - Unit `AidenRecentsStoreTests`: ordering, cap, pruning of deleted ids, per-machine keys.
   - XCUITest:
     - `testReselectingWorkspacesOpensRecents`: running row shows the indicator; tapping it opens the chat.
     - Update `testAccessoryWithSeveralRunningChatsOpensASheet` (`AidenShellUITests.swift:129`) and `testCaptureRunningAccessoryAndCatchUp` (`:1130`).

### 3.6 Effort / risk / deps
- **M.**
- Risk: **high on D1**, the reselect detection under the system TabView. Spike it first (half a day on a device or simulator, owned by whoever implements, not by this planning pass).
- Deps: t1b new-chat entry for the footer.

---

## 4. Drawer (concept 03)

### 4.1 Entry point and views
- Not live. Its contents are spread across:
  - the Search tab (`AidenSearchTabView`, `Features/Shell/AidenSearchTabView.swift:5-45`, `.searchable` prompt "Chats and Bots");
  - the Inbox "…" menu (Settings / Scheduled / Usage, `AidenAppShellView.swift:555-562`);
  - the machines status item (`AidenMachineChrome.swift:443`).
- Routes for those pages exist in `AidenAppRoute` (`AidenAppNavigation.swift:23-114`). Their tab mapping (`:35-41`) sends settings, scheduled, usage and machines to `.inbox`.

### 4.2 What's live
- Search: `AidenSearchModel` covers chats and Bots across machines; tests in `AidenSearchModelTests`.
- Pins: chat pins exist only as the triage `pinned` bucket (`Models/AidenInbox.swift:6-14`). There are no Bot or workspace pins on the phone.

### 4.3 Concept delta
| # | Concept | Note |
|---|---|---|
| R1 | Opens by swiping from the left edge or tapping the hamburger; slides over and dims the content | Edge-swipe conflicts with the NavigationStack back gesture. **Enable the edge pan only at a tab's root** (`navigation.path(for:).isEmpty`); on pushed screens only the hamburger opens it. At **regular width** the drawer becomes the `.sidebarAdaptable` sidebar's extra section, not an overlay (open question). |
| R2 | Pinned: Bots (sprite plus unread dot), then workspaces, then "Show more" | Bot and workspace pins are new **device-local** state (`AidenPinsStore`, UserDefaults per machine). Pinned *chats* reuse the triage pin (`pinnedAt`) where `supportsTriage`. Unread dot = `AidenBotAttention.needsYou` or unread conversation. |
| R3 | Recents: every chat, newest first | `AidenRecentsStore` (§3) across tabs, or the snapshots' chats sorted by activity. Use snapshots (truthful across devices) with a device-local "opened" fallback for Bots. |
| R4 | Bottom bar: Settings gear, Search field, compose button | Gear → push `.settings` on the current tab (no tab switch). Search field → focuses an inline search with `AidenSearchModel`; results replace Pinned/Recents while typing. Compose → t1b's new chat. Scheduled, Usage and Computers go in a "More" row group above the bottom bar (not shown in the concept, but they must stay reachable; `testEveryOldHomeDestinationIsReachable`, `AidenShellUITests.swift:555`). |
| R5 | No brain icons; Memory uses the SD-card icon | Only relevant if Memory appears in the drawer; it doesn't in the concept. |

### 4.4 Gap class
- R1, R4: **UI-only**. They also change the route→tab mapping (client nav state; §5).
- R2:
  - **client model/state**: device-local pins.
  - Syncing Bot and workspace pins across devices would be a **server contract** change; not proposed.
- R3: **client model/state**.
- Cross-platform: none required. Android has its own nav (`android/.../navigation/AidenNavigationHost.kt`).

### 4.5 Implementation steps
1. `Features/Shell/AidenPinsStore.swift` (new): pin/unpin Bot or workspace by `AidenHostObjectID`, persisted, plus "Pin" / "Unpin" context-menu actions on Bot and workspace rows (Bots and Workspaces lists).
2. `Features/Shell/AidenDrawer.swift` (new, shared):
   - `AidenDrawerModel` (pure: pinned, recents, search results); `AidenDrawerView` (Pinned / Recents / More / bottom bar).
   - `.aidenDrawer(isPresented:)` overlay modifier with a dimmed scrim. Dismiss on scrim tap, swipe left or route open.
   - Accessibility: `.accessibilityAddTraits(.isModal)`, focus moves into the drawer on open, Escape and the two-finger Z-gesture close it, and the hamburger keeps a visible focus ring.
3. `Features/Shell/AidenAppShellView.swift`:
   - Remove the Search tab (`:309-320`) and `.tabViewSearchActivation` (`:335`).
   - Mount `.aidenDrawer` above the TabView. Add the hamburger `ToolbarItem(placement: .topBarLeading)` to every tab root (Home, Bots, Workspaces, Inbox).
   - Settings, Scheduled and Usage are reached from the drawer.
4. `Features/Shell/AidenSearchTabView.swift`: extract the results list into `AidenSearchResultsList` for the drawer. Retire the tab view.
5. Demo: seed 2 Bot pins and 1 workspace pin in the `busy` scenario through a demo launch arg (UserDefaults reset happens in StateMatrix `:11-60`). Capture `drawer-open`.
6. Tests:
   - Unit:
     - `AidenPinsStoreTests`: persistence round-trip; a pin whose id disappears from the roster is hidden but not deleted while that machine is offline.
     - `AidenDrawerModelTests`: search replaces sections; Recents order.
   - XCUITest:
     - `testHamburgerOpensDrawerAndSettings`;
     - `testEdgeSwipeOpensDrawerOnlyAtRoot`: on a pushed chat, an edge swipe goes back;
     - `testDrawerSearchFindsBot`;
     - replace `testOnlyTheSearchTabHasASearchField` (`AidenShellUITests.swift:67`);
     - update `testEveryOldHomeDestinationIsReachable` (`:555`).

### 4.6 Effort / risk / deps
- **M.** Risk: gesture conflicts with back-swipe and with the iPhone Duo side rail; VoiceOver modality.
- Deps: t3b (Search, Scheduled, Computers screens keep their routes); t4a (Settings); t1b (compose).

---

## 5. Shell rewrite: AidenAppShellView, AidenAppNavigation and friends

Ordered, file-level:
1. **Tab enum** (`AidenAppNavigation.swift:5-21`):
   - `case chats, bots, workspaces, inbox`; drop `search`.
   - `listTabs` / `listsRow` (`:9`, `:14-20`) gain `.chats`.
   - Route→tab mapping (`:35-41`):
     - chat routes opened from Home or Recents → `.chats`;
     - Bot routes → `.bots`;
     - workspace routes → `.workspaces`;
     - settings, scheduled, usage, machines → **the current tab** (pushed from the drawer). Today they force `.inbox`.
2. **Persistence**:
   - The snapshot store at `:204-296` (key `aiden.product-navigation.v2`, `:205`) already falls back to `.inbox` on an unknown tab.
   - Bump to **v3** with a v2→v3 migration: `search` → `chats`; inbox paths stay on `inbox`. Clear any `.search` path. Mirror the v1 migration pattern at `:272-295`.
   - `AidenStateMatrix` resets v1/v2 keys (`AidenOnTheGoUITests/AidenStateMatrix.swift:11-60`); add v3.
3. **Quick actions and intents**:
   - `AidenHomeAction` (`AppIntents/AidenHomeActionIntent.swift:7-12`) gets `newChat` → Chats tab with the composer focused (t1b API), `newChatVoice` → Chats with voice, and `workspaces` / `bots` unchanged.
   - `ContentView.swift:268-274` (`pendingTab → shellTab`) needs no change beyond the enum.
4. **Shell body** (`AidenAppShellView.swift:283-442`):
   - Four `Tab`s in concept order.
   - Chats uses `splitTab(.chats…)` with `AidenHomeView` as the compact root. At regular width the detail column shows the selected chat (follow `AidenListTab` `:1140-1251`).
   - Drawer overlay, Aurora background slot and ambient-activity environment.
   - Dock-recents sheet case.
5. **Catch Up**: keep `startCatchUp` / `advanceCatchUp` (`AidenAppNavigation.swift:629-660`). The entry moves from the Inbox row to Home's "See all" when there are unread items.
6. **AidenChatScreens** (`AidenAppShellView.swift:934-1037`) keeps draft and voice state across container swaps. Home's composer must hand its draft to the same store when it creates a chat (t1b).
7. **Docs, same PR**:
   - `ios/PROJECT_SPEC.md:15,72-89` (four tabs Inbox/Workspaces/Bots/Search → Chats/Bots/Workspaces/Inbox; Settings reached from the drawer; nav v3);
   - `docs/plans/ios-iphone-duo-plan.md` (split rules for Chats; drawer at regular width);
   - `ios/CHANGELOG` / TestFlight log (new entries);
   - `.memory/inbox-sidebar.md`;
   - `docs/plans/README.md` row for this plan.
8. **Unit tests**: `AidenOnTheGoTests/AidenAppShellTests.swift` (95 tests; e.g. `testEveryRouteLandsOnItsOwnTabsPath` at `:56`) must be updated for the new mapping. Add `testV2SnapshotWithSearchTabMigratesToChats` and `testSettingsPushesOnCurrentTab`.

Effort **M**. Risk: medium. Many UI tests key on tab labels and the Search role (`AidenShellUITests.swift:20, 67, 84, 839`).

---

## 6. Interfaces to t1b and 4B (named, not implemented here)

| Name | Owner | Shape the shell expects |
|---|---|---|
| `AidenHomeComposerSlot` | t1b | `View` with `init(flow: AidenNewWorkChatFlow, machine: AidenHostObjectID?)`. Pinned above the dock on Home only. Reports its height through a preference so the digest's bottom inset clears it. |
| `AidenNewWorkChatFlow.start(firstMessage:attachments:on:)` | t1b | Extends today's flow (`AidenNewWorkChatFlow.swift:99-130`, `onCreated(AidenChat, AidenHostObjectID)`). Used by the Home composer, the drawer compose button and dock-recents footers (`context: .tab(AidenAppTab)`). |
| `AidenVoiceActivity` (`isListening: Bool`, `level: Float 0…1`) | t1b | Observed by `AidenAmbientActivitySource` → `.listening` plus mic level for Aurora. |
| `AidenAmbientActivity` / `AidenAmbientActivitySource` / `\.aidenAmbientActivity` | **t1a** | Enum, source and environment key (§0). Done gets a 2 s hold; the source exposes `level` for listening. |
| `.aidenAmbientBackground { }` | t1a slot, **4B view** | ZStack layer under the dock and composer. 4B reads the environment plus appearance (Off/Subtle/Vivid, Follow activity), and handles Reduce Motion and Low Power (`Config/AidenAppearance.swift:757,764`). |
| Agent Slider / model picker | t1b | Lives inside the composer; the shell never references it. |

---

## Shared components to extract
1. **`AidenBotSpriteAvatar` usage**: one call site pattern, `AidenBotSemanticAvatarView(avatar:name:size:state:)` (PR #925). Replaces `AidenBotAvatarSymbol` (`AidenInboxTabView.swift:607-621`) everywhere.
2. **`AidenInboxPromptCard`**: an approval or question card with card-driven buttons and optimistic resolve. Reusable in Bot chat (t2a) and in notifications' "open to answer".
3. **`AidenPendingPromptLoader`**: visible-only, capped, cancellable approval and question fetch.
4. **`AidenMachineChip`**: name plus status dot plus chevron menu. Used by Home, composer (t1b) and drawer.
5. **`AidenDockRecentsPopover`** plus **`AidenRecentsStore`**.
6. **`AidenDrawer`** plus **`AidenPinsStore`** plus `AidenSearchResultsList`.
7. **`AidenAmbientActivitySource`** plus the background slot.
8. **`AidenHomeDigest`** (pure model).

## Phase order
1. **P0, spikes** (no UI change):
   - Tab-reselect detection under the system TabView on iOS 26.0, 26.1 and 26.2.
   - Add the demo routine-notifications route (missing today).
2. **P1, shell and nav**: the tab enum, v3 snapshot migration, drawer (moves Settings, Scheduled, Usage and Search out), and the hamburger. This removes the Search tab with no new data. It unblocks t3b and t4a placement.
3. **P2, Home**: `AidenHomeView`, machine chip, greeting, the digest (client join), and the composer slot (empty placeholder until t1b lands). Needs PR #925 merged for sprites.
4. **P3, Inbox**: segments, Done, prompt cards via option A, and sprite rows.
5. **P4, dock recents**: recents store, popover, accessory tap re-pointed, running sheet retired.
6. **P5, Aurora hooks**: activity source plus slot (can merge with P1 if 4B is ready early, since it is tiny).
7. **Docs and tests**: in every phase's PR (AGENTS.md); not a trailing phase.

## Open questions for the owner
1. **Greeting name**: the phone can't know it (API forbids usernames, `docs/aiden-remote-api-v1.md:128`). Options: no name, a device-local "Call me…" setting (also onboarding), or drop the greeting.
2. **Inline approvals**: client-only lazy fetch (option A, iOS-only, more requests) or a summary field (option B, protocol revision bump with iOS, Android and fixtures, cheaper at runtime)?
3. **Dock style**: accept the system Liquid Glass tab bar (labels on all tabs, iPad sidebar and Duo rail kept), or build the concept's custom icon-only dock and lose those?
4. **Running accessory**: keep it beside the dock-recents spinners, or retire it once Aurora "working" ships?
5. **Search** (decided in Phase 1 step 3: removed; the drawer's field searches chats and Bots): OK to remove the Search tab (system search role, `AidenAppShellView.swift:309`) in favour of the drawer field? It loses the iOS 26 search-tab affordance.
6. **Drawer at regular width (iPad, open iPhone Duo)**: an overlay as on phone, or merged into the `.sidebarAdaptable` sidebar? Decided in Phase 1 step 3: an overlay at every width. The sidebar stays the top-level navigation (HIG); the drawer is transient, and a third column would crowd the open iPhone Duo.
7. **Home on iPad**: Home as the Chats tab's sidebar column with the digest, and the chat in detail? Or a full-width Home?
8. **Android parity**: Android's IA is Bots/Workspaces areas (`AidenProductNavigationStore.kt:11-14`). Does this new direction apply to Android now, later, or never?
9. **Bot and workspace pins**: device-local only (proposed), or synced through the host (a server contract change)?
