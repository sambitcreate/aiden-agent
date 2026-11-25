# iOS new direction: Phase 1 foundation

Branch `claude/ios-new-direction`. Plan: `docs/plans/ios-new-direction-upgrade-plan.md` (Phase 1 progress notes are the source of truth).

## Design kit (step 1)
- Files: `ios/AidenOnTheGo/Config/AidenSettingsKit.swift` (page, section, card, rows) and `AidenSettingsKitControls.swift` (chip, pill, swatches, stat hero, heatmap, circle button). Tokens in `AidenDesignTokens.swift` (`AidenTypeScale`, `AidenSettingsTokens`).
- The page title is the system large nav title; there is no `pageTitle` type step.
- `.aidenType(_:)` scales once via `@ScaledMetric(relativeTo: step.textStyle)`; `AidenUIFontID.font(size:)` must not scale again (Humanist uses `fixedSize`).
- Separators: each row sets `aidenSeparatorInset` (a `ContainerValues` entry); the card reads it per row.
- Card/page: `cardFillHex` vs `pageBackgroundHex` hold `cardToPageContrast` (1.07) in every preset; tests enforce it, fix tokens rather than the test.
- Kit text is `LocalizedStringKey`; runtime values go in as `"\(value)"`.
- Testing gotcha: `ImageRenderer` leaves a `ScrollView` blank; draw scrolling pages in a `UIWindow` (`drawInWindow` in `AidenSettingsKitTests`).
- Usage's heatmap uses `AidenHeatmap`. `AidenStatusChip` is the one chip (inbox's merged in).

## Demo routes (step 2)
- `-AidenDemoScenario full` launch argument (no env var). Routes in `Features/Remote/Demo/AidenDemoFoundationRoutes.swift`, DEBUG-only and on the shipping-target allowlist in `scripts/check-ios-shipping-target.test.mjs`.
- `AidenDemoFull.Host` (`.studio` = Relay, `.laptop` = Courier) varies the running Bot, routine, usage scale and whether the triage task exists, so the two machines never answer alike. Set per machine via `Machine.full`.
- Shapes follow the Mac server, not just the phone decoders (phone is looser: empty preview, optional git `capability`, free errorCode). Scheduled runs, `/runs`, the feed and `lastRunAt` all derive from one `Run` list; feeds honour `since` (scheduled: epoch ms, inclusive; routines: ISO, exclusive). Times are whole seconds so cursors round-trip.
- Responder: `stream(...)` answers without finishing (SSE snapshot then open). Parked holds keep weak waiters and are unparked on `stopLoading`, so a held request never retains the responder.

## Shell and IA (step 3)
- Tabs: `AidenAppTab` = chats, bots, workspaces, inbox (Chats first/default). No Search tab; search lives in the drawer.
- Nav store key `aiden.product-navigation.v3` (JSON Data, tolerant decode, missing tab → chats). v2 migrated once (search → chats, paths kept); first v3 write removes v2. Corrupt v3/v2 → empty snapshot (Chats). UI test launches must pass `-aiden.product-navigation.v3 reset|<hex>` (`AidenStateMatrix.navigationArgument`).
- Chats tab: `AidenChatsTabView` over `AidenChatsList.entries` (dedupe per host-scoped id keeping newer, ties by title then id; blocked/hidden machines excluded). Split at regular width like Inbox/Bots/Workspaces (`chatsColumns`). Home (Phase 2, Home+Aurora lane) replaces the Chats root content via `chatsList(selection:)` in `AidenAppShellView`.
- Drawer: `Features/Shell/AidenDrawerView.swift` (`AidenDrawerView`, `AidenDrawerOverlay`, `AidenDrawerPinButton`), `AidenDrawerModel.swift` (`AidenDrawerPinsStore` UserDefaults `aiden.drawer-pins.v1`, purged per machine on unpair in `AidenRemoteCoordinator`; `AidenDrawerPinned.items`). Overlay at every width (HIG: sidebar is top-level nav). Open menu `ToolbarItem(.topBarLeading)` on every list; 16pt leading edge strip only when compact stack root and not side rail. Any `navigation.snapshot` change closes it; close refocuses the menu button.
- UI test gotchas: drawer's More is below 12 recents, scroll the drawer's collection view (`drawerRow`), not its pinned section header. Edge-swipe Back needs the push animation settled first. The drawer is exposed to XCUITest as an `Alert` (isModal).
- Reselect spike: the TabView selection Binding setter IS called with the unchanged tab on reselect (iOS 27 sim). Spike code removed.
- Clone simulators used by xcodebuild tests are deleted after the run, so `log show` on them finds nothing; surface spike values via an accessibility label instead.
- `testBotContinuityPagesReadTheBotsOwnMachine` is intermittent on the aiden-foundation sim (scene-active timing), not a step 3 regression.
- Optimistic rule (owner, 2026-11-24): step 3 surfaces render from memory, with skeletons (`AidenChatListSkeleton`) for Chats, drawer Recents (while `listState == .loading`) and search's Searching Bots. There are no spinners. VoiceOver focus after the drawer closes is keyed per tab (`focusedMenuButton: AidenAppTab?`), and navigating from the drawer leaves focus to the new page.
- The iPhone Duo fold can't be driven headlessly: there is no simctl or XCUIDevice API, and System Events times out. Inner-display (open) shots need the Simulator GUI.
