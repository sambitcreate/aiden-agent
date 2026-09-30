# Keychain Not Found prompt — 2026-09-27

Branch `worktree-fix-keychain-not-found-prompt` from main a9baa4aa.

Local testing repeatedly raised the macOS modal "Keychain Not Found — A keychain cannot be found to store `user-data:<sha256>`" with a **Reset To Defaults** button (the `exec` icon is `/usr/bin/security`). The account is the Bot capability authority key: SHA-256 of the realpath of Electron `userData` (`bot-capability-authority-item.ts`). At startup the Bot capability checkpoint and Telegram Bot binding store write their rollback/bootstrap items through `security add-generic-password`.

Cause: E2E (`tests/e2e/fixtures.ts`) and the packaged acceptance scripts (`pi-session-packaged-restart-acceptance`, `subagent-run-store-packaged-acceptance`, `run-packaged-diagnostics-acceptance`) launch Electron with `HOME=<mkdtemp root>`. `security` resolves the user keychain domain from `$HOME/Library/Keychains`, finds nothing, and securityd shows the alert on the write. Reads are silent (`find-generic-password` exits 44), and `security default-keychain -d user` exits 1 with "A default keychain could not be found" and no UI. Each run has a new temp root, so the hash differs every time. Clicking Reset To Defaults is harmful; Cancel just fails the write.

Fix: `createKeychainItem` write now preflights `security default-keychain -d user`, requires an absolute quoted path whose file exists (`keychainExists`, injectable), and otherwise throws `BotCapabilityUnavailableError` before `add-generic-password` — the same fail-closed outcome as Cancel, without the modal. Real users with a normal login keychain are unaffected. Tests inject `keychainExists` and answer `default-keychain` in mocks; a regression covers exit-1, missing file, and unparseable output, asserting no add call.
