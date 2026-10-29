# Main-process lifecycle: quit deadlines, load retry, IPC routing (2026-10-29)

Branch `claude/audit-fix-main-lifecycle`, from the main-lifecycle audit
(findings 1-14) plus persistence/IPC audit F8 and F9.

## Quit can no longer hang
- `withDeadline(work, ms)` in `main/services/quit-barrier.ts` settles any step
  as fulfilled, rejected or timed-out. It does not cancel the work.
- `shutdownAndQuit` runs every service step through `settleShutdownStep` with
  its own budget: serial steps first (Gemini Live 3 s, parent generations 8 s,
  background jobs 6 s, model pace 1 s, subagents 7 s, spending 1 s, Remote
  5 s), then the independent stores in parallel (2-5 s each). A step that
  times out is logged and skipped.
- A hard ceiling (`SHUTDOWN_HARD_CEILING_MS`, 45 s, unref'd) calls
  `app.exit(1)` and logs which steps were still pending. It is disarmed only
  when the update installer takes over. Exit code 1 keeps the soak receipt
  fail-closed.
- `closeRendererBeforeShutdown` destroys a window that has neither closed nor
  vetoed within 5 s (a hung renderer never answers beforeunload).
- Renderer `executeJavaScript` calls (close guard, unload arming, onboarding
  marker) go through `executeRendererScript` with a 6 s deadline. When the
  renderer does not answer, window close and app quit show "Aiden isn't
  responding" with Keep Aiden Open / Close Anyway (Quit Anyway); the force
  path calls `window.destroy()`. Reload and onboarding reset never force.

## Startup and window races
- `mainWindowLoads.retryFailed(start)` (superseding-task-core) restarts a
  rejected main-window load. A Dock click or second-instance on a window
  whose first load failed reloads it instead of waiting on the old rejection.
- `shutdownHasBegun()` guards the deferred startup chain (warm-up timer,
  Remote init, schedules, follow-through, Telegram, updater), so a quit during
  startup does not start services after shutdown.
- `will-prevent-unload` retries only reloads Aiden started; anything else is
  logged.
- Foundation Models refresh on `activate` uses the TTL cache (never forced).
- Main-window notifications wait for renderer readiness through one shared,
  30 s-bounded wait.
- The startup failure path exits 1 if `shutdownAndQuit` returns without
  quitting (Computer Use state unsaved).

## Dictation pill
- The pill is `markAuxiliaryWindow`'d, so on Linux it no longer keeps the app
  alive after the last real window closes; the release branch also destroys it.

## Native IPC (F8) and broadcasts (F9)
- `main/native-ipc-core.ts`: media types are allow-listed; `aiden:dialog:open`
  keeps only title, buttonLabel, message, filters and a properties subset
  (openFile, openDirectory, multiSelections, createDirectory,
  showHiddenFiles). `defaultPath` is dropped. All three handlers require the
  active main-frame sender (`rendererDocumentOwner`).
- `broadcast` targets only registered receivers: the main window (all
  channels) and the pill (`PILL_NOTIFICATION_CHANNELS`). Snapshot, recorder,
  picture-in-picture and capture windows no longer get payloads. A new window
  with an Aiden preload must call `registerBroadcastReceiver`.

## Visual snapshots
- `abortableSleep` (visual-snapshot-core) removes its abort listener when the
  timer fires and rejects at once on an already-aborted signal.

## Skipped
- Vibrancy `visualEffectState` (needs before/after screenshots of an
  unfocused window).
- Pill `backgroundThrottling`: the pill records while hidden, so it stays off.
