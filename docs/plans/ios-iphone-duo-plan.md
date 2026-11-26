# iPhone Duo: list and conversation side by side

Status: In review (PR) (2026-11-22), branch `feature/ios-iphone-duo`. Phases 1 to 3 are done and reviewed; origin/main is merged in. Phase 4's remaining items are listed under it.

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

- Decide layout by horizontal size class only (AGENTS.md). Regular width gets list + detail, on iPhone Duo's inner display and on iPad. Compact width (Duo outer display, every other iPhone) keeps today's single stack unchanged. Update 2026-11-25 (PR #934): the rule now also needs regular height (`AidenTabChrome.besideList`), so a Plus or Pro Max held sideways keeps the stack and the dock; the Duo's inner display and iPad are regular both ways and are unchanged.
- One source of truth: each tab's existing path in `AidenAppNavigation`. In split mode the path's first route is the sidebar selection and the rest is the detail column's stack. Saved navigation and every `open`/`leave`/Catch Up rule stay as they are.
- Use system containers (`NavigationSplitView`, `TabView`) so the fold, the camera and the vertical rail are handled by the system. No custom bars and no hinge-specific code where a system container already adapts.
- Opening or closing the display swaps each list tab's container: compact width is a plain `NavigationStack` bound to the tab's whole path, and regular width is the `NavigationSplitView`. A split that collapsed itself into one stack left the closed iPhone Duo's side rail without a working Back (iOS 27.1 simulator). Only the container for the current layout writes the path (`AidenAppNavigation.setPath(_:of:laidOutBesideList:widthIsRegular:)`), so the outgoing one can't empty it. The container also passes its own horizontal size class, because it hears the new width an update before the shell does. Chat and Bot chat screens belong to the shell (`AidenChatScreens`), so the swap keeps the draft, attachments, voice and reading place; a durable Bot chat's feed runs in its kept parts (`AidenBotSessionScreenParts`), so it keeps its live conversation too. The shell announces the swap, so nothing waits on a timer.
- The shell also owns Search (`AidenSearchModel`: query, scope and results) and each list tab's scroll place, so both survive the swap. A list's place is the row across its top, recorded from row frames in the list's own named coordinate space while the person scrolls and when it comes to rest, and put back once with `ScrollViewReader.scrollTo(id, anchor: .top)` after the new list's first layout. A row ID holds through the reflow at the new width and through rows or banners that arrive above it. `scrollTo` matches a `ForEach` identity by its own type, so the stored `AnyHashable` is unwrapped first. A list at rest records nothing more, since a list taken down by the fold reports geometry on its way out.
- A Search query counts as answered only when every machine replied, and only for 30 seconds: long enough to survive a fold, short enough that a later visit asks again.
- The reading place is read when scrolling settles, from row frames in the transcript content's own coordinate space. Each frame belongs to the screen that measured it, because a fold builds the new screen's rows before the old screen's rows leave. The visible height is `ScrollGeometry.containerSize`, which already leaves out the content insets.
- The iOS Aiden preset's accent is muted ink (the owner's decision for iOS). The desktop (`renderer/shared/appearance.ts`), Android and the shared `protocol/aiden-appearance-v1.json` keep the blue Aiden accent, so iOS is the one stated exception in its fixture test. Follow-up: decide whether the desktop and Android follow. Links are underlined in the transcript and in HTML previews on every theme, because an ink accent alone sits too close to body text to mark a link (WCAG 1.4.1).
- Visuals the Mac draws for the phone (`chat-visual-viewer-v1`) still come back blue on the Aiden theme: the request carries only the preset ID ("aiden"), and the Mac resolves that to its own blue palette.
- The tab view keeps the system's tab bar placement. It isn't forced to a sidebar, because the list column already gives the extra hierarchy level.
  - 2026-11-25: on the closed Duo (compact width) the system tab bar is now hidden and Aiden's dock draws the tabs along the bottom (`docs/plans/ios-new-direction-upgrade-plan.md`, Phase 2). The rail keeps the status bar and the navigation bar's items. The open Duo is unchanged.

## Phases

### Phase 1: Inbox list + detail on regular width

- The Inbox tab becomes a `NavigationSplitView` at regular width. The sidebar is the existing Inbox list (machine chips, Needs you / Updates / Earlier, Catch Up, running row) with the selected row highlighted. The detail is a `NavigationStack` rooted at the selected route, or an empty state ("Pick a chat").
- A pure mapping between the tab path and (selection, detail path), unit tested, including Catch Up's Next, `leave`, `replace`, and restoring a saved path.
- The Inbox toolbar (menu, compose, machine pill) stays with the list column. The conversation's toolbar moves to the detail column, where the system puts it on the trailing rail.
- Compact width renders exactly as before.

### Phase 2: Bots and Workspaces list + detail

- The same treatment for the Bots tab (Bot list | Bot chat) and the Workspaces tab (workspace list | workspace, then its chats in the detail stack).
- Search stays a single stack. Its results open on their own tab as today.
- Superseded (2026-11-24, iOS new direction Phase 1 step 3): the Search tab is gone. The tabs are Chats, Bots, Workspaces and Inbox, and Chats is a list and detail at regular width like the others. Search, pins, recents and the pages with no tab live in a leading drawer that overlays the content at every width, including the open iPhone Duo; the drawer holds no path, closes only on the person's actions, and its query lives in the shell's `AidenSearchModel`, so a fold keeps it.

### Phase 3: Bars ready for the vertical rail

- Every toolbar item has a title and a symbol (`Label`), so the system can show it on the rail, in a horizontal bar, or in overflow.
- Compose keeps the highest visibility priority. Back and Close stay first (`cancellationAction`).
- The chat and Bot chat views are task views: on iOS 27.1 they prefer keeping toolbar items (`toolbarVerticalCompressionBehavior(.prefersToolbarItems)`). Availability is gated, since the deployment target is iOS 26.
- Replace `UIDevice.userInterfaceIdiom` layout decisions (attachment picker) with size class.

Done (2026-11-22, not yet reviewed):

- The image-only toolbar buttons are now `Label`s: a chat's and a Bot chat's More, and the workspace page's menu. Every other bar item already had a title. Text items (Catch Up's Next) stay text: on the closed iPhone Duo the system keeps them in the bar along the top, where the word reads better than a symbol.
- The custom views stay where they carry meaning a title can't. On the closed iPhone Duo (iOS 27.1 simulator) the system keeps the title bar along the top and moves only the trailing actions to the rail, so the Inbox machine pill ("3 of 4") and the Bot header (avatar and name, opens the profile) still show. Bot chats now also set the Bot's name as their title, so a bar without the header still names it, and the profile stays in More.
- Compose has `visibilityPriority(.high)` (iOS 27.0 and later, in both SDKs) in the Inbox and on the Workspaces tab. Back is the system's, and sheets already put Close and Cancel in `cancellationAction`.
- Chat and Bot chat set `toolbarVerticalCompressionBehavior(.prefersToolbarItems)` on iOS 27.1, behind the UIKit 9127.0.85 SDK check, so Xcode 27.0 builds without it.
- The attachment picker's centered landscape column is decided by regular width, not by `userInterfaceIdiom == .pad`.
- `ToolbarOverflowMenu` isn't used: no screen's rail overflows on the iPhone Duo, and the Inbox and workspace menus already group their secondary actions.
- Owner request: the Inbox's "<Machine> is offline" notice has a close button (X, 44 pt, "Hide <Machine> offline notice"). Closing hides that machine's notice until the app is quit and opened again, even if the machine comes back and drops again. The shell owns the set in memory (`AidenOfflineNoticeDismissals`, nothing saved), so it holds across tabs and a fold. Reconnect, the machine chips and the "3 of 4" pill don't change.
- Owner request: the Aiden preset's accent is muted ink (#1F2228 light, #E4E7EC dark) instead of blue, here and in the app's AccentColor. The other presets keep their accents, and status colours stay coloured. Every preset's accent holds 4.5:1 on the canvas, sidebar and raised surfaces, and every solid fill's content holds 4.5:1 on its fill (`AidenDesignTokenTests`). The Aiden swatch in Settings → Appearance now looks close to Monochrome's. The desktop Aiden preset (`renderer/shared/appearance.ts`) is still blue.
- Owner request: lists share one quiet style (`AidenListRowLayout`, `AidenListSectionHeader`, `aidenListCardRow`). Each section is a rounded card inset like Catch Up, on the raised fill with no border; its heading sits above it in small regular secondary text. Rows have no separators: a fixed mark column (a spinner while running, a filled dot when unread, an open circle otherwise, or an avatar), a body-size title that is never bold, one subheadline summary line, and the trailing marks on the summary's line. Every measure scales with Dynamic Type. It covers the Inbox, the Running chats sheet, Search results, Bots, the Workspaces list and its archived list, a workspace's chats and Computers. Settings-style forms keep the system's grouped cards with inset separators, as `docs/settings-design-system.md` asks, and pickers stay dense.
- Review round 1 (2026-11-22): a pinned list heading has the canvas behind it, so rows scrolling under it don't show through. Computers' footer is a plain row on the canvas, since a plain list draws a footer on its own band with a hairline, and a navigation link row's trailing inset makes room for the system's chevron. List row whitespace (mark column, vertical padding, line gap) scales with the text only up to a cap. Settings → Appearance tiles show the sidebar and a raised card, which tells Aiden (cool grey, slate dark) from Monochrome (white, black); Aiden and Graphite still read close, as their palettes are close. After merging main (#872), each tile draws only the look the chosen mode gives it (`AidenThemeTileSwatch`), as on desktop and Android, rather than both schemes side by side.
- Review round 2 (2026-11-22): `AidenSwitchToggleStyle`, applied to each switch through `aidenSwitchStyle()`, draws switches on the palette's on-track: the accent when it holds 1.5:1 against the white thumb, else the success green (Aiden and Monochrome in dark). It is not installed at the root: a menu treats any custom toggle style as an opaque view, and the compose machine picker's menu of toggles fell apart into one item per label piece (name, detail and symbol as separate checkmark rows) with picking a machine broken. `testWorkspacesComposeStartsOnThePickerAtTheFilteredMachine` now picks a machine from that menu. The Inbox Bot row's avatar uses the row layout's avatar column, which clips its mark to the column, so it can't cover the name at the accessibility sizes. Every transcript surface (chat, Bot chat, live reply, streaming chunks) renders through `AidenMarkdownView` and its underlined-link theme; the plain-text fallback for oversized replies has no links.
- Review round 2 sim findings (2026-11-22): the reading place's anchor depends on the row's height and the visible height, and after a fold the first return could run on a stale height (a row measured shorter than the view gives a negative anchor that, once the row settles taller, leaves the question above at the top). The return now runs again whenever the place's row takes a new height (`AidenChatScreenParts.setRowFrame` reports it) or the visible height changes, while the place is held. Jump to latest carries a raised tint under its glass and a soft shadow. The Default computer picker is rebuilt on an accent change, because its menu button kept the tint it was built with. Workspace rows put the folder in the avatar mark column the other lists use. Not done: a swipe left open on a system list row stays open across navigation (UIKit `swipeActions` behavior).
- Owner request: a Bot row on Bots no longer shows the Bot's purpose bubble, and VoiceOver no longer reads it there. The profile still shows it, and search still matches it.
- Owner request: the machine chips have a status dot (filled green online, an open ring offline, and VoiceOver says Offline), regular-weight names and a 12 pt gap. The chip row fades out at an edge with more chips past it instead of being cut off.
- Owner request: the Running accessory's ring no longer wanders when the tab bar minimizes or expands. Each placement gets its own ring, which fades in with the title instead of sliding across from the old place.

### Phase 4: Fold, reading width and polish

Done in this PR: the fold keeps each chat's and each Bot chat's draft, attachments, voice and reading place (a durable Bot chat also keeps its live feed), Search, and each list's scroll place (Phase 2 and the review rounds); docs (`ios/DEVELOPMENT.md`, `ios/PROJECT_SPEC.md`, `ios/AGENTS.md`, `ios/CHANGELOG.md`, this plan). Merge check (2026-11-22): on an iPad mini in portrait the system hid the Bots list the first time the tab showed, leaving "No Bot selected" alone; the split now brings the list back whenever its visibility changes with nothing chosen. The composer and snapshot unit tests failed on the iPhone Duo, CI's newest simulator. Their 375 and 390 pt test windows took the open screen's 84 pt right safe-area inset. They now draw without safe areas, and the tap-target checks compare whole device pixels. They pass open and closed. Remaining work, not in this PR:

- Check every pose (closed, half open, open, rotated). Keep the transcript, composer, docks and banners clear of the fold and readable: a bounded reading width in the detail column, and `ReservedRegion` only for custom overlays that a system container doesn't move.
- Sheets on the inner display use the system's placement.
- Simulator screenshots of each pose (half open and rotated not yet checked).
- A swipe left open on a list row stays open across navigation (UIKit `swipeActions` behavior); close it when its row leaves the screen.
- `testEveryMainScreenPassesTheAudit` on an iPad mini in portrait (iOS 27.1). Fixed on 2026-11-22:
  - The empty detail under the list no longer shows its words.
  - Opening Computers or Settings from the list puts it away.
  - The running row's title wraps at the largest sizes.
  - The test waits for the list to leave before auditing a Bot, a chat or Computers.
  - The row the window's bottom edge cuts ('1h') and the Bot page's own message (measured growing at every size) have audit rules (`option-a-accessibility.md`).

  Still failing there:
  - The two Form near-pass ceilings ('Connection' in the machine editor, '3 of 4 online' in Settings). `main` fails on these too on that simulator; its baseline run found nothing else.
  - Dynamic Type "partially unsupported" findings that come and go. Run after run they land on different screens and in different passes. Settings audited three times in a row in one launch gave different results, with or without the Default computer picker's `.id`. When one appears, every text on that screen appears with it. It looks like the audit sampling before the screen has laid out again, on a host with a load average of 35 to 75.
- Main's shell-first onboarding (Add Computer empty states and the inline pairing sheet) checked at regular width on the open iPhone Duo, where the empty state sits in the list column.

## Process

One implementer subagent works through the phases in order. After each phase, two independent reviewer subagents read the diff (one for correctness and the navigation model, one for HIG and iPhone Duo behavior on the simulator). Every P0/P1 finding is fixed and re-reviewed before the next phase starts.
