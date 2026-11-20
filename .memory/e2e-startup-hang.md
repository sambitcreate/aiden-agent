# macOS E2E startup hang — 2026-11-20

Symptom: in the macOS Electron E2E job, a spec's first launch opened no window within 30 s, quitting then hung, and the log showed `settingsPrepared:false`. Seen on `guided-setup.spec.ts:6`, `follow-through-lifecycle.spec.ts:30` and `environment-devices-tab.spec.ts:16`.

Cause: `crash-reporting.spec.ts:41` ended its app with `process.crash()`. On macOS, ReportCrash then works on the crashed process for about 30 s and raises the "quit unexpectedly" dialog through UserNotificationCenter. An Electron launch that overlaps that window reaches `will-finish-launching` but never gets `applicationDidFinishLaunching`, so `ready` never fires and `app.quit()` cannot finish. The hangs started when the 4 shards moved and put another launch 30–50 s after the crash test.

Fix: the test kills its app with `SIGKILL` from the same `uncaughtExceptionMonitor`. SIGKILL leaves no crash report or dialog. The test's assertions still hold because `after_crash` comes from the unclean-run marker and the pending crash record is written by Aiden's own monitor first.

Rules that follow:
- No E2E spec may end the Electron main process with `process.crash()` or another crashing signal (SIGSEGV, SIGABRT) on macOS. Use `SIGKILL`. Renderer crashes (`forcefullyCrashRenderer`) do not raise the dialog.
- `tests/e2e/electron-test-bootstrap.cjs` records startup milestones (`will-finish-launching`, native ready, Playwright run) and `firstAidenWindow` in `tests/e2e/fixtures.ts` adds them to a `firstWindow` timeout. "native ready never" means AppKit never finished launching; look for something on the host (crash dialogs, ReportCrash) rather than in Aiden's startup code.
- Reproduction used a temporary probe workflow on a `diag/` branch (runs 44677657475, 44680079058 and 44680129677; validation run 44681438771: SIGKILL 9 of 9 rounds clean, `process.crash()` control hung 2 of 6), since the Cua Space is Linux and cannot show macOS crash handling.

Details: `docs/ci.md` (2026-11-20 entry).
