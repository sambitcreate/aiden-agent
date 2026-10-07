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
  - Tool parity (Task 1.5): `bot-tool-policy.ts` is the legacy Bot classification from `llm-client.ts` (skills/MCP exact joins, `inspect_image` only when the Bot model lacks images and a vision provider is granted, web/computer_use/subagents/schedules capabilities, file locations, shell, `share_image` needs the Bot folder). `bot-tool-facts.ts` runs the exact MCP/skill joins lazily per decision. `bot-tool-assembly.ts` filters candidates at offer time, re-checks at every call (`checkPolicy` gets the call's args/id/signal) and fences each execution behind a fresh admission. `bot-tool-sources-main.ts` builds candidates with the legacy factories (`buildAgentTools` for MCP/skills/web/Computer Use/subagent, Bot file router, shell, routine tool, `suggest_connection`). `bot-tool-candidates.ts` holds the per-call (`bind`) bindings for `share_image` (shared images become `aiden.bot-shared-image` entries) and `inspect_image` (reads images from `pi.user` entries; `replay: "safe"`).
  - Images (`bot-images.ts`): the person's images stay native in `pi.user`. For a model without image input, `beforeRequest` swaps them for `Attached image reference: image_img-<sha256 prefix>.` for that request only.
  - Approvals: `bot-approvals.ts` puts Bot prompts on a `ToolApprovalCoordinator` with `approvalId = waitId` (the coordinator now accepts a caller-supplied id). `bot-approvals-main.ts` broadcasts `bots:approval` / `bots:approval-settled`; answers arrive by `waitId` via `bots:approve`, `chat:approve` or the Remote approval routes (`llmClient.approve`/`approveAsHost` fall through to Bot approvals). An aborted wait (Dismiss, delete, quit) rejects instead of denying, so no declined result is recorded and Resume re-asks under the same `waitId`.
  - Approval-gated Bot tools: mutating MCP tools, `share_image`, and Computer Use (live summary from its controller; `onAllow` binds the grant to the call id).
  - Model errors: `resolveModel` returns `null` only when the Bot has no model authority; other failures throw and surface as state `{ kind: "model_error", message }` / `BotSessionError("model_error")`.
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
- Subagents on durable Bots are read-only children (no V2 persistence/projection, no write/shell/web/MCP/delegation lanes, thinking level off) owned by `bot:<botId>:<callId>` in the Bot's canonical chat and folder. Form Fill is not offered. Routines (`schedule_task` for Bots) need no approval and are withheld on Telegram turns and without the `schedules` capability.
- The renderer and Remote do not yet show Bot approval prompts (`bots:approval`) or `model_error`; wave-2 renderer and Task 5.2 own that.
- Desktop chat still sends Bot messages through `chat:start`; `bots:send` exists for the wave-2 renderer.
- Bot "delete" archives the Bot record (no hard delete in BotStore/capability store); photo and managed-home files are not erased.
- Legacy Bot transcripts in ChatStore are not purged (ChatStore has no clear-messages API).
