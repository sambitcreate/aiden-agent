# iOS Home header and compact dock (concepts 01/02)

Branch `claude/ios-home-chrome`, stacked on `claude/ios-home-aurora` (#931). Owner decision 2026-11-25: custom Home header and an icon-only dock at compact width; regular width keeps the system `.sidebarAdaptable` sidebar. Plan: `docs/plans/ios-new-direction-upgrade-plan.md` Phase 2 "Home header and dock".

## Where it lives
- `Features/Shell/AidenDock.swift`: `AidenTabChrome` (`resolve(besideList:)`, `besideList(horizontal:vertical:)`, `keyboardTakesBottomEdge(keyboard:screen:)`, `showsDock(besideList:showsConversation:keyboardIsUp:)`), `AidenAppTab.title/dockSymbol/accessibilityCount(needsYou:)`, `AidenDock`, `AidenChromeIconButtonStyle` (Home header's round glass button).
- `AidenAppShellView`: `splitTab` hands `AidenListTab` a `dock: (AidenAppRoute?) -> AnyView`; `AidenListTab.stack` puts `.toolbar(.hidden, for: .tabBar)` + `.safeAreaBar(edge: .bottom)` + `.aidenComposerSoftScrollEdge()` on the root and on every `navigationDestination` screen. `dockBar(under:)` returns the running accessory (when `runningHome == .accessory`) above `AidenDock`, or nothing in a conversation / with the keyboard up. Home header: `homeHeaderBar` in a top `safeAreaBar` on `chatsList`, nav bar hidden at the Chats root in the dock layout.
- `AidenAppNavigation.selectFromDock(_:)`: select, or pop to root on reselect. `aidenUsesDock` environment entry (`AidenMachineChrome.swift`).
- `AidenRunningAccessory`: `isInBar`; the host is a glass capsule; no more `tabViewBottomAccessory`, so no iOS 26.1 gate: `AidenRunningHome.resolve(_ chrome:)` is `.accessory` with the dock, `.inboxRow` beside the list.

## Rules (review round 1, 2026-11-25)
- Landscape: `besideList = horizontal == .regular && vertical != .compact`. A Plus/Pro Max sideways (regular/compact) keeps the stack and dock; iPad and open Duo (regular/regular) keep the split. `AidenListTab` passes the same rule as `widthIsRegular` to `setPath`, so the laid-out guard agrees.
- Keyboard: `keyboardWillChangeFrame` + `keyboardTakesBottomEdge` (frame intersects the screen bottom and is at least 120 pt tall). Floating keyboards and the hardware shortcut bar leave the dock.
- `@ScaledMetric` reads the environment above the dock's `.dynamicTypeSize(...xxxLarge)` clamp, so the icon sizes are capped by hand (dock 27, header 24).
- Reselect at a tab's root does not scroll to top yet (deferred: needs a scroll hook across the four list containers alongside `AidenListScrollKeeper`).

## Gotchas
- A `safeAreaInset`/`safeAreaBar` outside a `NavigationStack` doesn't reach the list inside it; the dock must be each screen's own bar.
- The closed Duo draws a hard scroll edge under a bottom bar unless `.scrollEdgeEffectStyle(.soft, ...)` (via `aidenComposerSoftScrollEdge()`).
- Inside an `.isTabBar` container the children become tabs and their AXValue is the selection (1/0), so `accessibilityValue` is lost: the Inbox count goes in the label (`accessibilityName(of:)`), with `accessibilityInputLabels` the bare name.
- Closed Duo: hiding the tab bar leaves the system rail (status bar plus the nav bar's items at the trailing edge, no TabBar element). UI tests detect the rail by posture (`showsSideRail`: a non-Home "Open menu" outside every navigation bar), the dock by `aiden.dock` / `aiden.dock.<tab>` (`AidenStateMatrix.dock/dockTab/bottomTabs`).
- UI tests wait for Chats' root with `AidenStateMatrix.homeRoot` (`aiden.home.menu`, or the Chats nav bar beside the list) and `tabRoot(_:)`; `navigationBars["Chats"]` does not exist at compact width.
- The dock no longer minimizes on scroll (the old `testTheTabBarMinimizesOnScrollDownAndComesBack` became `testTheDockStaysInReachWhileTheListScrollsUnderIt`).
- The accessibility audit (`testEveryMainScreenPassesTheAudit`) counts the dock as a bar running from its capsule's top to the window's bottom edge, full width (`AuditFinding.dock`). Rows that scroll under it are bars-touching, and its chosen tab's name has its own allowance (Dynamic Type, one per tab screen).
- A row XCUITest calls hittable under the dock or running accessory still takes the tap on the bar; drag the list first (`openLongChat`).
- Closing the drawer gives the Home field its keyboard back. The default `scrollDismissesKeyboard` did not dismiss it, so `chatsList` sets `.scrollDismissesKeyboard(.immediately)`: a drag down the Home list puts the keyboard away and the dock returns.
- While the Home field has focus the ambient aurora keeps animating, so XCUITest waits 60 s for idle before every action; a keyboard-up UI test takes minutes.
- `app.cells` includes rows just past the window's edge; filter by `frame.minY < window.maxY` when looking for the last visible row.
