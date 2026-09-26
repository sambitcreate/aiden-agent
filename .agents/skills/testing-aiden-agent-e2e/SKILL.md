---
name: testing-aiden-agent-e2e
description: How to write, list, type-check, and run the Playwright Electron e2e tests for Aiden Agent — which parts work on a Linux VM (authoring, type-checking, listing), why the Electron suite itself only runs on macOS, and the harness APIs and locators the specs rely on.
---

# Testing Aiden Agent e2e (Playwright + Electron)

## Devin Secrets Needed
None for the mock harness. `tests/e2e/fixtures.ts` runs a deterministic mock LM Studio on a random localhost port. You only need a real LM Studio for `npm run test:e2e:live:lmstudio` (`AIDEN_E2E_LIVE_LMSTUDIO=1`, optional `AIDEN_E2E_LMSTUDIO_BASE_URL`).

## Where the suite can run
The Electron suite only runs on macOS. CI runs it on `macos-26` (the `e2e` job in `.github/workflows/ci.yml`, sharded by `scripts/ci-e2e-shards.mjs`). A Linux VM cannot launch the app from this checkout, and a fixture patch will not fix that:

- `npm run build` builds the native helpers (`build:worktree-remover`, `build:worktree-file-io`, `build:bot-inbox-writer`, `build:subagent-run-store`, `build:subagent-file-mutator`, `build:subagent-shell-runner`). Every one of those scripts (`scripts/build-*.mjs`) prints a skip message and exits 0 when `process.platform !== "darwin"`, so the build "succeeds" on Linux without producing `build/native/*`.
- The helper sources in `native/` use macOS-only APIs (`st_birthtimespec`, `renameatx_np`, `arc4random_buf`, and others). The development app resolves `build/native/aiden-subagent-run-store`, and `main/index.ts` initializes the subagent run store during startup. Without a working helper, startup fails before any spec gets a window.
- Do not hand-port the helpers for a test run. The run-store generation tokens that `main/services/subagents/subagent-run-store-io.ts` validates include birth-time fields, and a partial port that drops them breaks the read/write handshake. A Linux helper port has to land as a reviewed repo change with its own tests, not as a VM-local workaround.
- `tests/e2e/fixtures.ts` launches Electron with an isolated environment. `APP_ENV_PASSTHROUGH` does not forward `DISPLAY`/`XAUTHORITY`, and `assertRuntimeIsolation` only exempts the macOS-injected `__CF_USER_TEXT_ENCODING`. Supporting Linux would also need a reviewed fixture change.

### What does work on a Linux VM
- Install: `npm ci` (Node `>=22.19`, per `package.json` `engines`).
- Type-check specs: `npm run type-check:e2e`.
- Confirm new specs and titles are collected: `npm run test:e2e:list`.
- Non-Electron unit suites and lint (see the `test:*` scripts in `package.json`).
- Then push and let the macOS `Deterministic Electron E2E` CI job run the specs, or run them on a Mac.

### Running on macOS
- Full suite: `npm run test:e2e` (type-checks, runs `npm run build`, then `playwright test --fail-on-flaky-tests`).
- One spec after a build: `npx playwright test tests/e2e/<spec>.spec.ts --config=playwright.config.ts`.
- The fixture refuses to launch unless `build/main/index.js` and `build/renderer/main-window.html` exist.
- When a spec fails, check the `aiden-dev-log` attachment first, then `electron-process-state`. The attachment holds `<rootDir>/user-data/logs/aiden-dev.log` for normal runs and `<rootDir>/user-data/logs/aiden.log` when `AIDEN_E2E_RUNTIME_PROFILE=production` (the `test:e2e:diagnostics:production` scripts).

## Fixture options and onboarding
- `portableConfigSeed` (default `"lmstudio"`) writes a keyless `LM Studio (local)` provider pointing at the mock into the isolated config dir. `"empty"` writes no providers.
- `workspaceSeed` (default `false`) writes one full-permission workspace (`Aiden E2E workspace`) into the isolated user-data `config.json`.
- Set options per file with `test.use({ workspaceSeed: true })`.
- First-run setup is not skipped. Call `finishLmStudioOnboarding(page)` from `./fixtures`, which fills the profile name `E2E Local User`, picks LM Studio, waits for model discovery, and clicks "Start using Aiden". This is how the existing specs (for example `chat-message-queue.spec.ts`) get past onboarding.

## Harness notes
- `aiden.lmStudio.holdCompletions()` / `releaseCompletions()` hold SSE streams open, so detach/lifecycle tests get a real in-flight generation. `aiden.lmStudio.requests` captures every request. Filter on `r.url === "/v1/chat/completions"` and read the last `role: "user"` entry in `body.messages` to prove whether a send reached the model.
- `aiden.lmStudio.enqueueToolScenario({ prompt, calls, finalText })` scripts exact prompt-matched tool calls on the deterministic model.
- `aiden.relaunch()` restarts Electron against the same isolated data dirs.
- The model generates the sidebar chat titles, so with the mock they read `Deterministic E2E response received`, not the prompt text. Locate sidebar entries with `[data-sidebar]` plus `getByRole("button", { name: /Deterministic E2E response/ })`.
- To send a message, call `page.locator("textarea").fill(...)` and then `.press("Enter")`. The sidebar buttons are `getByRole("button", { name: "New Agent" })` and `{ name: "Settings" }`. Settings has a `Back to app` button. Routes use `createMemoryHistory` (`renderer/main/router.tsx`), so `page.url()` never changes; navigate with the UI only.
- Chats persist to `userDataDir/chats/index.json` and `chats/<id>.json`. When counting user chats, filter out entries with a `botId` and entries where `workspaceId === "assistant"`.
- `QueuedMessages` (`renderer/components/queued-messages.tsx`) renders `section[aria-label="Queued messages"]` with the text "N queued", the buttons "Pause queue"/"Resume queue", and the per-item labels `Edit queued message N`, `Delete queued message N`, `Reorder queued message N`, `Steer with queued message N`.
- A draft that is detached mid-generation registers in `detachedLifecycleStreams` (`renderer/lib/chat-terminal-sync.ts`). To exercise the drain path, navigate away (for example New Agent) while the mock holds the stream, then return to the chat.
