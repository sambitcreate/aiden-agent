# Explicit state machines, Lane D: `aiden serve` owners

Started 2026-11-04. Scope: `cli-native` C09, C10, C03, C01, C02, C11, C04, then triage of the other C entries. Worksheets: `docs/state-machines/serve-daemon.md`.

- `feature/subagent-desktop-serve-upgrade` (uncommitted and local-only in `~/projects/aiden-agent`) rewrites `serve.ts`, `daemon-chats.ts` and `serve-lifecycle.ts`, and replaces the daemon approval map with `HeadlessInteractionHub`. Keep extracted logic in new files with small adapter edits so that branch merges cleanly.
- Pi's `extensionRunner.emit` catches handler errors, so a throwing `session_shutdown` handler cannot skip closers or usage in `perform`.
- A fresh worktree needs `build/native` for `tests/extensions.test.mjs`: copy `packages/cli/dist/app/native` after a CLI build.
- `DaemonTurnOwner` (`packages/cli/src/daemon-turn-lifecycle.ts`) is the only writer of chat custody. Lane A's #735 keeps the lease API, so this does not stack on it; its doc home is `docs/state-machines/`.
- Never await `cancelChat` from inside a tool_call or before_agent_start hook: `session.abort()` waits for the very hook that called it.
- `.memory/` is gitignored but tracked: new files need `git add -f`.
