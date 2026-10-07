# Bot durable runtime (Bots rework, Tasks 1.1–1.3) — 2026-10-07

Plan: `docs/superpowers/plans/2026-10-07-bots-rework.md`. Spec: `docs/superpowers/specs/2026-10-07-bots-rework-design.md` §6.

## Layout
- `main/services/bot-runtime/`
  - `profile-lock.ts`: `<profile>/bots/runtime.lock` (`{pid, startedAt, token}`), published with `writeFileAtomic({exclusive})`. Live pid (or this process's own token) refuses; a dead pid or torn file is reclaimed by moving it aside first.
  - `harness-host.ts`: one Pi Durable harness per Bot at `<profile>/bots/<dir>/session.sqlite`. `<dir>` is `botDirectoryName(botId)`: characters outside `[A-Za-z0-9_-]` become `~xx` UTF-8 bytes (`bot:1` → `bot~3a1`), because Bot ids contain `:`. Lazy open, 10-minute idle close (only with no live task or submission), corrupt DB (SQLite errcode 26/11) moved to `session.sqlite.corrupt-<ts>` and a fresh root opened, `destroy` = abort (bounded 10 s) → close → `rm -rf`, deleted ids refuse reopen.
  - `tool-adapter.ts`: pi-agent-core `AgentTool` → Pi Durable tool (TypeBox args validated by the harness, chord signal → `AbortSignal`, `onUpdate` snapshots → appended `api.output`, details → `api.details`).
  - `bot-extension.ts`: `aiden-bot` extension. Sections `aiden-base`, `aiden-persona`, `aiden-authority` (untagged, in that order). `refresh({requestId})` reloads Bot/sections/tools and reinstalls the extension; call it before every submit/resume. `beforeTool` checks policy; approvals persist `{waitId, toolCallId, summary}` in the tool task memo `aiden.approval`.
  - `bot-session-service.ts`: send/resume/dismiss/state/deleteBot/awaitReply/markSilent. Transcript notices are `aiden.bot-notice` entries (`interrupted`, `session_reset`, `routine`, `silent`).
  - `bot-session-main.ts`: production wiring (started from `initializeBotApplicationService`).
  - `bot-models.ts`: one `Models` proxy backed by each Bot's resolved runtime.
- `main/services/telegram/bot-reply-outbox.ts`: Bot ingress (`tg:<bot>:<chat>:<thread>:<message>`) and persisted reply outbox (`awaiting → pending → sending → sent`, plus `interrupted`/`failed`).

## Observed Pi Durable 1.0.3 behaviour (verified by tests)
- **Dismiss after restart:** `conversation.abort(ctx)` on a reopened harness whose turn was SIGKILLed mid-stream makes **zero provider requests**. The abort mark is committed before any phase runs, so the generation's abort handler runs instead of its `request` phase. The streamed partial `pi.assistant` entry stays in the transcript; the submission settles `unanswered` with reason `aborted`. No pre-armed-abort workaround is needed.
- `submission.abort()` (and `harness.abortSubmission`) only withdraws **queued** submissions; for a placed (running/interrupted) input it returns `already_placed` and does nothing. Dismiss therefore uses `conversation.abort()`.
- Opening, `root()`, `inspect()` and `viewState()` never start the scheduler (`scheduling: "paused"`). `submit`, `wait`, `waitForIdle`, `abort` and `compact` do. `awaitReply` checks for a paused turn first so waiting never resumes it.
- Resume (`harness.resume()`) keeps the aborted partial and makes one fresh request; a second `resume()` is a no-op.
- A `requestId` dedupes across restarts and after the submission settled (`tx.submissionByRequest`).
- **Hook errors are swallowed:** an exception from `beforeRequest`/`beforeTool` is reported via `onReport` and ignored (for `beforeTool` it becomes a block). To fail closed on readmission, the extension calls `harness.abortTask(taskId)` and waits for its own signal; the run ends `unanswered`, no provider call.
- Tool replay: an interrupted `unsafe` tool becomes an `interrupted` error result; a `safe` one reruns once. Approval waits happen in `beforeTool` (before intent), so a restart re-runs the hook and the memo returns the same `waitId`.

## Not ported yet (open)
- Durable Bot tools cover Bot file tools, `run_command`, routines and `suggest_connection` only. MCP connections, skills, web search, subagents, computer use, companion vision, share-image and approval prompts still exist only on the legacy `llm-client` path. `requestApproval` denies.
- Desktop chat still sends Bot messages through `chat:start`; `bots:send` exists for the wave-2 renderer.

## Hard delete and Bot data (Task 1.6)
- Archive/restore are gone from main. `BotSessionService.deleteBot`: abort + `host.destroy` (refuses when another process holds the profile) → routines, dismissals, Telegram binding, favorites → `BotApplicationService.deleteBot`, which runs a `delete_bot` lifecycle-journal operation: photo (`BotAvatarStore.deleteBot`, all owners and receipts) → managed home (`deleteHome`: move the home into `<bot-service>/removed`, drop receipt, drop binding, purge) → access (`BotCapabilityStore.deleteBotAuthority`: policy + chat reductions) → chat rows (via chat-application remove) → `BotStore.delete` (record + companion appearance) last. Every step is idempotent; a crash leaves the Bot listed and the pending operation rolls the delete forward on the next start.
- Records with a legacy `archivedAt` are deleted Bots: hidden by `BotStore.list/get`, reported by `legacyArchivedIds()`, and erased by `BotApplicationService.initialize` before its audits. Pending legacy `archive_bot`/`restore_bot` journal entries also erase the Bot and are closed; the journal still parses those kinds but refuses to begin them.
- One-time startup wipe of legacy Bot transcripts (`legacyTranscriptWipe`, marker `bot-legacy-transcripts-wiped.json` in userData): each Bot keeps only its canonical chat row with no messages (`ChatStore.clearMessages`) and its Pi compaction journal removed; historical Bot chats are deleted (a Telegram-backed one is emptied instead).
- Quit: `main/index.ts` stops the scheduler and Telegram, then `shutdownBotSessionRuntime()` (5 s budget) so running turns are left interrupted and the profile lock is released.
- Still dead but present (owned by the Remote contract task 5.2 / desktop UI): `BotDefinition.archivedAt` in `renderer/shared/bots.ts`, Remote `POST /bots/{id}/archive|restore` (now refuse with `invalid_request`), the `includeArchived` query, `bot-archived-file-read-authority.ts` and `inspectArchivedReadAuthority`, the capability `authorityStatus` field (always `active` for new policies), and `archivedAt` guards in Telegram validation, routines, runtime authority, the legacy system prompt and the inbox projection.
