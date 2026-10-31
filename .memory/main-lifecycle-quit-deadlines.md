# Main-process lifecycle: quit deadlines, load retry, IPC routing (2026-10-29)

Branch `claude/audit-fix-main-lifecycle`, from the main-lifecycle audit
(findings 1-14) plus persistence/IPC audit F8 and F9.

## Quit can no longer hang
- `withDeadline(work, ms)` in `main/services/quit-barrier.ts` settles any step
  as fulfilled, rejected or timed-out. It does not cancel the work.
- `shutdownAndQuit` runs every service step through `settleShutdownStep` with
  its budget from `SHUTDOWN_BUDGET_MS` in `main/index.ts`: serial steps first
  (Gemini Live 3 s, parent generations 8 s, background jobs 6 s, model pace
  1 s, subagents 7 s, spending 1 s, usage data 2 s, soak receipt 5 s, Remote
  5 s), then the
  independent stores in parallel. A step that times out is logged and skipped.
- Each budget is at least the service's own internal grace: bot ingress 5.5 s
  (`stopAndSettle` waits 5 s), Computer Use status 5.5 s (5 s grace), devices
  8 s (recordings 2 s + SSH 5 s + local `daemon stop` 10 s exceed it). When the
  devices step times out, `terminateDeviceHelperCommands()` SIGTERMs every
  helper command `runChildCommand` still has running (the same fallback their
  own timeouts apply) and refuses every later one (code 124, never spawned):
  the shutdown chain keeps going past the deadline and could otherwise start
  `daemon stop` ~9 s in, after the scan. A refused (or signalled) `daemon
  stop` is not left to the next launch: that launch reuses a healthy daemon
  and never stops it, and the daemon has no idle timeout. Instead `stopAgent`
  then SIGTERMs the pid in `daemon.json` directly from main, with no helper
  process, only after a synchronous, 2 s-bounded `/bin/ps` check that its
  command line runs a script under Aiden's `tools/agent-device` install and
  its `lstart` matches the recorded `processStartTime` (agent-device 0.21.12's
  own identity check). No SIGKILL escalation. This only helps if the shutdown
  chain reaches `stopAgent` before the process exits. Raising the budget
  instead would push the hard ceiling past ~56.5 s.
- Parent generations share 8 s between the 6 s generation grace and Gemini
  context-cache deletes (8 s request timeout each). A slow delete reports the
  step unsettled, which skips the soak receipt; cache entries expire on their
  server-side TTL.
- A hard ceiling (`SHUTDOWN_HARD_CEILING_MS`, unref'd) is derived from the
  budgets: serial sum + the longest parallel branch (bot ingress then bot
  runtime, 10.5 s) + diagnostics + 5 s slack, about 56.5 s. It calls
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
- executeJavaScript cannot be cancelled, so unload arming goes through the
  renderer's `window.__aidenArmUnloadApproval(revision, armBy, expiresAt)`
  (`renderer/lib/lifecycle-guard.ts`): an arm call running after `armBy`
  (deadline minus 1 s) installs nothing, an approval expires 2 s after the
  deadline, and an action that ends declined or unresponsive sends
  `__aidenClearUnloadApproval()`, which runs after any late arm call.
- `createLifecycleCheck` (application-lifecycle-core) gates close, reload,
  quit and onboarding reset. `destroy()` fires window-all-closed and
  before-quit synchronously, and before-quit drops a quit while a check is in
  flight, so a forced window close queues `destroy()` with `afterRelease`.
  Otherwise Close Anyway on the last Linux/Windows window left a headless
  Aiden running.

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
- `destroyPill()` also destroys a pill that is still loading (`loadingWindow`),
  and a pill closed mid-load rejects its `ensurePill` waiters instead of
  leaving them pending.

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
