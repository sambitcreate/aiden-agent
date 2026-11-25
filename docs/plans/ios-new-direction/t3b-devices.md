# Track 3B — Find & devices (t3b-devices)

Scope: concept 14 Search, 18 Scheduled, 12 Computers sheet, 22 Computer (+ idea-computer: Wake on request, Last seen, Version), 23 Pair.
Repo read: `ios-new-direction` worktree, HEAD d476bc35d (== origin/main). iOS paths below are relative to `ios/AidenOnTheGo/` unless prefixed with `ios/` or repo-root dirs (`main/`, `docs/`, `protocol/`).

Current Remote contract revision on main: 65 (`main/services/aiden-remote-protocol.ts:373-374`, `protocol/aiden-remote/v1/fixtures/contract.json:2`). Any server-contract item below claims the next revision at merge time and lands with iOS, Android (`android/app/src/main/java/sbtbiswas/AidenOnTheGo/`) and the fixtures together.

---

## 14 — Search

### 1. Entry point and views
- Entry: system search tab, `Tab(role: .search)` in `Features/Shell/AidenAppShellView.swift:309-320`, activated with `.tabViewSearchActivation(.searchTabSelection)` (~:334).
- `Features/Shell/AidenSearchTabView.swift` (297 lines): struct inputs `:5-12`; no-computers state `:28-29` (`AidenNoComputersEmptyView(surface: .search)`, defined `Features/Remote/AidenPairingView.swift:256`); `.searchable(..., prompt: "Chats and Bots")` `:41`; `.task(id: model.trimmedQuery)` `:46`.
- Model: `Models/AidenSearchModel.swift` — `AidenSearchBotHit` `:4-16`, `AidenSearchMachine` `:27-42`, debounce/limits `:44-75`, local chat filter `:128-144`, `run()` `:159-195`, per-machine fan-out `:197-246`.

### 2. What's live
- Empty query: ContentUnavailableView "Search — Find a chat, or a Bot conversation on any of your computers." (`AidenSearchTabView.swift:51-58`).
- Results List (`:86-153`): **Chats** section (`AidenSearchChatRowView` `:194-243`: `bubble.left` glyph, title, "workspace · machine · offline", no time) and **Bots** section (`AidenSearchBotRowView` `:245-286`: `AidenChromeSymbols.bots` glyph, title, 3-line preview, "Bot conversation · machine"). "Searching Bots" ProgressView row and an unsearched-machines note (`:179-184`). No results: "No results" + note that only loaded chats are searched (`:155-177`).
- Data: chats are a **local** filter over already-loaded snapshots via `AidenUnifiedInbox.make(... searchText:)` (`AidenSearchModel.swift:128-144`, no request — covered by `AidenOnTheGoTests/AidenSearchModelTests.swift:212`). Bot hits come from `AidenRemoteClient.botConversations(query:)` (`Networking/AidenRemoteClient.swift:2352`) → `GET /bot-conversations?query=&botId=&limit=&cursor=`, query ≤200 chars (`Models/AidenBot.swift:866`), gated on `bot:read`, 300 ms debounce, 30 s answer lifetime.
- Demo: `/bot-conversations` is served (`Features/Remote/Demo/AidenDemoHosts.swift:733`, computed match `:973-991`); `offline-mix` has a machine whose Bot search fails (`:498-503`).

### 3. Concept delta
| Concept | Live | Faithful version |
|---|---|---|
| Back button + search field at top | System search tab, field at bottom on iPhone (UI test `ios/AidenOnTheGoUITests/AidenShellUITests.swift:67`, `:871`) | Keep the system search tab (Liquid Glass bottom field). Drop the back button; the tab bar is the way back. Do not rebuild a custom top field. |
| Filter chips All / Chats / Bots / Files | none | All / Chats / Bots as a segmented filter (or `.searchScopes`). **Files only after a contract decision** (see below). |
| Chat row: title + relative time, no glyph | glyph, workspace · machine, no time | Title + trailing relative time from the same source the Inbox uses (`Features/Remote/AidenInboxViews.swift:77-103`, `AidenInboxDuration`); keep the machine name only when >1 machine (as `AidenMachineRoster.searchMachineName`, `Features/Shell/AidenMachineChrome.swift:85-94`). Drop the `bubble.left` glyph. |
| Bots section = Bot entities with sprite avatar ("Repo Watcher") | Bot **conversation** hits with a generic symbol | Two things: (a) a local "Bots" match on Bot names from the snapshots the inbox store already holds (`Features/Shell/AidenUnifiedInboxStore.swift:388`, `bots:`), drawn with `AidenBotCanonicalAvatarView` (`Features/Bots/AidenBotsHomeView.swift:746` usage) — the Hi-bit sprite is the only Bot avatar; (b) keep conversation hits as rows under it ("in Repo Watcher"), also with the sprite instead of `AidenChromeSymbols.bots`. |
| Files section (pairing-session.ts, aiden-remote-api-v1.md) | no file search anywhere | There is no search route. Only a per-workspace recursive snapshot `GET /workspaces/{id}/files` (`AidenRemoteClient.swift:3475`, ≤4,000 entries, depth 20 — `docs/aiden-remote-api-v1.md:364`; lazy `?tree=1` is Mac-only `:365`) and Bot files `GET /bot-conversations/{chatId}/files` (`:3152`). Faithful v1: omit the Files chip. v2 options in Open questions. |

### 4. Gap class
- Drop back/top field: UI-only.
- Scope filter: client state (`AidenSearchModel` gets a `scope`; Bot fan-out skipped when scope == .chats).
- Chat timestamp: UI-only (summary already carries `updatedAt`/`inbox.lastAssistantAt`).
- Bot-entity matches + sprite: client model/state (new `AidenSearchBotMatch` from snapshot Bots; no request).
- Files: **server contract** if done properly (new `GET /search/files?query=` or `GET /workspaces/{id}/files?query=` in `main/services/aiden-remote-router.ts` + `aiden-remote-protocol.ts`, feature token, fixtures, Android) — or client-only bounded fan-out over the cached `AidenWorkspaceFileIndex` (`Models/AidenWorkspaceEnvironment.swift:18`) for workspaces already indexed on this phone. Cross-platform if shipped.

### 5. Steps
1. `Models/AidenSearchModel.swift`: add `enum Scope { all, chats, bots }`; add `botMatches: [AidenSearchBotMatch]` computed locally from inbox-store snapshots (name/purpose contains, case- and diacritic-insensitive, same trimming as chats). Skip `askMachines` when scope == .chats.
2. `Features/Shell/AidenSearchTabView.swift`: `.searchScopes` (or a top segmented picker inside the list header) bound to scope; chat row → title + trailing relative time, remove glyph; new Bot entity row with `AidenBotCanonicalAvatarView` (size 28) → `.bot(botID)`; conversation rows reuse the sprite. Keep the "Searching Bots"/unsearched-machines notes and the "only loaded chats" footnote.
3. Extract a shared `AidenRelativeTimeLabel` (used by Inbox, Search, Scheduled "Next …").
4. Demo: no new route needed for chats/Bots; add a second named Bot in `AidenDemoContent.botListJSON` (`AidenDemoHosts.swift:965`) so the Bots section shows >1 entity.
5. Tests (behavioral): extend `AidenSearchModelTests` — scope `.chats` makes no Bot request (assert on demo responder call log); a Bot name match appears without a request; scope `.bots` hides chat results. UI: extend `AidenShellUITests` search test to tap a Bot match and land on the Bot.
6. AidenStateMatrix: add a `search-results` capture (scenario `four`, query typed) — light/dark, L/AX-XXXL.

### 6. Effort / risk / deps
S–M (without Files). Risk: `.searchScopes` placement on iPhone with the bottom field is new on this surface; verify AX-XXXL. Deps: none. Files: L + contract, deferred.

---

## 18 — Scheduled

### 1. Entry point and views
- Entry: Inbox ⋯ menu `Button("Scheduled tasks", systemImage: "calendar.badge.clock") { navigation.open(.scheduled) }` (`Features/Shell/AidenAppShellView.swift:557`); route renders `AidenScheduledTasksView(coordinator:)` at `:648`; `.scheduled` belongs to the inbox tab (`Features/Shell/AidenAppNavigation.swift:30,37`), leave at `:613`. Push notifications land on `.machine(instanceId:)` from `Features/Remote/AidenScheduledRunNotifier.swift:76`.
- `Features/Remote/AidenScheduledTasksView.swift` (1363 lines): access `AidenScheduledTaskAccess` `:6`; model `:106-160` (optimistic `pendingEnabled`; `isEnabled` `:380`, `pauseOrResume` `:385-394`, `remove` `:396`, `run` `:438`, `runs` `:481`, `updateSettings` `:510`); list view `:645-843`; detail `:845`; runs `:917`; editor `:981`; settings `:1297`.
- Model: `Models/AidenScheduledTask.swift` — `AidenScheduledTaskResult` `success|error|silent|blocked` (`:17-19`), `running`, `nextRunAt`, `lastResult`.

### 2. What's live
- Inline title "Scheduled tasks" (`:781`), `.searchable("Search tasks")`, toolbar gear (Settings) + ⋯ "Create manually" (`:783`).
- Machine picker `AidenNewWorkMachinePicker(kind: .reading)` (`:666`, `:689-691`; `.reading` keeps offline machines pickable for cached history — `Features/Shell/AidenNewWorkMachinePicker.swift:13-23`).
- Info card "Create tasks in any chat" (`:693-705`); read-denied ContentUnavailableView (`:707`); view-only notice on missing `schedule:write`; segmented All/Active/Paused/Running (`:727`); empty "No scheduled tasks" (`:736`), search-empty (`:743`).
- Rows: NavigationLink → detail; name, ProgressView when running, trailing "Active"/"Paused", cadence via `AidenScheduledTaskPresentation.cadence`, "Next …"; swipe Pause/Resume tinted `palette.warning`.
- `.refreshable`, loading overlay, offline banner (`safeAreaInset`), editor/create/settings sheets, alert.
- Routes (`Networking/AidenRemoteClient.swift:3292-3430`): `GET|POST /scheduled-tasks`, `GET|PATCH|DELETE /scheduled-tasks/{id}` (If-Match), `POST .../pause|resume|run` (202, If-Match + Idempotency-Key), `GET .../runs`, `GET /scheduled-tasks/notifications?since=`, `POST /scheduled-tasks/preview`, `GET /scheduled-tasks/scripts`, `GET /scheduled-tasks/mcp-servers`, `GET|PATCH /scheduled-tasks/settings` (doc `docs/aiden-remote-api-v1.md:388-398`). Capabilities `schedule:read`/`schedule:write` (`Networking/AidenRemoteContract.swift:644-645`).
- Demo: **no** `/scheduled-tasks` route is registered (`AidenDemoHosts.swift:627-738` registers server, workspaces, summaries, memory, models, chats, bots, bot-conversations only), so the screen is a 404/error state in every scenario.

### 3. Concept delta
| Concept | Live | Faithful version |
|---|---|---|
| Large title "Scheduled", leading ≡ | inline "Scheduled tasks", back button | Large title "Scheduled". The ≡ is a drawer — shell work owned by Track 1A; keep the back button until the drawer lands, then the route moves under it. |
| Trailing + | ⋯ → "Create manually" | `+` opens the existing editor sheet (`:981`) in create mode. Keep gear for Settings. Only shown with `schedule:write`. |
| One card, rows = name + trailing control | rows with status text, cadence, Next, chevron | Name on line 1, cadence · "Next Tue 9:00" on line 2 (the concept drops it, but without it a toggle row is ambiguous — keep a muted subtitle). Trailing: inline `Toggle` (`.aidenSwitchStyle()`) bound to `isEnabled`/`pauseOrResume` (already optimistic); when `running` show "Running" + small ProgressView instead of the toggle; when `lastResult == .error` show "Failed" as a **soft danger fill label** (no border) and keep the toggle reachable in the detail. Tap row → detail (keep NavigationLink; no chevron per settings design system trailing rules). |
| No info card | info card | Move "Create tasks in any chat" into the empty state and the `+` menu footer; drop the permanent card. |
| No segmented filter | All/Active/Paused/Running | Drop the segmented control; `.searchable` stays. If filtering is kept, put it in a toolbar Menu. |
| No machine picker | picker row | Keep the picker when >1 machine (it hides itself otherwise via `picker.showsPicker`). Concept omits it only because it shows one machine. |
| Red "Failed" text | — | Soft fill + label + icon per AGENTS status-color rule; never red text alone. |

"Failed" needs no server change: it maps to `lastResult == .error` (`Models/AidenScheduledTask.swift:17-19`).

### 4. Gap class
All UI-only, except: demo data (client test infra) and the drawer (cross-track shell dependency).

### 5. Steps
1. `AidenScheduledTasksView.swift`: `.navigationTitle("Scheduled")` + `.navigationBarTitleDisplayMode(.large)`; toolbar: `+` (write only) and gear; delete TaskFilter/segmented Picker and the info card; move the hint into the empty state (`:736`).
2. Extract `AidenScheduledTaskRow` (name, subtitle, trailing state) with a `TrailingState` enum `{toggle(Bool), running, failed}` derived from the task + `pendingEnabled` in the model (pure function on the model — testable).
3. Keep swipe Pause/Resume as a VoiceOver custom action fallback; inline toggle is the primary control.
4. Shared: `AidenStatusLabel(tone: .danger/.success/.warning, text:)` soft-fill pill (reused by Computers status and Search offline notes).
5. Demo: add `/scheduled-tasks`, `/scheduled-tasks/{id}`, `/runs`, `/settings`, `/notifications` replies in `AidenDemoHosts.swift` `register(_:with:)` with 4 tasks (enabled, paused, running, last-failed) shaped from `protocol/aiden-remote/v1/fixtures/contract.json`; grant `scheduleRead`/`scheduleWrite` on demo installations (`:420-444`). Also make POST pause/resume reply 202 so the toggle round-trips.
6. AidenStateMatrix: new route capture `scheduled` for `four` and `offline-mix` (offline banner + cached history).
7. Tests: unit — trailing state is `running` while `running == true` regardless of enabled; `failed` only when `lastResult == .error`; toggling flips at once and reverts on a 409 (extend `AidenOnTheGoTests/AidenScheduledTaskTests.swift`, which already covers routes/revisions `:525`). UI — tap toggle on demo task, assert the switch value and that the demo responder saw `POST /scheduled-tasks/{id}/pause`.

### 6. Effort / risk / deps
S–M. Risk: an inline toggle in a NavigationLink row needs its own hit target (toggle must not push). Deps: drawer from Track 1A for the ≡; demo routes are a prerequisite for screenshots.

---

## 12 — Computers sheet ("Run on")

### 1. Entry point and views
- Live entry: the Inbox host status item "3 of 4" (`AidenHostStatusItem`, `Features/Shell/AidenMachineChrome.swift:443`) → `onOpenMachines: { navigation.open(.machines) }` (`AidenAppShellView.swift:491`) → route `:642`; also Settings → Computers (`Features/Workspace/AidenAppSettingsView.swift:82-86`, UI test `AidenShellUITests.swift:617`, `:738`, `:924`).
- `Features/Shell/AidenMachinesView.swift` (519 lines): `AidenMachineStatus` `:6-27`; `AidenInstallationPresentation.endpointType` ("Tailscale" for `.ts.net`, else "Local Network") and `lastConnection` `:30-44`; `AidenMachineRow` `:48-88`; `AidenMachinesModel` `:100-279` (`select` = `setDefaultMachine` + connect attempt; status mapping `:270-278`); List view `:284-434`; `AidenMachinesRouteView` with its own pairing sheet `:437-460`; row view `:463-519`.
- Per-flow picker already exists: `AidenNewWorkMachinePicker` (Menu of Toggles, `Features/Shell/AidenNewWorkMachinePicker.swift:287-368`) and the Settings `AidenDefaultMachineRow` (`:371-409`). Product rule (`:3-4`): "The default machine is only where a picker starts, so work can go elsewhere without moving it."

### 2. What's live
Pushed "Computers" page (inline title). Card rows: `AidenMachineChip`, name, "status · transport", last-connected when offline, hidden note, identity suffix, checkmark on the default machine, chevron → detail. Swipe Forget / Reconnect. Footnote "Hiding a computer keeps it paired…" (`:342`), "+ Pair a computer" row (`:354-370`). Forget confirmation + alert.

### 3. Concept delta
| Concept row/element | Reality | Faithful version |
|---|---|---|
| Bottom sheet "Run on", "Chats and Bots run on the computer you choose." | Default is chosen in Settings/Computers; per-flow picker in compose | Sheet = "Where new work starts": choosing a row calls `AidenMachinesModel.select` (default machine). Copy: "New chats and Bots start on the computer you choose. You can pick another each time." (matches `AidenDefaultMachineRow` hint). Open it from the Home/Inbox status item (Track 1A owns the trigger); keep the pushed Computers page for management (detail, forget, hide) behind a "Manage computers" row. |
| "Studio Mac · Online · 3 Bots running" | status · transport | Client-only: `runningBotCount(on:)` in `AidenUnifiedInboxStore` beside `openChatCount(on:)` (`Features/Shell/AidenUnifiedInboxStore.swift:158-161`) using `AidenBotAttention.isRunning` (`Models/AidenUnifiedInbox.swift:33-35`). Nil when the machine's snapshot is blocked/unread → omit. |
| "MacBook Air · Asleep · wakes when chosen" | phones cannot tell asleep from offline; no wake | Show "Offline · last seen 2h ago". "Asleep" and "wakes when chosen" are **false claims today**: there is no wake route and the host's only keep-awake is the desktop-only scheduled-tasks setting (`docs/aiden-remote-api-v1.md:395`). See Wake under 22. |
| "Aiden Server · Linux · online" | `GET /server` has no platform/kind field (`AidenServer`, `Networking/AidenRemoteClient.swift:237-253`; server projection `main/services/aiden-remote-router.ts:2700-2712`; protocol type `main/services/aiden-remote-protocol.ts:2266-2275`) | Needs an additive `/server` field, e.g. `host: { platform: "darwin"|"linux"|"other", kind: "desktop"|"server" }`, sourced from `hostPlatformCapabilities().platform` (`main/services/host-platform-capabilities.ts:55-62`) and whether it's `aiden serve`. Until then, no platform label. Platform names must match host-platform-capabilities (`darwin`→"Mac", `linux`→"Linux"). |
| "Meal Planner's computer · Bot computer · off" | Bot computers are macOS arm64-only VMs (`host-platform-capabilities.ts:65`), owned by a Bot, started only by that Bot's tools, a routine, its Computer tab or a sign-in card (AGENTS.md "Bot computers"). Not exposed to phones as hosts; no route. | **Contradicts the product — drop it.** A Bot computer is not a place to run chats. If surfaced at all, it belongs on the Bot's profile (Track 2B), read-only. |
| Outline icon per row | `AidenMachineChip` (filled tint chip) | Keep `AidenMachineChip` — the colour/symbol is the person's own per-machine identity (`AidenMachinePreferences`) used across Inbox chips/strip; an outline-only icon loses it. Optionally a lighter chip variant. |
| Selected row: checkmark + filled background | checkmark only | Checkmark + `palette` selected background token; no border (AGENTS: no decorative outlines on choice rows). |
| "Add a computer · Scan the code in Aiden on your Mac" | "+ Pair a computer" | Row in sheet → pairing sheet (23). Copy must not be Mac-only: "Scan the code in Aiden or from `aiden serve`" (pairing view already says Mac, Linux, or server — `AidenPairingView.swift:425`). |

### 4. Gap class
- Sheet + copy + selection background: UI-only.
- Bots-running count: client model/state.
- Platform label: **server contract** (`/server` field; `aiden-remote-router.ts`, `aiden-remote-protocol.ts`, `packages/cli` serve path, fixtures `contract.json`, iOS `AidenServer` decode, Android `networking/AidenRemoteClient.kt`) — cross-platform.
- Asleep/wake: cross-platform + server contract (see 22). Not in this phase.
- Bot computer row: dropped (contradiction).

### 5. Steps
1. New `Features/Shell/AidenRunOnSheet.swift`: List of `AidenMachinesModel.rows` (reuse `AidenMachineRow`), trailing checkmark on `isSelected`, selected background, `select(id)` on tap then dismiss; refusal handling via `setDefaultMachine` `.busy` message (as `AidenDefaultMachineRow` `:380-384`); "Add a computer" row; "Manage computers" → `.machines`. `presentationDetents([.medium, .large])`.
2. Extract shared `AidenMachineStatusLine` ("Online · 3 Bots running", "Offline · last seen 2h ago", "Connecting…") used by the sheet, Computers page row (`AidenMachinesView.swift:463-519`) and detail header.
3. `AidenUnifiedInboxStore`: `runningBotCount(on:) -> Int?`.
4. Track 1A wires the trigger (Home/Inbox status item) to the sheet instead of the pushed page.
5. Demo: `four` already has an offline "Build Box" (`AidenDemoHosts.swift:486-492`); add a running Bot session state on Studio so the count shows.
6. Tests: unit — `runningBotCount` counts only `.running` sessions and is nil for a blocked snapshot; selecting a row moves the default and leaves the open target alone (extend `AidenOnTheGoTests/AidenNewWorkTargetTests.swift` / `AidenMachineDetailTests.swift:188` style). UI — open sheet, pick "Home Mini", reopen: checkmark moved; compose picker starts on Home Mini.
7. AidenStateMatrix: `run-on-sheet` for `four` and `offline-mix`.

### 6. Effort / risk / deps
M (UI) + M server-contract item for platform. Risk: two "choose a machine" surfaces (sheet vs compose picker) can confuse; copy must say "starts". Deps: Track 1A trigger; contract revision for Linux label.

---

## 22 — Computer (+ idea-computer)

### 1. Entry point and views
- Route `.machine(instanceId:)` → `AidenMachineDetailView(instanceId:, coordinator:, preferences: .shared)` (`AidenAppShellView.swift:644`); pushed from Computers rows (`AidenMachinesView.swift:414`) and from scheduled-run notifications (`AidenScheduledRunNotifier.swift:76`).
- `Features/Shell/AidenMachineDetailView.swift` (443 lines): chip image `:91-107`, symbol tile `:111-137`, view `:143-205`, Form `:207-356`.

### 2. What's live
Inline title (machine name). Form: header chip + name; Name TextField ("Leave it blank to use the computer's own name…"); Symbol grid; Colour grid (selected state is a stroke ring `:386-389`); "Hide from Inbox" toggle `:268-276`; Connection section — Status `:279`, Connection (transport) `:287`, "Last connected" **only when not online** `:288-290`, Workspaces count if >0 `:291`, Open chats from `inboxStore?.openChatCount(on:)` `:294`, identity suffix `:297`, Reconnect `:298-311`, Default label or "Make this the default computer" `:312-322`; Forget `:325-334` + confirmation. No Version row, no wake toggle.

### 3. Concept delta
| Concept / idea | Reality | Faithful version |
|---|---|---|
| Large title + green dot "Online" | inline title | Large title; status line under it via shared `AidenMachineStatusLine` with a soft dot (status colour as fill only). |
| Rows Connection / Workspaces / Open chats | present | Keep. |
| Last seen = Now (idea) | only when offline (`:288-290`) | UI-only: always show "Last seen" — "Now" while connected, relative `lastConnectedAt` (`Models/AidenInstallation.swift:19`, updated `:318`, `:367`) otherwise. |
| Version = 0.69.0 (idea) | `appVersion` decoded (`Networking/AidenRemoteClient.swift:240,286`) and kept on `AidenHostConnection.server` while connected (`Features/Remote/Hosts/AidenHostConnection.swift:124`), never shown, not persisted | Show `connection.server?.appVersion` when connected. To show it offline, persist `appVersion` on `AidenInstallation` (optional, `decodeIfPresent`) when `/server` is adopted — client model. No contract change. |
| Hide from Inbox toggle card | present | Keep. |
| Wake on request toggle (idea) | Today keep-awake is a desktop-only setting (`docs/aiden-remote-api-v1.md:395`, desktop capability `keepAwake` darwin+linux `host-platform-capabilities.ts:40-44,78`). No remote wake path exists. | Two separate features, both not UI-only: (a) **remote "Keep awake while Aiden works" switch** — server contract: add the field to the phone-visible `/scheduled-tasks/settings` revision or a new `PATCH /server/power` behind a capability (router + protocol + fixtures + Android); (b) **actually waking a sleeping Mac** — Wake-on-LAN magic packet from the phone needs the host's MAC address in the pairing/`/server` payload, the iOS multicast entitlement (`com.apple.developer.networking.multicast`) and only works on the same LAN; over Tailscale it needs a relay peer. Recommend shipping (a) only, labelled "Keep this computer awake", gated on a feature token, and not claiming "wakes when chosen". |
| Name/Symbol/Colour editing not in concept | inline form | Move into an "Edit" sheet from the ⋯ menu (Name, Symbol, Colour), keeping the existing editor code; colour selection keeps a non-decorative selected indicator (checkmark glyph), not a stroke ring. |
| ⋯ menu | — | Edit, Reconnect, Make default. |
| Red centered "Forget this computer" | Forget button in Form | Bottom destructive text button with the existing confirmation dialog. |

### 4. Gap class
Layout/menu/edit sheet/Last seen: UI-only. Version offline: client model (persist). Keep-awake remote switch: server contract + cross-platform. Wake-on-LAN: cross-platform + entitlement + contract — defer.

### 5. Steps
1. `AidenMachineDetailView.swift`: large title; header status line; reorder sections (Details card: Connection, Workspaces, Open chats, Last seen, Version; Hide from Inbox card; Forget). Move Name/Symbol/Colour into `AidenMachineEditSheet` (new file, lifted from `:207-276`). Toolbar ⋯ Menu: Edit, Reconnect, Make default.
2. `Models/AidenInstallation.swift`: `var appVersion: String?` (Codable, `decodeIfPresent`); set it where `/server` is adopted (`AidenHostConnection.adopt(server:)` `:427` / `AidenInstallation` refresh `:239-255`).
3. Shared `AidenMachineStatusLine` (from 12).
4. Demo: `/server` already returns `appVersion` `0.30.0`/`0.12.0` (`AidenDemoHosts.swift:781`) — fine.
5. Tests: extend `AidenOnTheGoTests/AidenMachineDetailTests.swift` — Last seen reads "Now" when connected and the stored date when offline; Version appears after `/server` adoption and survives going offline (persisted); editing in the sheet still saves (existing `:200` test adapted). UI: `AidenShellUITests.swift:1038` (open chats) extended to assert Version row text from demo.
6. AidenStateMatrix: `machine-detail` for `four` (online Studio, offline Build Box).
7. Keep-awake (later phase): contract design doc + router/protocol + `contract.json` + iOS/Android decoders + toggle row gated on the feature token.

### 6. Effort / risk / deps
S–M for UI + Version + Last seen. Keep-awake switch M + contract revision. WoL L, not recommended now. Risk: moving editing behind a sheet hides the most-used customisation; check with owner (Open questions).

---

## 23 — Pair (Add Computer)

### 1. Entry point and views
- Shell sheet `.pairing(showsDesktopCheck:)` (`AidenAppShellView.swift:357-363`) via `openAddComputer` (`:279-280`); also from `AidenMachinesRouteView` (`AidenMachinesView.swift:451-458`) and the no-computers empty view (`AidenPairingView.swift:256-305`).
- `Features/Remote/AidenPairingView.swift` (1338 lines): `AidenPairingView` `:321`; desktop-check page (`:420-483`, "Connect Aiden"), Get Aiden page (`:540-603`), `addComputerPage` `:669-723`, `scanCard` `:725-822`, `nearbySection` `:824-893`, `manualEntrySection` `:895-982`; camera permission `:996-1016`; scan handler `:1018`; manual submit `:1028`; pairing `:1052`; inline AVCapture scanner `:1187-1338`; frosted cutout `:1112`. Bonjour discovery model `:5-255` (`NetServiceBrowser`, TXT instance id `:158`).
- Client: `pair(` `Networking/AidenRemoteClient.swift:1380,1444`, `manualPairingPayload(` `:1473`, `normalizeManualPairingCode` `:1548` (20-char Crockford, rejects lookalikes).
- Plan: `docs/plans/aiden-manual-pairing-plan.md` — Implemented; manual LAN/Tailscale UI acceptance still open (`:3`, `:51`). Invariants `:17-26`: code never leaves the phone, decrypted envelope must name the exact selected endpoint, one pairing window for QR and code.

### 2. What's live
Inline "Add Computer"; ✕ (root only) and ✓ confirm (submits manual; disabled when both fields empty) `:686-711`. Scan card: 244 pt rounded card, "Tap to scan" + `qrcode.viewfinder`, caption "Scan the code from `aiden serve` or Connections settings"; once tapped, live camera with frosted cutout and "Point at the QR on your computer"; "Connecting…" while mutating. Camera-denied alert → Open Settings `:401-413`; camera-unavailable inline error `:756-761`. "Nearby on Wi-Fi" (only when Bonjour finds agents): green dot, name, `host:port`, "Use" → fills Address, focuses Code, checkmark when selected `:824-893`. "Or enter it": Address ("mac.local or host.ts.net") + Code ("Setup code or payload", auto-formatted) with per-field errors; footer "For computers on your local network or Tailscale. Your provider keys stay on your computer."

### 3. Concept delta
| Concept | Live | Faithful version |
|---|---|---|
| Large title, ✕ only | inline title, ✕ + ✓ | Large title; remove ✓ — submit lives with the manual fields (keyboard Go / a "Connect" button in the expanded section). |
| Dark viewfinder with corner brackets, camera live on open | "Tap to scan" first | Start the camera on appear **only when already authorized** (`AVCaptureDevice.authorizationStatus == .authorized`); otherwise show the tile with "Allow camera" (system prompt on tap). Never auto-prompt on open. Corner brackets instead of the full stroked square. Replace hard-coded `Color(aidenHex: "#2B2F38")`/`#111318` (`:734-736`) with palette tokens. |
| Caption "Point at the QR on your computer" | two captions | Keep both states; idle caption must keep `aiden serve` so Linux/server users aren't excluded. |
| Nearby row: desktop icon, "Use" | green dot + host:port | Desktop icon (`desktopcomputer`) + name, address as secondary line; "Use" stays and still only selects (it can't pair without the code — plan `:15`: "A code cannot locate a Mac; LAN users select a Bonjour-discovered exact instance"). After "Use", expand the code field inline. |
| "Enter address and code" text button | always-visible fields | Collapse manual entry behind the button (DisclosureGroup-style); auto-expand when Nearby "Use" is tapped, when the camera is denied/unavailable, or when an input error exists. Keep field-level errors and the footer. Text fields keep no focus ring (AGENTS). |
| Bottom-anchored button | — | `safeAreaInset(edge: .bottom)` button. |

### 4. Gap class
All UI-only. No contract change: the payload, endpoint binding and code normalisation stay as they are.

### 5. Steps
1. `AidenPairingView.swift`: `addComputerPage` large title, remove the ✓ toolbar item, add `@State isManualExpanded`; bottom "Enter address and code" button; auto-expand rules above; "Connect" button inside the expanded section calling `submitManual()`.
2. `scanCard`: auto-activate when authorized; corner-bracket overlay shape (extract `AidenScanViewfinder`); palette tokens for the dark gradient.
3. `nearbySection`: icon + name + address; "Use" expands manual.
4. Keep the desktop-check and Get Aiden pages unchanged.
5. Tests: `AidenShellUITests.swift:635` (first run walks desktop check → Add Computer) and `:695` (invalid manual input) must be updated: tap "Enter address and code" before typing; assert the invalid-code error still shows. Unit (pure): "manual section expanded" decision function — expanded when camera denied, when an agent is selected, or when an input error is set. Existing parser tests stay.
6. AidenStateMatrix: `pairing` capture for `empty` (no camera in simulator → camera-unavailable path, which also proves auto-expand).

### 6. Effort / risk / deps
S–M. Risk: auto-starting the camera changes privacy feel — only when already authorized; simulator has no camera so UI tests cover only the fallback path; the plan's physical-device manual acceptance remains open (`aiden-manual-pairing-plan.md:51`). Deps: none.

---

## Shared components to extract
1. `AidenMachineStatusLine` — status dot (soft fill) + "Online · 3 Bots running" / "Offline · last seen 2h" / "Connecting…"; used by Run on sheet, Computers page, Computer detail.
2. `AidenStatusLabel(tone:text:)` — soft semantic fill pill (no border) for Running/Failed/Paused/offline; Scheduled rows, Search notes.
3. `AidenRelativeTimeLabel` — one formatter for Inbox, Search, Scheduled "Next".
4. `AidenScheduledTaskRow` with `TrailingState`.
5. `AidenMachineEditSheet` — Name/Symbol/Colour, lifted from the detail Form.
6. `AidenScanViewfinder` — corner-bracket overlay on the existing inline scanner.
7. Search Bot rows reuse `AidenBotCanonicalAvatarView` (no new avatar code; Hi-bit sprite only).
8. Demo: `/scheduled-tasks*` responders + a second Bot + a running Bot session (in `AidenDemoHosts.swift`), mirrored in `ios/AidenOnTheGoUITests/AidenStateMatrix.swift` captures `search-results`, `scheduled`, `run-on-sheet`, `machine-detail`, `pairing`.

## Phase order
1. **Demo + shared primitives**: scheduled-tasks demo routes, running-Bot/second-Bot demo data, `AidenStatusLabel`, `AidenRelativeTimeLabel`, `AidenMachineStatusLine`. Enables screenshots for everything below.
2. **Computer detail (22, UI part)**: large title, Last seen always, Version (+ persisted `appVersion`), edit sheet, ⋯ menu, bottom Forget.
3. **Scheduled (18)**: large title, `+`, inline toggle/Running/Failed rows, drop info card + segmented filter.
4. **Pair (23)**: viewfinder, collapsed manual entry, nearby row restyle; update the two pairing UI tests.
5. **Run on sheet (12)**: after Track 1A lands the Home/Inbox trigger; Bots-running count; no platform label yet.
6. **Search (14)**: scopes, timestamps, Bot-entity matches with sprite.
7. **Contract follow-ups (one revision, iOS+Android+fixtures together)**: `/server` host platform/kind (Linux label); remote keep-awake switch. Wake-on-LAN and Files search only on owner sign-off.

## Open questions
1. Run on: should the sheet move the **default** (live semantics, `AidenMachinesModel.select`) or only the next piece of work (the compose picker already does that)? Recommend default + copy "where new work starts".
2. Files in Search: defer, client-only over cached workspace indexes, or a new server search route (contract revision)?
3. Wake on request: ship only a remote "Keep this computer awake" switch (contract), or invest in Wake-on-LAN (MAC address in pairing, multicast entitlement, LAN-only)? Recommend the switch only and drop "Asleep · wakes when chosen" copy.
4. Platform label: add `host.platform`/`host.kind` to `GET /server` now, or omit "Linux" from the sheet?
5. Bot computer row in the Computers sheet contradicts the product (Bot-owned macOS VM, not a host). Confirm dropping it; surface on the Bot profile (Track 2B) if at all.
6. Machine customisation (Name/Symbol/Colour) moving behind an Edit sheet — acceptable, or keep it inline below the details?
7. Scheduled: keep a muted cadence/"Next" subtitle (recommended) even though the concept shows names only? Keep any filter (Menu) or rely on search alone?
8. Search field: confirm the system bottom search tab stays (concept shows a top field with Back).
