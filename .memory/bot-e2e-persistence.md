# Bot E2E on the real stack — 2026-10-15

`tests/e2e/bots-persistence.spec.ts` is the one Playwright flow that uses the real main-process Bot store, durable runtime and live projection (the other Bot specs replace Bot IPC). It creates a Bot through the create flow, sees the self-intro and one prompt-matched turn from the deterministic LM Studio fixture, relaunches on the same userData and checks the transcript returns without a new completion request.

## Keychain isolation
- The fixture option `isolatedKeychain: true` (macOS only) creates `<fixture HOME>/Library/Keychains/aiden-e2e.keychain-db` (empty password, no auto-lock) and sets it as the user-domain search list and default with `HOME=<fixture root> /usr/bin/security`. `security` reads the user domain from `$HOME/Library/Preferences/com.apple.security.plist`, so `Library/Preferences` must exist first or the settings silently do not persist.
- Guard: provisioning refuses if the fixture HOME already resolves a search list (that would mean HOME is not honoured). Teardown runs `security delete-keychain`.
- No production seam: `bot-capability-keychain-anchor.ts` runs unchanged (see `keychain-not-found-prompt.md` for why a missing default keychain fails closed).

## Found while building it
- Start chat (starter carousel, onboarding Bots step) creates a Full-access Bot without acknowledging the desktop access notice. On a fresh profile its first send fails with `BotCapabilityNoticeRequiredError`, which `bot-runtime-authority.ts` folds into `access_unavailable` ("can't reach its AI model"). The create flow and Advanced acknowledge the notice first, which is why the spec uses the create flow. Reported as a follow-up, not fixed here.

## Per-turn Keychain storm — 2026-11-09
- The spec went flaky on `main` CI (Electron E2E 3/4 on `e87ae20f4` and `721fcbe46`, first try and retry): the intro or the answer missed its 10 s `toBeVisible`. Locally it reproduced 6/6 with every core saturated.
- Cause: every catalog snapshot (built ~17 times per turn) calls `reconcileNamespace` for each incarnation namespace, ~107 calls per turn, and each went through `persistence.update()` → checkpoint `commit` → `reconcile`, which reads the rollback anchor and bootstrap marker. On macOS each read is a `/usr/bin/security` subprocess: 244 per turn, ~6.8 s between Send and the model request with an instant model. Only 5 commits per turn actually changed state.
- Fix: `BotCapabilityStore.reconcileNamespace` runs the editor on a clone of the verified in-memory state (`DataStore` caches it; startup verified it against the anchor) and commits only when the clone changed, like `admit` does for stale model bindings. Changes still commit through the full checkpoint; a poisoned store still refuses. Result: Send → model request 1.4 s, the whole spec ~12 s instead of ~22 s, `security` calls 584 → 96.
- How it was found: wrap `globalThis.setTimeout` in Electron main from the test (`aiden.app.evaluate`) and log ≥300 ms timers with stacks — `runSecurity` arms a 5 s timer per call — then map `build/main/index.js` frames through `index.js.map` with `node:module` `SourceMap`. Wrapping `child_process` from the test misses calls because the bundle binds `spawn` at import.
- Still open: with every core pinned and load average >100, the relaunch's Electron shutdown can exceed the fixture's 35 s limit. Not seen on CI; shutdown is 1.5–4 s at normal load.
