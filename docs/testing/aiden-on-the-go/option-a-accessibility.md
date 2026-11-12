# Option A M7: accessibility

Evidence for Task 34, "Accessibility gate". Branch `ios/option-a-lane-text`, base `e7f79ff39`. Everything here ran on the tab shell (`AIDEN_TAB_SHELL_ENABLED`, `-AidenDemoTabShell YES`) against the `four` demo scenario: four machines, one offline, running and waiting chats, a Bot.

Task 35 removed that flag and the launch argument: the tab shell is now the only shell, so the gate runs on it without either.

## The gate

`AidenShellUITests.testEveryMainScreenPassesTheAudit` replaces `testRecordAccessibilityAuditBaseline`. It runs `performAccessibilityAudit` on eight screens, in light and then in dark, in this order:

| Screen | How the test gets there |
| --- | --- |
| inbox | First screen, with a chat row and the Catch Up row on screen |
| bots | Bots tab, with a Bot row |
| bot | That Bot's chat, its first message showing |
| chat | "Fix the flaky upload test", with Send showing |
| machines | Inbox status item ("3 of 4") |
| machine editor | Studio Mac's row on Machines, its name field showing |
| settings | Inbox menu, Settings |
| search | Search tab, query "flaky", a chat result and a Bot result showing. Last, because in a regular-width window the active search field takes the tab strip's place and the test has no way back to the other tabs: before fix round 1 the "bots" audit on iPad ran on Search's results. |

What stops it passing by accident:

- The screens are pinned. The test asserts that the list of audited screens equals the eight above, in order, for each appearance. A screen it can't reach fails the test instead of being skipped.
- It covers both layouts, under the same rules. In the compact layout (the phone, or a window 500 pt wide or less) and in the regular-width layout (iPad's tab strip and split views) every finding must match a rule below, within that rule's ceiling for the layout. A rule with no regular-width ceiling excuses nothing there. The per-screen `wideBaseline` it held the iPad to before is gone.
- Each audit asserts at least four texts and cells on screen first, not counting the tab bar's own words, so an empty or loading screen can't pass an audit with nothing to find.
- Every audit type runs (`.all`). The test runs them in two passes: every type except Dynamic Type and clipped text, then those two. In one pass the Dynamic Type checks change the text size, the screen lays itself out again, and checks in the same pass lost their element. That showed up as "Contrast failed on no element" on a different screen each run. Run alone, contrast found no such issue (probe, run 7b below), and with the two passes every contrast finding names its element.
- The launch sets no content size override (`AidenStateMatrix.ContentSize.system`). A `-UIPreferredContentSizeCategoryName` argument pins the size, and the audit's Dynamic Type checks then report every text as not scaling.
- Every finding is printed (`AUDIT ISSUE` or `AUDIT ALLOWED`) and collected. The test fails if any finding is not allowed, or a rule excuses more than its ceiling. It lists all of them, and attaches the allowed ones to the result as `accessibility-audit-allowed`.
- The scripts that run the lane's tests (`t-text*.sh`) set the simulator's text size to Large (`xcrun simctl ui <device> content_size large`) before each run, so a size left over from a capture run can't change what the audit sees.

## What the gate allows, and why

No audit type is turned off. In the compact layout a finding is let through only when it matches one of these rules, and each rule may excuse at most its ceiling on each screen in one appearance; a screen a rule doesn't name gets none. The ceilings are the most each rule needed in one appearance on iOS 27 ("Aiden Lane text") or iOS 26.5 ("Aiden iOS 26"), fix round 1. Where iOS 26.5 needs more than iOS 27, the rule has a ceiling for each, so the iOS 27 gate (the main one) can't take on new findings up to 26.5's excess (`ceilingOnIOS26`, from the Task 35 fix round 1 runs). Rules are tried in this order. The reasons are also in the code, beside each rule (`AidenShellUITests.auditAllowances`).

| Rule | Matches | Ceiling per screen | Why it isn't a fault in the app |
| --- | --- | --- | --- |
| Text drawn in a bar | Dynamic Type or clipped text on an element at least half inside one bar (navigation bar, tab bar, running accessory, search field, the Bot's connection hint) | inbox 1, search 1, bot 1 | The status item ("3 of 4"), the Bot's title and the search field. Bars keep their height at every text size, the status item and the running accessory offer the Large Content Viewer, and VoiceOver reads each one whole. A list row half scrolled under a bar no longer matches. |
| System secondary text in a Form | Contrast "nearly passed" (3:1 or better, short of 4.5:1) on a static text, on Settings, Machines and the machine editor only | settings 6, machines 6, machine editor 4 | These three are Forms drawn in the system's own secondary label colour (section headers, footers, a row's second line), which darkens under Increase Contrast. Below 3:1 is never allowed, and the app's own colours on every other screen must reach 4.5:1. |
| A machine filter chip, with its tile | Contrast "nearly passed" on an element in the filter strip's row | inbox 1, bots 1 | The audit measures the whole 44 pt chip, symbol tile included, and the tile is a graphic, whose bar is 3:1. The name is the foreground colour on the raised surface. `AidenMachineChromeTests.testChipColoursMeetContrastInEveryTheme` checks each tile's glyph at 4.5:1 in all ten themes. |
| Selectable transcript text | Hit area on a static text | iOS 27: chat 2. iOS 26: chat 4, bot 5 | Transcript text is selectable, so the audit counts it as a target. It isn't a control, and a long press selects it at any size. iOS 26.5 reports more of these than iOS 27 (2 in the chat, none in the Bot chat). |
| The composer's text view | Hit area on the composer's growing text field (the audit reports it as a text field or text view) | chat 1, bot 1 | The text view is one line inside a field at least 44 pt tall (47 pt here), and a tap anywhere on the field focuses it. The "no element" case is gone: with the two passes the audit names the element every time. |
| The search field's clear button | Hit area on the `Clear text` button | search 1 | UIKit's own button, drawn and sized by the system (46 by 46 pt). |
| Settings' Machines row label | Clipped text on `Machines` | settings 1 | The label shows whole at the largest standard size and at AX5 (`xxxl-*-settings.png`, `ax5-*-settings.png`). Nothing drawn is cut. |
| A message time | Clipped text on a label starting "Sent " | chat 2 | VoiceOver reads the time as "Sent November 10, 2026 at 4:27 AM", and the audit measures that label against the "4:27 AM" drawn. |
| Text pushed below the screen | Dynamic Type "partially unsupported" on the Machines footer, "Pair a machine", and Search's "Couldn’t search Bot conversations on …" note | machines 2, search 1 | Each is a system text style and grows: see `ax5-*-machines.png` and `ax5-*-search.png`. Larger text pushes them below the bottom of the screen, and the audit reads text it can no longer see as text that stopped growing. |
| A machine chip in the filter strip | Clipped text on an element in the filter strip's row | inbox 1, bots 1 | The strip scrolls sideways and keeps one line by design. A name truncates past 240 pt, and each chip speaks the whole name. |
| Contrast of text in or under glass | Contrast on an element that touches a bar or, on iOS 26 only, lies in the 44 pt below the navigation bar or above the tab bar or accessory | iOS 27: inbox 8, search 1, bots 1, bot 2, machines 1, settings 4 (3 until the Connected machine row went, which put one more Read Aloud row under the tab bar). iOS 26: inbox 12, search 1, bot 2, machine editor 2, settings 6 | Liquid Glass draws its text with vibrancy over whatever scrolls behind, so the audit's reading changes with the content under it. The evidence: with Reduce Transparency on, the glass turns solid and the Bot's "Connecting…" hint passes (run 7). Before that change it failed even at the palette's full foreground colour. The 44 pt band is iOS 26's soft scroll-edge effect, which fades content beyond each bar: the 26.5 runs put faded text up to 39 pt from a bar's edge (the Inbox's "42m" and "Aiden Agent" above the accessory, Settings' "Aiden Agent" and "Memory" headers), and 44 pt is the accessory's own height. The band lies only where the effect is drawn: below the navigation bar and above the tab bar and accessory. The search field and the Bot's connection hint draw no such edge and get none. iOS 27 draws no band, so there it is 0. The band applies to contrast only, never to text size or clipping. This rule is tried last, so a finding another rule explains is counted there. |

The model chip's rule is gone: the chip now fits (see fixes), and the chat reports no clipped text without an element. Numbered lists were the other candidate for that rule; with it gone, one in an audited chat would fail the gate.

Last phone runs: 77 findings allowed on iOS 27 and 101 on iOS 26.5, none over a ceiling.

### The regular-width layout

On an 834 pt iPad ("Aiden iPad Audit", iPad Pro 11-inch on iOS 27.0, and "Aiden iPad Audit 26", the same iPad on iOS 26.5) the gate runs the rules above. Each rule has its own ceilings in a regular width (`ceilingInRegularWidth`, and `ceilingInRegularWidthOnIOS26` where 26.5 finds more), the most it excused on each screen in one appearance. Two rules are for the regular width only, and two others take more labels there.

| Rule | Regular-width ceiling per screen | Why it isn't a fault in the app |
| --- | --- | --- |
| Text size of the floating tab strip's titles and badge (new, tried first) | inbox, bots, machines, machine editor, settings, search: 4 each | Dynamic Type "partially unsupported" on no element, only while iPad's floating tab strip shows. The audit's own description names three `UILabel`s and a `_UIBarBadgeView`: the Inbox, Bots and Workspaces titles (Search has only its symbol) and the Inbox badge. XCTest logs that it can't resolve the strip's `_UIFloatingTabBarItemCell`, which is why there's no element. With the strip hidden (a chat, a Bot) or the sidebar open in its place there are none (probe: 4 with the strip, 0 with the sidebar). The system draws the strip at one size, as it does the phone's tab bar. The test finds the strip by its tab buttons and adds it to the glass it measures against, since `app.tabBars` is empty on iPad. |
| Text drawn in a bar | inbox 1, bot 1 | The status item and the Bot's title, as on the phone |
| System secondary text in a Form | settings 10, machines 6, machine editor 2 | As on the phone. The wider Form shows more footers at once. |
| A machine filter chip, with its tile / A machine chip in the filter strip | inbox 1, bots 1 each | As on the phone |
| Selectable transcript text | chat 3. iOS 26.5: chat 5, bot 5 | As on the phone. In a regular width the reply's first paragraph fits on one line, so it is under 44 pt tall. |
| The composer's text view / the search field's clear button | chat 1, bot 1 / search 1 | As on the phone |
| Text pushed below the screen | machines 2, machine editor 5, settings 1, search 1 | The phone's labels, plus the machine editor's Connection header and row, Identity and Reconnect, and Settings' "Read Aloud is unavailable" footer. At AX5 none of them is on the screen (probe below); at Large they sit low on the page. The editor's Hide from Inbox footer ("A hidden machine stays paired…"), the section just above Connection, is reported in every iOS 26.5 run and in some iOS 27 runs (not gate1, yes in the suite run). |
| Transcript and Search result text measured growing at every size (new) | bot 4, chat 3, search 3 | Dynamic Type "partially unsupported" on the demo Bot reply (its first line and three list items), the first chat's reply (its first line and two list items) and Search's Bot result (name, snippet, "Bot conversation · Home Mini"). Launched at each of the nine sizes from Large to AX5, each one grows at every step and stays on the screen: "Monday: roadmap review" 230 by 52 pt at Large, then 253, 266, 286, 332, 381, 452, 524 and 572 pt wide at AX5. The reply is MarkdownUI's, scaled with the body style; the Search rows are system text styles. The phone gate audits the same lines, where they wrap, and finds nothing, so a real size limit would fail there. Matched by screen and label (`textThatGrowsAtEverySize`). |
| Contrast of text in or under glass | inbox 1, bot 2 | The status item, the Bot's title and its connection hint. iOS 26.5 on iPad found nothing in the scroll-edge band: there's no bottom bar, and nothing faded under the navigation bar. |

Last iPad runs: see the regular-width run record below.

## What the audit found, and what changed

Runs are logs in the task's working folder (`task-34-audit*.log`).

| Finding | Fix |
| --- | --- |
| Status chips "Approval", "Question", "Failed" under 4.5:1 (the warning and danger fill colours as text) | `AidenStatusChip` writes in the palette's text-safe status colour. The text-safe colours are now worked out against the chip's own 12% tint over the canvas and the raised surface too (`AidenPalette.statusTextGrounds`), so the words pass on the chip in every theme (`AidenDesignTokenTests.testStatusTextMeetsFourPointFiveToOneOnItsOwnChip`, red before the change at 3.9:1 to 4.4:1). |
| Bot row purpose ("Finds the signal in a busy week") clipped at larger sizes | At the accessibility sizes the name, purpose and time stack, and the purpose wraps. Below them it takes two lines, not one: on one line the audit finds the purpose cut short at the larger standard sizes (fix round 1, run fix1-c). |
| Default machine in Settings cut to "Stu…ac" at AX5 | The picker shows the name without its symbol at the accessibility sizes, and the name then shows whole at AX5 (`ax5-*-settings.png`). It keeps the menu style: with `aidenPickerThatWrapsWhenLarge` the audit reports "Default machine" as Dynamic Type "partially unsupported" (run 7, and again in fix round 1, run fix1-c), so that modifier stays off this picker. |
| Permission choices in title case ("Ask Before Actions") (fix round 1) | Sentence case: "Full access", "Ask before actions", "No access". |
| A link to a machine that is no longer paired, when two machines share its name (fix round 1) | The message names it as the Inbox does, with the four-character suffix (`AidenMachineLabel.labels`), so the two read differently. |
| On iOS 26.5 a tap on the transcript left the keyboard up (fix round 1) | The chat and the Bot chat put the keyboard away on a tap through a UIKit tap recognizer (`AidenTranscriptTap`, a `UIGestureRecognizerRepresentable`) that doesn't cancel touches and recognizes alongside the transcript's own, so links, buttons and text selection still work. On iOS 26 the SwiftUI tap gesture never fired. The Bot chat had no tap to dismiss before. |
| "New workspace permission" cut to "Ask…ctions" at AX5 | The Settings menu pickers become a row that pushes the list of choices at the accessibility sizes, so the value wraps (`aidenPickerThatWrapsWhenLarge`). |
| Model chip cut to "Claud… · Medi…" at AX5 | At the accessibility sizes it is one text that wraps. |
| Model chip cut to "Claude… · Medi…" at the largest standard size (fix round 1) | Below the accessibility sizes the chip shows the first of three faces that fits (`ViewThatFits`): model and level whole, then the model alone, dropping the level, then both shortened. Its widest is now 240 pt (`AidenComposerLayout.longestChip`), up from 180, so "Claude Sonnet 4.5 · Medium" shows whole at the default size and the model alone at XXXL. A run's extra controls take width from the chip, which drops the level first, so the composer keeps one line. `AidenComposerSurfaceTests.testTheModelChipDropsTheLevelBeforeCuttingTheModel` renders it at both sizes. |
| The Inbox section count ("Needs you 4") under 4.5:1 in the iPad layout (fix round 1) | The count is in the title's semibold weight. A lone regular-weight digit read under 4.5:1 in the same colour as the title. |
| The running accessory's "+1" | Full foreground colour, and the accessory offers the Large Content Viewer. It still fails on glass (allowed above). |
| Composer "· Medium" and "· Hidden", the Inbox section count | No extra fading on top of the secondary colour. |
| Code block language and Copy | Primary colour. |
| Offline machine row detail ("Never connected") on the warning tint | Foreground colour, and two lines before it truncates. |
| Bot "Connecting…" hint | Foreground colour. On glass it still fails without Reduce Transparency (allowed above). |
| On iOS 26.5 in a regular width the app stopped during the machine editor's Dynamic Type check (regular-width task) | UIKit asserted after `UICollectionView _updateVisibleCellsNow:` called itself a hundred deep: the Form's two adaptive `LazyVGrid`s (Symbol and Colour) sized their rows again on every pass at a new text size. A person changing the text size on that page could hit the same loop. They are now `AidenTileGrid`, a `Layout` with the same columns that measures every tile at once; the page looks the same (`audit-machine editor-*` before and after). `AidenMachineChromeTests.testTheTileGridFitsAsManyColumnsAsItsMinimumAllows` and `testTheTileGridStacksItsRows` cover its columns. Three Dynamic Type passes on the editor in a row: the app gone after the first before, running after all three since. |
| "Modifying state during view update" at launch on an iPad (regular-width task) | Not the tab binding. A breakpoint on `os_log_fault_default_callback` stopped twice in the first frame's commit: `UIKitAdaptableTabView.updateUIViewController` → `UIKitTabBarController.updateSidebarToConfiguration` → `-[UITabBarControllerSidebar _setHidden:source:]` → `TabViewCoordinator_Phone.tabBarController(_:sidebarVisibilityWillChange:animator:)`, which sets SwiftUI's own sidebar-visibility binding during the update. No app code in the stack. It came from `.defaultAdaptableTabBarPlacement(.sidebar)`: without it the same launch logs nothing. The shell now uses the system's placement, as the Option A spec has it ("iPad uses `.sidebarAdaptable` — same code, system behaviour"): an iPad opens on the tab strip, and the sidebar is one tap away. `testIPadUsesASidebar` opens it from the sidebar button. The gate's result bundles no longer carry the runtime warning. |

### Differentiate Without Colour

- A row's machine chip (Inbox chat rows, Bot rows) shows the machine's name beside the tile. Machines share a symbol until someone picks another, so colour was the only difference. On an Inbox chat row a "·" in the secondary colour then separates the name from the workspace's, hidden from VoiceOver (fix round 1).
- The picked filter in the machine strip gets a checkmark.
- Warning and danger status chips get a symbol each (`exclamationmark.triangle.fill`, `xmark.octagon.fill`).
- The picked symbol in the machine editor gets a 2 pt outline.

Unit tests render each with the setting on and off (`AidenMachineChromeTests`, "Without colour" tests, including `testWithoutColourADotSeparatesTheMachineNameFromTheWorkspace` and `testWithoutColourThePickedSymbolHasAnOutline`). Fix round 1 broke each on purpose to check the tests can fail (run record).

### Identifiers added

`aiden.machine-name` on the machine editor's name field, and `aiden.connection-hint` on the Bot's connection hint.

## Manual pass, on the simulator

There is no person and no device in this lane, so the pass is screenshots of the real app driven by `testCaptureTheAccessibilityPass`. It is skipped unless `TEST_RUNNER_AIDEN_CAPTURE_DIR` is set, so it does nothing in FULL. With `AIDEN_CAPTURE_SET=screens` it saves Inbox, Inbox scrolled, a Catch Up approval, Search, Bots, a Bot, Machines, the machine editor, Settings and Settings scrolled, in light and dark. With `AIDEN_CAPTURE_SET=themes` it saves the Inbox and a Catch Up approval in each of the ten themes, light and dark.

Simulator "Aiden Lane text" (iPhone, iOS 27). The screenshots are in the task's working folder under `task-34-shots/`.

| Check | How | What I saw |
| --- | --- | --- |
| AX5 Dynamic Type | `xcrun simctl ui <device> content_size accessibility-extra-extra-extra-large`, then the screens set (`ax5/`) | Before the fixes: Bot purpose, Default machine, the permission picker and the model chip cut short. After: all wrap. Text in the bars and the accessory ("Plan the… +1") truncates, as the system bars do. Code blocks scroll sideways by design. |
| Largest standard size | `content_size extra-extra-extra-large`, screens set (`xxxl/`) | Everything whole except the model chip, which shortens by design (above) |
| Light and dark | Both appearances in every set | Both readable. The audit gate covers both. |
| Reduce Transparency | `xcrun simctl spawn <device> defaults write com.apple.Accessibility EnhancedBackgroundContrastEnabled -bool true`, then a simulator restart, screens set (`reduce-transparency/`), and the audit gate (run 7) | Bars, the accessory and the tab bar turn solid. Nothing scrolls visibly behind them. Turned off again afterwards. |
| Reduce Motion and Differentiate Without Colour | Together: `defaults write com.apple.Accessibility ReduceMotionEnabled -bool true` and `DifferentiateWithoutColor -bool true`, a simulator restart, and the app's own `-aiden.appearance.reduceMotion on`, then the screens set (`dwc-reduce-motion/`). Both turned off again afterwards. | Differentiate Without Colour: the picked filter has a checkmark, each row's chip names its machine, and Approval, Question and Failed carry their symbols. Reduce Motion: the screens settle the same way and nothing is left mid-transition. A still can't show an animation, so whether motion is reduced is for the device pass. |
| Ten themes, light and dark | Themes set (`themes/`): aiden, slate, berry, moss, paper, calm, graphite, dusk, midnight, monochrome | Inbox and a Catch Up approval in all twenty. All text readable, the status chips' words readable on their tints, the selected filter and Send filled in the theme's accent with a readable label. |

## Open for Task 36 (needs a device or a person)

- VoiceOver through the Inbox, Catch Up and an approval. The simulator has no VoiceOver. What automation covers: the labels and hints the rows, chips and Catch Up expose (unit and UI tests), and the audit's element checks.
- VoiceOver on the new-work machine picker's toggles.
- Liquid Glass contrast on a real screen, with and without Reduce Transparency. The simulator's glass is what the audit can't read.
- The Large Content Viewer on the status item and the running accessory (needs a long press at an accessibility size on a device).
- Numbered lists in a chat ("1. Ship the inbox rework") were reported as clipped at larger sizes in chats the gate doesn't audit ("Draft release notes", "Plan the Q3 roadmap"). Bullet lists in the audited chats pass. The list layout is MarkdownUI's, so it needs a look at AX sizes on a device before deciding whether to restyle it.

## Parked, not for Task 36

- ~~The regular-width layout's Dynamic Type findings~~ Done: the regular width runs the rules above (see "The regular-width layout").
- ~~In a regular-width window the Search tab's active field replaces the tab strip~~ Fixed in Task 35 (check N1): Search keeps its bar in a regular width, and `testSearchInARegularWidthLeavesAWayBackToTheOtherTabs` opens Workspaces from the sidebar with the field up. The gate still audits Search last.

## Run record

Audit runs on "Aiden Lane text" (iOS 27.0, Xcode 27.1), `testEveryMainScreenPassesTheAudit` alone:

| Run | State | Result |
| --- | --- | --- |
| 1, 2 | The renamed test, before any fix | Failed: the machine editor's name field had no identifier to find it by. Run 2 was cut short by a second `xcodebuild` on the same simulator. |
| 3 to 6 | Fixes and allowances in turn | Failed, each with fewer findings |
| 7 | Reduce Transparency on in the simulator | Failed on the remaining non-glass findings. The Bot's "Connecting…" hint passed, which is the evidence for the glass rule. |
| 7b (probe) | Contrast only, Inbox at the top and the bottom, a pushed chat, Workspaces | No finding without an element. That led to the two passes. |
| 8 | Two passes | Failed on two findings in each appearance (the model chip, Settings' Machines label), covered by rules in run 9 |
| 9 | Final rules and fixes | Passed, 81 findings allowed |

Other runs:

| Run | Where | Result |
| --- | --- | --- |
| Unit tests for the touched code (`AidenDesignTokenTests`, `AidenMachineChromeTests`, `AidenOwnerRoutingTests`, `AidenChatMarkdownTests`, `AidenComposerSurfaceTests`, `AidenInboxTests`, `AidenNewWorkTargetTests`, `AidenUnifiedInboxTests`) | Aiden Lane text | 345 passed |
| `AidenDesignTokenTests` before the status text change | Aiden Lane text | `testStatusTextMeetsFourPointFiveToOneOnItsOwnChip` failed, 3.9:1 to 4.4:1 on the chips |
| Search and chat keyboard tests, Search's machine name | Aiden Lane text | 4 of 4 passed |
| Same | Aiden iOS 26 (iOS 26.5), under `sim26.lock` | 4 of 4 passed, the chat test with its one expected failure (a tap left the keyboard up; fixed in fix round 1) |
| Break check: Search showing the host's name, the chat transcript with `scrollDismissesKeyboard(.never)` | Aiden Lane text | Both new tests failed, then the code went back |
| The audit gate | Aiden iOS 26 | Reached all eight screens in both appearances once Settings opens with a second tap when the first lands on a menu still opening. Failed on five contrast findings in the scroll-edge band (the 44 pt band in fix round 1). |
| `testDraggingTheResultsPutsTheKeyboardAwayAndKeepsTheQuery` | Aiden Lane iPad, four times in a row | 4 of 4 passed |
| `AidenShellUITests` | Aiden Lane iPad, at `bdba3c86c` | 50 run, 2 skipped, 4 failed: the three known menu-shell failures (`testCaptureBaselineScreens`, `testLoadEarlierKeepsTheReaderOnTheMessageTheyWereReading`, `testAShortChatStaysAtTheTop`, "The chat did not open") and the audit gate (54 findings in the wide layout). The gate now skips there. `testDraggingTheResultsPutsTheKeyboardAwayAndKeepsTheQuery` passed, after the narrowing tests. |
| The audit gate after the wide-window skip | Aiden Lane text / Aiden Lane iPad | Passed / skipped |
| FULL | Aiden Lane text, at `bdba3c86c` | Unit: 2,227 run, 7 skipped, 2,219 passed, 1 failed. UI: 50 run, 3 skipped (including the opt-in capture), 47 passed. |
| `testADeletedChatLeavesAtOnceOverItsOwnMachine`, the one unit failure | Aiden Lane text, ten times alone, then its class | 9 of 10 alone, the class 86 of 86. It expects the last request to be `GET /workspaces` and sometimes sees a refresh of the kept chat after it: a timing flake in a store test this task doesn't touch. |
| `npm run test:ios-release` | | 32 of 32 passed |

### Fix round 1

Logs are `task-34-fix1-*.log` in the task's working folder.

| Run | Where | Result |
| --- | --- | --- |
| fix1-a: `AidenComposerSurfaceTests`, `AidenMachineChromeTests`, `AidenOwnerRoutingTests`, `AidenChatTests`, both keyboard tests | Aiden Lane text | The new chip test failed at the old 180 pt width: even the model alone didn't fit at XXXL beside the provider icon. Everything else passed. |
| fix1-b | Aiden Lane text | Measured the chip's three faces at Large, XXL and XXXL, which set the 240 pt width |
| fix1-c | Aiden Lane text | The gate failed on the filter chip matched by the Form rule (screens restored to that rule), the Bot purpose cut on one line (back to two) and "Default machine" with the wrapping picker (taken off again) |
| fix1-d | Aiden Lane text | The gate and `testTheEmptyStatesScrollClearOfTheField` passed. No clipped text without an element in the chat: the model chip fits. 77 allowed. |
| fix1-ios26a, under `sim26.lock` | Aiden iOS 26 (iOS 26.5) | The Bot chat's keyboard test passed. The chat's tap step failed (the recognizer alone). The gate went over the ceilings set from iOS 27, which gave the iOS 26.5 ceilings above. Nothing failed outside a rule. |
| fix1-phone-e | Aiden Lane text | The gate passed with the glass rule last. 77 allowed. |
| fix1-ipad-a, -b, -c | Aiden Lane iPad | The two "4" findings were the Inbox section counts (fixed: gone in -b). The bots step never left Search: the tab strip isn't there while the search field is active, and the test found the Bot by its Search result. Search now goes last (-c), and -c pinned `wideBaseline`. |
| fix1-ios26b, under `sim26.lock` | Aiden iOS 26 (iOS 26.5) | The gate passed (101 allowed) and both keyboard tests passed, after the recognizer also resigns the first responder in UIKit |
| fix1-full: FULL under `full.lock`, at `5a398c388` | Aiden Lane text | Unit: 2,231 run, 7 skipped, 2,224 passed, 0 failed. UI: 51 run, 3 skipped (including the opt-in capture), 48 passed, 0 failed. `npm run test:ios-release` then failed 1 of 32: the shipping check still looked for the old SwiftUI `TapGesture` on the chat transcript. It now looks for `AidenTranscriptTap` (`4f6bbe31e`) and passes 32 of 32. |
| fix1-ipad-shell: `AidenShellUITests`, at `4f6bbe31e` | Aiden Lane iPad | 51 run, 2 skipped, 46 passed, 3 failed: the three known menu-shell failures (`testCaptureBaselineScreens`, `testLoadEarlierKeepsTheReaderOnTheMessageTheyWereReading`, `testAShortChatStaysAtTheTop`). The audit gate passed in the regular-width layout, each screen at or under its baseline with the same counts as fix1-ipad-c, and both keyboard tests passed. |
| fix1-breakcheck | Aiden Lane text | With each Differentiate Without Colour cue broken on purpose (the row chip's name always on, no status symbol, no filter checkmark, no symbol outline, no separator) and the no-longer-paired message back to "This machine is no longer paired", every matching test failed: all five "Without colour" tests in `AidenMachineChromeTests` (6 failures) and the five naming tests in `AidenOwnerRoutingTests` (7 failures). The code went back afterwards. |

The iPad drag test (`testDraggingTheResultsPutsTheKeyboardAwayAndKeepsTheQuery`) failed in earlier iPad rounds (Task 25) before `d33215a7b`, which measured the drag in the window instead of the app frame and gave the window back its width after a narrowing test. Since then it passed in every iPad run (Task 25 and 31 reruns, four in a row here, and after the narrowing tests in the suite run). The width is now restored in a teardown block, so a narrowing test that fails part way still leaves the window wide.

### The gate on iPad

Each run used a simulator made for it and deleted afterwards: "Aiden iPad Audit" (iPad, iOS 27.0), "Aiden iPad Audit 26" (iPad, iOS 26.5) and "Aiden Phone Audit" (iPhone 17 Pro, iOS 27.0), with Xcode 27.1.

| Run | Where | Result |
| --- | --- | --- |
| phone0, from `origin/main` | Aiden Phone Audit | The gate passed, 75 allowed |
| gate0, the gate with `wideBaseline` | Aiden iPad Audit | Failed: 125 findings in the regular width, several screens over their baseline |
| lldb, a symbolic breakpoint on `os_log_fault_default_callback` | Aiden iPad Audit | Two faults at launch, both from SwiftUI writing its sidebar state while drawing the first frame (`UIKitAdaptableTabView.updateUIViewController` to `TabViewCoordinator_Phone.tabBarController(_:sidebarVisibilityWillChange:animator:)`), with no app code in the stack. Without `defaultAdaptableTabBarPlacement(.sidebar)`: none. |
| Tab strip probe | Aiden iPad Audit | The four Dynamic Type findings with no element on every screen are the floating tab strip: the three tab titles and the Inbox badge (`_UIFloatingTabBarItemCell`, which XCTest reports as an automation type mismatch) |
| Growth probe | Aiden iPad Audit | The transcript and Search result text the audit calls partially unsupported grows at every size from L to AX5 (for example "Monday: roadmap review", 230 to 572 pt wide) |
| gate1, the regular-width rules | Aiden iPad Audit | Passed, 122 allowed |
| ipad26 r1 | Aiden iPad Audit 26 | Failed with "No Inbox menu": the app had been killed in the machine editor. The audit's text size check made the adaptive `LazyVGrid` in the Form rows re-size on each pass until UIKit stopped the app. |
| Machine editor probe | Aiden iPad Audit 26 | Three text size passes on the editor: the app died in the first with `LazyVGrid`, survived all three with `AidenTileGrid` |
| ipad26b, ipad26c | Aiden iPad Audit 26 | -b failed on 15 findings over the iOS 27 ceilings (hit areas in both chats, the hidden machine footer), which set the iOS 26.5 regular-width ceilings. -c passed, 134 allowed. No finding in the scroll-edge band. |
| `AidenMachineChromeTests`, `AidenMachineDetailTests` | Aiden iPad Audit 26 | 71 passed, including the two tile grid tests |
| phone2 | Aiden Phone Audit | The gate passed, 75 allowed, the same findings as phone0 |
| `npm run test:ios-release` | | 53 of 53 passed (20 Ruby, 33 Node) |
| ipad-suite: `AidenShellUITests` | Aiden iPad Audit | 59 run, 2 skipped (the opt-in capture, and the tab bar minimizing, which is iPhone only), 56 passed, 1 failed: the gate, on a fifth machine editor finding over the ceiling of 4 (the Hide from Inbox footer, which gate1 didn't report). That set the editor's ceiling to 5 on both systems. The three menu-shell failures of earlier iPad runs (`testCaptureBaselineScreens`, `testLoadEarlierKeepsTheReaderOnTheMessageTheyWereReading`, `testAShortChatStaysAtTheTop`) all passed. An iPad now opens on the tab strip, which is the likely reason; none was changed for it. |
| gate2 | Aiden iPad Audit | Passed, 123 allowed |
| ipad26d, on the final build | Aiden iPad Audit 26 | Passed, 134 allowed |
| phone3, on the final build | Aiden Phone Audit | Passed, 75 allowed |
