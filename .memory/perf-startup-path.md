# Main-process startup path (branch perf/startup-path, 2026-10-03)

Fixes from the optimization audit, findings MAIN-1/2/3.

## MAIN-1: window created during reconciliation
- Before: `whenReady` ran ~20 sequential reconcile awaits (terminal history,
  live/pi runtime stores, bots, migrations, worktree reconcile, dock, shortcuts,
  Remote — ~380 ms on an empty profile) and only then `createMainWindow()`.
- Now: after the first settings read (to set `nativeTheme.themeSource`, so no
  theme flash) `whenReady` starts `createMainWindow({ startupAdmissionHeld: true })`
  and keeps reconciling. The renderer bundle loads in parallel.
- Invariant kept: no renderer invoke runs before reconciliation finishes.
  `main/services/startup-ipc-admission.ts` wraps `ipcMain.handle` (installed in
  `main/bootstrap.ts` before `import("./index.js")`, so before any handler
  registration) and holds every invoke in arrival order until
  `openProcessStartupIpcAdmission()` runs after `initializeAidenRemoteService`.
  The app has only `ipcMain.handle` (no `ipcMain.on`/`sendSync`).
- The renderer awaits `app:getInfo` before its first React render, so while
  invokes are held the user sees only the themed empty window, never stale UI.
- `createMainWindow` skips awaiting `shortcutInitializationPromise` when
  admission is held (shortcuts initialize later in the same chain).
- If startup fails before admission opens, the startup window is destroyed
  (its held invokes could never answer the close handshake), then quit.
- `toolOutputStore.pruneExpired()` is now fire-and-forget (logged on failure).
- New diagnostic milestone `startup-reconciled` (allowlisted in
  `diagnostics-contract.ts`).

## MAIN-2: lazy externals (esbuild `packages: "external"` hoists static imports)
- electron-updater: `createRequire` on first use in `app-updater.ts` (CJS, keeps
  the protected install handoff synchronous). `start()` runs after the window.
  Test harness mocks `node:module`; a test asserts the SDK is not loaded until a check.
- remark/unified: `ensureSpeechTextParser()` awaited in the TTS service before
  `reservation.assertCurrent()`; `prepareSpeechText` stays sync and throws if
  the parser was not loaded.
- bonjour-service: dynamic import inside the Linux publisher's `start()`.
- parse5/acorn/postcss/postcss-value-parser: `browserAssetReferences` is async.
- Deferred: `@google/genai` (6 files, enum values + sync TTS client factory,
  ~19 ms), MCP SDK + ajv (~72 ms; owned by perf/mcp-network-background — ajv
  savings in peer-response only materialize once MCP is lazy too), pi-ai/
  pi-agent-core (core runtime), yaml (~16 ms, skills discovery), and lazy
  handler-module stubs (broad refactor).

## MAIN-3: large blobs
- Remote OpenAPI JSON (289 KB) + Ajv 2020 now load on first peer response;
  `validatePeerResponse`/`peerOperationResult` are async.
- Playwright injected source (326 KB) left alone: it is a string literal and
  measured ~1 ms to evaluate.

## Measuring
- `measure-startup` launches Electron with `HOME`, `AIDEN_CONFIG_DIR` and
  `--user-data-dir` in a temp dir and reads `user-data/logs/aiden-dev.log`.
- Run it from the repo root: native helpers resolve from `process.cwd()/build/native`
  in unpacked builds, and a different cwd fails startup with
  `SubagentRunStoreStorageError: io_failed`.
- Medians, 6 interleaved runs, empty profile, busy shared machine, ms after
  `session-started`: origin/main window 1064 / shown 1342; MAIN-1 only 779 /
  1192; MAIN-1+2+3 653 / 925.
