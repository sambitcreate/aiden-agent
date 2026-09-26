# Aiden CLI standalone (PR #121, target 0.50.0)

- `packages/cli` is its own npm package. It is not included in the desktop
  electron-builder `files` (`build/**` only), so desktop packaging is unaffected.
- Several desktop services are split into portable `*-core.ts` modules
  (schedule-store, subagent-supervisor, vision-analysis-tool, local-models,
  aiden-remote-speech, subagent-mcp-mutation-host). When main changes one of
  the thin desktop wrappers, port the behavior into the core too. The 2026-09-26
  merge ported: schedule `isCurrent` fencing, subagent `compactionEngine` and
  `maxTurns` / V2 tree turn allowance, and the vision per-request id.
- `packages/cli/src/vendor/advisor/*` are vendored desktop files with rewritten
  import specifiers. `packages/cli/tests/extensions.test.mjs` requires parity
  with the originals after imports are stripped. Re-vendor them whenever
  `main/services/{advisor-runtime,advisor-context,advisor-attempt-store,data-store,regular-file-read}.ts`
  changes.
- The CLI build uses `prebuilt/native/*` helpers only when the manifest source
  hashes match. After changing native sources (including
  `native/subagent-shell-runner/setsid-fixture.c`), rebuild them with:
  - `node scripts/build-native-helpers.mjs` (darwin)
  - `node scripts/build-native-helpers.mjs --docker linux/amd64 linux/arm64`
- CI:
  - The `cli-linux` and `cli-playground` jobs are required (desktop area) in
    `scripts/ci-required.mjs`.
  - Root `npm test` ends with `npm run test:cli`.
  - The CI test registry accepts only the audited npm commands of
    `test:cli`/`cli:build`, which run as the preserved `cli-package` entry in
    the renderer-other lane.
- Aiden remote contract revision: 12. Both the CLI PR and main claimed 11, so
  the merge bumped it.
- models.dev in the CLI is reached only through the explicit `catalog models-dev
  fetch` command. That command is the foreground, user-initiated counterpart of
  the Settings action and writes a display-only cache. Nothing calls it on
  startup.
- `npm --prefix packages/cli run type-check` runs only in the `cli-linux` Docker job. It is not part of root `npm test`, so run it locally after merging main. Main-side dependency interfaces (for example `WorkspaceWorktreeApplicationDependencies`) must be wired in `packages/cli/src/remote-worktrees.ts`.
- `packages/cli-playground` installs standalone in CI, so it needs its own `@types/node`.
- AGENTS.md now names `aiden catalog models-dev fetch` as an approved models.dev caller (coordinator decision 2026-09-26). It is the CLI counterpart of the Settings action, with the same endpoint and constraints and a display-only cache.
