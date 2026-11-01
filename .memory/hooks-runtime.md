# Hooks runtime: trust and dispatch decisions (2026-10-31)

Plan: `docs/plans/aiden-hooks-plan.md`. Guide: `docs/hooks.md`. Settings page: [hooks-settings](hooks-settings.md).

## Contract
The contract lives in `main/services/hooks/hook-types.ts`. Every surface goes through `getHookDispatcher()` (`main/services/hooks/index.ts`).

**Surface adapters**
- `agent-surface-hooks.ts`: `createSurfaceHooks`, `botSurfaceHooks` and `chatSurfaceHooks`.
- `workspace-chat-hooks.ts`: workspace chats on the desktop and in `aiden serve`.
- `bot-runtime/bot-extension.ts`: pi-durable hooks. Answers are memoised so a replay never re-runs a hook.

**Scope rules**
- `HOOK_EVENT_SCOPE_KINDS` is the single table of which scope kinds each event is dispatched with.
- Propose, save and repo-file parsing all refuse pairs that are not in it.

## Decisions
**Digest and approval**
- The digest covers event, matcher, command, timeout, `failClosed`, `envAllow` and scope. It includes `async` only when it is true, so existing approvals stay valid.
- Workspace hooks also fold in the script files they run (`hook-script-files.ts`). Limits are 16 files, 128 words and 256 MiB per file, hashed as a stream.
- `scriptCoverage: "partial"` flags commands Aiden can't follow, such as `cd … &&`, `npx`, `npm run` and `make`.
- Scripts are re-checked just before each run (`recheckScriptsBeforeRun`). If they changed, the run is skipped; for PreToolUse that is a deny.

**Failure handling**
- `failClosed` hooks are never auto-disabled, because their failures are what make them block.
- If the hooks can't be loaded, PreToolUse fails closed and other events carry on with a notice. Neither outcome is cached.

**`async: true`**
- Timeout ≤ 600 s; it can't be combined with `failClosed`.
- Up to 4 run at once and 32 wait.
- Stopped by pause, `AIDEN_HOOKS=0`, quit and `stopCliHooks`, but not when the turn ends.
- Its lines go to `HookDispatchContext.reportAsync`. Surfaces pass the same reporter they use for ordinary hook messages (`SurfaceHookOptions.report`, the workspace-chat `report`).
- WorktreeSetup has no reporter, so its lines only reach the log.

**Approval card and blocked prompts**
- The approval card (`renderer/shared/hook-proposal-approval.ts`) has an exact key set, `async` included. The timeout cap is 120 s, or 600 s for async, so an update to an owner's long async hook still validates.
- Prompts blocked by UserPromptSubmit carry `hookBlocked`, written only through `chatStore.setPromptHookBlock`.
  - Spread it with `hookBlockedField()`. An own `hookBlocked: undefined` key broke `chat-store-core` deep-equal tests.

**Bounded shell (hooks, `run_command`, artifact runner)**
- After the shell exits, any background child that still holds the pipes is killed.
- One that redirected its output keeps running.
- `run_command` appends `BACKGROUND_STOPPED_NOTE`.
