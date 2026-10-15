# Bot E2E on the real stack — 2026-10-15

`tests/e2e/bots-persistence.spec.ts` is the one Playwright flow that uses the real main-process Bot store, durable runtime and live projection (the other Bot specs replace Bot IPC). It creates a Bot through the create flow, sees the self-intro and one prompt-matched turn from the deterministic LM Studio fixture, relaunches on the same userData and checks the transcript returns without a new completion request.

## Keychain isolation
- The fixture option `isolatedKeychain: true` (macOS only) creates `<fixture HOME>/Library/Keychains/aiden-e2e.keychain-db` (empty password, no auto-lock) and sets it as the user-domain search list and default with `HOME=<fixture root> /usr/bin/security`. `security` reads the user domain from `$HOME/Library/Preferences/com.apple.security.plist`, so `Library/Preferences` must exist first or the settings silently do not persist.
- Guard: provisioning refuses if the fixture HOME already resolves a search list (that would mean HOME is not honoured). Teardown runs `security delete-keychain`.
- No production seam: `bot-capability-keychain-anchor.ts` runs unchanged (see `keychain-not-found-prompt.md` for why a missing default keychain fails closed).

## Found while building it
- Start chat (starter carousel, onboarding Bots step) creates a Full-access Bot without acknowledging the desktop access notice. On a fresh profile its first send fails with `BotCapabilityNoticeRequiredError`, which `bot-runtime-authority.ts` folds into `access_unavailable` ("can't reach its AI model"). The create flow and Advanced acknowledge the notice first, which is why the spec uses the create flow. Reported as a follow-up, not fixed here.
