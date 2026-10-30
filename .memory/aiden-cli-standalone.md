# Aiden CLI standalone (PR #121, target 0.50.0)

**2026-10-30: serve-only.** The interactive CLI (Pi's TUI, `aiden -p`, `--mode json|rpc`, `--list-models`, slash commands, themes, `aiden theme`/`aiden reset`, the feature tour) was retired. `packages/cli` is now a headless server: `aiden serve` (Remote on by default, `--no-remote`; startup pairing QR in a foreground TTY, `--pair tailscale`, `--no-pair`) plus admin subcommands. Daemon chats still use Pi's SDK (`createAgentSession`), so `@earendil-works/pi-coding-agent` and the system-prompt branding patch stay. See `docs/plans/aiden-serve-only-cli.md`; notes below that mention the TUI, themes or the playground are history.

## Lease ownership (issues #405 and #392, 2026-10-15)

CLI `acquireLease` holds an OS `flock` on a permanent `<resource>.lease.lock` file until release. A short native helper locks a duplicate of the parent's descriptor, then exits; the parent keeps the lock through async work, and process death releases it. A raw read of the guard cannot cancel the lock. The former `<resource>.lock/owner.json` is diagnostic metadata, published and removed only under the guard; malformed values including JSON `null` are stale. Serve recovery, including foreground startup, and stop cleanup acquire that same guard, recheck the owner, and remove stale metadata and socket only while holding it. New metadata carries `protocol: "flock-v1"`, so a recycled live PID cannot wedge recovery after the guard is free; legacy live metadata remains protected unless its PID is verifiably foreign. The daemon child removes a stale socket after it acquires the serve lease. Never unlink, rename, or copy over guard files. Stop older CLI processes and daemons before upgrading a shared agent directory; mixed-version writers do not share this protocol.

- `packages/cli` is its own npm package. The shared lease helper is copied into
  `dist/app/native/` for CLI bundles and `Helpers/` by desktop electron-builder.
- Several desktop services are split into portable `*-core.ts` modules
  (schedule-store, subagent-supervisor, vision-analysis-tool, local-speech-downloads,
  aiden-remote-speech, subagent-mcp-mutation-host). When main changes one of
  the thin desktop wrappers, port the behavior into the core too. The 2026-09-26
  merge ported: schedule `isCurrent` fencing, subagent `compactionEngine` and
  `maxTurns` / V2 tree turn allowance, and the vision per-request id.
- The advisor imports `main/services/advisor-runtime.ts` and
  `advisor-attempt-store.ts` directly (lazy-loaded chunk). The former
  `src/vendor/advisor/*` copies and their drift test were removed in
  `perf/cli-bundle-startup` (see `.memory/cli-bundle-startup.md`).
- The CLI build uses `prebuilt/native/*` helpers only when the manifest source
  hashes match. After changing native sources (including
  `native/subagent-shell-runner/setsid-fixture.c`), rebuild them with:
  - `node scripts/build-native-helpers.mjs` (darwin)
  - `node scripts/build-native-helpers.mjs --docker linux/amd64 linux/arm64`
- CI:
  - The `cli-linux` job is required (desktop area) in `scripts/ci-required.mjs`.
    The `cli-playground` job was removed with `packages/cli-playground` on
    2026-10-30.
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
- `packages/cli-playground` (the CLI appearance studio) was removed on 2026-10-30 along with its CI job, `cli:playground*`/`test:cli-playground` scripts and ESLint ignores.
- AGENTS.md now names `aiden catalog models-dev fetch` as an approved models.dev caller (coordinator decision 2026-09-26). It is the CLI counterpart of the Settings action, with the same endpoint and constraints and a display-only cache.
- The native shell runner passes `-f` only to zsh (macOS). On Linux `/bin/sh -f` is noglob; a glob regression test in subagent-shell-runner-io.test.ts covers this.
- Merging #71 (Linux desktop) took main's native C ports and `native-c-build-core.mjs` build scripts. The PR's OpenSSL/renameat2 shims were dropped because `native/shared/aiden-platform.h` carries its own SHA-256. `nativeHelperSourceHash` now also hashes `native/shared/*.h`, so a shared-header edit marks prebuilts stale. The PR's speech core carries main's "desktop" wording.
- Merging #246 (root pi 0.87.1) bumped the CLI to `@earendil-works/pi-coding-agent` 0.87.1 and added a direct `@earendil-works/chord` 0.87.1 dependency. btw wraps its context in `normalizeContext`, and the child beforeTool context drops `systemPrompt`. The re-vendored advisor uses `normalizeContext`. The build's external check falls back to ESM resolution for chord's import-only subpaths and allowlists the optional `kerberos`. Session import accepts both `v: 4` (storage v1) and `version: 4` (0.84.4) journal headers.
- Since #471 (Pi 1.2.0), the CLI pins pi-coding-agent, pi-ai, pi-agent-core, pi-codemode and pi-mcp at exactly 1.2.0 and no longer depends on chord directly.
- Merging #251 (main's Remote contract revision 14) renumbered this PR's `GET /scheduled-tasks/notifications` addition to contract revision 15. The shared fixture and the Android copy are byte-identical at 15. The TS, iOS and Android fixture assertions expect 15, and the iOS fixture CodingKeys keep both main's streamInput/question/chatSkills and this PR's scheduleRunNotification.

- 2026-09-27 review: plan index now describes Phase 6 as implemented; physical iPhone acceptance remains pending.

- 2026-10-19 H3 adds an explicit durable Bot host switch; see `docs/cli-durable-bots.md` for ownership, preserving migration, supported endpoints, and remaining boundaries.
- MCP (2026-10-21, Phase 3 of `docs/plans/mcp-pi-migration-plan.md`): the CLI's MCP client and OAuth are the desktop's `main/services` modules on `@earendil-works/pi-mcp`; the CLI build rejects any bundled `@modelcontextprotocol/sdk` client. Pi's built-in MCP extension is replaced by Aiden's `/mcp` command and `aiden pi-mcp` is gone; `aiden-mcp.json` is the only MCP config. Details in `.memory/mcp-pi-migration.md`.
