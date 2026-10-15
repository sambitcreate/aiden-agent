# run_command cleanup workflow

- The managed worktree started without `node_modules`, so the focused regression could not run until `npm ci --ignore-scripts` populated root dependencies. The install completed in 7 seconds.
- Node 26.10.0's native `glob` follows the fixture symlink for `**/*`, while the existing `foreground glob agrees with native glob` test expects it not to. The full coding-tools run failed 58/59; one targeted rerun and an unchanged-production baseline both failed the same way. This is separate from process cleanup.
- Linux verification was unavailable locally: `docker` is installed, but its configured OrbStack daemon socket is not running.
