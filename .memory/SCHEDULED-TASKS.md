# Scheduled Tasks

Status: implemented through Phase 4 on `codex/scheduled-tasks-phases-3-4` (2026-07-23). The original frozen plan remains in `docs/scheduled-tasks-plan.md`.

## Frozen decisions

- Cron library: `croner` (TS-native, DST/timezone-correct, built-in catch, zero deps).
- Task modes: `llm` (agent runs prompt) or `script` (stdout is the message; empty stdout = silent, non-zero exit = error).
- Output: dedicated chat thread per task + macOS Notification (title = task name, body = first 120 chars).
- Surfaces: sidebar destination `/scheduled` is primary (required); Settings section holds global defaults only.
- Per-task permission: `read-only` (mutating built-ins and all unknown-capability MCP connector tools withheld) or `full` (mutating tools may run unattended). No `ask` exists inside scheduled runs. Script mode requires explicit `full` because an arbitrary local script is inherently mutation-capable. The agent tool recommends the level at creation time.
- Agent exposure: single compressed `schedule_task` tool in `buildAgentTools` (Hermes `cronjob` pattern); excluded from scheduled runs (no recursive scheduling).
- Live approval boundary: interactive agent calls may list schedules without approval, but create/pause/resume/remove/run-now always use the existing hash-bound approval surface, regardless of workspace permission.
- Script roots: `~/.aiden/scripts/` (global) and `<workspace>/.aiden/scripts/` (workspace wins on collision); basename-only names, traversal rejected.
- Run history: 50 most recent runs per task.
- Hermes is the behavior reference (`/Users/sambitbiswas/projects/opp/hermes-agent`), not a code source.

## Implemented architecture

- Phase 1: `schedule-store`, lifecycle service/core, script and LLM execution, typed IPC/query surfaces, settings, bounded run history, at-most-once advancement, launch catch-up, and process-group script limits.
- Phase 2: `/scheduled`, sidebar entry, search/status tabs, templates, editor, cron preview, CRUD, global defaults, dedicated chats, and recoverable authoritative-load errors.
- Phase 3: guarded `schedule_task` create/list/pause/resume/remove/run-now flow, conservative permission recommendation, script-root validation, recursion exclusion, and live approval for every mutation.
- Phase 4: notification navigation, global live kill switch, scheduled usage attribution, workspace-revocation cancellation, bounded shutdown settlement, per-task lifecycle serialization, stale/deleted chat recovery, invalid-record quarantine, and packaged-runtime acceptance.
- Persistence is `<userData>/schedules.json` plus `<userData>/schedule-runs.json` through `DataStore`; 50 runs are retained per task. LLM runs reuse `llmClient.start` and claim one generation per dedicated chat.

## Review amendments to the frozen plan

- The plan originally allowed MCP tools in read-only runs. MCP currently has no reliable per-tool read/write capability metadata, so read-only scheduled runs withhold MCP entirely rather than claiming an unenforceable permission boundary.
- The plan exposed a permission toggle for scripts. Script tasks now require Full and the editor states that consequence explicitly; a read-only arbitrary script cannot be enforced after process launch.
- Changing a task workspace cancels and settles its live run, clears the old dedicated-chat binding, and creates a correctly scoped chat on the next run. Opening a task chat makes the persisted chat workspace authoritative for follow-up tools.
- Invalid persisted schedules remain visible as disabled `Needs attention` tasks instead of aborting application startup.
