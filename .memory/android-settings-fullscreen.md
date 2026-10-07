# Android Settings and Installations as full-screen pages (2026-10)

Settings and Paired desktops used to be ModalBottomSheets over the product shell, with all desktop networking inside the composable (state lost on rotation or re-entry) and spinners while it loaded.

## Shape now

- Navigation: `AidenScreen.Settings(page: AidenSettingsPage)` (`settings`, `settings|appearance|voice|providers|add-provider|about`), `AidenScreen.Installations` (`installations`), `AidenScreen.PairDesktop` (`pair`). Tokens are saved-state spelling; unknown pages are dropped on restore. Routing lives in `MainActivity`'s `when`; the product shell and ContentView take `onOpenSettings` / `onOpenInstallations`.
- Root order mirrors iOS: connected desktop, providers, memory, voice input, Read Aloud, appearance, about. The Google TTS charges note moved from pairing into the Read Aloud footer (`READ_ALOUD_SETUP_GUIDANCE`).
- Shared primitives in `features/settings/AidenSettingsComponents.kt`: `AidenSettingsScaffold` (LargeTopAppBar + LazyColumn, Scaffold insets, IME), `AidenSettingsGroup` (one title style, `surfaceContainer` card on a `surfaceContainerLow` page, `shapes.large`, inset `outlineVariant` dividers via a `row {}` builder), and ListItem-based rows: navigation (chevron), switch (whole row `toggleable(Role.Switch)`, `checked = null` shows a placeholder, never a fake state), value, radio (whole row `selectable(Role.RadioButton)`, no borders).
- Data: `AidenSettingsStore` (process lifetime, owned by `AidenAppContainer`) follows `coordinator.client`, renders the per-installation `AidenSettingsCache` snapshot (`settings_cache/`, SHA-256 file names) immediately, refreshes on Settings ON_RESUME, and makes memory and speech-model mutations optimistic with rollback. `AidenSettingsRemote` abstracts `AidenRemoteClient` so UI tests use fakes. The container prunes caches of unpaired installations with `retainOnly` instead of touching `AidenRemoteCoordinator.removeInstallation`.
- Material You: `AidenThemePresetID.DYNAMIC` ("System") appears on API 31+ (`AidenThemePresetID.available(sdk)`); `aidenDynamicPalette` maps the dynamic scheme onto canvas/sidebar/raised/foreground/secondary/accent/danger and keeps Aiden's success/warning. Below 31 the catalog falls back to the Aiden palette.
- Pairing: first run (ContentView NEEDS_PAIRING) is `AidenPairDesktopScreen(firstRun = true)` with no back/close and still lists credential-less installations. Camera permission resolves to GRANTED / REQUESTABLE / BLOCKED (`aidenCameraAccess`); BLOCKED opens `ACTION_APPLICATION_DETAILS_SETTINGS`, and permission is re-checked on resume. The scanner re-arms after a failed pair (`key(scanAttempt)`) and releases the camera and analyzer thread on dispose. No spinners: busy actions disable and relabel.

## Not done

- iOS's "New workspace permission" app default has no Android counterpart (workspace creation picks permission each time), so it was not added.
- Device (connected) Compose tests were written and compiled but run by the integrator.
