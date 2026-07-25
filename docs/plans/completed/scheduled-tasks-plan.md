# Scheduled Tasks Plan

Status: implemented through Phase 4 on 2026-07-23; retained as the original implementation plan
Date: 2026-07-23  
UI reference: ChatGPT/Codex "Scheduled tasks" workbench (sidebar destination, task list, suggestions), adapted to Aiden's existing tokens and component system.

Source basis: current Aiden source, Hermes Agent cron subsystem (`/Users/sambitbiswas/projects/opp/hermes-agent`: `cron/jobs.py`, `cron/scheduler.py`, `cron/scheduler_provider.py`, `tools/cronjob_tools.py`), Aiden project memory and UI references, and the confirmed product decisions below.

Implementation hardening amendment: read-only scheduled LLM runs withhold MCP tools because connector schemas do not currently carry enforceable read/write capability metadata. Script tasks require explicit Full permission. Interactive `schedule_task` mutations always require the live approval surface. See `.memory/SCHEDULED-TASKS.md` for the shipped architecture and review-driven amendments.

## Verdict

Scheduled tasks fit Aiden's existing architecture cleanly: a new main-process service, JSON persistence via `DataStore`, a typed IPC prefix, a dedicated chat thread per task, and an agent tool registered in `buildAgentTools`. At planning time no scheduler existed, so this was a new vertical, but every seam it needed (persistence, IPC, agent tools, chat store, settings, split-view UI) already had an established pattern.

Hermes is the reference for behavior, not for code: its Python JSON-registry + 60s ticker + delivery-target design translates directly into a croner-driven TypeScript service.

## Confirmed product decisions (frozen)

1. **Task modes** — each task is `mode: "llm"` (agent runs a self-contained prompt) or `mode: "script"` (no LLM; run a local script and deliver its stdout verbatim; empty stdout = silent skip, non-zero exit = error alert).
2. **Output** — every run appends a message to a **dedicated chat thread per task** and fires a **macOS Notification** (title = task name, body = first 120 characters of output). Tasks are also listed on the Scheduled page.
3. **Surfaces** — a **sidebar destination** (`/scheduled`) is the primary management surface (required, not optional). Settings gets a section for global defaults only.
4. **Permissions** — per-task `permission: "read-only" | "full"` toggle in the task creator. There is no "ask" mode for scheduled runs: `full` runs mutating tools silently; `read-only` blocks mutating tools with a clear error in the run result. The `schedule_task` agent tool **recommends the right level** when creating a task (read-only by default; full only when the task obviously needs writes or commands).
5. **Agent exposure** — a `schedule_task` tool is registered in `buildAgentTools` so the agent can create/list/pause/resume/remove/run tasks by natural-language request (Hermes `cronjob` tool pattern, compressed single-action schema).
6. **Cron library** — `croner`: TypeScript-native, DST/timezone-correct via `Intl`, built-in `catch` error handling, 100% pass on the independent cron-comparison edge-case suite, zero dependencies.
7. **Script locations** — scripts resolve from **both** `~/.aiden/scripts/` (global) and `<workspace>/.aiden/scripts/` (workspace). Workspace scripts take precedence on name collision. Absolute paths outside both roots are rejected.
8. **Run history** — keep the **50 most recent runs per task** (bounded like Hermes).

## What Hermes does (reference)

- `croniter`-parsed schedules plus human forms (`"30m"`, `"every 2h"`, ISO timestamps); custom in-process 60s ticker.
- Jobs in per-profile JSON (`~/.hermes/cron/jobs.json`), atomic writes + file lock; SQLite execution ledger; per-run Markdown output with 50-run retention.
- `no_agent` mode: script stdout is the message; empty stdout = silent; non-zero exit = error alert.
- At-most-once firing: `next_run_at` advanced before execution; dispatch claims prevent double-fire across processes.
- Single compressed `cronjob` agent tool (`create|list|update|pause|resume|remove|run`) with prompt-injection scanning and script-path sandboxing.
- `context_from` chaining and per-job model/provider overrides — deferred for Aiden v1.

## What Aiden adds

- The scheduler runs inside Electron main; no daemon, no REST API, no delivery platforms.
- Delivery is chat thread + system notification instead of chat-platform fan-out.
- Workspace identity and permission come from the stored `workspaceId`, re-resolved in main (renderer never supplies paths).

## Data model

Add to `main/services/types.ts`:

```ts
export type ScheduledTaskMode = "llm" | "script";
export type ScheduledTaskPermission = "read-only" | "full";
export type ScheduledRunResult = "success" | "error" | "silent" | "blocked";

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  mode: ScheduledTaskMode;

  // Schedule (croner-parsed, 5-field cron + optional seconds)
  cron: string;
  timezone: string;            // IANA; defaults to system
  nextRunAt?: number;
  lastRunAt?: number;

  // Execution context
  workspaceId?: string;
  providerId?: string;
  model?: string;

  // LLM mode
  prompt?: string;

  // Script mode (relative name under a scripts root; no absolute paths stored)
  script?: string;

  // Permission (never "ask")
  permission: ScheduledTaskPermission;

  // Delivery
  chatId?: string;             // dedicated thread, created on first run
  notify: boolean;             // macOS notification on run

  // Status
  lastResult?: ScheduledRunResult;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  startedAt: number;
  finishedAt: number;
  result: ScheduledRunResult;
  output: string;              // truncated for storage
  error?: string;
  chatId?: string;
}
```

Persist `ScheduledTask[]` via `DataStore` in `<userData>/schedules.json`. Persist `ScheduledRun[]` in `<userData>/schedule-runs.json`, pruned to 50 per task on write.

## Architecture and files

```
main/
  services/
    schedule-store.ts        # DataStore CRUD, next-run calc, run-log pruning (50/task)
    schedule-service.ts      # croner lifecycle: start/stop/reschedule, app-launch reconciliation
    schedule-execution.ts    # run one task: script path or llmClient.start, chat append, notify
    schedule-tool.ts         # schedule_task agent tool (schema + handler + guards)
  handlers/
    scheduled-tasks.ts       # ipcMain.handle("schedule:list" | "save" | "remove" |
                             #   "pause" | "resume" | "runNow" | "runs" | "settings")
renderer/
  main/router.tsx            # + /scheduled route under chatLayoutRoute
  components/
    chat-sidebar.tsx         # + "Scheduled" row (Clock icon) below chat history
    scheduled-tasks-view.tsx # destination: header, search, tabs, list, suggestions
    scheduled-task-editor.tsx# create/edit dialog (mode, prompt/script, cron, permission toggle)
    settings/scheduled-tasks-settings.tsx  # global defaults section
  lib/ipc.ts                 # + scheduleApi
  lib/queries.ts             # + useScheduledTasks, useScheduledRuns
  preload.ts                 # + "schedule:" invoke prefix, + "schedule:updated" notification channel
package.json                 # + croner dependency
```

### Scheduler lifecycle (`schedule-service.ts`)

- On `app.whenReady()` (after `registerHandlers()`): load tasks, create one `Cron` per enabled task, compute and persist `nextRunAt`. On quit: stop all jobs.
- Reconciliation on launch: for a task whose `nextRunAt < now`, run it once on start (catch-up) and reschedule from now. Missed windows do not stack.
- At-most-once: `nextRunAt` is advanced and persisted **before** execution begins; a re-entrant guard (`runningTaskIds: Set<string>`) refuses overlapping runs of the same task.
- Save/disable/remove stops the croner job; save/enable (re)starts it. All croner errors route through its `catch` option into the run log.

### Execution (`schedule-execution.ts`)

Script mode:

1. Resolve script: `<workspace>/.aiden/scripts/<name>` wins over `~/.aiden/scripts/<name>`; reject absolute paths and `..` traversal.
2. Run via bounded child process (`spawn`, no shell string; `.sh`/`.bash` via bash, `.js` via node, `.py` via python3, else direct exec), cwd = workspace root when bound, timeout 60s, output capped.
3. Non-empty stdout → assistant message in the task's chat + notification (first 120 chars). Empty stdout → `silent` run, no message, no notification. Non-zero exit/timeout → `error` run, error message in chat, notification.

LLM mode:

1. Resolve workspace from `workspaceId`; reject when workspace permission is `"none"`.
2. Effective tools: build via `buildAgentTools`, then filter by task permission — `read-only` drops `write_file`, `edit_file`, `run_command` (task runs read-only tools + skills/MCP); `full` keeps everything and never prompts (no approval surface exists in a scheduled run).
3. Create the task's dedicated chat on first run (`chatStore.create`, title = task name), then `llmClient.start(streamId, { chatId, workspaceId, providerId, model, messages: [user prompt] })` and await terminal `chat:done`/`chat:error`.
4. Assistant content lands in the chat via the normal stream path; notification = task name + first 120 chars.
5. Blocked mutating attempt under `read-only` → `blocked` result with a clear message in chat.

`schedule_task` tool guard: a scheduled run's tool set **excludes `schedule_task` itself** (no recursive scheduling, Hermes rule).

### Agent tool (`schedule-tool.ts`)

Single compressed tool, Hermes-style:

```
schedule_task(action, id?, name?, cron?, mode?, prompt?, script?,
              workspaceId?, permission?, timezone?, notify?)

action: create | list | pause | resume | remove | run_now
```

- `create` requires `cron`; `llm` mode requires `prompt`; `script` mode requires `script`.
- Permission guidance in the schema description: default `read-only`; recommend `full` only when the prompt clearly needs file writes or shell commands; state the recommendation in the tool result.
- Guards: prompt-injection scan on `prompt` (Hermes strict pattern set); script name validation (basename only, exists in an allowed root); no recursive scheduling; `list` before mutating actions is instructed in the description (never guess IDs).
- `run_now` executes immediately through the same execution body as a cron fire (no drift).

## UI plan

### Sidebar destination (`/scheduled`)

Mirrors the reference screenshot, adapted to Aiden's tokens and primitives:

- **Header**: `Text` title "Scheduled tasks", secondary subtitle ("Ask Aiden to schedule tasks, set reminders, or monitor for updates"), `Input` search field, segmented tabs (All / Active / Paused), `Create` `Button` (variant `filled`, `Plus` icon).
- **Task list**: `rounded-card border border-separator` rows with `Separator`s, matching `skills-settings.tsx` density: status dot (active/paused/error), name, `cron` display + relative next run ("Next run in 17 hours"), `Switch` enable toggle, context menu (Edit, Run now, Open chat, Pause/Resume, Delete).
- **Suggestions**: section header + three template rows (icon, name, schedule chip, one-line description) — "Daily brief · Weekdays at 8:00 AM", "Weekly review · Fridays at 4:00 PM", "Follow-up monitor · Weekdays at 9:00 AM". Selecting one opens the editor pre-filled.
- **Empty state**: `EmptyState` with a short explainer and a Create button.
- **Editor dialog**: `Dialog` + `FieldSet`/`Field` — name; mode segmented control (Ask Aiden / Run script); `Textarea` prompt or script picker; cron field with humanized preview and next-3-runs preview (croner `nextRuns`); timezone (default system); workspace picker; permission toggle (`read-only` default, helper text: "Read-only: can read files and search. Full: can also edit files and run commands without asking."); notify `Switch`.

### Sidebar row

`Clock` icon + "Scheduled" row in `chat-sidebar.tsx` under the chat list section, selected state driven by pathname, same hover/pressed treatment as other rows. Badge with active task count is deferred.

### Settings section

`Scheduled tasks` under the **Agent** nav group:

- Global enable switch.
- Default mode, default permission, default notify.
- Scripts roots explainer (`~/.aiden/scripts/` and `<workspace>/.aiden/scripts/`).
- Default timezone.
- Compact read-only list of tasks with Edit/Delete shortcuts (full management stays on the Scheduled page).

## Security model

| Concern | Mitigation |
|---|---|
| No live user | No `"ask"` mode; `read-only` blocks mutating tools, `full` runs silently. |
| Workspace boundary | Main re-resolves `workspaceId`; `"none"` workspaces refuse to run; folder path never accepted from renderer. |
| Script sandbox | Basename-only script names; resolution confined to the two scripts roots; no shell-string execution; bounded timeout/output. |
| Prompt injection | Strict Hermes-style scan on create/update of LLM prompts. |
| Recursive scheduling | `schedule_task` withheld from scheduled-run tool sets. |
| Credential scope | LLM runs use the configured provider/model only; no base-url overrides. |
| At-most-once | `nextRunAt` advanced+persisted before execution; in-process run guard; launch reconciliation without stacked catch-up. |
| Cancellation | Quit, workspace switch, disable, or remove stops croner jobs and cancels active runs. |

## Notifications

`new Notification({ title: task.name, body: output.slice(0, 120) })` from main after each non-silent run; error runs always notify (body = error summary) unless the task's `notify` is off. Clicking a notification focuses the window and navigates to the task's chat (route push via `app:navigate` pattern if needed; otherwise deferred to a follow-up).

## Settings added to `AppSettings`

```ts
scheduledTasksEnabled?: boolean;        // default true
scheduledDefaultMode?: ScheduledTaskMode;         // default "llm"
scheduledDefaultPermission?: ScheduledTaskPermission; // default "read-only"
scheduledDefaultNotify?: boolean;       // default true
scheduledDefaultTimezone?: string;      // default system
```

## Implementation phases

### Phase 1 — Main-process foundation

1. `npm install croner`.
2. Types in `main/services/types.ts` (+ re-export in `renderer/lib/types.ts`).
3. `schedule-store.ts` — DataStore CRUD, run log, 50-per-task pruning.
4. `schedule-service.ts` — croner lifecycle + launch reconciliation; started from `main/index.ts` after handlers register.
5. `schedule-execution.ts` — script/LLM execution, chat append, notification.
6. `main/handlers/scheduled-tasks.ts` + registration in `handlers/index.ts`.
7. `preload.ts` — `schedule:` invoke prefix + `schedule:updated` channel.
8. `renderer/lib/ipc.ts` `scheduleApi` + `queries.ts` hooks.
9. Settings section + nav entry.
10. Focused tests: store pruning, cron parsing/next-run, script resolution/traversal rejection, permission filtering, execution result mapping.

Acceptance: tasks created via IPC fire on schedule in a dev build; script mode silent/error semantics verified; notification fires with 120-char body; runs persist with 50-run cap.

### Phase 2 — Scheduled destination

1. `/scheduled` route, view, rows, tabs, search, suggestions, editor dialog.
2. Sidebar row in `chat-sidebar.tsx`.
3. Dedicated-chat link (row action "Open chat").
4. Empty state + relative next-run formatting.

Acceptance: full CRUD from the UI; pause/resume state visible; list matches Hermes/reference information density; reduced-motion and dark-mode clean.

### Phase 3 — Agent tool

1. `schedule-tool.ts` with schema, guards, and permission recommendation.
2. Registration in `buildAgentTools`; exclusion from scheduled-run tool sets.
3. Tests: create/list/pause/resume/remove/run_now flows, injection-scan rejection, script-name validation, no recursive scheduling.

Acceptance: in a chat, "every weekday at 9am summarize my unread git changes" creates a working read-only task; "watch this log and alert me" creates a script task; the agent never schedules inside a scheduled run.

### Phase 4 — Hardening

1. Notification click → focus + open chat.
2. Global kill switch honored live (pause all jobs without deleting tasks).
3. Usage accounting for scheduled LLM runs (`usageStore.record` source `"scheduled"`).
4. Full verification: `npm run type-check`, `npm run lint`, `npm run test`, `npm run build`, `npm run package` smoke.

## Deferred (not v1)

- `context_from` task chaining; per-task provider/model overrides beyond stored defaults; one-shot ISO schedules and `"every 2h"` shorthand parsing; run-output Markdown export; sidebar badge counts; quiet hours; multi-notification grouping.

## Risks

- **Croner bundling**: esbuild main-process bundle must treat `croner` as a normal dependency (no native code; safe). Verify packaged smoke in Phase 4.
- **Chat creation from main**: scheduled LLM runs create chats without renderer involvement; must invalidate/broadcast so the sidebar reflects the new thread (`chats:metadata-updated` pattern).
- **Notification permission**: macOS may prompt on first notification; copy must be conservative.
