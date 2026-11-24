# Design app server fixtures

Plain Node stand-ins for `main/services/design-canvas/app-server/app-server-process.test.ts`. No dependencies, no network beyond 127.0.0.1 (and the short-lived wildcard listeners the exposure tests need to catch).

- `server.mjs`: a dev server that listens on `--host`/`--port` or `HOST`/`PORT`, prints a Vite-style `Local:` URL and answers 200. Its `--fake-*` flags misbehave on purpose: `--fake-wildcard`, `--fake-late-wildcard=<ms>`, `--fake-crash-after=<ms>`, `--fake-never-listen`, `--fake-chatty-never-listen`, `--fake-other-port`, `--fake-flood=<bytes>`, `--fake-child`, `--fake-setsid-child`, `--fake-setsid-loopback-child` (a setsid child on 127.0.0.1 that only a crash sweep or a stop ends) and `--fake-in-use-once=<file>` (CRA's address-in-use message on the first run only).
- `fake-pm.mjs`: a package manager. `install` and `ci` write `node_modules/.fake-installed` and exit with `FAKE_INSTALL_EXIT`; `run <script> [--] args…` runs the script with `sh -c`, as npm does. The test hands the service a `#!/bin/sh` shim that runs it.
