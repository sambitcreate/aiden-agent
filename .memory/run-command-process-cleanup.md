# run_command process-group cleanup, issue #424

Unix `run_command` owns its detached process group until requested termination finishes. Shell `close` settles the command only after the SIGTERM-to-SIGKILL cleanup promise completes or the group is confirmed absent. A closing shell alone does not cancel escalation: a redirected background descendant can remain in the group. Successful commands take no cleanup delay, and abort, timeout, output-limit, and spawn-error result formatting stays the same.

The existing coding-tools suite now runs a Node worker that ignores SIGTERM and writes a heartbeat. It covers early shell closure, a resistant foreground process, timeout, and output overflow. The cancellation case fails against `11b58367` because the heartbeat continues after the command settles. The test has fallback PID cleanup and skips Windows, whose process-tree behavior is outside this issue. No Remote, UI, native-client, or onboarding contract changed; no plan status changed.

Local verification on macOS Node 26.10.0: focused process regression, root type-check, focused ESLint, and `npm run test:cli` (99 tests) pass. The full coding-tools suite is 58/59 because an unrelated native-glob comparison fails identically on unchanged production source; its one targeted rerun also fails. Linux verification was unavailable because the configured Docker daemon is stopped.

## Latest-main integration, 2026-10-16

Merged `origin/main` at `ee218d1f` into PR #494 with merge commit `555fdfd26`. The sole conflict was `CodingToolOptions`: retain this PR's test deadline seam and main's native `fileMutatorBinary` together. `package.json` matches main exactly, so its test scripts are preserved. The merged coding-tools file runs both the native edit/write helper and the process-group cleanup.

After building the native file mutator, eight focused `run_command`/`edit_file` cases passed. Full coding-tools passed 66/67; only the pre-existing native-glob symlink comparison failed. Root and CLI type checks, focused ESLint, and the full bundled CLI suite (99/99) passed. Hosted exact-head checks are pending.

Main advanced through the 0.57.0 release while these checks ran. Merged `origin/main` at `515de673` as `7452b181` without conflicts; it changed release metadata and the plan index only. With refreshed root dependencies, the native helper build, eight focused process/edit cases, root and CLI type checks, focused ESLint, and bundled CLI suite (99/99) all passed again. The root `package.json` still matches main exactly. Hosted validation is pending on the pushed integration head.
