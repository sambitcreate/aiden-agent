# t4b-aurora — Aurora ambient theme (Figma section 6)

Repo read at `ios-new-direction` worktree, commit d476bc35d (== main). Paths are relative to `ios/AidenOnTheGo/` unless prefixed. Read-only; nothing run.

**Prior art:** none. A grep of docs/, .memory/ and git log for "aurora" returns only unrelated theme query params in tests (`main/services/visual-viewer-document.test.ts:40`, `main/services/aiden-remote-router.test.ts:1248`). This is a new surface with no server contract.

---

## Screen 6 — Aurora (ambient activity gradient)

### 1. Concept, entry point and views
- **Concept** (`concepts/aurora-section.png`):
  - A single-hue blurred glow fills the bottom 400 pt of the home screen behind the composer and dock. It fades out by 45% of screen height.
  - States, as color / lightness / speed:

    | State | Color | Lightness | Speed | Notes |
    |---|---|---|---|---|
    | Idle | secondary | 0.32 | 0.12x | |
    | Working | blue | 0.80 | 0.5x | |
    | Listening | blue | 0.85 | — | follows mic level |
    | Needs you | warning | 0.75 | 0.3x | |
    | Done | success | 0.65 | 0.25x | 2 s, then Idle |
    | Failed | danger | 0.42 | 0.1x | |

  - 600 ms cross-fade between states. Reduce Motion gives a still gradient; Low Power turns it off. There is a dark variant.
  - Settings rows: **Aurora: Off / Subtle / Vivid**, a **Follow activity** toggle, and the footer "Still with Reduce Motion. Off in Low Power Mode."
- **Entry point:** there is no screen of its own. The aurora is a background layer on the new Home/Chats root, which t1a owns. The concept home (`concepts/01-home.png`) is a greeting, Bot cards and a home composer; the live app has no home composer yet (`live/01-home.png`).
- **New views:**
  - `AidenAuroraView` (the renderer)
  - `AidenAuroraState` (a pure reducer)
  - `AidenAuroraModel` (an @Observable driver)
  - two Appearance rows

### 2. What's live today
- **No ambient layer.** `AidenAppearanceRoot` paints a flat `palette.canvas` behind everything (`Config/AidenAppearance.swift:785-821`).
- **Inputs it needs already exist:**
  - **Reduce Motion:** the env `aidenReduceMotion` (`Config/AidenAppearance.swift:757`), resolved from an app override `AidenReduceMotionPreference` (`:242`, `resolvedReduceMotion(system:)` `:709`).
  - **Low Power:**
    - the env `aidenLowPowerMode` (`:764`), documented as "Decorative, continuously redrawn animations (orbs, shimmers) hold still to save power".
    - It is seeded from `ProcessInfo.processInfo.isLowPowerModeEnabled` (`:790`) and live-updated on `NSProcessInfoPowerStateDidChange` (`:815-819`).
  - **Activity data:** the unified inbox store `AidenUnifiedInboxStore` (`Features/Shell/AidenUnifiedInboxStore.swift`, @MainActor @Observable). It exposes:
    - `snapshots` `:28`, `hiddenMachines` `:30`, `inbox` `:32`
    - `needsYouCount` `:37`, `hasRunningChats` `:40`
  - **Voice:** `ComposerVoiceInputController.state` (`Features/Chat/ComposerVoiceInputController.swift:12-17`, `isListening` `:52`).
- **Precedent for gated animation:** `AidenBotSemanticAvatarView.swift:128-140,170` pauses a `TimelineView(.animation(minimumInterval: 1/30, paused:))` when system or app Reduce Motion or Low Power is on. `AidenImageGenerationPlaceholder.swift:424` also pauses on `scenePhase != .active`. The aurora should copy this pattern.
- **No `MeshGradient` anywhere in the iOS target** (grep is clean), so this would be the first use.

### 3. Concept delta (and AGENTS.md conflicts)
| Item | Delta | Conflict / note |
|---|---|---|
| Working/Listening "blue" | iOS has **no blue semantic token**. The Aiden light accent is ink `#1F2228` (palettes `Config/AidenAppearance.swift:575`; changed by commit 05c990be8, "ink default accent"). Desktop accent is `#006AD6`/`#3E97F6` (`renderer/shared/appearance.ts:157,168`). | Must add a token rather than hard-code a hex, because ios/AGENTS.md says "do not introduce a custom UI system for branding". Open question Q1. |
| Preset collisions | Moss's accent is green (`#157862`) and would read as Done. Berry's is pink (`#B42C70`) and would read as Failed. Monochrome is black/white. | Can't simply use "accent" for Working. |
| Bottom band behind composer + dock | The live dock is a system TabView with `.sidebarAdaptable` (`Features/Shell/AidenAppShellView.swift:284`), plus the iOS 26.1 bottom accessory (`:341`, `Features/Shell/AidenRunningAccessory.swift:5-22`). Liquid Glass samples whatever is behind it, so the aurora will tint the tab bar. Update 2026-11-25: on a stack the system tab bar and accessory gave way to Aiden's dock in each screen's bottom bar (PR #934); the aurora still sits behind the dock's glass. | That is intended. It must not reduce label contrast (see Accessibility). |
| Color-coded states | Color is the only channel the aurora has. | Root AGENTS.md: status lives in soft fills, labels and icons, and never in color alone. The aurora must be **purely decorative** (`accessibilityHidden`); every state is already said in text elsewhere (badge, "Needs you" chips, running accessory). |
| "Done" | No "done" event exists. Rows go working → idle (`Models/AidenChat.swift:2701-2707`). | Done must be inferred client-side as an edge (see the state machine). |
| "Failed" for Bots | `AidenBotSessionStateKind` has idle/running/interrupted/needs_model/unavailable/paused and **no failed** (`Models/AidenBotSession.swift:84-92`). | Bots feed only Working and Needs you. |
| Listening "follows mic level" | No mic level is computed anywhere. `AidenComposerAudioCaptureState` only holds `isCapturing` and is not @Observable (`ComposerVoiceInputController.swift:629-639`). | A client change is needed (UI-adjacent; no server work). |
| Settings sit below "Lock Screen excerpts" | The live Appearance form already has a Privacy section with that toggle (`Config/AidenAppearance.swift:823-910`). | t4a places the rows. The concept puts them in the same page, which is compatible. |

### 4. Gap class per item
| Item | Class |
|---|---|
| Renderer view, cross-fade, reduce-motion/low-power gating | UI-only |
| Activity color token per preset (blue) | client model/state (palette) |
| Aurora state reducer + Done edge + debounce | client model/state |
| Observable mic level | client model/state |
| Settings keys (mode, follow activity) | client model/state |
| Faster Done/Failed than a 15-60 s poll | client model/state (reuse the open chat's stream); **no** server contract needed for v1 |
| Bot "failed" state | server contract (out of scope; not needed) |
| Android/desktop parity | cross-platform (later) |

### 5. Implementation steps

#### 5.1 State machine (pure, testable)
`Models/AidenAuroraState.swift`:

```swift
enum AidenAuroraPhase: String { case idle, working, listening, needsYou, done, failed }
struct AidenAuroraInputs { var working: Set<String>; var needsYou: Bool; var failed: Bool; var listening: Bool; var micLevel: Double }
struct AidenAuroraState { var phase: AidenAuroraPhase; var doneUntil: Date?; var lastWorking: Set<String>; var pendingIdleSince: Date? }
static func reduce(_ s: AidenAuroraState, _ i: AidenAuroraInputs, now: Date, followsActivity: Bool) -> AidenAuroraState
```

**Sources.** Use the same scope as `needsYouCount`: all online, non-blocked machines that are not in `hiddenMachines`, **ignoring** the machine filter and search (`Models/AidenUnifiedInbox.swift:159-164`). Do not use the filtered `inbox.running`, which respects the filter (`:165`, `:195-200`, `:228-230`). The aurora is a global ambient signal, like the tab badge (`AidenAppShellView.swift:285`).

| Input | Exact source |
|---|---|
| `working` (set of `machineID:chatID` / `machineID:bot:<id>`) | Chats with `displayRowState == .working` (`Models/AidenChat.swift:2701-2707`; `rowState` rev 18 at `:2651`), plus Bots with `AidenBotAttention.isRunning` (`sessionState == .running`, `Models/AidenUnifiedInbox.swift:33-35`). Snapshot type `AidenHostInboxSnapshot` `:5-22`. |
| `needsYou` | Chats with `displayRowState` `.needsApproval`/`.needsInput` (the same rule as `localPlacement` tiers 0/1, `Models/AidenInbox.swift:241-242`), plus Bots with `AidenBotAttention.needsYou` (issueCount>0, interrupted or needs_model; `Models/AidenUnifiedInbox.swift:29-31`). Equivalent to `inboxStore.needsYouCount > 0` minus failed rows (see Q2). |
| `failed` | Chats with `showsFailed` (unread && lastRunFailed rev 36; `Models/AidenChat.swift:2656,2697`), which is the failed tier 2 in `Models/AidenInbox.swift:244`. |
| `listening` | `ComposerVoiceInputController.state == .listening` (`ComposerVoiceInputController.swift:12-17,52`). The controller is owned per composer session (`Features/Conversation/AidenComposerSession.swift:118`), so the home composer (t1a/t1b) must expose its controller, or the model reads a promoted observable `AidenComposerAudioCaptureState` (`:629-639`). |
| `micLevel` | **New.** Compute RMS in both taps (`ComposerVoiceInputController.swift:166` Mac-recording and `:286` native; bufferSize 1024). Smooth with a 0.15 attack / 0.4 release envelope and publish on main at most 30 Hz. |
| Done | Derived. An id leaves `working` between two snapshots and, on the same snapshot, is not needs-you and not failed. |

**Priority, highest first:** `listening` > `needsYou` > `failed` > `done` (transient) > `working` > `idle`.
- **Rationale:**
  - Listening is the user's own action in the foreground.
  - Needs you blocks progress.
  - Failed is unread history the user should see.
  - Done is a 2 s flourish that must not hide an active blocker.
  - Working is background progress.
- **Open:** Q2 asks whether Failed should outrank Needs you.
- **While another run keeps working:** Done still plays for 2 s when one of several runs finishes, then returns to Working (not Idle).
- **Done is suppressed** when the finishing id is the chat the user has open (`navigation.showsConversation`, `Features/Shell/AidenAppNavigation.swift:461-463`). The user saw it finish, and the aurora is hidden there anyway.

**Debounce and hysteresis:**
- **Working → Idle:** commit only after 600 ms with an empty working set (`pendingIdleSince`). This absorbs row flaps between a tool call and the next turn, and between polls of different machines.
- **Idle → Working:** immediate.
- **Needs you / Failed:** immediate. They arrive from polls, so they're already coarse.
- **Done:** `doneUntil = now + 2 s`. A new Done inside the window extends it by up to 2 s from the latest edge.
- **First snapshot after launch or reconnect** (`lastWorking` empty because it's unknown): never emit Done. Seed `lastWorking` only. Also reset `lastWorking` for a machine that went offline, so a reconnect doesn't produce a spurious Done.
- **Follow activity off:** phase is pinned to `.idle`. Listening still applies, because it's direct feedback for the user's own action (Q5).
- **Mode Off:** the reducer still runs (it's cheap), but the view isn't mounted.

**Latency caveat.** Inbox polls are 15 s focused, 30 s background, and 60 s when the Inbox tab is hidden, with failure backoff of 30/60/120/300 s and 0-20% jitter (`Models/AidenInboxPollPolicy.swift:24-38`; role at `AidenUnifiedInboxStore.swift:622-625`). So Done/Failed can lag a run's real finish by up to 60 s.
- **Mitigation 1 (v1, cheap):** the Home root counts as "Inbox visible" for `setInboxVisible` (`AidenUnifiedInboxStore.swift:144`). This keeps it at the 30 s/15 s tier; t1a owns that wiring.
- **Mitigation 2 (optional v2):** when a run the user started from the home composer is streamed by an `AidenChatViewModel`, feed its terminal status into the model directly. `AidenChatViewModel` already publishes run status to the Live Activity (`Features/Chat/AidenChatViewModel.swift:1015-1019`, start at `:2007`, foreign runs at `AidenChatViewModel+ForeignRuns.swift:342`; manager API `LiveActivities/AidenRemoteLiveActivityManager.swift:60,99,206`). Add a small `AidenAuroraModel.noteRunEnded(id:failed:)` hook next to the existing `updateStatus` call.
- **No new endpoint.**

#### 5.2 Rendering (SwiftUI)
`Features/Shell/AidenAuroraView.swift`. Options:

| Option | Look | Cost | Verdict |
|---|---|---|---|
| `MeshGradient` (iOS 18+; the app is iOS 26+) 3×3, animated by `TimelineView(.animation(minimumInterval: 1/30, paused:))` moving 3-4 interior points on slow sines | Closest to the concept: organic, single hue | One GPU pass over a 400 pt band. Animating points only re-renders the gradient; no offscreen blur needed if the bottom row is opaque-ish and the top row is clear. | **Recommended** |
| `Canvas` + 2-3 `RadialGradient` blobs + `.blur(24)` | Matches "layer blur 24" literally | A live Gaussian blur over a full-width band every frame costs an offscreen pass and the most battery | Fallback only |
| Metal `.colorEffect` shader (`ShaderLibrary`) | Most control (noise field) | Low GPU cost, but adds a .metal file and shader tests can't run headless | Defer; not needed |
| Static `LinearGradient` | Still | ~0 | Used for Reduce Motion |

**Design mapping:**
- **Blur:** the sheet's "layer blur 24" is approximated by the mesh's inherent smoothness plus a soft top fade via `.mask(LinearGradient(.black → .clear, from bottom to 55% height))`, which gives "clears by 45%". Do not apply `.blur` over live content.
- **Hue:** one hue per state. Build the mesh colors from one base `Color` using HSL lightness from the table: center points at L, edges at L ± 0.08, top row fully transparent.
  - **Spread:** a bottom-row height factor, Subtle 0.7 / Vivid 1.0.
  - **Speed:** a scalar on the time base.
  - **Opacity:** Subtle 0.35 / Vivid 0.6 (tunable; see Accessibility).
- **Cross-fade:** keep `displayed` and `incoming` phases and animate `.easeInOut(duration: 0.6)`. Mesh `colors` are animatable, so interpolate the colors and speed rather than stacking two meshes. Under Reduce Motion, use the same 600 ms opacity cross-fade (a fade is acceptable under Reduce Motion) with no point motion.
- **Listening:** speed is 0. Lift the center control point by `micLevel × 40 pt`, push lightness up to `0.85 + 0.1 × level`, and anchor the bright spot under the mic button (the concept's Listening column shows the glow concentrated on the trailing side). The mic's x comes via an anchor preference from t1b's composer.
- **Gating:** `paused: reduceMotion || lowPower || scenePhase != .active || !isVisible`.
  - **Low Power:** the view is **not mounted** (per the sheet "Off"), which is stricter than the existing env doc (`AidenAppearance.swift:764`).
  - **Reduce Motion:** the static gradient is shown.
  - **Accessibility Increase Contrast** (`systemHighContrast`, `palette(for:systemHighContrast:)` at `AidenAppearance.swift:691`): cap the opacity at Subtle × 0.5.
- **Dark variant:**
  - The palette already resolves per scheme (`AidenThemeCatalog`, `AidenAppearance.swift:563-617`).
  - In dark mode, apply lightness to the dark palette's status hues and switch the blend to `.plusLighter` at a lower opacity; the concept's Working·Dark column is a navy base with a blue glow.
  - In light mode, use normal blend over `palette.canvas`.

**Theme mapping.** Add to `AidenPalette` (`Config/AidenAppearance.swift:266`):
- **`activityHex`** (light/dark) per preset. Default is a desktop-matching blue, `#006AD6` light / `#3E97F6` dark (`renderer/shared/appearance.ts:157,168`).
- **Overrides** only where a preset has a chromatic, non-status accent. Moss and Berry keep blue; Monochrome uses `secondary` (Q1/Q6).
- **Status hues:** Idle = `secondary`, Needs you = `warning`, Done = `success`, Failed = `danger`. These are the raw hexes (`:266-305`), **not** the text-safe `successText`/... variants (`:438-480`), because this is a fill.
- **Unit test:** activity must keep a hue distance from `success`/`danger`/`warning` in every preset (see Tests).

**Performance budget (to verify with Instruments by the implementer, not here):**
- **GPU:** ≤ 1.5 ms GPU per frame on A15 at 30 fps for the band; no offscreen passes (Core Animation "Color Offscreen-Rendered" shows nothing for the layer).
- **Frame rate:** cap at 30 fps (`minimumInterval: 1/30`, matching `AidenBotSemanticAvatarView.swift:170`). Never ProMotion 120.
- **Paused:** 0 redraws when paused (Reduce Motion, background, covered by a conversation, Low Power).
- **CPU:** the reducer runs only on snapshot change (`apply(_:)` `AidenUnifiedInboxStore.swift:419-494`) and on mic level ticks (≤ 30 Hz), not per frame.
- **Energy:** no measurable "Energy Impact" increase on the home screen idle at Subtle vs Off (Xcode gauge stays "Low").
- **Memory:** no textures or images; < 1 MB.

#### 5.3 Mount point (coordinate with t1a)
- **Where:**
  - On the new Home/Chats root only, as a `.background(alignment: .bottom)` layer of that root's `NavigationStack` content, **below** the home composer and above `palette.canvas`.
  - It must sit inside the tab's content so the system tab bar's glass samples it, not inside the `TabView` modifier chain at `AidenAppShellView.swift:284-341`.
  - Update 2026-11-25: on a stack the dock (PR #934) is each screen's own bottom bar over the same content, so the aurora stays behind the dock's glass as it did behind the tab bar.
  - Use `.ignoresSafeArea(edges: .bottom)`, `.allowsHitTesting(false)`, `.accessibilityHidden(true)`, and `.frame(height: 400)`.
- **Visibility gate:** `isVisible = navigation.tab == <home tab> && !navigation.showsConversation && scenePhase == .active` (`Features/Shell/AidenAppNavigation.swift:5-6,461-463`). `AidenAuroraModel` is owned by the shell (like `inboxStore`) and fed by `inboxStore.snapshots`/`hiddenMachines` plus the home composer's voice controller.
- **Must NOT show on:**
  - any conversation, chat or Bot chat (`showsConversation`). Those have their own composer and dock and status UI.
  - sheets: Settings, Appearance (except the preview swatch; see 5.4), pairing, running-chats sheet (`AidenAppShellView.swift` sheets).
  - the Search tab, Workspaces, Bots list, and Inbox list if it remains a separate tab (Q3).
  - the regular-width sidebar/split detail column (iPad/Mac; Q3). At most, the home column only.
  - Live Activity, widgets, Lock Screen.
  - onboarding/pairing screens.
  - demo-mode screenshot runs unless a test sets the mode explicitly (default for UI tests is Off; see Tests).
  - when VoiceOver is running. Optionally keep it but static; it's decorative and costs battery (Q7).

#### 5.4 Settings storage and Appearance rows (t4a places them)
- **Storage:** in `AidenAppearanceStore` (`Config/AidenAppearance.swift:636`), next to the existing `aiden.appearance.*` keys (`:637-653`), using the same didSet/UserDefaults pattern (`:656-689`):
  - `aiden.appearance.aurora`: `AidenAuroraMode` (`off|subtle|vivid`). Default: `subtle` (Q4).
  - `aiden.appearance.auroraFollowsActivity`: Bool, default `true`.
  - Because they live in UserDefaults, launch args set them for tests (`-aiden.appearance.aurora vivid`), exactly as `AidenStateMatrix` already sets mode and presets (`ios/AidenOnTheGoUITests/AidenStateMatrix.swift:44-73`).
- **Rows** in `AidenAppearanceSettingsView` (`Config/AidenAppearance.swift:823-910`), placed by t4a below the Lock Screen excerpts toggle per the sheet:
  - a segmented `Picker("Aurora", …)` Off/Subtle/Vivid
  - `Toggle("Follow activity")`, disabled when Off
  - the footer "Still with Reduce Motion. Off in Low Power Mode."
  - Follow `docs/settings-design-system.md`, which t4a owns. Use standard Form rows, no custom chrome, no colored borders.
  - When Low Power is on, add a secondary footer line "Off while Low Power Mode is on" so the setting doesn't look broken.

#### 5.5 Testing
**Unit (`ios/AidenOnTheGoTests/AidenAuroraStateTests.swift`, new).** The reducer is pure, with an injected `now`. Behavioral cases:
1. Empty snapshots → idle.
2. One working chat → working (immediately).
3. Working → empty → idle only after 600 ms. An empty set at +300 ms followed by working again never shows idle.
4. Working → idle row (not failed) → `done` for 2 s, then idle. At +2.1 s it's idle; with another still-working run it's working.
5. Working → failed row → `failed` (not done).
6. A needs-you chat plus a working chat → needsYou. Bot `interrupted` → needsYou. Bot `running` → working.
7. Listening beats needsYou; listening ends → back to the underlying phase.
8. First snapshot with already-idle rows → no done. A machine goes offline then online → no done.
9. Hidden machine and blocked machine ignored. Machine filter/search do **not** change the phase. Assert against `AidenUnifiedInbox.make` output built with a filter, using the same fixtures as `AidenUnifiedInboxTests`.
10. `followsActivity=false` → idle regardless (listening excepted).

**Palette test.** Extend `AidenDesignTokenTests`: for every preset × scheme, the `activity` hue differs from `success`/`danger`/`warning` by ≥ 30° (or `activity == secondary` for Monochrome). This is an independent oracle, not a restatement of the table.

**Mic level.** A unit test on the RMS/envelope helper with synthetic buffers (silence → 0; full-scale sine → ~0.707 before mapping; release decays).

**Settings.** Round-trip `AidenAppearanceStore` persistence for the two keys, following the existing store tests.

**Demo scenarios** (`Features/Remote/Demo/AidenDemoHosts.swift`). These reuse the row pattern slots at `:1118-1166` (0 needs_approval, 1 working, 2 needs_input, 3 failed, 4 unread, 5 pinned, ≥6 earlier) via `machine(..., rows:, start:)` in the scenario switch `:482-512`, and the enum `:16-36`:
- `aurora-idle`: one machine, `start: 6`, so only earlier rows.
- `aurora-working`: `rows: 1, start: 1`.
- `aurora-needs-you`: `rows: 1, start: 0`.
- `aurora-failed`: `rows: 1, start: 3`.
- `aurora-done`: a working row served through the `.computed(status:json:)` responder (`:52`) that flips to idle on the second inbox poll. Pair it with a Debug-only shortened poll interval if needed (the demo already has run-option flags at `AidenDemoRunOptions` `:1226`).
- **Listening** can't be produced by the demo without the mic. Add a Debug-only `-AidenAuroraForcePhase <phase>` launch arg read by `AidenAuroraModel` (compiled out of Release) for screenshots only. Behavior is covered by the unit tests.
- Mirror the new cases in `AidenStateMatrix.Scenario` (`AidenStateMatrix.swift:12`).

**XCUITest (`AidenStateMatrix` + a new `AidenAuroraUITests`):**
- **Exposing the phase:** the aurora is accessibility-hidden, so expose its phase through a Debug-only invisible element `accessibilityIdentifier("aurora.phase")` with value = phase (or `.accessibilityValue` on a test-only overlay gated by `-AidenUITestHooks`).
- **Per scenario × {light, dark} × {aurora subtle}:** assert the phase value and attach a screenshot.
- **Gating:**
  - **Reduce Motion:** `-aiden.appearance.reduceMotion on`; assert value `…/still`.
  - **Mode Off:** the element is absent.
  - **Conversation open:** the element is absent after opening a chat.
- **Done:** wait for `working` → `done` → `idle`, with a timeout above the poll interval.
- **Default for all other UI tests:** pass `-aiden.appearance.aurora off` in the shared `launch` helper so existing screenshot baselines don't shift. The aurora tests opt in.

### 6. Effort, risk, dependencies
| Piece | Effort | Risk | Depends on |
|---|---|---|---|
| Reducer + model + unit tests | M | Low | t1a home root exists; inbox store scope |
| Renderer (MeshGradient, gating, cross-fade, dark) | M | Med: tuning for contrast and battery; first MeshGradient in the app | Palette `activityHex` |
| Palette token + token tests | S | Low, but needs a product decision (Q1) | — |
| Mic level | S | Low | t1b home composer owns the voice controller |
| Settings keys + rows | S | Low | t4a Appearance layout |
| Demo scenarios + StateMatrix + UI tests | M | Med: the Done timing test is poll-bound | Demo responder `.computed` |
| Faster Done via open-chat stream (v2) | S-M | Low | — |

**Overall:** M-L, about 1 PR after t1a's shell lands. It's client-only, with no server contract or protocol revision.

---

## Accessibility
- **Decorative only:** `accessibilityHidden(true)`, `allowsHitTesting(false)`. Nothing is conveyed only by the aurora's color. Each state already has a text channel:
  - **Needs you:** the tab badge (`AidenAppShellView.swift:285`) and "Needs you" chips/sections (`Models/AidenInbox.swift:410` projection).
  - **Working:** the running accessory "Running: …" (`AidenRunningAccessory.swift:118-122`) and row indicators.
  - **Failed:** the failed tier rows (`Models/AidenInbox.swift:244`).
  - **Listening:** the composer's own mic state and labels.
  - **Done:** has no text channel, and that's acceptable. It's a transient flourish, and the row itself moves to Updates.
  - t1a's home must keep these text signals visible on Home.
- **Text contrast over the aurora:**
  - The composer and dock sit on glass above it. Composer placeholder/labels and tab labels must stay ≥ 4.5:1 (body) and ≥ 3:1 (icons/large) against the *composited* worst case: Vivid, Done/Working at max lightness, light mode.
  - Enforce this with a unit test using `AidenPalette.contrastRatio` (`Config/AidenAppearance.swift:443`). Composite `activity`/status at the mode's max opacity over `canvas`, then check `foreground` and `secondary` against it for every preset × scheme. If a preset fails, the opacity cap for that preset drops; the test drives the cap.
  - With Increase Contrast on, use half opacity. With Reduce Transparency on, render at Subtle × 0.5 and no plusLighter.
- **Motion:**
  - Honor both the system and app Reduce Motion (`resolvedReduceMotion`, `:709`) by holding a still gradient.
  - Speeds are slow (≤ 0.5x), so there's no flashing. Respect the 3-flashes/s guideline: the Done flourish is a 600 ms fade, not a flash.
- **Dynamic Type:** none (no text).

## Shared components to extract
- `AidenAmbientGate`: a view modifier/env computing `paused`/`hidden` from `aidenReduceMotion`, `aidenLowPowerMode`, `scenePhase`, and visibility. The Bot avatar (`AidenBotSemanticAvatarView.swift:128-140`) and image placeholder (`AidenImageGenerationPlaceholder.swift:424`) already duplicate this logic.
- `AidenActivitySignals`: one global (filter-independent) projection of working/needsYou/failed across machines, which `needsYouCount`/`hasRunningChats` and the aurora both read. This avoids a second walk of the snapshots. A candidate home is next to `AidenUnifiedInbox.make` (`Models/AidenUnifiedInbox.swift:112-254`).
- `AidenAudioLevelMeter`: an RMS envelope shared by both voice taps. It's reusable for t1b's waveform button.
- `AidenPalette.activity`: a semantic "in-progress" color also usable by the running accessory and working indicators.

## Phase order
1. Palette `activity` token + contrast/hue tests (unblocks visuals; needs Q1).
2. `AidenActivitySignals` + `AidenAuroraState` reducer + unit tests.
3. Settings keys + Appearance rows (with t4a), with the UI-test default `off`.
4. `AidenAuroraView` renderer + gating + mount on t1a's Home root.
5. Mic level (with t1b), then Listening.
6. Demo scenarios + StateMatrix + UI tests/screenshots.
7. (v2) Faster Done/Failed from the open chat stream; consider parity.

## Android / desktop parity (scope only)
- **Android:**
  - Feasible later as a Compose `Brush.radialGradient` band in the M3 Expressive layer (`android/app/src/main/java/sbtbiswas/AidenOnTheGo/ui/theme/`; tests at `android/app/src/test/java/sbtbiswas/AidenOnTheGo/ui/theme/AidenMotionTest.kt`), gated by `PowerManager.isPowerSaveMode` and the animator-duration scale.
  - The reducer is pure, so port it 1:1 and share fixtures.
  - Not in this track.
- **Desktop:** has the needed status tokens already (`--status-accent/red/green/warning` + `-surface`, `renderer/shared/appearance.ts:1062-1074`). An aurora behind the desktop composer is possible but is a separate product decision; desktop has no "dock". Recommend **no** desktop parity unless the owner asks.
- **No server/contract change on any platform.**

## Open questions for the owner
1. **Working blue:** add a per-preset `activity` color (default desktop blue `#006AD6`/`#3E97F6`), use the accent where it's chromatic, or always a fixed blue? Should Monochrome stay gray for Working?
2. **Priority:** should **Failed** (unread failed run) outrank **Needs you**? Proposed: Needs you first.
3. **Where:** Home root only, or also the Inbox/Bots list tabs and the iPad/Mac sidebar layout?
4. **Default mode:** Subtle (as the sheet implies), or Off until the feature is proven?
5. **Follow activity off:** is the aurora a static Idle haze, and should Listening still react?
6. **Done latency:** acceptable to rely on 15-30 s inbox polls for v1, with the faster path from the open run's stream in v2?
7. **VoiceOver/Reduce Transparency:** hide the aurora entirely, or keep it dimmed and static?
