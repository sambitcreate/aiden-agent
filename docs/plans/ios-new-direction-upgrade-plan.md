# iOS new direction: concept-to-live upgrade plan

Status: **Proposed (2026-11-24).** Nothing here is built yet. This is a plan, not a record.

Scope: Aiden on the Go for iPhone and iPad (`ios/AidenOnTheGo`). It takes every shipped screen to its Figma concept one to one, and adds the Aurora ambient background. Android parity and server contract changes are called out wherever a concept needs them.

Sources:
- Figma file `iUQn8UF5HHe3Esli4wIgsd`, page **ios working** (`120:3987`): <https://www.figma.com/design/iUQn8UF5HHe3Esli4wIgsd/?node-id=120-3987>. Each concept sits next to a live simulator capture of the closest screen shipping today. The captures were taken on an iPhone 17 Pro in demo mode (`-AidenDemoScenario busy -AidenDemoBotUX`).
- Eight code-grounded track reports in [`ios-new-direction/`](ios-new-direction/). Two reviewers per track read the code, the concepts and the live shots. Every claim in a track report cites `path:line`. This document is the synthesis. When it and a track report disagree, this document wins, and the reconciliation is written down in [Reconciled decisions](#reconciled-decisions).

| Track | Report | Screens |
|---|---|---|
| 1A Shell and IA | [t1a-shell.md](ios-new-direction/t1a-shell.md) | 01 Home, 02 Dock recents, 03 Drawer, 07 Inbox |
| 1B Composer and voice | [t1b-composer.md](ios-new-direction/t1b-composer.md) | 13 New chat, 05/20 Agent slider, 09 Live voice |
| 2A Bots | [t2a-bots.md](ios-new-direction/t2a-bots.md) | 04 Bot chat, 06 Meet your Bot, 10 Bots gallery |
| 2B Bot settings | [t2b-bot-settings.md](ios-new-direction/t2b-bot-settings.md) | 11 Bot profile, 25 Bot memory, 26 Delete Bot |
| 3A Workspaces | [t3a-workspaces.md](ios-new-direction/t3a-workspaces.md) | 15 Workspaces, 16 Workspace detail, 17 Git review, 08 Workspace run |
| 3B Devices and utilities | [t3b-devices.md](ios-new-direction/t3b-devices.md) | 14 Search, 18 Scheduled, 12 Computers sheet, 22 Computer, 23 Pair |
| 4A Settings foundation | [t4a-settings-foundation.md](ios-new-direction/t4a-settings-foundation.md) | 19 Settings, 21 Appearance, 24 Usage, and the shared design kit |
| 4B Aurora | [t4b-aurora.md](ios-new-direction/t4b-aurora.md) | The Aurora ambient theme |

## How to read this

1. Start with the [screen map](#screen-map). It lists every concept, the live screen it replaces, its track, the kind of gap and the effort.
2. Then read the [phases](#phases). Phase 0 is a set of fixes that can ship alone this week. Phase 1 is the foundation that every later screen needs.
3. Every server change is listed once, in [Server contract batches](#server-contract-batches). Each batch claims the next Aiden Remote protocol revision after the one on `main` when it merges. `main` is at revision 65 today. Each batch updates the iOS client, the Android client and the fixtures together.
4. [Open questions](#open-questions-for-the-owner) closes the plan. Each question has a recommendation, so work can start before every answer is in.

The gap classes used throughout:

- **UI-only.** SwiftUI layout, copy and components.
- **Client model.** Phone-side state or a new demo or persistence key, with no wire change.
- **Server contract.** A new route or field, which needs a protocol revision bump with iOS, Android and fixtures.
- **Cross-platform.** Android or desktop must change too, such as shared copy.

## Screen map

Efforts are S (up to a day), M (a few days), L (a week or more) and XL (a project of its own).

| # | Concept | Live today | Track | Gap | Effort |
|---|---|---|---|---|---|
| 01 | Home: greeting, Bot sprites, "From your Bots" digest, composer | Chats list root (`AidenAppShellView.swift:283-442`) | 1A | UI + client model | M |
| 02 | Dock recents: a popover of recents when the selected tab is tapped again | Running sheet and running accessory | 1A | UI + spike (TabView has no reselect callback) | M, high risk |
| 03 | Drawer: Pinned, Recents, More, Settings, Search, Compose | No drawer; the Search and Settings tabs | 1A | UI + client model (device-local pins) | M |
| 07 | Inbox: triage, with All / Needs you / Done | Inbox tab list | 1A | UI + client (Option A) or server (Option B) | L |
| 13 | New chat sheet | Compose flow | 1B | UI-only | M |
| 05 / 20 | Agent slider: composer chip, track and Settings page | Model `Menu` with an effort submenu (`AidenChatComposer.swift:197-274`) | 1B | Server contract + UI on iOS and Android | L |
| 09 | Live voice: a call relayed through the computer, no screen share | Dictation in the composer only | 1B | Server contract (Live voice relay) + client | XL |
| 04 | Bot chat: intro header, status chip, suggestion cards, inline actions | Bot chat | 2A | UI + demo; memory text is a server contract | M |
| 06 | Meet your Bot: a hatch flow of look, then name, then computer | New Bot form | 2A | UI-only (`POST /bots` already takes `avatar`) | M |
| 10 | Bots gallery grid and templates | Bots list | 2A | UI; "Done" tiles need a server contract | M (M+ with Done) |
| 11 | Bot profile at a glance | Bot profile sheet with inline editing | 2B | UI; editing moves to an Edit page | L |
| 25 | Bot memory | Memory page | 2B | Copy on three platforms + UI | S + M |
| 26 | Delete Bot | System alert | 2B | UI + client model (optimistic delete) | M |
| 15 | Workspaces: Active / Archived, "branch · N changes" | Workspaces list | 3A | Server fill (no revision) + UI | S + S/M |
| 16 | Workspace detail: Files, Git and Artifacts tiles, mode picker, running row | Workspace detail, plus a **blank-sheet bug** | 3A | UI; Artifacts and mode Option B are server contracts | M + M |
| 17 | Git review | Git screen with raw `.green` / `.red` / `.orange` (`:1541-1565`) | 3A | UI + demo routes | M |
| 08 | Workspace run: "Edited N files" card, headline with elapsed time | Run transcript with a duplicate "Worked for" footer | 3A | UI on iOS and Android, no server change | M + M |
| 14 | Search with All / Chats / Bots scopes | Search tab | 3B | UI-only (Files search deferred) | S–M |
| 18 | Scheduled tasks | Scheduled list | 3B | UI + demo route | S–M |
| 12 | Computers ("Run on") sheet | Machine picker | 3B | UI; the platform label needs a server contract | M + M |
| 22 | Computer detail | Machine detail | 3B | UI; the keep-awake switch needs a server contract | S–M (+M) |
| 23 | Pair | Pairing screen | 3B | UI-only | S–M |
| 19 | Settings | App settings | 4A | UI on the new kit | M |
| 21 | Appearance | Appearance as a `.sheet` (`AidenAppSettingsView.swift:218-220`) | 4A | UI; accent and app icon need owner calls | M |
| 24 | Usage: monthly hero, By Bot, and a computer dropdown (All computers or one) | Usage view | 4A | UI + client model (sums hosts on the phone); the month range and By Bot need a server contract | M + M–L |
| — | **Aurora** ambient background | Nothing | 4B | Client-only | M–L |

The concepts for 05 and 20 are the same feature, so they are planned together. Neither has a live capture, and neither does 09.

## Prerequisites

1. **#925 (the Hi-bit sprite) merged.** Home, the Bot chat header, the gallery, the hatch and the profile all draw the Hi-bit Bot. It is the only Bot avatar. Never draw a brain icon.
2. **The design kit (4A, phase 1).** Every restyle builds on it. See [Shared components](#shared-components).
3. **Demo routes for the screens that cannot be captured today.** `AidenDemoHosts.swift` does not serve:
   - `GET /bots/routine-notifications`
   - scheduled tasks
   - `/usage`
   - `/bots/{id}/memory`
   - workspace git routes
   - an archived workspace
   - a second Bot and a Bot that is running

   The live captures for 12, 17, 18, 24 and 25 relied on scratch data that was not committed. Each screen's PR adds the demo data it needs and an `AidenStateMatrix` scenario, so its before and after screenshots can be reproduced.

## Phases

The phases run in order. The screens inside each phase can run in parallel, one PR per row, as long as each PR updates its own docs and tests.

### Phase 0: quick wins (each ships alone)

| Fix | Where | Track |
|---|---|---|
| Workspace menu → Workspace Settings opens a blank sheet. The action sets two `@State`s at once, and `.sheet(isPresented:)` reads the old `nil`. Replace them with one `@State var settingsPresentation: AidenWorkspaceSettingsPresentation?` (an `Identifiable` wrapper around `AidenRemoteRequestContext`) and present it with `.sheet(item:)`. Add an XCUITest that opens the sheet, cancels and reopens it. | `AidenWorkspaceDetailView.swift:32-34,47-74` | 3A |
| Fill `git` on the workspace projection. `projectAidenRemoteWorkspace` never sets it, even though OpenAPI already declares it (`openapi.json:11100`) and both clients already decode it. Fill it from the cached `GitService.info()` (`git.ts:2578`) through an injected `gitInfo` with a timeout, and wire the CLI server the same way. **No revision bump.** | `main/services/aiden-remote-workspaces.ts:102-125` | 3A |
| Change the `memorychip` symbol to `sdcard`, to follow the Memory icon rule. | `AidenBotSuggestionCards.swift:308` | 4A / 2A |
| Remove the decorative 0.5 pt stroke from the Usage view. | `AidenUsageView.swift:584-594` | 4A |
| Rename "Erase memory" to "Forget all" on iOS, Android and desktop in one PR, so the shared copy stays in step. | iOS, Android, desktop | 2B |
| Fix the Android copy that drifted to "this Mac". Also add Bot demo fixtures. | Android | 2B |
| Change the Bot chat placeholder to "Message {name}", and fix Title Case in Bot surfaces. | iOS | 2A |

### Phase 1: foundation

1. **Design kit (4A P1).** Add `AidenTypeScale`, `AidenSettingsTokens` and the components in [Shared components](#shared-components) to `ios/AidenOnTheGo/Config/AidenSettingsKit.swift` and `AidenDesignTokens.swift`. Mirror Android's `AidenSettings*` (`AidenSettingsComponents.kt:97-394`). Add behaviour tests and matrix captures for Settings and Appearance.
2. **Demo routes.** Fill every gap listed under [Prerequisites](#prerequisites).
3. **Shell and IA (1A P0 and P1).**
   - Spike first, for half a day: can a tap on the already-selected tab be detected under the system `TabView`? Concept 02 depends on it.
   - Move the tabs to **Chats · Bots · Workspaces · Inbox**.
   - Bump `aiden.product-navigation.v2` to `v3`, and migrate a saved `search` selection to `chats` (`AidenAppNavigation.swift:5-21,35-41,204-296`).
   - Add the drawer. It opens with an edge swipe at the root of a tab only. It holds device-local Pinned items, Recents, a More section (Scheduled, Usage, Computers), Settings, Search and Compose.
   - Add `newChat` and `newChatVoice` to `AidenHomeAction`.
   - Update `AidenAppShellTests.swift` (95 tests) and `AidenShellUITests.swift:20,67,84,839`, which key on tab labels and the Search role.
   - Update `ios/PROJECT_SPEC.md:15,72-89`, the iPhone Duo plan and `.memory/inbox-sidebar.md`.
4. **Ambient hooks (1A P5 and 4B steps 1-2).**
   - Add `AidenPalette.activity` per preset.
   - Add the pure `AidenAuroraState` reducer over `AidenActivitySignals`, with unit tests.
   - Add the `.aidenAmbientBackground {}` slot and the `\.aidenAmbientActivity` environment key.
   - Nothing is drawn yet.

**Phase 1 progress** (branch `claude/ios-new-direction`):

- Step 1, design kit: landed. `AidenTypeScale` and `AidenSettingsTokens` are in `AidenDesignTokens.swift`. The page, card and rows are in `Config/AidenSettingsKit.swift`; the chip, pill, swatches, stat hero, heatmap and circle button are in `Config/AidenSettingsKitControls.swift`, which keeps each file under 500 lines. The inbox's own `AidenStatusChip` merged into the kit's, so there is one chip. Neutral chips read in the foreground colour and accent chips in a new text-safe `accentTextHex`, because the raw secondary and accent miss 4.5:1 on their own tint in most presets. Type steps follow Dynamic Type and the in-app Text size through `.aidenType(_:)`. No screen uses the kit yet, so the Settings and Appearance matrix captures, and a UI test that card rows are buttons, wait for the first screen that adopts it (Phase 3, 4A P2).
- Step 2, demo routes: landed. A new `full` demo scenario (`-AidenDemoScenario full`, also in `AidenStateMatrix`) serves every gap under [Prerequisites](#prerequisites) from `Features/Remote/Demo/AidenDemoFoundationRoutes.swift`, on two machines whose usage differs:
  - a second Bot, Relay, that is running, with a live session and a partial reply;
  - `/bots/{id}/memory` for both Bots, and `GET /bots/routine-notifications` with one succeeded and one failed routine;
  - an archived workspace, archived on this device the way the person would archive it;
  - `/usage` computed per range, with sparse days, server-style streaks and model rows that add up to the totals;
  - scheduled tasks (an llm task, a running llm task with MCP servers, a paused script task), their runs, the run feed, settings, scripts and MCP servers;
  - workspace git: review, diff, branches, push capability and worktrees.

  `AidenDemoHostsTests` reads every route through the real `AidenRemoteClient`, so a shape the decoders reject fails the test. The phone's validators are stricter than `protocol/aiden-remote/v1/fixtures/contract.json` in places, and the demo follows the phone: a git `operationId` starts with `op_`, a scheduled-task revision with `rev_`, and a task with MCP servers must be an llm task with full access and no workspace. The contract fixture's Bot memory group also counts one character fewer in `usedChars` than its entries join to. These are fixture drift for the contract owner to reconcile, not demo bugs.

### Phase 2: Home, composer and Aurora

- **Home (01).** The Chats root shows a greeting, the Bot sprites and a "From your Bots" digest. The digest shows at most three rows. It is built on the phone from Bot attention plus `GET /bots/routine-notifications`. The composer slot is `AidenHomeComposerSlot(flow:machine:)`.
- **Composer and New chat (13; 1B phase 1, client-only).**
  - Add `AidenComposerPrimaryAction`, which turns Voice into Send once there is text.
  - Add hold to talk.
  - Add `AidenComposerConfig.home()`.
  - Add the New chat sheet, built from `AidenRadioListRow`, `AidenSummaryChip` and the machine line.
- **Aurora renderer and settings (4B steps 3-6).** See [Aurora](#aurora).

### Phase 3: screen lanes (parallel)

| Lane | Order | Notes |
|---|---|---|
| Bots (2A, 2B) | Primitives → Bot chat (04) with demo `routine_proposal` and `memory_update` entries → gallery (10) → Meet your Bot (06) → Memory (25) → Profile (11) → optimistic Delete (26) | Profile editing moves to an Edit page. The hatch uses `AidenBotLookPicker`. |
| Workspaces (3A) | 15 → 17 → 16 → 08 | Git review needs the demo git routes first. 08 ships on iOS and Android in one PR. |
| Devices (3B) | Computer (22) → Scheduled (18) → Pair (23) → Computers sheet (12) → Search (14) | 12 waits for the drawer. Drop the Bot computer row and the "Asleep" copy. |
| Settings (4A) | Settings (19) → Appearance (21) as a pushed route → Notifications page (phone-local) → Usage restyle (24) | Accent override and app icon wait for owner answers. |
| Inbox (1A) | Inbox (07) → dock recents (02) | Dock recents only if the Phase 1 spike succeeds. |

### Phase 4: server contract batches

Ship the [server batches](#server-contract-batches) one at a time. Each claims the next revision when it merges. The Agent slider batch goes first, because the owner asked for the phone slider now.

### Phase 5: UI that needs the server

- Agent slider UI and a read-only Settings page on iOS and Android (1B phase 3).
- Live voice through the computer (1B, after the Live voice relay batch).
- Usage hero and By Bot (4A P7). Never show "$0.00" as the hero.
- Bot tiles that show Done, and "active N ago".
- The Computers sheet platform label and the keep-awake switch.

### Phase 6: Android parity and optional items

Android's navigation is organised around Bots and Workspaces (`AidenProductNavigationStore.kt:11-14`). Whether the new IA goes to Android is an owner decision. Until then, Android gets only the shared contract work, the copy changes and 08.

## Server contract batches

| Batch | Changes | Revision | Unblocks |
|---|---|---|---|
| Workspace git | Fill `git` in `projectAidenRemoteWorkspace` (desktop and CLI) | **None**: the field is already in the contract | 15, 16 |
| Agent slider | `agentSlider` on `GET /models` (`aiden-remote-models.ts:44-61`); `thinkingLevel` in chat metadata (`aiden-remote-chats.ts:723-735`); `setChatModelSelection`; `inputSource: "voice"` | +1 | 05/20, 09 |
| Bots | `memory_update.text`; `lastTurnEnd` and `lastActiveAt` on `GET /bots` | +1 | 04, 10, 11 |
| Usage | `range=month` on usage; `GET /spending/bots?period=current` from the spending ledger, never the usage store (it has no Bot ids, `usage-store-core.ts:29-45`) | +1 | 24 |
| Devices | `host.platform` and `host.kind` on `GET /server`; a remote "Keep this computer awake" switch | +1 | 12, 22 |
| Live voice relay | A Live session started on the host for a chat; a stream that carries microphone and reply audio plus transcripts; a Live device grant; a feature token | +1 | 09 |
| Workspace artifacts | `GET /workspaces/{id}/artifacts` and an artifact content route that returns self-contained HTML | +1 | 16 |
| Optional | An inline-approval summary (07, Option B); a per-workspace approval mode (16, Option B); per-file commit (17); Files search (14); Wake-on-LAN (22) | Each +1 | Only if the owner asks |

The owner dropped the Terminal tile on 2026-11-24, so there is no Terminal route.

Every revision bump updates the iOS client, the Android client, the contract fixtures, `docs/aiden-remote-api-v1.md` and the OpenAPI document in the same PR.

## Aurora

Aurora is a soft gradient behind the Home root that shows what Aiden is doing. Full design: [t4b-aurora.md](ios-new-direction/t4b-aurora.md).

| State | Colour | Lightness | Speed | Trigger |
|---|---|---|---|---|
| Idle | secondary | 0.32 | 0.12× | Nothing is running |
| Working | activity blue | 0.80 | 0.5× | A chat, Bot or routine is running |
| Listening | activity blue | 0.85 | Follows the mic level | Voice input is on |
| Needs you | warning | 0.75 | 0.3× | An approval or question is waiting |
| Done | success | 0.65 | 0.25× | A working → idle edge; shows for 2 s, then Idle |
| Failed | danger | 0.42 | 0.1× | An unread failed run |

**Layout and motion**
- It covers the bottom 400 pt, blurred, and fades out by 45% of the screen height.
- States cross-fade over 600 ms.

**Accessibility and power**
- Reduce Motion shows a still gradient.
- Low Power Mode turns it off.
- It is `accessibilityHidden`.
- A contrast test caps its opacity for each preset.

**How the state is chosen**
- Priority: listening > needs you > failed > done > working > idle.
- A 600 ms debounce stops Working from flickering to Idle.
- Done is inferred from a working → idle edge (`Models/AidenChat.swift:2701-2707`), never on first load or a reconnect.
- v1 relies on the inbox poll, every 15–60 s (`AidenInboxPollPolicy.swift:24-38`). v2 gets Done faster from the open run's stream.
- The reducer sits next to `AidenUnifiedInbox.make` (`Models/AidenUnifiedInbox.swift:112-254`).

**Rendering and settings**
- `AidenAuroraView` is a `MeshGradient` at 30 fps. It is gated the same way as `AidenBotSemanticAvatarView.swift:128-170`, through a shared `AidenAmbientGate`.
- Settings → Appearance gets an "Ambient background" card with:
  - Off / Subtle / Vivid, stored in `aiden.appearance.aurora`, default Subtle.
  - "Follow activity", stored in `aiden.appearance.auroraFollowsActivity`.
- Working blue is a new `AidenPalette.activity` token per preset, defaulting to `#006AD6` light and `#3E97F6` dark. The iOS accent is ink (`#1F2228`), so it cannot be used.

**Microphone level**
- Nothing measures the mic level today (`ComposerVoiceInputController.swift:629-639`).
- A new `AidenAudioLevelMeter` feeds both Listening and the voice rings.

**Testing**
- Other UI tests run with Aurora Off.
- A Debug-only launch argument forces a state for screenshots.

**Scope**
- Client-only, with no server change. Android follows later with a Compose `radialGradient`. There is no desktop version.

## Shared components

The track reports proposed some components twice under different names. These are the canonical names.

| Canonical | Replaces | Home |
|---|---|---|
| `AidenGroupedCard` | `AidenSettingsGroupCard` (2B) | Kit |
| `AidenStatusChip` | `AidenStatusLabel` (3B) and the 2A chip | Kit; soft semantic fill, no coloured border |
| `AidenMachineLine` family | `AidenMachineChip` (1A) and `AidenMachineStatusLine` (3B) | Shell |
| `AidenBotProfileHeader` | `AidenBotIntroHeader` (2A); one header with a chat variant and a profile variant | Bots |
| `AidenRelativeTimestampView` (existing, compact style) | `AidenRelativeTimeLabel` (3B) | Kit |
| `AidenSettingsRow`, `AidenNavigationRow`, `AidenAvatarValueRow`, `AidenLargeTitlePage`, `AidenSectionCaption`, `AidenPillSegmentedControl`, `AidenSwatch` / `AidenSwatchGrid`, `AidenStatHero`, `AidenHeatmap`, `AidenCircleIconButton` | — | Kit (4A) |
| `AidenRadioListRow`, `AidenSummaryChip`, `AidenComposerPrimaryAction`, `AidenAgentSlider*` | — | Composer (1B) |
| `AidenSuggestionCard`, `AidenInlineActionRow`, `AidenBotActionTiles`, `AidenBotMemorySummaryCard`, `AidenBotCanUseCard`, `AidenConfirmCard` | — | Bots (2A, 2B) |
| `AidenGitReviewScreen`, `AidenGitFileRow`, `AidenDiffText`, `AidenRunChangesCard` | — | Workspaces (3A); diff colours come from tokens |
| `AidenScheduledTaskRow`, `AidenScanViewfinder`, `AidenMachineEditSheet` | — | Devices (3B) |
| `AidenAuroraView`, `AidenAmbientGate`, `AidenActivitySignals`, `AidenAudioLevelMeter` | — | Ambient (4B) |

## Reconciled decisions

- **Search.** 1A moves Search into the drawer and drops the Search tab. 3B keeps the system search tab. The plan follows the concept and 1A, and the drawer's Search opens the 3B scoped search screen. This is still the owner's call, as question 1.
- **Aurora priority.** The plan uses 4B's order. 1A defers to it.
- **Activity source.** 1A's `AidenAmbientActivitySource` and 4B's `AidenActivitySignals` become one model. 1A owns the slot and the environment key. 4B owns the reducer, the view and the gate.
- **Faithful versions where a concept contradicts the product.**
  - "Asks first" is shown as enabled capabilities plus an "Allowed without asking" count.
  - The Bot computer row is dropped from the Computers sheet.
  - The Terminal tile is dropped, because there is no Remote route.
  - Per-file commit becomes a read-only file list with an All / Staged scope.
  - The Meet your Bot copy says what Full Access means.
  - Swatches stay mode-following discs, as `settings-design-system.md:63` requires.

## Demo and test strategy

- Every screen PR adds its demo data and an `AidenStateMatrix` scenario. It attaches before and after screenshots from that scenario to the PR.
- Tests are behavioural only:
  - XCUITest flows for navigation and sheets.
  - Unit tests for reducers and resolvers, such as `AidenAuroraState` and `AidenAgentSliderResolver`, which ports `renderer/shared/agent-slider.ts:255,285`.
  - Contract fixtures for every revision bump.
  - No tests that grep source text, and no snapshots of class strings.
- New test files go in the right `package.json` script and in `scripts/ci-test-registry.json` where they apply.
- Android changes are checked on a headless AVD.

## Owner decisions (2026-11-24)

These answers override the recommendations below where they differ.

- **Order.** Merge #925 (Hi-bit) first, and start this plan in parallel.
- **Tabs (Q1).** Yes: Chats · Bots · Workspaces · Inbox, with Search and Settings in the drawer.
- **Agent slider (Q6).** Build the phone slider in this plan. Desktop PRs 0–4 merged (#888, #889, #892, #893, #896); the phone PR was left to the owner and has not been opened, so the slider server batch and the iOS slider UI are scheduled now (1B phases 2–3). Android decodes the new fields and its fixtures move with the revision; its slider UI comes with the later Android pass.
- **Voice (Q7).** True Gemini Live, relayed through the computer: a live voice call only, with **no screen-share button**. This replaces the turn-based v1. It reuses the desktop's Aiden Live session (`gemini-live-assistant-plan.md`) on the host, and the phone streams microphone audio to it and plays the reply audio. It needs its own design pass and a server contract batch. See [Live voice through the computer](#live-voice-through-the-computer).
- **Greeting name (Q3).** Use a name the host already sends, if it sends one. It does not today: `GET /server` carries only the computer's display name, and the desktop's `Profile.name` (`main/services/types.ts:1067`), which defaults to the macOS account's full name, is not on the wire, and the DTO allowlist forbids local usernames. So the phone gets an optional, device-local "Call me…" setting, also offered in onboarding, and the greeting is nameless until it is set.
- **Aurora (Q19–Q20).** Subtle by default, on the Home root only. Needs you outranks Failed.
- **Android (Q5).** Later. Android gets only the contract work and shared copy for now.
- **Usage (24).** Keep the new direction, and add a computer dropdown at the top: **All computers** (the default) plus each paired desktop and `aiden serve` host. All computers sums each reachable host's own usage and spending on the phone, so no host ever sees another host's data. A host that is offline or too old to answer is listed with its last cached figures and marked as such, and it is never counted as zero. This builds on the existing multi-host machine list and adds no server route beyond the Usage batch.
- **Workspace detail (16).** Remove the Terminal tile. The tiles are **Files**, **Git** and **Artifacts**. Artifacts lists the workspace's HTML artifacts and opens one in a locked-down web view on the phone. This needs a new server batch; see [Workspace artifacts](#workspace-artifacts).

### Live voice through the computer

- **Host.** The desktop already runs voice-only Aiden Live with Google's Live API. The phone asks the paired computer to start a Live session tied to a chat. The computer holds the Google credential and the Live socket, and the phone never sees either.
- **Transport.** Microphone audio goes from the phone to the host, and reply audio and transcripts come back, over the existing authenticated Remote connection as a new stream. The design pass must measure round-trip latency on the LAN and through the relay before committing to the codec and frame size.
- **Phone UI.** Concept 09's call screen with Mute, End and a transcript, but no screen-share button. It uses `AidenVoiceRings` and `AidenAudioLevelMeter`, and drives Aurora's Listening state.
- **Gating.** It is shown only when the host advertises the Live feature and the device has a new Live grant. The host's existing Live kill switch (`AIDEN_EXPERIMENTAL_GEMINI_LIVE=0`) turns it off.
- **Server batch.** Live voice relay (+1 revision, iOS, Android decode and fixtures). `aiden serve` support is a separate decision, because it has no Live session today.

### Workspace artifacts

- **Server batch (+1 revision).** It needs two routes, both scoped to a workspace the device can read and both capped in size:
  - `GET /workspaces/{id}/artifacts` lists the artifacts by id, title, kind and update time. It never returns a path.
  - A content route returns one artifact's self-contained HTML.
- **Phone rendering.** The phone shows the HTML in a `WKWebView` that is locked down:
  - It uses a non-persistent data store.
  - It has no network access, enforced by a content rule list that blocks every load except the document itself.
  - It never runs `file://` loads or app bridges.
  - Links go out to the system browser only after the person confirms.
- **Snapshots.** Inline chat visuals keep using their snapshots (`chat-visuals-v1`). The artifact list is for opening an artifact in full.
- **Before building.** The design pass confirms which desktop store backs workspace artifacts (`main/services/generative-ui-artifact-store.ts` or the design-mode artifacts) and how `aiden serve` answers.

## Open questions for the owner

The owner answered several of these on 2026-11-24; see [Owner decisions](#owner-decisions-2026-11-24). Each question has a recommendation, so work can proceed unless the owner says otherwise. The full lists are at the end of each track report.

**Shell and navigation**
1. **Tabs.** Chats · Bots · Workspaces · Inbox, with Search and Settings in the drawer. *Recommend yes.* It loses the iOS 26 search-tab affordance.
2. **Dock.** Keep the system Liquid Glass tab bar, which keeps the iPad sidebar and the Duo rail, or build the concept's icon-only dock? *Recommend the system bar.*
3. **Greeting name.** The API forbids usernames (`docs/aiden-remote-api-v1.md:128`). *Recommend an optional, device-local "Call me…" setting, also offered in onboarding, with a nameless greeting by default.*
4. **Inline approvals in Inbox.** Option A: fetch approvals for the visible rows, iOS-only. Option B: a summary field, which bumps the revision. *Recommend A first.*
5. **Android.** Does the new IA go to Android now, later or never? *Recommend later. Android gets contract work, copy changes and 08 now.*

**Composer and voice**

6. **Agent slider.** The plans index says the owner is building the phone slider by hand (`docs/plans/README.md:91`). Should this plan schedule the slider, or only reserve the chip slot? *Recommend reserving the slot and planning the server batch only.*
7. **Voice.** Turn-based voice for v1 (dictate, send, Read Aloud), or true Gemini Live through the Mac (XL)? Can the screen-share button go? *Recommend turn-based v1 and dropping screen share.*
8. **Hold to talk.** On release, keep the words in the field or send them? *Recommend keeping them in the field.*

**Bots**

9. **Done on Bot tiles.** This needs `lastTurnEnd`, a revision bump. *Recommend yes, in the Bots batch.*
10. **Profile editing.** Should it move to ••• → Edit Bot, with the profile as a pushed page? *Recommend yes.*
11. **Meet your Bot copy.** New Bots get Full Access, so the copy must say so. Alternatively, the hatch could offer an access choice. *Recommend honest copy, with no new step.*
12. **Forget all.** Rename it on all three platforms. *Recommend yes; this is Phase 0.*

**Workspaces and devices**

13. **Mode picker.** Option A: Full / Ask / None tiers, UI-only. Option B: a per-workspace approval mode, which bumps the revision. *Recommend A.*
14. **Terminal tile.** *Recommend dropping it.*
15. **"Run on" sheet.** Does it set the default computer, or only where the next piece of work runs? *Recommend the default, with the copy "where new work starts".*
16. **Waking a computer.** A remote keep-awake switch, which bumps the revision, or Wake-on-LAN? *Recommend the switch only.*

**Settings and Aurora**

17. **Accent override.** iOS-only, or parity with Android and desktop? Also: how many app icon variants, and in which sprite tints? *Recommend iOS-only first.*
18. **"This month" on Usage.** *Recommend the host's local calendar month.*
19. **Aurora default.** Subtle or Off? *Recommend Subtle, on the Home root only.*
20. **Aurora priority.** Does Failed outrank Needs you? *Recommend Needs you first.*
21. **Aurora with Reduce Transparency or VoiceOver.** *Recommend a dimmed, still gradient rather than hiding it.*
22. **Working blue.** *Recommend a per-preset `activity` token. Monochrome stays grey.*
