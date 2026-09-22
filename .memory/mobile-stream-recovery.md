# Native stream recovery — 2026-09-22

Baseline: origin/main `c8c09e0d2` (freshly fetched; starting coordinator checkout was stale). Branch `feature/mobile-stream-recovery`. PR #119 was inspected: it owns unrelated Phase 6 test assumptions/Live Activity acceptance and was not modified.

## Verified source and decisions

Read the Notion Hermex→Aiden iOS study `3e280314a1c481e7ad47cbd668968a42` (edited 2026-09-21); it has no linked child pages relevant to this slice. Verified upstream `uzairansaruzi/hermex` HEAD `aa7830b28a071769c2d26bc08949e38e09f4b388` and inspected commits `a6aaf599c` (#314), `057c67a37` (#323), `0f0c686d5` (#325), `0264674a6` (#585), plus late-event/replay/no-op/optimistic fixes `ce91156`, `ebb376b`, `cf0e59c`, `4fa0b31`. Conceptual adaptation only; no upstream source copied. Aiden keeps REST + SSE and its own sequence/identity contracts.

Aiden already retries transport/status failures and ignores incomplete SSE frames. There is no Hermex-style full-buffer replay reconstruction on its normal path, so no extra replay buffering was introduced.

## Implementation

- Both native clients persist the accepted stream identity, but keep advancing sequence cursors with their process-local partial text/reasoning/tool buffers. A cold view reconstructs from sequence zero, including legacy cache records with a nonzero cursor. Warm reconnect stays at the last applied sequence. This removes one disk write per event; no journal/cursor schema migration is needed.
- iOS repeated load does not replace the existing stream consumer with its stale disk cursor. Send generations fence cache/network reloads and title reads; reloads during pending POST are skipped so optimistic messages survive. Title refresh restarts after send settles with task-owned cleanup.
- Android ends event consumption at terminal even when authoritative transcript reconciliation fails. Both clients retain active ownership and disable Send until replay/reconciliation completes. Android explicitly publishes that ownership for Compose recomposition; iOS observes it. Successful terminal cleanup clears ephemeral buffers.
- Recovery warnings clear on healthy stream/status or transcript reads without clearing a different composer/control error. Stale Android load failures are fenced like successful results. Conditional stream-file deletion preserves a newer record; absence of a file does not keep a successfully reconciled iOS owner alive.
- No wire shape, provider configuration, durable feature, visual styling, or onboarding change. Existing feature tour remains accurate. Bot controls and workspace browsing belong to other program peers.

## Validation

- New Android transport regression uses production ViewModel/client and MockWebServer: old cached cursor 27 → cold request zero → warm request one, full prefix restored, late frame after done ignored while transcript fetch fails, retained identity unchanged, no turn POST replay, Send blocked through settlement.
- Three existing failed-send cases now force reload while POST is held and verify optimistic survival. Original main ViewModel fails all four enhanced regressions (three lost optimistic messages, cold replay timeout); fixed focused suite passes.
- Full Android JVM suite: 176 passed, zero failed/skipped. `lintDebug` and `compileDebugAndroidTestKotlin` also pass.
- Three XCTest additions in the existing registered AidenChatTests.swift exercise cold/warm replay and unchanged persistence, terminal send gating and cleanup, optimistic reload survival, and Stop against a live recovered stream.
- Xcode 27 beta generic iOS build-for-testing passes with signing disabled; this compiles XCTest, does not execute it. `npm run test:ios-release` passes (31 Node tests, 20 Ruby tests / 42 assertions).
- Physical XCTest blocked: coordinator's immediately prior device run reported `com.apple.dt.deviceprep Code=-3: Unlock Sambit’s iPhone to Continue` for iPhone 13 Pro `00008110-00063CD91E98801E`. No repeated blocked run, simulator, or unlock bypass attempted. Device acceptance remains pending.
- Separate GPT-5.6 Sol medium blast-radius and adversarial reviews were performed after implementation. Fixed findings: accidentally broadened Stop guard (restored), stale error publication, title retry loss, warning ownership, and Send during terminal replay. Both final reviews report no remaining actionable findings.

Local logs: `/tmp/aiden-mobile-recovery-baseline.log`, `/tmp/aiden-mobile-recovery-android.log`, `/tmp/aiden-mobile-recovery-build.log`, `/tmp/aiden-mobile-recovery-ios-release.log`. Hosted checks/review status must be checked independently after publication; no merge/release/deploy authorized.
