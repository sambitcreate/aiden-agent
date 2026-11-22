# Bot turn latency ("Getting ready" 10 s+) — 2026-11-22

Branch `feature/bot-message-latency-ef3d2d`. Plan record: `docs/plans/instant-ui-optimistic-updates-plan.md`, follow-up dated 2026-11-22.

## Root cause
- Since the Bot execution layer (2026-11-03), every phase invoke of a `pi.generation` task runs through `createBotExecutionRegistry` (`main/services/bot-runtime/bot-execution.ts`). That covers binding lookup, commits, `port.resolve` (`botRuntimeAuthority.admit` → `resolver.admitOnce`), `execution.revalidate()`, then `prepareRegistry` (`registry.fork(); refresh()`). `refresh()` runs `loadBot`, `currentTools` (`tools.admit`) and `systemSections` (another admission).
- Every admission or revalidation called `catalog.snapshotForRuntime`, which is a full inventory read: `listProviders` (credential signature and checkAuth for every provider), Mac files, shell, MCP connections, skills and other capabilities.
- Measured on a clean profile with a temporary probe: 17 snapshots between Send and the provider request, about 1 s. The owner's prod COS `session.sqlite` showed a 9–19 s gap between generation start and model request on every turn after 2026-11-03, against about 10 ms before. The cost scales with the number of providers, connectors and skills.

## Fix
- `BotCapabilityCatalogMainService` takes `hooks.runtimeReuse: { revision(), ttlMs, now? }`. Production (`bot-capability-services-main.ts`) passes `botRuntimeInventoryLeases.revision()` and `BOT_RUNTIME_SNAPSHOT_REUSE_MS = 3_000`.
- Entries are keyed by botId, retainedBindings and retainedProviders. They are single-flight, `structuredClone`d per caller, never cached on failure, and capped at 32 entries (LRU). The caller's abort only detaches that caller (`abortable`).
- Hooked changes (`invalidateBotRuntimeInventoryAuthority`) move the revision, so they are read at once. Unhooked drift is read within 3 s.
- `aiden serve` gets the same reuse in `packages/cli/src/bots.ts` (its watcher on auth/models/MCP/web-search files and approved roots moves `inventoryLeases`).
- Tests: three cases at the end of `main/services/bot-capability-bindings.test.ts` (`countingPorts`).

## Phones
- iOS and Android no longer show a "Sending…" caption on a sending Bot message. `.sending` and `.sent` draw identically, and the status line carries the wait.
- Removed from iOS: `AidenBotSendWait` and `sendingCaptionDelay`/`showsSendingCaption`.
- Removed from Android: `AIDEN_BOT_SENDING_CAPTION_DELAY_MS`, `rememberAidenBotSendWaitMs`, `AidenBotPendingCaption.SENDING` and `bot_session_sending`.
- The status line ("Getting ready", then "Thinking" once the model starts) was deliberately kept.

## Open follow-ups (measured, not done)
- The request phase runs `prepareRegistry` again for each step, which is a second full registry refresh per model call.
- `bot-capabilities.json` grows without bound because claims are never pruned. About 50 leftover `.previous` rollback files sit in `bot-service`.
- Each capability commit spawns `/usr/bin/security` several times for the Keychain rollback anchor.
- The send POST itself took 2–5 s in prod logs. Prod has not been re-measured since the fix.
