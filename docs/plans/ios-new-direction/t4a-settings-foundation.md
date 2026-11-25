# t4a: Settings and design foundation (Track 4, part A)

Repo read: `/Users/sambitbiswas/projects/aiden-agent/.claude/worktrees/ios-new-direction` (claude/ios-new-direction = origin/main). All paths are relative to it. Read-only work: no simulator and no xcodebuild were run.

Scope covered here:
- Concept 19 Settings and idea-settings.
- Concept 21 Appearance and idea-appearance. The Aurora rows are placed here, but t4b owns how they behave.
- Concept 24 Usage and idea-usage.
- An audit of the iOS theme layer.
- The shared component kit that the other tracks build on.

---

## 0. Design foundation audit (iOS theme layer versus the concepts)

### 0.1 What exists

| Layer | Where | Notes |
|---|---|---|
| Spacing tokens | `ios/AidenOnTheGo/Config/AidenDesignTokens.swift:1-20` | `AidenSpacing` has xs 4, s 8, m 12, l 16, xl 20, xxl 24, xxxl 32. `AidenRadius` has control 16, card 24, composer 28, code 12. There are no type, row-height, separator-inset or chip tokens. |
| Palette | `ios/AidenOnTheGo/Config/AidenAppearance.swift:266` (`AidenPalette`) | Holds hex values for canvas, sidebar, raised, foreground, secondary, accent, success, warning and danger. Text-safe status colors and `statusChipFillOpacity = 0.12` are at `:437-482` (`:455`). |
| Solid fill / buttons | `AidenAppearance.swift:353` (`AidenSolidFill`, WCAG 4.5:1 deepening capped at 45%), `:502` `aidenSolidFillTint`, `:522` `AidenSolidFillButtonStyle<S: Shape>(tone:shape:hitSize:)` | This is the squircle or filled button primitive. It stays as is. |
| Switch | `AidenAppearance.swift:390-427` (`aidenSwitchStyle()`, `switchOnTrackHex`) | Already themed. |
| Presets | `AidenAppearance.swift:163` (`AidenThemePresetID`, 10 presets), catalog `:563-617` (`tilePreview(preset:mode:systemScheme:)`, `palette(preset:scheme:)`) | Each preset has a light and a dark hex table. |
| Store | `AidenAppearance.swift:636-720` (`AidenAppearanceStore`, `aiden.appearance.*` UserDefaults) | `uiFontSize` is persisted and clamped to 12...18, default 14 (`:668`, `:686`), but **no UI sets it**. `selectTheme` writes both the light and dark preset (`:700`). |
| Root / env | `AidenAppearance.swift:785-821` (`AidenAppearanceRoot`), `:959-971` `AidenUITypographyModifier` (ScaledMetric relative to `.body` × uiFontSize) | Sets the env keys `aidenPalette`, `aidenThemePreset`, `aidenReduceMotion`, `aidenLowPowerMode` and others. |
| Memory symbol | `ios/AidenOnTheGo/Features/Bots/AidenBotMemoryView.swift:240-243` (`AidenBotMemorySymbol.name = "sdcard"`) | This is the iOS analog of `MemoryCardIcon`. `AidenBotSuggestionCards.swift:308` uses `"memorychip"` for a memory suggestion. That chip icon is not a brain, but it drifts from the SD-card rule and should switch to `AidenBotMemorySymbol.name`, a small fix. |
| Bot avatar | `ios/AidenOnTheGo/Features/Bots/AidenBotSemanticAvatarView.swift:120` (`AidenBotSemanticAvatarView`) | The only Bot avatar renderer. Per-Bot usage rows must use it. |
| Skeleton | `ios/AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift:108` (`AidenBotSkeletonBlock`) | Reused by the Usage pending view. |
| Chrome symbols | `ios/AidenOnTheGo/Features/Shell/AidenAppShellView.swift:3` (`AidenChromeSymbols`) | |
| Android settings kit (parity reference) | `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/settings/AidenSettingsComponents.kt:97-394` | Provides `AidenSettingsScaffold`, `AidenSettingsGroup`, `AidenSettingsNavigationRow`, `AidenSettingsSwitchRow`, `AidenSettingsValueRow`, `AidenSettingsRadioRow`, `AidenSettingsSkeletonRow` and `AidenSettingsMessageRow`. **iOS has no equivalent.** Every iOS settings surface is a stock `Form`. |

### 0.2 Gaps against the concepts' visual language and `docs/settings-design-system.md`

- **Large titles.**
  - Settings uses `.navigationBarTitleDisplayMode(.inline)` (`AidenAppSettingsView.swift:213-214`). Usage is also inline (`AidenUsageView.swift`, pending view `:5-57`).
  - The concepts use large titles everywhere, and the design system sets "heading metrics 26/32" (`docs/settings-design-system.md:51`).
  - Gap class: UI-only.
- **Grouped cards with inset separators.**
  - Today these are stock `Form` sections with system insets and system background.
  - The design system wants "soft neutral surfaces, inset separators, and restrained elevation, with no outline" (`settings-design-system.md:51`).
  - `Form` can be themed (`.scrollContentBackground(.hidden)` with `listRowBackground(palette.raised)`), but row insets and leading-icon alignment differ per row type. A custom `AidenGroupedCard` matches Android's `AidenSettingsGroup` and the concept.
  - Gap class: UI-only.
- **Borders.**
  - The usage card draws a 0.5pt stroke at foreground 0.06 (`AidenUsageView.swift:584-594`). The "borderless surfaces" rule (AGENTS.md; `settings-design-system.md:51` "with no outline") says to drop it, keeping the raised fill and radius.
  - Theme tiles draw a selected label on accent 0.12 (`AidenAppearance.swift:882-904`), which is fine because it is a fill, not a border.
- **Pill segmented control.**
  - Mode uses the stock `.segmented` Picker (`AidenAppearance.swift:837-844`).
  - The concept shows a full-width capsule track with a raised thumb. Build `AidenPillSegmentedControl` and keep the accessibility traits (`.isSelected`, adjustable). Do not hand-roll gestures without VoiceOver support.
- **Soft status chips.**
  - `statusChipFillOpacity = 0.12` exists, but each screen builds its own capsule. Usage's "Last 30 days" chip uses `palette.sidebar` (`AidenUsageView.swift`, tokenActivitySection).
  - Extract `AidenStatusChip`: soft fill plus a text-safe color, no border, per AGENTS.md.
- **Typography.**
  - There is no type scale. Screens use raw `.font(.title2.weight(.semibold))` and similar.
  - Add `AidenTypeScale` (page title, section caption, row title, row value, stat hero, footnote) as `Font` helpers that stay relative to Dynamic Type, so the in-app Text size multiplier applies to them as well.
- **Focus.** SwiftUI's default focus is kept on iPad keyboard and full keyboard access. Custom rows must stay `Button`s, not `onTapGesture`, so focus rings remain.

### 0.3 Proposed shared component kit (new file `ios/AidenOnTheGo/Config/AidenSettingsKit.swift`, plus additions to `AidenDesignTokens.swift`)

| Component | API sketch | Used by concepts |
|---|---|---|
| `AidenTypeScale` (tokens) | `enum AidenTypeScale { static var pageTitle, sectionCaption, rowTitle, rowValue, statHero, statCaption, footnote: Font }`. Each is built from `Font.TextStyle` so Dynamic Type and `uiFontSize` both apply. | All |
| `AidenSettingsTokens` (tokens) | `rowMinHeight 52`, `rowHPadding = AidenSpacing.l`, `separatorLeadingInset` (icon column + `AidenSpacing.m`), `cardRadius = AidenRadius.card`, `cardFill = palette.raised`, `pageBackground = palette.canvas` | All grouped pages |
| `AidenLargeTitlePage<Content>` | `AidenLargeTitlePage(title: LocalizedStringKey, subtitle: String? = nil, leading: ToolbarContent? , trailing: ..., @ViewBuilder content)`. It wraps `ScrollView` + `LazyVStack(spacing: AidenSpacing.xxl)`, sets `.navigationTitle` with `.large`, applies the canvas background and leaves safe-area inset room for the dock or running accessory. | 19, 21, 24, and the Bot profile / Workspace / Scheduled / Computers pages (t2b, t3a, t3b) |
| `AidenSectionCaption` | `AidenSectionCaption("Most used models", trailing: AnyView?)`, a secondary footnote above a card | 21, 24, 19 (idea), Bot memory, Search |
| `AidenGroupedCard<Content>` | `AidenGroupedCard(footer: String? = nil) { rows }` in a `_VariadicView` layout that places an inset separator *between* rows automatically, with no outline. It is the analog of the web `FieldSet` and Android `AidenSettingsGroup`. | 19, 21, 24, Bot profile, Workspace settings, Computers |
| `AidenSettingsRow` | `AidenSettingsRow(icon: AidenRowIcon?, title:, subtitle: String? = nil, accessory: .value(String) / .chevron / .valueChevron(String) / .toggle(Binding<Bool>) / .chip(AidenStatusChip) / .custom(AnyView), action: (() -> Void)? = nil)`. It renders a `Button` when there is an action, so focus rings and the `.isButton` trait come for free. The value text uses `palette.secondary`. It supports `.disabled` with a reason line. `AidenRowIcon` is a plain SF symbol tinted secondary, with no icon background (owner memory: "titles only, no icon bgs"). | 19 (all rows), 21 (Accent, Text size, App icon, Lock Screen), 24 (model and Bot rows), t3b Computers rows |
| `AidenNavigationRow` | A thin wrapper over `AidenSettingsRow` around `NavigationLink(value: AidenAppRoute)` | 19 |
| `AidenPillSegmentedControl<T: Hashable>` | `AidenPillSegmentedControl(selection: Binding<T>, options: [T], label: (T) -> String)`: a capsule track on `palette.sidebar` with a raised thumb on `palette.raised`. It animates with `aidenReduceMotion`-aware matchedGeometry, exposes the VoiceOver adjustable trait, and keeps keyboard focus. | 21 (Mode), 24 (range), t1a Inbox filters, t3b Scheduled |
| `AidenStatusChip` | `AidenStatusChip(_ text:, tone: .neutral/.accent/.success/.warning/.danger, symbol: String? = nil)`: a fill of `tone` at `statusChipFillOpacity`, text in the text-safe color, no stroke | 19 ("2 of 2 online" could stay a plain value), 24 ("Last 30 days"), t3b Computers, t2a Bot status |
| `AidenSwatch` / `AidenSwatchGrid` | `AidenSwatch(fill: Color, ring: Color, isSelected: Bool, label: String)` is a circle that shows a check glyph when selected and has no decorative border. `AidenSwatchGrid(columns: 5, items, selection:)` uses `LazyVGrid` and `.accessibilityElement(children: .contain)` with `.isSelected`. | 21 (themes, accent), t4b Aurora palette |
| `AidenStatHero` | `AidenStatHero(value: "1.2M", caption: "Tokens · last 30 days", @ViewBuilder accessory)` | 24 and idea-usage ("$12.40"), Bot profile stats |
| `AidenHeatmap` | `AidenHeatmap(days: [AidenUsageDay], columns: 10, value: KeyPath, palette:)`, extracted from `AidenUsageView` tokenActivitySection. It uses an accent opacity ramp, a Less/More legend and per-cell accessibility labels. | 24, Bot profile activity (t2b) |
| `AidenCircleIconButton` | `AidenCircleIconButton(symbol:, label:, action:)` uses `AidenSolidFillButtonStyle(shape: Circle())` with a 44pt hit size | 19 (drawer/back), t1a |
| `AidenAvatarValueRow` | `AidenSettingsRow` with leading `AidenBotSemanticAvatarView(size: 28)` | idea-usage By Bot, t2b, t3b |

Tests for the kit, all behavioral:
- XCUITest checks that a grouped card's rows are reachable as buttons with the expected labels and values.
- An `ImageRenderer` pixel-sample test checks that `AidenStatusChip` fills match the tone at 0.12 in light and dark (same pattern as the existing `testThemeTilesPreviewTheLookTheModeGivesEveryTheme`).
- A unit test checks that `AidenPillSegmentedControl` writes the selection binding and exposes `accessibilityValue`.
- Do not lock class or modifier strings.

---

## 1. Concept 19 Settings (+ idea-settings)

### 1.1 Entry point and views
- Entry is the Inbox toolbar overflow Menu → Settings, at `ios/AidenOnTheGo/Features/Shell/AidenAppShellView.swift:552-560` (`navigation.open(.settings)`). It is routed at `:645-650` to `AidenAppSettingsView(coordinator:appearance:)`. The route `.settings` is in `ios/AidenOnTheGo/Features/Shell/AidenAppNavigation.swift:23-32`, on the inbox tab (`:37`).
- The view is `ios/AidenOnTheGo/Features/Workspace/AidenAppSettingsView.swift:3` (243 lines).

### 1.2 Live today
The page is a `Form`, "App settings", with an inline title (`:213-214`). Its sections:
1. **Aiden Agent** (`:81-90`). The Computers NavigationLink to `.machines` carries the value "X of Y online" (`:73-77`). Then `AidenDefaultMachineRow` (`AidenNewWorkMachinePicker.swift:371`).
2. **Global defaults** (`:92-108`). The Appearance button opens a **sheet** (`:93-97`, `:218-220`), and the "New workspace permission" picker sits here too.
3. **Providers** (`:110-114`).
4. **Approvals**, only when the host offers it (rev 61; `:34-37`, `:116-124`).
5. **Chat**: "Show tool activity", gated by `offersBotUX` (`:126-135`).
6. **Memory**: the "Use memory" toggle. It reads `remoteClient().memorySettings()` and writes `updateMemorySettings(revision:enabled:)` (`:44-70`, `:137-154`).
7. **Read Aloud**: status from `readAloudStatus()` (`:14-25`, `:156-162`).
8. **Voice input**: a Transcription picker (`AidenVoiceInputMode`) and a Computer speech model link (`:164-186`).
9. **Feedback**: Interaction haptics (`:188-201`).
10. **About** (`:203-211`): Privacy policy, Support and `LabeledContent("License", "MIT")`. **There is no version row.**

States: Memory loads and fails inline, and the Approvals and Chat sections are capability-gated. Loading has no skeleton beyond the inline row state.

Live shots also show the floating running accessory and the tab bar overlapping the bottom of the content. That is shell work for t1a.

### 1.3 Concept delta (faithful version)
Concept 19:
- Large title "Settings" with a hamburger (drawer) on the top left.
- Card 1: Agent Slider "Balanced".
- Card 2: Computers "2 of 2 online", Appearance "System", Providers, Memory "On" (SD-card icon), Voice input "On device".
- Card 3: Privacy policy, Support.
- Rows show trailing values, inset separators and no chevrons.

idea-settings adds:
- To card 2: Usage "30 days" and Notifications "On".
- To card 3: Version "0.1.0".

Faithful adaptation:
- **Do not drop live settings.** The concept omits default machine, new-workspace permission, approvals, tool activity, Read Aloud, haptics and License, and these are real product settings. Fold them into drill-in rows:
  - "Defaults" opens a page with Default computer and New workspace permission.
  - "Approvals" stays its own row, still capability-gated.
  - "Chat" holds Show tool activity.
  - "Voice & speech" merges Voice input, Computer speech model and Read Aloud; its value is "On device".
  - "Haptics" becomes a toggle row in card 2.
  - "License MIT" becomes a value row in About.
- Rows that navigate **keep a chevron or button trait**. The concept's chevron-less rows hide affordance, and the design system says rows that open something are "full-width buttons with a chevron and a visible focus-visible ring" (`settings-design-system.md:141`). The faithful version uses a trailing value plus a small tertiary chevron.
- The Memory row uses `AidenBotMemorySymbol.name` ("sdcard"). No brain icon.
- Appearance becomes a **pushed page**, not a sheet (see 21).
- The hamburger and drawer placement belongs to t1a's shell/drawer plan. This track ships Settings as a `.settings` route reachable from both the drawer and the current menu.
- The Agent Slider row is owned by the concept 20 owner (t1b). The row is placed here as `AidenNavigationRow` to their route, with a value of the home-stop name, hidden until their screen exists.

### 1.4 Gap classes
| Item | Class |
|---|---|
| Large-title grouped-card restyle and section consolidation | UI-only |
| Appearance as a pushed route (`AidenAppRoute.appearance`) | client model/state (route enum, `AidenAppNavigation.swift:23-32`) |
| Usage row | UI-only. It reuses `.usage` and the `usageUnavailable` gate (`AidenAppShellView.swift:258-261`, `AidenHomeLoadPlan.loadsUsage`). Its value is "30 days" until monthly lands (see 24). |
| Version row | UI-only. Read `CFBundleShortVersionString` the way `AidenRemoteCoordinator.swift:1355-1358` already does. Today that is MARKETING_VERSION 0.1.0 (`ios/AidenOnTheGo.xcodeproj/project.pbxproj:1734`). Show the build too (`CFBundleVersion`), e.g. "0.1.0 (38)", plus long-press to copy. |
| Notifications row and page | client model/state; details below |
| Agent Slider row | cross-track dependency (t1b) |

**Notifications today.** The phone has local alerts only, and there is no user-facing switch:
- `AidenRunAlertNotifier` (`ios/AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift:571`) handles chat run alerts with the kinds `needsApproval`, `needsAnswer`, `completed` and `failed` (`:467-484`).
- `AidenScheduledRunNotifier` (`:156`) handles scheduled-task runs.
- `AidenBotRoutineNotifier` (`:279`) handles Bot routines.
- Permission is requested lazily, after the first completed run while the app is active (`:519-530`).

A faithful Notifications page needs:
- An OS permission state row: Allowed / Off, with "Open iOS Settings" when it is denied.
- Per-kind toggles: "Needs you" (approval and answer), "Finished", "Failed", "Scheduled tasks", "Bot routines".
- Storage in a new `AidenNotificationPreferences` in UserDefaults, read by each notifier before `center.add`.

This is purely client-side because alerts are produced locally from polls. **No server change.** The per-Bot "Notifications" group on desktop (`settings-design-system.md:141`) is desktop-side state and is not exposed to the phone, so per-Bot notification toggles on the phone would be a server contract change. Leave them out.

### 1.5 Implementation steps
1. Build the kit (section 0.3) in `ios/AidenOnTheGo/Config/AidenSettingsKit.swift`. Add `AidenTypeScale` and `AidenSettingsTokens` to `AidenDesignTokens.swift`.
2. Rewrite `AidenAppSettingsView` body as `AidenLargeTitlePage("Settings")` with three to four `AidenGroupedCard`s. Keep all existing loaders (memory, readAloud) and gates.
3. Add the routes `.appearance`, `.notifications`, `.settingsDefaults` and `.voiceSettings` in `AidenAppNavigation.swift`, with destinations in `AidenAppShellView.swift:645-650`.
4. Create a new `ios/AidenOnTheGo/Features/Workspace/AidenNotificationSettingsView.swift` and a model `AidenNotificationPreferences`, injected into the three notifiers. Each notifier `init` already takes `defaults:`, so tests can pass a suite.
5. Add the version row helper `AidenAppVersion.display` (bundle read), shared with `AidenRemoteCoordinator.clientVersion`.
6. Demo and AidenStateMatrix: add a `settings` capture to the matrix runs (`ios/AidenOnTheGoUITests/AidenStateMatrix.swift:11-37`) for one/four/offline-mix × light/dark × L/AX3. The offline-mix capture proves the Computers value and the Memory failure state.
7. Tests:
   - XCUITest: Settings shows the Version row matching `Bundle.main` (oracle: the bundle dictionary, not a literal).
   - XCUITest: Usage row disabled when `usageUnavailable` (old-host scenario).
   - Unit: `AidenRunAlertNotifier` with a fake `AidenRunAlertCenter` posts nothing for `.completed` when "Finished" is off, but still posts `.needsApproval`.
   - Unit: `AidenScheduledRunNotifier` still advances its cursor when scheduled alerts are off, so turning them back on never floods. That is an independent invariant: no backlog flood.

### 1.6 Effort, risk, dependencies
- Effort: **M**. The restyle is S once the kit exists; Notifications is M.
- Risk: losing a capability gate in the restructure. Mitigate with the old-host matrix scenario.
- Dependencies: the t1a drawer (entry point), t1b Agent Slider route, and the kit (phase 1).

---

## 2. Concept 21 Appearance (+ idea-appearance); Aurora rows placed for t4b

### 2.1 Entry point and views
- Settings → Appearance button → `.sheet` (`AidenAppSettingsView.swift:93-97`, `:218-220`).
- The view is `AidenAppearanceSettingsView`, `ios/AidenOnTheGo/Config/AidenAppearance.swift:823-905`.
- The tile is `AidenThemeTileSwatch`, `:912-957`.

### 2.2 Live today
A sheet with its own `NavigationStack` + `Form` and a Done button. It contains:
- A segmented Mode picker, System/Light/Dark (`:837-844`).
- A Themes `LazyVGrid` (adaptive, min 100; `:846-861`) of tiles. Each tile previews the preset in the current mode's look: a sidebar strip, the canvas, a raised card with "Aa", and an accent dot. The selected tile shows a checkmark circle (`:912-957`). The footer reads "Current theme: X".
- A Privacy toggle, "Show response excerpts on Lock Screen" (`AidenRemoteLiveActivityManager.responseExcerptPreferenceKey`; `:863-870`).

Data is local only (`AidenAppearanceStore`, `:636-720`). `uiFontSize` exists in the store but has no control.

Test: `testThemeTilesPreviewTheLookTheModeGivesEveryTheme` samples swatch pixels, per `docs/settings-design-system.md:63`.

### 2.3 Concept delta (faithful version)
Concept 21:
- Large title, pushed with Back.
- A full-width pill segmented control (System/Light/Dark) outside any card.
- A card holding a 5×2 grid of **solid circles** with labels; the selected one has a check.
- A "Lock Screen excerpts" toggle card.

idea-appearance adds:
- An **Accent** row with six swatches.
- A **Text size** "Default" row.
- An **App icon** "Default" row.

Contradictions and how to keep the faithful version:
- **Solid circles break the theme-tile rule.** `settings-design-system.md:63` says every tile previews the theme in the current mode's look, and iOS tests this by sampling pixels. Single-accent circles also collapse near-identical accents: Paper #7E5E2A vs Calm #7E5B2C, and Moss #157862 vs Dusk #0F766E (`AidenAppearance.swift:575-616`).
  - Faithful version: `AidenSwatch` circles drawn from `AidenThemeCatalog.tilePreview(preset:mode:systemScheme:)`. The outer disc is the preset's canvas and sidebar split (a two-tone half), with an inner accent dot. The check glyph is drawn in the solid-fill foreground.
  - This keeps the mode-follow invariant, keeps Paper/Calm distinguishable by canvas, and needs no border.
  - Update the existing pixel test to sample the disc's canvas half instead of the tile's canvas region. Its oracle stays `tilePreview`.
- **Accent swatches.** A free accent override layered on a preset is new behavior. It must be expressed as **per-scheme hex pairs** that flow through `palette.accentHex`, so that `AidenSolidFill` contrast deepening, `switchOnTrackHex`, text-safe colors and chip fills keep working. A single sRGB pick applied raw would fail 4.5:1 on some canvases.
  - Offer a fixed set: "Theme" (default, meaning no override) plus 5 curated pairs, each pre-validated for ≥3:1 non-text and ≥4.5:1 text via the existing `contrastRatio` helper (`AidenAppearance.swift:973+`).
  - The concept's "dark/check" first swatch maps to "Theme".
  - Desktop has no accent override (`renderer/shared/appearance.ts` has none), so this is iOS-only unless the owner wants parity. See the open question.
- **Text size.**
  - Android ships a four-step `AidenFontSize` (Small 0.9, Default 1.0, Large 1.15, Extra Large 1.3; `android/app/src/main/java/sbtbiswas/AidenOnTheGo/config/AidenAppearance.kt:52-57`). Its UI is `features/settings/AidenAppearanceSettingsScreen.kt:93-100`, a radio group.
  - On iOS, map the same four steps onto the existing `uiFontSize` (12.6/14/16.1/18.2 → clamp 12...18, so use 13/14/16/18). It stays multiplicative over Dynamic Type through `AidenUITypographyModifier` (`:959-971`), so an AX3 user still grows.
  - The row opens a small page with radio rows and a live preview line. No decorative borders on radio rows; selection is shown by the radio and a background state (AGENTS.md).
- **App icon.**
  - `UIApplication.setAlternateIconName` needs alternate icon sets in the asset catalog and `CFBundleAlternateIcons` / `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` in the build settings.
  - The icons must come from the Hi-bit sprite direction; no new mascot.
  - Effort is mostly art. iOS shows a system alert on change, which is expected.
- **Lock Screen excerpts** keeps its exact key; it is restyled into a toggle card.
- **Aurora (t4b).** Place an "Ambient background" card between Themes and Accent. It holds the rows t4b defines (on/off toggle, intensity or palette). This track only reserves the card slot and the `AidenGroupedCard` API; behavior, storage and reduced-motion and low-power handling belong to t4b.

### 2.4 Gap classes
| Item | Class |
|---|---|
| Sheet → pushed `.appearance` route, large title | client model/state (route) + UI |
| Pill mode control, swatch grid restyle | UI-only (test update for the swatch sampling) |
| Accent override | client model/state: a new `AidenAppearanceStore.accentOverride` key and palette composition in `AidenThemeCatalog.palette`. Cross-platform only if Android or desktop parity is wanted. |
| Text size control | UI-only (store exists); align step names with Android |
| App icon | UI + assets + build settings (client) |
| Aurora card slot | cross-track (t4b) |

### 2.5 Implementation steps
1. Add `AidenAppRoute.appearance` and push it from the Settings row. Delete the `NavigationStack` and Done button inside `AidenAppearanceSettingsView` (`:823-905`), which a pushed page would otherwise double up.
2. Rebuild the body as `AidenLargeTitlePage("Appearance")`:
   - `AidenPillSegmentedControl` (mode).
   - `AidenSectionCaption("Theme")` + `AidenGroupedCard { AidenSwatchGrid }`.
   - The t4b Aurora card slot.
   - `AidenGroupedCard` with Accent, Text size and App icon rows.
   - `AidenGroupedCard` with the Lock Screen excerpts toggle.
3. In `AidenAppearanceStore`, add `accentOverride: AidenAccentID?` with a UserDefaults key `aiden.appearance.accent`. `palette(preset:scheme:)` applies the override pair's light or dark hex before any derivation.
4. Add a `AidenTextSize` enum (small/default/large/xl ↔ uiFontSize 13/14/16/18). `AidenAppearanceStore` maps between it and `uiFontSize`; existing stored values snap to the nearest step.
5. Add alternate icon assets and `AidenAppIconChoice` (`.default`, plus 2–3 sprite variants); call `setAlternateIconName` and read `alternateIconName` for the row's value.
6. Matrix: add an `appearance` capture × light/dark × L/AX3.
7. Tests:
   - Update `testThemeTilesPreviewTheLookTheModeGivesEveryTheme` to sample the new disc. The oracle is still `tilePreview`.
   - Unit: every curated accent pair meets 4.5:1 for text against the canvas of **every** preset in both schemes after `AidenSolidFill`. The oracle is an independent WCAG luminance computation, not the catalog's helper.
   - Unit: text size snapping (stored 15 → Default 14 or Large 16 by nearest rule) and persistence round trip; extend `AidenChatTests.swift:13113-13155`.
   - XCUITest: selecting Large makes a known row's frame taller than at Default. This is behavioral, with no literal sizes.

### 2.6 Effort, risk, dependencies
- Effort: **M**. Restyle S, accent M, text size S, app icon M because of art.
- Risk: an accent override silently breaking contrast. Mitigate with the WCAG test across all presets.
- Dependencies: the kit, the t4b Aurora rows, and an owner decision on accent parity.

---

## 3. Concept 24 Usage (+ idea-usage)

### 3.1 Entry point and views
- Entry is the Inbox toolbar menu → Usage, disabled when `usageUnavailable` (`AidenAppShellView.swift:552-560`, `:258-261`). It is routed at `:645-650` to `AidenMachineUsageView(coordinator:)`.
- Views, all in `ios/AidenOnTheGo/Features/Workspace/AidenUsageView.swift`:
  - `AidenUsagePendingView` `:5-57`
  - `AidenMachineUsageModel` `:61-126`
  - `AidenMachineUsageView` `:129-166`
  - `AidenUsageView` `:168-513`
  - presentation helpers `:522-582`
  - card style `:584-594`

### 3.2 Live today
- The model's `load()` calls `client.usage()` and `client.modelCatalog()`. It handles cancellation and credential revocation. A machine picker uses `AidenNewWorkPicker(kind: .reading)`.
- Client: `AidenRemoteClient.usage(range: String = "30d")` validates against `["7d","30d","90d","1y","all"]` and sends `GET /usage` (`ios/AidenOnTheGo/Networking/AidenRemoteClient.swift:1864`).
- Server: the route is declared at `main/services/aiden-remote-router.ts:671`, range validation is at `:1580`, and the handler is at `:4568`. The range type is `UsageDateRange` (`main/services/types.ts:1072`). The doc is `docs/aiden-remote-api-v1.md:260`.
- Model: `AidenUsageSummary {range,startDate,endDate,totals,days,models}`, with `AidenUsageTotals.hostedCostSummary` (`ios/AidenOnTheGo/Models/AidenChat.swift:3091-3155`).
- Layout, in order:
  - Machine picker.
  - Hero "Your activity" with a date range.
  - A 2×2 metric grid (Requests, Active days, Current streak, Longest streak) plus Total tokens.
  - "Daily totals" with a "Last 30 days" chip, a 10-column heatmap and a Less/More legend.
  - An Input/Output/Reasoning/Cache-read breakdown.
  - Insights: Completed %, Local share, Failed, Hosted cost.
  - "Most used models": top 5 with `AidenProviderIcon` and run counts.
  - A privacy note.
- States: skeleton, offline, failed, and empty by omission.
- Demo hosts (`ios/AidenOnTheGo/Features/Remote/Demo/AidenDemoHosts.swift`) do **not** serve `/usage` (grep finds no `usage` route), so concept shot 24 used scratch data. The matrix cannot capture Usage today.

### 3.3 Concept delta (faithful version)
Concept 24:
- Large title.
- A hero card: "1.2M", "Tokens · last 30 days", and a 3×10 heatmap.
- "Most used models", then list-card rows such as "Claude Sonnet 5.5 · 128 runs".

idea-usage:
- A hero "$12.40 · Hosted cost · this month".
- The heatmap.
- "By Bot" rows with Hi-bit avatars and $ amounts.

Faithful version:
- **Hero.** Keep the concept's single hero (`AidenStatHero`) with the heatmap inside it. Move the 2×2 metrics and the token breakdown into a collapsible "Details" `AidenGroupedCard` of value rows, so no live metric is lost.
- **Range.** Add an `AidenPillSegmentedControl` for 7d / 30d / 90d. The client already supports these. Offer "This month" only once the server supports it.
- **Models.** "Most used models" moves into an `AidenGroupedCard` with `AidenSettingsRow` rows (provider icon + name, value "128 runs").
- **Cost per Bot rows** use `AidenBotSemanticAvatarView`, the Hi-bit sprite and the only Bot avatar. No initials circles and no SF person symbols.
- **Drop the 0.5pt stroke** on cards (`:590-593`), per the borderless-surfaces rule.
- **Privacy note.** Keep it.

### 3.4 Gap classes
| Item | Class |
|---|---|
| Restyle (hero, heatmap extraction, grouped model list, range pill) | UI-only |
| Monthly hosted cost ("this month") | **server contract**, detailed below |
| Cost per Bot | **server contract + cross-platform**, detailed below |
| Demo `/usage` data | client (demo) |

**Monthly hosted cost.**
- Today: `UsageDateRange` has no calendar month (`main/services/types.ts:1072`), `RANGE_DAYS` is day-count based (`main/services/usage-store-core.ts:77-82`), and `days[].hostedCostUsd` exists.
- Option A, client-only approximation: request `30d` or `90d` and sum `days` with `date >= first of the current month` on the phone. This works because days carry `hostedCostUsd` (`AidenChat.swift`, `AidenUsageDay`), but the server's day boundary is the desktop's local date, not the phone's. **Mislabeling risk.**
- Option B, faithful: add `range=month` to `GET /usage`. The server computes the host-local calendar month. Touch points:
  - `aiden-remote-router.ts:1580` (validation)
  - `usage-store-core.ts:77-82`
  - `types.ts:1072`
  - `docs/aiden-remote-api-v1.md:260`
  - iOS validator `AidenRemoteClient.swift:1864`
  - Android `AidenUsageSheet.kt`
  - fixtures
- Option B needs a protocol revision claimed at merge time; the latest on this branch is 65 (`main/services/aiden-remote-protocol.ts:373`). Gate on the new capability so old hosts fall back to 30d.

**Cost per Bot.**
- The usage store deliberately has **no Bot ids**: "cannot carry prompts, chat ids, workspace ids…" (`main/services/usage-store-core.ts:29-45`). So `/usage` cannot provide it.
- `GET /bots/{botId}/spending` (rev 47; router `:649`, handler `:3549-3569`; `main/services/aiden-remote-spending.ts:10-23`) returns `{spending: null}` when no limit applies (`docs/aiden-remote-api-v1.md:1040-1049`). So it can't serve an unlimited Bot, and it would also need N calls.
- The spending ledger (`userData/spending.json`; `docs/usage-limits-and-spending.md:65-79`) does key by Bot and month, and a Bot's month start day is configurable from the 1st to the 28th.
- Proposed new route: `GET /spending/bots?period=current` → `{ periodStart?, bots: [{ botId, spentUsd, periodStart, periodEnd, limitUsd: number|null }] }`. Rules for it:
  - Read from the ledger regardless of whether a limit is set.
  - Each Bot carries its own period because start days differ, so the UI caption should say "this billing month".
  - Bots with $0 are omitted.
- The route is scoped by the same Bot privacy rules as other Bot responses (`AidenBotPrivateResponseScoped`, `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift:3261`).
- It needs a revision bump, iOS + Android + fixtures together, a server test in the router suite, and a docs row in `aiden-remote-api-v1.md` and `usage-limits-and-spending.md`.

### 3.5 Implementation steps
1. Extract `AidenStatHero` and `AidenHeatmap` from `AidenUsageView.swift` into the kit, and replace `aidenUsageCard` with `AidenGroupedCard` (no stroke).
2. Rebuild `AidenUsageView` as `AidenLargeTitlePage("Usage")`: range pill → hero card → "Most used models" grouped card → Details grouped card → privacy footnote.
3. Demo: serve `GET /usage` from `AidenDemoHosts.swift` with a deterministic 30-day fixture (plus the future `month` range and `/spending/bots` once added). Add a `usage` capture to the matrix for one/four/offline-mix/old-host.
4. Server phase:
   - Add the `month` range.
   - Add `GET /spending/bots`.
   - Bump the protocol revision.
   - On iOS: `AidenRemoteClient.usage(range:)` accepts `"month"` when capable, a new `spendingByBot()` method, and an `AidenBotSpendingSummary` model.
   - Android follows in the same PR.
5. Hero swap: when `month` is supported and hosted cost is above 0, the hero reads "$12.40 · Hosted cost · this month" and tokens become a row. When hosted cost is 0 (local-only), the hero stays on tokens. Never show "$0.00" as the hero.
6. Tests:
   - Server: the `month` range sums only the current host-local month; the oracle is a fixture with records on both sides of the boundary.
   - Server: `/spending/bots` returns a Bot with no limit, and uses each Bot's own period start (start day 15 vs 1).
   - iOS unit: the decoder rejects an unknown range and the client refuses `"month"` without the capability.
   - XCUITest: a "By Bot" row shows the Bot's name and amount from the demo fixture, and the avatar element is present.
   - No literal style asserts.

### 3.6 Effort, risk, dependencies
- Effort: restyle **S–M**; monthly **M**, because of the server, both clients and the fixtures; per-Bot **M–L**, because of the new route, privacy scoping and both clients.
- Risk: summing the month on the phone gives wrong boundaries, so prefer Option B. There is also a privacy regression risk if per-Bot data were added to the usage store; do not do that.
- Dependencies: a protocol revision slot and Android owner coordination.

---

## 4. Shared components to extract (summary)
1. `AidenTypeScale` and `AidenSettingsTokens` (tokens)
2. `AidenLargeTitlePage`
3. `AidenSectionCaption`
4. `AidenGroupedCard` (auto inset separators, no outline)
5. `AidenSettingsRow` / `AidenNavigationRow` / `AidenAvatarValueRow`
6. `AidenPillSegmentedControl`
7. `AidenStatusChip`
8. `AidenSwatch` / `AidenSwatchGrid`
9. `AidenStatHero` / `AidenHeatmap`
10. `AidenCircleIconButton`

Mirror names with Android's `AidenSettings*` so parity reviews map one to one.

Small factual fixes found in passing:
- `AidenBotSuggestionCards.swift:308` uses `"memorychip"` for a memory suggestion; it should use `AidenBotMemorySymbol.name` ("sdcard").
- The usage card stroke breaks the borderless rule.

## 5. Phase order
1. **P1 Kit.** Tokens, the kit components, tests for the kit, and matrix captures for settings and appearance. This unblocks every other track. Effort M.
2. **P2 Settings restyle.** Settings with Version and Usage rows, Appearance as a pushed route with the pill control, mode-following swatch discs and the Text size control. Client-only. Effort M.
3. **P3 Notifications page.** Client-only. Effort M.
4. **P4 Usage restyle.** Usage restyle plus demo `/usage` fixture. Client-only. Effort S–M.
5. **P5 Accent override and App icon.** Client plus assets. Effort M. Waits on owner decisions.
6. **P6 Server phase.** `range=month` and `GET /spending/bots`, with a protocol revision bump, iOS + Android + fixtures and docs. Effort M–L.
7. **P7 Usage hero and By Bot.** Wires the server phase into the Usage hero and the By Bot section.

The Agent Slider row lands when t1b's route exists; the Aurora card slot is filled when t4b lands; the drawer entry point comes from t1a.

## 6. Open questions
1. **Accent override scope.** Should it be iOS-only, or should Android and desktop get parity? Desktop has no accent override today. Parity makes it a cross-platform settings change.
2. **Concept 21 solid circles.** Is the faithful mode-following disc acceptable? It is needed to keep the `settings-design-system.md:63` invariant and to tell Paper/Calm and Moss/Dusk apart.
3. **App icon variants.** How many, and which sprite tints? Who draws them?
4. **"This month".** Should it use host-local calendar month (proposed) or the phone's month? For per-Bot cost, is "each Bot's billing month" acceptable when start days differ?
5. **Notifications.** Should per-kind toggles stay phone-local (proposed), or should the phone also edit the desktop's per-Bot "When it finishes or needs input" switch? That would be a server contract change.
6. **Folding sections.** Should Read Aloud, Voice input and Computer speech model fold into one "Voice & speech" drill-in? Should Defaults (default computer, new-workspace permission) get its own page?
7. **Chevrons.** Should rows keep a tertiary chevron (proposed, for affordance and to match `settings-design-system.md:141`) or follow the concept's chevron-less rows?

Cross-track note: the known blank Workspace Settings sheet (Workspace menu → Workspace Settings) belongs to t3a. The fix there is `.sheet(item:)`. The same pattern shows in this track: Appearance currently uses `.sheet(isPresented:)` (`AidenAppSettingsView.swift:218-220`), which goes away when it becomes a pushed route.
