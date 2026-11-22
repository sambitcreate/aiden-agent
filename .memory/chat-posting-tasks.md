# Tasks made in a chat post into that chat — 2026-11-22

Proactive Aiden plan, Phase 1 unit C4 (docs/plans/proactive-aiden-plan.md). A scheduled task created by Aiden's `schedule_task` tool from a workspace chat keeps `originChatId` and every run lands in that chat.

Design decisions worth keeping:

- `originChatId` is main-owned. Only the schedule tool's create path sets it (`ScheduleToolAccess.standard.originChatId`, from `llm-client.ts` `scheduleOriginChatId`: not for Bot, Assistant-mode or owned chats). The IPC parser refuses the key, Remote's `exactKeys` refuses it, and `normalizeInput` always copies it from the existing task, so edits from the editor or a phone keep it. Bot routines never carry it.
- `post_in_chat` defaults to on when the task's workspace is the chat's workspace; `true` elsewhere is refused, `false` gives the task its own chat. It is refused on updates; moving out is **Use its own chat** (`schedule:use-own-chat`, revision-checked, `store.clearOriginChat`).
- The 15-minute floor (`assertChatTaskCadence`, gaps across the next 6 fires) is enforced in the tool and again in the store, so a later edit can't speed up a bound task.
- Bound tasks always have a project, and a project task can't have MCP servers (existing rule), so the run's policy is just the task's permission via `scheduledGenerationToolPolicy`.
- Core: `main/services/schedule-chat-delivery.ts` `createTaskRunChatDelivery(deps).deliverTaskRunToChat(task, {trigger, eventText?, signal})`. Outcomes: `ran`, `fell_back` (own chat), `skipped` with `chat_busy` / `chat_budget`. `eventText` is fenced as data under "What happened" for Phase 4 trigger runs; a `chat_budget` skip returns before anything runs, so a caller can keep its held batch.
- Budget: 6 task runs per chat per hour, in memory (`TaskRunBudget`), one budget card per hour; manual Run now is exempt. Separate from NoticeDelivery's 6 wakes an hour.
- Busy chat: `llmClient.waitForChatIdleWithin(chatId, 10 min)` (the plain `waitForChatIdle` only has a 5 s grace), then admission inside `noticeDelivery.inOrder(chatId, ...)`; a turn that grabs the chat at the last moment is waited out until the deadline. Still busy: record-only card plus a `chat_busy` run.
- Admission saves the prompt as a user message with `notice` (source `schedule`) and broadcasts `chats:follow-through-changed` with `transcript: true`, then generation runs in that chat. Script tasks hold no chat: their stdout lands as a record-only card (failure tone on error, nothing when silent).
- A missing chat clears the binding (`releaseOriginChat`) and falls back; a Bot, owned or other-workspace chat falls back without clearing. Deleting a chat calls `scheduleStore.releaseOriginChat(chatId)` from `chat-application-service` and broadcasts `schedule:updated`.
- Phones: the binding isn't projected; a skipped run still maps to `succeeded` with its summary text in the Remote run DTO (mapRun unchanged, no protocol revision).

UI: approval card **Posts in** row (`postsIn` on `ScheduledTaskApprovalDetails`, in the run-journal allowlist); editor **Posts in <chat>** field with **Use its own chat**; composer chip in `renderer/components/chat-task-chips.tsx` (kept out of follow-through-chips.tsx) linking to `/scheduled?task=<id>`; delete-chat dialogs name tasks that will move; a skipped run shows an info toast.

Onboarding (C5): the Scheduled Automations tile (`ScheduledAutomationsArt` in `onboarding-art/control-art.tsx`, `oa-schat-*` rules in `control-art.css`) now draws a workspace chat with the "Scheduled task" card, its answer, and the "Checking back at 3:10 PM" and task chips above the composer. The old `oa-sched-*` rules stay: Bot watches, routine models and Bot messaging art reuse them. Covered in `onboarding-feature-gallery.test.tsx`.

Tests: `schedule-chat-delivery.test.ts`, `schedule-tool.test.ts`, `schedule-store.test.ts`, `scheduled-tasks-parse.test.ts`, `scheduled-task-application-service.test.ts`, `schedule-execution-tool-policy.test.ts` (bound run), `aiden-remote-schedules.test.ts` (PATCH keeps the binding), `renderer/components/chat-task-chips.test.ts`, `scheduled-task-editor.test.tsx` (approval row). Lanes: `test:scheduled`, `test:assistant-automations`.

Open: native phone cards for `schedule` notices, phone display of skipped runs, screenshots.
