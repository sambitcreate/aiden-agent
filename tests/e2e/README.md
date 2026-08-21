# Electron E2E tests

The default suite launches the built Electron app through Playwright with a
fresh temporary `--user-data-dir`, a separate absolute `AIDEN_CONFIG_DIR`, and
a test-owned LM Studio-compatible server bound to a random loopback port. It
does not read or contact a developer's Aiden profile, credentials, or LM Studio
server.

Run the deterministic PR/release gate with:

```sh
npm run test:e2e
```

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

The separately selected live vision acceptance is opt-in and is never part of
the CI or release gate:

```sh
npm run test:e2e:live:lmstudio
```

That command contacts `http://127.0.0.1:1234/v1` by default. Override only for
an explicitly chosen compatible server with `AIDEN_E2E_LMSTUDIO_BASE_URL`.

Artifacts are written to `test-results/e2e` for traces and failure screenshots,
and `playwright-report/e2e` for the CI HTML report.
