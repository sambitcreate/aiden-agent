# run_command cleanup workflow

- The managed worktree started without `node_modules`, so the focused regression could not run until `npm ci --ignore-scripts` populated root dependencies. The install completed in 7 seconds.
- Node 26.10.0's native `glob` follows the fixture symlink for `**/*`, while the existing `foreground glob agrees with native glob` test expects it not to. The full coding-tools run failed 58/59; one targeted rerun and an unchanged-production baseline both failed the same way. This is separate from process cleanup.
- Linux verification was unavailable locally: `docker` is installed, but its configured OrbStack daemon socket is not running.
- The 2026-10-16 main merge conflicted only where #494's test deadline option and main's native file-mutator option were added to the same interface. Keeping both resolved it; the root test script matched main without manual edits.
- `.memory/` and `.papercuts/` are ignored even for previously committed files; a path-specific `git add` rejected their updates. Stage tracked updates with `git add -u` instead.
- Main advanced to the 0.57.0 release while the first merged head was being validated. A second ordinary merge and focused rerun were needed before publishing the final exact head.
- The Android Gradle wrapper lives in `android/`, so an initial repository-root `./gradlew` invocation failed before any build work. The focused test was rerun from `android/`.
- Running bundled CLI and native iOS/Android builds together saturated the host: the CLI Bot parity and codemode tests took roughly 16 minutes and failed with authority revocation/SIGTERM (exit 143). Both passed on one isolated rerun; the Bot case still took 13 minutes. This appears timing-sensitive and is not evidence that the tests are healthy under load.
- The simulator stream E2E case first timed out waiting for a saved assistant reply while generation remained active, before reaching the #508 coordinate assertion. It passed on one rerun (14.6 seconds); keep the first failure visible as a flake.
