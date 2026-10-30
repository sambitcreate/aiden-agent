# Electron E2E tests

The default suite launches the built Electron app through Playwright with a
fresh temporary `--user-data-dir`, a separate absolute `AIDEN_CONFIG_DIR`, and
a test-owned LM Studio-compatible server bound to a random loopback port. It
does not read or contact a developer's Aiden profile, credentials, or LM Studio
server.

On a Mac, run it in a local Cua Spaces Linux sandbox so test windows stay off your
display (needs the `cua` CLI; see `scripts/cua-space-e2e.sh`):

```sh
npm run test:e2e:space                                   # full suite
npm run test:e2e:space -- tests/e2e/<spec>.spec.ts       # any Playwright args
npm run test:e2e:space -- --run <command> [args]         # other window-opening commands
```

The Space is Linux, so specs take their non-darwin branches there. Changes to a spec's
darwin branch or to macOS-only behavior still need `npm run test:e2e` on the host (or
the macOS CI gate). On Linux, follow CI's Linux E2E step: its apt packages,
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, `ulimit -c 0`, then
`xvfb-run --auto-servernum npm run test:e2e`.

Hosted CI splits deterministic spec files across three isolated macOS runners, each with
one Playwright worker. `scripts/ci-e2e-shards.mjs` balances files using recorded hosted
durations and automatically assigns newly added specs. After `npm run build`, reproduce
one shard with `node scripts/ci-e2e-shards.mjs 1/3`; append `--list` to inspect its files.
Never run these shards concurrently against the same checkout or desktop session.

The production-profile diagnostics spec runs separately after the desktop build job's
build through `npm run test:e2e:diagnostics:production:run`. The original
`npm run test:e2e:diagnostics:production` still prepares its own build for local use.
The release workflow retains its own deterministic and signed-app migration/packaged
diagnostics acceptance tests.

Useful static checks are `npm run type-check:e2e` and
`npm run test:e2e:list`. The fixture constructs the app environment from a
small system-variable allowlist, adds only its owned storage values, and rejects
any inherited Pi provider auth. It verifies `HOME`, all XDG roots, `userData`,
`sessionData`, and the portable config root from Electron main. A test-only main
preload aligns Electron's native home path with the fixture root. One onboarding
case starts with an empty portable provider list; that same preload routes only
LM Studio's default loopback origin to the case's random-port server while the
persisted product endpoint remains unchanged. Teardown reports
server/process leaks and preserves an original test failure when cleanup also
fails.

A spec that needs the real Bot store opts into `test.use({ isolatedKeychain: true })`
(macOS only). Before launch, the fixture creates an unlocked, passwordless keychain
inside the fixture HOME and makes it that HOME's default with `/usr/bin/security`,
run with `HOME` pinned to the fixture root. It refuses to proceed unless the
fixture HOME starts with an empty keychain search list, so the developer's login
keychain and keychain preferences are never touched, and teardown deletes the
keychain. Production code is unchanged: the Bot store writes its rollback
authority through the same `security` calls it uses for real users.
`bots-persistence.spec.ts` uses it to create a Bot, run real turns against the
deterministic model, relaunch on the same profile and read the transcript back.

The separately selected live vision acceptance is opt-in and is never part of
the CI or release gate:

```sh
npm run test:e2e:live:lmstudio
```

That command contacts `http://127.0.0.1:1234/v1` by default. Override only for
an explicitly chosen compatible server with `AIDEN_E2E_LMSTUDIO_BASE_URL`.

Local artifacts are written to `test-results/e2e` for traces and failure screenshots,
and `playwright-report/e2e` for the HTML report. Hosted jobs upload only the sanitized
failure receipt, under a shard-specific name with seven-day retention.
