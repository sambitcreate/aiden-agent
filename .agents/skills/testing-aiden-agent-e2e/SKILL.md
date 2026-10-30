---
name: testing-aiden-agent-e2e
description: How to write, list, type-check, and run the Playwright Electron e2e tests for Aiden Agent — how to run the Electron suite off-screen on a Mac through the Cua Space runner (npm run test:e2e:space) or on Linux with xvfb-run, when a spec still needs the macOS host, and the harness APIs and locators the specs rely on.
---

# Testing Aiden Agent e2e (Playwright + Electron)

## Devin Secrets Needed
None for the mock harness. `tests/e2e/fixtures.ts` runs a deterministic mock LM Studio on a random localhost port. You only need a real LM Studio for `npm run test:e2e:live:lmstudio` (`AIDEN_E2E_LIVE_LMSTUDIO=1`, optional `AIDEN_E2E_LMSTUDIO_BASE_URL`).

## Where the suite can run
CI runs the Electron suite in two places, both from `.github/workflows/ci.yml`: the main gate on `macos-26` (the `e2e` job, sharded by `scripts/ci-e2e-shards.mjs`), and the `Run deterministic Electron E2E gate` step of the Linux x64 job (`xvfb-run --auto-servernum npm run test:e2e`).

### On a Mac: run it in a Cua Space
Do not run window-opening tests on the Mac's own display. Use the Cua Space runner, which syncs the checkout (including uncommitted files) into a local Linux sandbox and runs it like CI's Linux E2E step:

- Full suite: `npm run test:e2e:space`
- One spec or any Playwright args: `npm run test:e2e:space -- tests/e2e/<spec>.spec.ts`
- Watch it on the Space desktop: `npm run test:e2e:space -- --watch tests/e2e/<spec>.spec.ts`
- Any other window-opening command (Electron smoke scripts): `npm run test:e2e:space -- --run <command> [args]`
- Artifacts come back to `test-results/cua-space-<space>/`. A busy Space exits 75; concurrent sessions set a distinct `CUA_SPACE`, and `--reset` stops processes an interrupted run left behind.

It needs the `cua` CLI (`curl -fsSL https://cua.ai/install.sh | DO_NOT_TRACK=1 sh -s -- --only spaces --no-onboarding`). The Space is Linux (arm64 on Apple silicon), so specs take their non-darwin branches there. When you change a spec's darwin branch (iOS Simulator environment tabs, Computer Use and Apple models in guided setup, This Mac settings, Meta-modifier shortcuts) or macOS-only behavior (Keychain, packaging, computer-use, packaged diagnostics), also run that spec on the host with the commands below, or rely on the macOS CI gate.

### On a Linux machine
Follow CI's Linux E2E step: install its apt packages (`xvfb pkg-config libsecret-1-dev libselinux1-dev gnome-keyring dbus-x11`), then `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, `ulimit -c 0`, and `xvfb-run --auto-servernum npm run test:e2e`. Without the sysctl, Ubuntu 24.04 leaves Electron with no usable sandbox and it aborts.

### Checks that need no window
- Install: `npm ci` (Node `>=22.19`, per `package.json` `engines`; CI pins 22.23.4).
- Type-check specs: `npm run type-check:e2e`.
- Confirm new specs and titles are collected: `npm run test:e2e:list`.
- Non-Electron unit suites and lint (see the `test:*` scripts in `package.json`).

### Running on the host (macOS-specific behavior only)
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
