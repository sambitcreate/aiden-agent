# CLI bundle size and startup (branch perf/cli-bundle-startup, 2026-10)

Audit findings EXT-1..8 and EXT-45, applied to `packages/cli`.

- Entry layout: `src/cli.ts` is a thin bootstrap (Node built-ins plus the
  import-free `src/command-help.ts`). It answers `--version`/`-v` (only when it
  is the sole argument and `PI_PACKAGE_DIR` is unset) and `aiden help` itself,
  installs the SQLite-only warning filter (`src/sqlite-warning.ts`), then
  dynamic-imports `src/cli-runtime.ts`. That module lands in `dist/app/chunks/`,
  so it takes `appDir` as a parameter; never use `import.meta.url` there for
  paths beside the bundle. `PI_TELEMETRY = "0"` must stay in `cli.ts`, because
  `tests/bundle.test.mjs` asserts it in `cli.js`.
- `--help` still loads the full runtime, because pi prints extension flags.
- `dispatchCommand` lazy-imports each command's module.
- One esbuild build with splitting covers cli, the speech/subagent/avatar
  workers and the lazy pi entries (OAuth flows, Bedrock, image-resize-worker).
  The lazy entries are emitted into `dist/app/chunks/` beside the chunks that
  load them through `import.meta.url`-relative variable imports. The build
  fails if a resolver module is ever emitted elsewhere.
- Dedupe: `dedupeRepoPackagesPlugin` maps every bare import to the shallowest
  `packages/cli/node_modules` copy of the same name@version.
  `assertNoDuplicatePackages` fails the build if a duplicate copy slips through.
- Dist only: `model-capabilities.json` is minified, and pi's `docs/images` are
  not copied. The build size log walks all of `dist/app`.
- Plotly was already lazy: it is read from disk only when `render_artifact`
  runs. Inlining it into exported artifacts is a desktop export contract, left
  unchanged.
- The subagent worker still prints the SQLite warning to its piped stderr.
  That stderr only appears in failure diagnostics.
- Dockerfile: multi-stage. A `runtime-deps` stage runs `npm ci --omit=dev`, and
  the runtime image gets only `dist/app`, `themes`, `package.json` and the
  production `node_modules`.
- Measured on Node 22.22.3 (M-series):

  | Measure | Before | After |
  | --- | --- | --- |
  | `--version` | 343 ms | 34 ms |
  | `workspace list` | 327 ms | 299 ms |
  | `--help` | about 460 ms | about 460 ms |
  | `dist/app` size | 46 MB | 25 MB |
