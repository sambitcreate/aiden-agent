# Explicit state machines, Lane D: `aiden serve` owners

Started 2026-11-04. Scope: `cli-native` C09, C10, C03, C01, C02, C11, C04, then triage of the other C entries. Worksheets: `docs/state-machines/serve-daemon.md`.

- `feature/subagent-desktop-serve-upgrade` (uncommitted and local-only in `~/projects/aiden-agent`) rewrites `serve.ts`, `daemon-chats.ts` and `serve-lifecycle.ts`, and replaces the daemon approval map with `HeadlessInteractionHub`. Keep extracted logic in new files with small adapter edits so that branch merges cleanly.
- Pi's `extensionRunner.emit` catches handler errors, so a throwing `session_shutdown` handler cannot skip closers or usage in `perform`.
- A fresh worktree needs `build/native` for `tests/extensions.test.mjs`: copy `packages/cli/dist/app/native` after a CLI build.
- `DaemonTurnOwner` (`packages/cli/src/daemon-turn-lifecycle.ts`) is the only writer of chat custody. Lane A's #735 keeps the lease API, so this does not stack on it; its doc home is `docs/state-machines/`.
- Never await `cancelChat` from inside a tool_call or before_agent_start hook: `session.abort()` waits for the very hook that called it.
- `.memory/` is gitignored but tracked: new files need `git add -f`.
- C15 converted to one `phase`. Triage of the other `C*` entries is at the end of `docs/state-machines/serve-daemon.md`.
- C18 and C19 are blocked on the subagent upgrade branch, which rewrites those files. C05 waits on #733. C12, C16, C28 and C32 are P6.
- No file outside `packages/cli`, `docs/state-machines` and `.memory` changed, so no mobile contract moved.
- Cleanup hooks in `node:test` (`t.after`) run in registration order here, so stop a daemon before removing its directory. `box.stopServer` in `tests/serve-lifetime.test.mjs` does that; an earlier `t.after(serve stop)` orphaned real daemons.
- The local shell is zsh: an unquoted `$files` is one argument, so a looped `node --test $files` silently runs nothing. Check that a pass count came back.
- Control-socket chunks stop near 64 KiB, so a ceiling test needs a frame near the limit plus a later write, not one big write.
- `createDaemonApprovals` reports each raised prompt once from the settled outcome, so it does not rely on the coordinator's published flag, on `main` or after Lane B's #738.
