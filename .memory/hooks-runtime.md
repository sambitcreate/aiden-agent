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

**Landing review, 2026-11-06 (PR #687)**
- Hook changes run through one `serialized` queue in `hook-service.ts`, so a stale proposal can't overwrite or revive a hook. `approveProposal` and delete recheck the target after every await.
- A dispatcher failure denies PreToolUse, the same as a load failure (`hookDispatchFailure`). `botHooksWithoutFolder` covers a Bot whose folder can't be read.
- A Bot's hook ask is its own card, raised inside the tool, so Full access can't answer it.
- `hookBlockedField` also reads the in-process record (`holdHookBlockedPrompt`), so a fork of a chat whose mark write failed stays blocked. A blocked prompt sent where no hooks run stays refused. The record is lost if the write failed twice and the process then restarts.
- `background_job` and `computer_shell` read as `Bash` to matchers. Tools that run code (`hookMayRewriteInput`) never take `updatedInput`.
- A rewritten input goes through the hooks again; only the second answer counts, and a second change blocks the tool.
- Idempotency keys are `toolCallIdempotencyKey(prefix, id, args)`, so retried args run hooks again. Bot PreToolUse memos still outlive a rule change after a crash.
- A `failClosed` hook that output unreadable JSON denies. Plain stdout stays allowed.
- `unmetGuards` in `hook-service.ts`: a `failClosed` hook that was approved and has since changed or gone keeps blocking matching tools (status `missing`) until it is approved again or removed.
- Hook and trust files of the wrong shape throw, so they read as load failures rather than empty lists.
- Known and documented: `run_command` can write the `<userData>/hooks/` store on the desktop; subagents' tools skip Pre/PostToolUse; the shell reopens a script after the recheck; transitive imports aren't pinned.

Pullfrog on 7e2b03ae0 (2026-11-06): after a hook, Bots recheck a routine's go-ahead and any new hand-off, because only plan permits and allow-list entries recheck themselves (the probe skips both). The trust store now fails the load on any unreadable approval rather than dropping it. A changed repo guard keeps a separate Missing row; a saved one clears with Delete. After a rewrite, only the checked dispatch can stop the turn or add context.
