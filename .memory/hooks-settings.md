# Settings → Hooks page — 2026-10-31

Plan: `docs/plans/aiden-hooks-plan.md` §10 (Phase 2). Branch `feature/aiden-hooks`. Layout rules: Hooks section of `docs/settings-design-system.md`.

## Files
- `renderer/shared/hooks-settings.ts`: the view contract and pure helpers.
  - Types: `HooksOverview` (available, paused, disabledByEnvironment, hooks, workspaceFiles, proposals, workspaces) and `HookSaveRequest`.
  - `HOOKS_CHANGED_CHANNEL`.
  - Helpers: `hookStatusPresentation`, `groupHooksByScope`, `hookScopeLabel`, `parseHookTimeoutField`, `isHooksOverview`.
- `main/handlers/hooks.ts`: `registerHookHandlers({handle, service, workspaces, broadcast, env?})`.
  - Every argument is validated. Ids, names and matchers are single-line, with no control characters. A command is at most 4096 characters with no NUL. A digest is 64 hex characters.
  - A workspace scope must be one of the absolute roots `workspaces()` returns.
  - `failClosed` is allowed only for PreToolUse. Timeout is an integer from 1 to 120.
  - A bad argument throws "Invalid hooks request".
  - Before `getHookService()` exists, the list returns `available: false` and every write throws "still starting".
  - `hooks:list` passes every workspace scope explicitly, because the service reads a repo file only for scopes it is given.
  - Wired in `main/handlers/index.ts`. `broadcast` sends `hooks:changed` to every window.
- `renderer/lib/ipc.ts` `hooksApi`; `hooks:` prefix and `hooks:changed` in `renderer/preload-channels.ts`.
- `renderer/components/settings/hooks-settings.tsx`:
  - `HooksSettings` is the react-query container. It owns optimistic pause and switch overrides, rolled back on failure, and refreshes on `hooks:changed`.
  - `HooksSettingsView` takes props.
  - `hookProposalDiff` is exported for the update diff.
- Settings section `hooks` (Agent group, after MCP, lucide `Webhook` icon) in `renderer/shared/settings-section.ts` and `renderer/main/settings-view.tsx`.

## Decisions
- Approve of a repo hook sends `approveDigest(id, digest)` with the digest the person saw, so a file changed in between is refused.
- Test runs only from the Test button. An unapproved hook gets a "Run once" confirmation first, because the service's `testHook` runs unapproved hooks.
- Delete on a repo (`workspace-file`) hook reads "Remove approval": the file stays and the hook goes back to waiting.
- The run log comes oldest-first from the dispatcher. The sheet shows the last 10, newest first.
- The command textarea uses the shared `code-font-sized` class. The global unlayered `textarea { font: inherit }` beats Tailwind's `font-mono`.

## Tests
- `main/handlers/hooks.test.ts`: register-and-invoke against a real `createHookService` in a tmpdir, with a fake `run`.
- `renderer/components/settings/hooks-settings.test.tsx`: render and interaction tests.
- Both are in `test:hooks` and `scripts/ci-test-registry.json`.

## Screenshots
- `npm run test:e2e:space` does not exist on this branch.
- Owner screenshots came from a scratchpad Vite harness that renders the real component with the real CSS, captured with headless Playwright Chromium. Nothing from the harness is committed.
