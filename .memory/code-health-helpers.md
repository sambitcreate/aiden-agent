# Code health: shared main-process security helpers (MAIN-39, MAIN-40)

Branch `refactor/code-health-helpers` (2026-10). Audit findings MAIN-39 (dead code) and MAIN-40 (duplicated helpers).

## Shared helpers in `main/shared/` and `renderer/shared/`
- `main/shared/guards.ts`: `isRecord`, `recordOf`, `isPlainRecord` (`Object.prototype` or `null` prototype), `hasOwn`, `ownEntry`, `setOwnEntry` (`Object.defineProperty` with `NoInfer<T>`), `hasExactKeys(record, required, optional)`, `requireAllowedKeys` (lazy `for..in` with single or split record/fields errors), `requirePlainShape`, loop-based scalar-counting `boundedString`, UTF-16/UTF-8 `parseUtf8BoundedString`, `isTimestamp` (safe integer), `isFiniteTimestamp`, and `timestampOf`. Pure and runtime-agnostic (safe for Electron main, Vite renderer, and CLI bundle).
- `main/shared/async-timeout.ts`: `settleWithin(promise, ms)` (swallows rejections, clears timer, `unref?.()`).
- `renderer/shared/base64.ts`: loop-based `decodedBase64Bytes(value, maxChars?)` and `base64Value`.
- `path-containment.ts`: `isPathInside(root, candidate, { allowRoot, pathApi })`, `assertPathInside`, async `resolveRealPathInside` (realpaths both sides, so symlink escapes are caught). Uses `path.relative`; rejects `..`, `../x` and absolute (cross-drive) results but accepts in-root names like `..cache`. Use `allowRoot: false` where the root itself must not be a target.
- `redaction.ts`: `CREDENTIAL_TOKEN_PATTERNS` (one table), `redactCredentialTokens(text, placeholder)`, `redactUrlCredentials(text)` (userinfo and token-like query params). Callers keep their own placeholder and any local path or keyword rules.
- `bounded-body.ts`: `readBoundedBody(response, { maxBytes, signal?, errors })`. Rejects a declared oversize and cancels; counts streamed bytes; rejects non-byte chunks; cancels on any error; releases the lock; optional abort race. Callers keep their own error types and messages; omit `errors.missingBody` to read a missing body as empty.
- `process-group.ts` (2026-10, branch `claude/audit-fix-shell-git`): `processGroupExists`, `signalProcessGroup`, `createProcessGroupTerminator(child, { killGraceMs })` (SIGTERM to the group, SIGKILL after the grace period to anything left; `finished()` waits for the group, not just the leader), `waitForChildExit(child, { drainMs, onPipesHeld })` (settles `drainMs` after exit when a descendant still holds stdout) and `decodeCappedUtf8`. Used by `bounded-shell-command.ts` (run_command), `schedule-script.ts`, `git.ts`, `git-clone-runner.ts` and `github-pull-request.ts`.
- Tests: `test:main-shared` script and the `core-git` CI lane.

## Web search
`main/services/web-search-adapter-kit.ts` holds `normalizeWebSearchSourceUrl` (rejects any `\p{Cc}` before URL parsing, since WHATWG parsing silently strips tab/CR/LF) and re-exports `isRecord`. All provider adapters import it.

## Peer host
`peer-host-service-main.ts` stores credentials through `secureStorage` (Linux backend allowlist, fails closed), not raw `safeStorage`.

## Not migrated yet (follow-ups)
- `git.ts` path-containment sites and `managed-worktree-admission.ts` / `browser/files.ts` (they return relative paths with custom errors).
- `advisor-context.ts` `redactAdvisorText`: vendored into the CLI with a drift test; the CLI bundle branch removes the vendor copy.
- `web-search-response.ts` and `models-dev-cache-core.ts` bounded readers (provider-specific errors and abort semantics).
- Exact `isRecord` copies across `main/services`, `renderer/shared`, and Aiden Remote were migrated in `simplify/03-shared-guards` (leaving non-exact prototype-checking, array-permitting, and typed variants local).

## Dead code (MAIN-39)
Removed unused exports with `npx knip` (not a dependency), checking imports, build scripts, IPC, preload, the CLI and `scripts/`. Kept on purpose: `parseAidenRemotePendingQuestionResponse` (protocol), `subagentBackgroundEnabled` (rollback flag), pi-vcc vendor, durable-jobs, and files owned by in-flight branches. The unread `FORM_FILL_CONTEXT_BYTES`/`FORM_FILL_OPTION_BYTES` mirrors were later deleted in the 2026-11 dead-code sweep; the 224/96-byte bounds live only in `native/cua-s1-forms` `Encoding.swift`.
Orphan tests: `background-subagent-coordinator-v2.test.ts` registered; `scripts/subagent-inference-worker-smoke.test.mjs` given the standalone `test:subagent-worker-smoke` script (needs a build and Electron).
