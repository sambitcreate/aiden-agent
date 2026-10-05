# Code health: shared main-process security helpers (MAIN-39, MAIN-40)

Branch `refactor/code-health-helpers` (2026-10). Audit findings MAIN-39 (dead code) and MAIN-40 (duplicated helpers).

## Shared helpers in `main/shared/`
- `guards.ts`: `isRecord`, `hasExactKeys(record, required, optional)` (own keys only, no unknown keys).
- `path-containment.ts`: `isPathInside(root, candidate, { allowRoot, pathApi })`, `assertPathInside`, async `resolveRealPathInside` (realpaths both sides, so symlink escapes are caught). Uses `path.relative`; rejects `..`, `../x` and absolute (cross-drive) results but accepts in-root names like `..cache`. Use `allowRoot: false` where the root itself must not be a target.
- `redaction.ts`: `CREDENTIAL_TOKEN_PATTERNS` (one table), `redactCredentialTokens(text, placeholder)`, `redactUrlCredentials(text)` (userinfo and token-like query params). Callers keep their own placeholder and any local path or keyword rules.
- `bounded-body.ts`: `readBoundedBody(response, { maxBytes, signal?, errors })`. Rejects a declared oversize and cancels; counts streamed bytes; rejects non-byte chunks; cancels on any error; releases the lock; optional abort race. Callers keep their own error types and messages; omit `errors.missingBody` to read a missing body as empty.
- Tests: `test:main-shared` script and the `core-git` CI lane.

## Web search
`main/services/web-search-adapter-kit.ts` holds `normalizeWebSearchSourceUrl` (rejects any `\p{Cc}` before URL parsing, since WHATWG parsing silently strips tab/CR/LF) and re-exports `isRecord`. All provider adapters import it.

## Peer host
`peer-host-service-main.ts` stores credentials through `secureStorage` (Linux backend allowlist, fails closed), not raw `safeStorage`.

## Not migrated yet (follow-ups)
- `git.ts` path-containment sites and `managed-worktree-admission.ts` / `browser/files.ts` (they return relative paths with custom errors).
- `advisor-context.ts` `redactAdvisorText`: vendored into the CLI with a drift test; the CLI bundle branch removes the vendor copy.
- `web-search-response.ts` and `models-dev-cache-core.ts` bounded readers (provider-specific errors and abort semantics).
- The remaining local `isRecord` copies outside web search.

## Dead code (MAIN-39)
Removed unused exports with `npx knip` (not a dependency), checking imports, build scripts, IPC, preload, the CLI and `scripts/`. Kept on purpose: `parseAidenRemotePendingQuestionResponse` (protocol), `FORM_FILL_CONTEXT_BYTES`/`FORM_FILL_OPTION_BYTES` (Swift contract), `subagentBackgroundEnabled` (rollback flag), pi-vcc vendor, durable-jobs, and files owned by in-flight branches.
Orphan tests: `background-subagent-coordinator-v2.test.ts` registered; `scripts/subagent-inference-worker-smoke.test.mjs` given the standalone `test:subagent-worker-smoke` script (needs a build and Electron).
