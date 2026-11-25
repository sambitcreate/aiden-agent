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
