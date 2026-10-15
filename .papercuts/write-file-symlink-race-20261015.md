# write_file symlink race

- This worktree had no root `node_modules`; the first scoped repro could not load `@earendil-works/pi-agent-core`. `npm ci --ignore-scripts` restored the pinned test dependencies.
- The root script is `type-check`, not `typecheck`; the first command failed before TypeScript ran.
- Rebuilding all macOS prebuilt helpers changed three unrelated binaries despite unchanged sources. Restored those binaries and retained only the file-mutator artifact and matching manifest changes.
