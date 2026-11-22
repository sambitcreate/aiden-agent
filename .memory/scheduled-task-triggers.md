# Chat tasks that run when something happens — 2026-11-22

Proactive Aiden plan, Phase 4 (docs/plans/proactive-aiden-plan.md). Guide: docs/scheduled-task-triggers.md.

## E2 watch triggers (desktop)

- `ScheduledTask.trigger?: ScheduledTaskTrigger` (`renderer/shared/scheduled-task-trigger.ts`, strict `parseScheduledTaskTrigger`). E2 has `{kind:"watch", source:{type:"url"|"script"}, everyMinutes 5–1440}`. `ScheduledTaskInput.trigger`: undefined keeps the saved one, null removes it. A trigger task has `cron: ""`, no `nextRunAt`, no Cron job (`schedule-service-core` `schedule()` returns early) and skips the chat cadence floor. Only llm tasks of the person's own (no Bot); a script watch needs Full. An unreadable stored trigger is dropped and the task gets "Needs attention".
- Each trigger task is one routine on the E1 event core keyed by task id: `scheduled-task-triggers-store.ts` (bookkeeping in `<userData>/scheduled-task-triggers.json`, reconciled lazily against the schedule store on every list/mutate) and `scheduled-task-triggers.ts` (dispatcher + watches + runner). The routine's `updatedAt` is a trigger revision moved only when trigger/prompt/enabled change (fingerprint), never by `recordRun`/`updateRuntime`, so a recorded run doesn't retire a change a watch saw. Source change = fresh baseline; prompt change drops queued work.
- Event core extensions (backwards compatible for Bots): dispatcher `limits(routine)`, `payloadChars`, `mergeHeld` (for E3 batching); watch `reportsOutput(routine)` (script output is the news, no baseline/diff). `runScheduledScript` takes `env`.
- Runs: `scheduleService.runEvent(id, {kind:"event",source:"watch",...}, "event:<taskId>:<eventId>")` (same gates as an automatic run; waits out a running task); `schedule-execution` passes `trigger.payload` as `eventText` to `deliverTaskRunToChat`, which fences it in the origin chat and (new) in the own-chat fallback (`runInOwnChat(..., eventText)` appends it after the prompt). Replay: a recorded run (not blocked) with that id counts as settled. 4 runs at once overall via a slot queue. Skipped runs (chat busy/budget) are not re-queued.
- Three failed checks: the store's mutate sees enabled flip and calls `pauseTask` (updateRuntime enabled:false + lastError), keeping the revision; the watch's `paused` posts one record-only card through `scheduleExecution.recordInLandingChat` (new `chatDelivery.recordInLandingChat`).
- Wiring: `scheduled-task-triggers-main.ts`; started after `scheduleService.start()` in `main/index.ts`, stopped at cleanup, re-armed from the schedule service's broadcast. Never holds keep-awake.
- Phones: `AidenRemoteScheduleService` hides trigger tasks (list/notifications skip, get/update/remove/pause/resume/run/runs say not found) until E6.
- UI: editor **When** select (On a schedule / When something changes) + `WatchTriggerFields` (Check, Address/Script, Check every); list, detail, settings row and search show `formatTaskWhen` / `formatScheduledTaskTriggerLabel`.
- Tests: `scheduled-task-triggers.test.ts` (new, test:scheduled), `schedule-store.test.ts`, `aiden-remote-schedules.test.ts`, `schedule-chat-delivery.test.ts`, `scheduled-tasks-parse.test.ts`, `scheduled-task-view.test.ts`, `scheduled-task-editor.test.tsx`.

## E3 link triggers

- `ScheduledTaskLinkTrigger {kind:"webhook", gapMinutes 1–60, signatureHeader?, filters? (≤5 path=equals), dedupePath?, includeFields? (≤10)}`; dot paths, `__proto__` etc. refused.
- Router `/hooks/tasks/:token` (route label `taskTriggerWebhook`) calls `taskTriggerWebhook.admit` (404/429/415, before reading the body), reads ≤256 KB (413), passes the task's signature header value to `deliver` (401 HMAC, 400 bad JSON, filters → 202 "filtered", dedupe, emit → 202). Core in `scheduled-task-link-trigger.ts`; wired from `aiden-remote-service-main.ts` to `scheduled-task-triggers-main.ts`. The CLI host doesn't wire it (404).
- Batching: dispatcher `mergeHeld(held, incoming, routine)` (now gets the routine); link batches are a NUL-marked JSON payload (`mergeLinkBatch`, ≤24,000 chars, 20 calls), spelled out by `linkEventText` at run time with "N more calls were dropped". NULs are stripped from call text so a caller can't forge a batch.
- Token by hash in the bookkeeping (`setTokenHash`, `findByToken`), log of 50 (`appendLog`, `linkState`), secret `aiden-internal:task-hook:<taskId>` (deleted when the task is removed, via the schedule service broadcast payload). IPC `schedule:trigger-link:rotate` (needs Aiden On The Go on; returns url+secret once) and `schedule:trigger-link:state` (never the link).
- UI: editor **When its link is called** + `LinkTriggerFields`; task details `ScheduledTaskLinkPanel` (Create/Rotate link, Copy once, Recent calls).
- Tests: router test in `aiden-remote-router.test.ts` (order, signature, filter, 429, no token in logs); batch/redaction/dedupe/log/rotation in `scheduled-task-triggers.test.ts`.

## E4 Aiden can propose triggers

- `schedule_task` create takes `trigger` (standard and Assistant; `SCHEDULE_TRIGGER_PARAMETER`, parsed by `toolTrigger`); refused on update. Assistant refuses script watches; its schema's `cron` is now optional (required unless trigger). Canonical Assistant args carry `trigger` instead of `cron`.
- Approval details (`ScheduledTaskApprovalDetails`, `AssistantAutomationApprovalDetails`) gained optional `whenLabel`; a trigger task has `cron: ""`, `nextRunAt: 0`, and the validators accept an empty cron only with a `whenLabel` (phones that require a cron fail closed until E6). `whenLabel` is in the run-journal allowlists (`run-event-projection.ts`). Card shows it instead of the cadence.
- Results: task summaries carry `trigger` (the label); a link task's create result adds `link: "shown_to_person"` (standard also `status: "saved"`). The agent never sees the link.
- CLI `packages/cli/src/schedules.ts` `saveInput` refuses `trigger`.
