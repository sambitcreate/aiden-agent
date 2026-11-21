# iPhone Duo: list and conversation side by side

Status: In progress (2026-11-20), branch `feature/ios-iphone-duo`, no PR yet (owner asked for none).

## Goal

Make Aiden On The Go feel native on iPhone Duo, using the owner's reference screenshot (a coding agent's iOS app open on the inner display): the chat list on the leading side, the open conversation on the trailing side, and the system's vertical bar rail (status bar, Back, toolbar actions, tab bar) on the trailing edge.

## Sources

- HIG: [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo)
- [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo)
- Tech Talk 111461, "Prepare your app for iPhone Duo": the full-screen experience (vertical bars, edge to edge) needs the iOS 27.1 SDK.

## Baseline (2026-11-20, iPhone Duo simulator, iOS 27.1)

- Built with Xcode 27.0 (the `xcode-select` beta), the app runs in a compatibility window: horizontal bars, bottom tab bar, a black status rail. Built with Xcode 27.1 (`/Applications/Xcode.app`, used by CI and every TestFlight build since 39), the system already moves the toolbar and tab bar to the trailing rail. No project change is needed. Local Duo work must set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Inner display, open: the Inbox list spans the whole display and the fold. Opening a chat pushes it full width, so the list disappears and transcript text runs across the fold.
- No `NavigationSplitView` anywhere. Every tab is a `NavigationStack`.
- Some toolbar items are image-only custom views (`Image(systemName:)`), so the system can't title them in overflow. `.principal` custom headers can't go on the vertical rail.

## Decisions

- Decide layout by horizontal size class only (AGENTS.md). Regular width gets list + detail, on iPhone Duo's inner display and on iPad. Compact width (Duo outer display, every other iPhone) keeps today's single stack unchanged.
- One source of truth: each tab's existing path in `AidenAppNavigation`. In split mode the path's first route is the sidebar selection and the rest is the detail column's stack. Saved navigation and every `open`/`leave`/Catch Up rule stay as they are.
- Use system containers (`NavigationSplitView`, `TabView`) so the fold, the camera and the vertical rail are handled by the system. No custom bars and no hinge-specific code where a system container already adapts.
- Opening or closing the display swaps each list tab's container: compact width is a plain `NavigationStack` bound to the tab's whole path, and regular width is the `NavigationSplitView`. A split that collapsed itself into one stack left the closed iPhone Duo's side rail without a working Back (iOS 27.1 simulator). Only the container for the current layout writes the path (`AidenAppNavigation.setPath(_:of:laidOutBesideList:widthIsRegular:)`), so the outgoing one can't empty it. The container also passes its own horizontal size class, because it hears the new width an update before the shell does. Chat screens belong to the shell (`AidenChatScreens`), so the swap keeps the draft, attachments, voice and reading place. The shell announces the swap, so nothing waits on a timer.
- The shell also owns Search (`AidenSearchModel`: query, scope and results) and each list tab's scroll place, so both survive the swap. `ScrollPosition` doesn't move a `List` (iOS 27.1), so the place is put back on the list's own `UIScrollView`.
- The reading place is read when scrolling settles, from row frames in the transcript content's own coordinate space. Each frame belongs to the screen that measured it, because a fold builds the new screen's rows before the old screen's rows leave. The visible height is `ScrollGeometry.containerSize`, which already leaves out the content insets.
- The tab view keeps the system's tab bar placement. It isn't forced to a sidebar, because the list column already gives the extra hierarchy level.

## Phases

### Phase 1: Inbox list + detail on regular width

- The Inbox tab becomes a `NavigationSplitView` at regular width. The sidebar is the existing Inbox list (machine chips, Needs you / Updates / Earlier, Catch Up, running row) with the selected row highlighted. The detail is a `NavigationStack` rooted at the selected route, or an empty state ("Pick a chat").
- A pure mapping between the tab path and (selection, detail path), unit tested, including Catch Up's Next, `leave`, `replace`, and restoring a saved path.
- The Inbox toolbar (menu, compose, machine pill) stays with the list column. The conversation's toolbar moves to the detail column, where the system puts it on the trailing rail.
- Compact width renders exactly as before.

### Phase 2: Bots and Workspaces list + detail

- The same treatment for the Bots tab (Bot list | Bot chat) and the Workspaces tab (workspace list | workspace, then its chats in the detail stack).
- Search stays a single stack. Its results open on their own tab as today.

### Phase 3: Bars ready for the vertical rail

- Every toolbar item has a title and a symbol (`Label`), so the system can show it on the rail, in a horizontal bar, or in overflow.
- Compose keeps the highest visibility priority. Back and Close stay first (`cancellationAction`).
- The chat and Bot chat views are task views: on iOS 27.1 they prefer keeping toolbar items (`toolbarVerticalCompressionBehavior(.prefersToolbarItems)`). Availability is gated, since the deployment target is iOS 26.
- Replace `UIDevice.userInterfaceIdiom` layout decisions (attachment picker) with size class.

### Phase 4: Fold, reading width and polish

- Check every pose (closed, half open, open, rotated). Keep the transcript, composer, docks and banners clear of the fold and readable: a bounded reading width in the detail column, and `ReservedRegion` only for custom overlays that a system container doesn't move.
- Sheets on the inner display use the system's placement.
- Docs: `ios/DEVELOPMENT.md` (build with Xcode 27.1 for iPhone Duo), `ios/PROJECT_SPEC.md` and `ios/AGENTS.md` shell wording, `ios/CHANGELOG.md`, this plan's status.
- Simulator screenshots of each pose.

## Process

One implementer subagent works through the phases in order. After each phase, two independent reviewer subagents read the diff (one for correctness and the navigation model, one for HIG and iPhone Duo behavior on the simulator). Every P0/P1 finding is fixed and re-reviewed before the next phase starts.
