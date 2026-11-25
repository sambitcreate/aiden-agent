# iOS Home header and compact dock (concepts 01/02)

Branch `claude/ios-home-chrome`, stacked on `claude/ios-home-aurora` (#931). Owner decision 2026-11-25: custom Home header and an icon-only dock at compact width; regular width keeps the system `.sidebarAdaptable` sidebar. Plan: `docs/plans/ios-new-direction-upgrade-plan.md` Phase 2 "Home header and dock".

## Where it lives
- `Features/Shell/AidenDock.swift`: `AidenTabChrome` (`resolve(besideList:)`, `showsDock(besideList:showsConversation:keyboardIsUp:)`), `AidenAppTab.title/dockSymbol/accessibilityCount(needsYou:)`, `AidenDock`, `AidenChromeIconButtonStyle` (Home header's round glass button).
- `AidenAppShellView`: `splitTab` hands `AidenListTab` a `dock: (AidenAppRoute?) -> AnyView`; `AidenListTab.stack` puts `.toolbar(.hidden, for: .tabBar)` + `.safeAreaBar(edge: .bottom)` + `.aidenComposerSoftScrollEdge()` on the root and on every `navigationDestination` screen. `dockBar(under:)` returns the running accessory (when `runningHome == .accessory`) above `AidenDock`, or nothing in a conversation / with the keyboard up. Home header: `homeHeaderBar` in a top `safeAreaBar` on `chatsList`, nav bar hidden at the Chats root in the dock layout.
- `AidenAppNavigation.selectFromDock(_:)`: select, or pop to root on reselect. `aidenUsesDock` environment entry (`AidenMachineChrome.swift`).
- `AidenRunningAccessory`: `isInBar`; the host is a glass capsule; no more `tabViewBottomAccessory`.

## Gotchas
- A `safeAreaInset`/`safeAreaBar` outside a `NavigationStack` doesn't reach the list inside it; the dock must be each screen's own bar.
- The closed Duo draws a hard scroll edge under a bottom bar unless `.scrollEdgeEffectStyle(.soft, ...)` (via `aidenComposerSoftScrollEdge()`).
- Inside an `.isTabBar` container the children become tabs and their AXValue is the selection (1/0), so `accessibilityValue` is lost: the Inbox count goes in the label (`accessibilityName(of:)`), with `accessibilityInputLabels` the bare name.
- Closed Duo: hiding the tab bar leaves the system rail (status bar plus the nav bar's items at the trailing edge, no TabBar element). UI tests find rail buttons by position (`railButton` in `AidenShellUITests`), the dock by `aiden.dock` / `aiden.dock.<tab>` (`AidenStateMatrix.dock/dockTab/bottomTabs`).
- The dock no longer minimizes on scroll (the old `testTheTabBarMinimizesOnScrollDownAndComesBack` became `testTheDockStaysInReachWhileTheListScrollsUnderIt`).
