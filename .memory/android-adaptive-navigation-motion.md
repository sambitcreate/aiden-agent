# Android navigation motion, predictive back, and readable width (2026-10)

## Navigation host

- `navigation/AidenNavigationHost.kt` drives `transition.AnimatedContent` from a `SeekableTransitionState<AidenScreen>`. A `LaunchedEffect(navigator.stack.current)` animates (or snaps under reduced motion) to each new top screen.
- Push/pop: M3 shared-axis X. Child enter/exit specs are linear tweens in transition time (300ms, fade-through split at 105ms, 30dp travel via `slideIntoContainer`/`slideOutOfContainer`, so RTL mirrors). The M3 emphasized curve is applied to the transition fraction (`animateTo(target, NavigationFractionSpec)`), so one easing covers the whole transition and gesture scrubbing stays linear.
- Predictive back: the `PredictiveBackHandler` seeks to `predictiveBackSeekFraction(progress)` (at most `PredictiveBackSeekLimit` = 0.35) towards the screen below. A dedicated transform puts the previous screen underneath (`targetContentZIndex = -1`) and fades it in within the scrubbed range; the departing screen keeps full opacity until release, while `predictiveBackDepth` + `predictiveBackShift` shrink it to 90%, round and lift it, and shift it away from the swipe edge (M3: width/20 minus 8dp). Release calls `navigator.back()`, and the same transition finishes from the scrubbed fraction (no remount). Cancel scrubs back on the host's coroutine scope (the handler job is cancelled with the gesture in activity-compose 1.13), then `snapTo(current)`.
- Reduced motion: `MainActivity` passes `aidenReduceMotion()` (Appearance toggle or system animator scale 0). The host then snaps and skips the preview. CI emulators run with animations disabled, so UI tests choose `reduceMotion` explicitly.
- Tests: `AidenNavigationHostUiTest` drives gestures through `OnBackPressedDispatcher.dispatchOnBackStarted/Progressed/Cancelled`. It checks the previous screen is composed mid-gesture, that cancel keeps the current screen, and that release pops while keeping the revealed screen's saved state. `AidenNavigationStackTest` covers the depth and shift math.

## Adaptive

- Dependency: `androidx.compose.material3.adaptive:adaptive:1.2.0` (not in the Compose BOM). 1.3.0 requires compileSdk 37 and AGP 9.1, so it fails `checkDebugAarMetadata` on AGP 9.0.1 / compileSdk 36.
- `ui/theme/AidenAdaptive.kt`: `AidenWindowWidthClass.forWidth` (600/840 breakpoints), `LocalAidenWindowClass` override + `currentAidenWindowWidthClass()`, and `Modifier.aidenReadableWidth()` (840dp cap, centered; it follows measured space, so it is a no-op below 840dp and phone layouts are unchanged).
- Applied at screen roots after the Scaffold padding: chat transcript Box and composer bottom bar (after the inset/IME padding), workspace home list, workspace directory/detail, bots home, bot profile (before `verticalScroll`), scheduled list/detail, git review (the unified diff view stays full width for code), workspace environment. M3 `AlertDialog` (560dp) and `ModalBottomSheet` (`SheetMaxWidth` 640dp) already cap themselves.

## List-detail on Expanded windows

- `navigation/AidenNavigationScene.kt`: `aidenNavigationScene(stack, widthClass)`. Expanded + every entry above the shell is a `ChatDetail` gives `ListDetail(detail)` (constant key `list-detail`; `detail` is null at the root, which shows a placeholder). Anything else gives `Single(top)` keyed by its `stateKey`, so compact and medium behave exactly as before.
- The host's outer `SeekableTransitionState` holds scenes, not screens. A second seekable transition drives the detail pane (shared-axis X in the pane; it snaps when entering the layout). A chat popped inside the layout is scrubbed by predictive back in the pane, with the placeholder or previous chat revealed underneath; `gesture.inDetailPane` picks which transition, spec, and reset belongs to the gesture.
- Saved-state keys stay `shell` and `chat|id`. On a layout change (window resize) a screen is composed only by the target scene (`screenKeys` / `composes`), so a `SaveableStateProvider` key is never live twice. A resize snaps instead of sliding.
- `LocalAidenShowsUpNavigation` is false for a chat opened directly from the shell, beside the list pane; `AidenChatDetailScreen` hides its back arrow then. Chats opened from a chat keep the arrow.
- `AidenNavigator.openFromShell` (`resetTo`) is used for the shell's chat taps, so a list tap replaces the open chat; other shell actions still push, so returning from Settings or a Bot shows the chat that was open.
- Not done: highlighting the open chat in the list pane, and resizing the list pane.
