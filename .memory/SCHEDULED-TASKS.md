# Scheduled Tasks

Status: plan frozen, not yet implemented. Full plan in `docs/scheduled-tasks-plan.md` (2026-07-23).

## Frozen decisions

- Cron library: `croner` (TS-native, DST/timezone-correct, built-in catch, zero deps).
- Task modes: `llm` (agent runs prompt) or `script` (stdout is the message; empty stdout = silent, non-zero exit = error).
- Output: dedicated chat thread per task + macOS Notification (title = task name, body = first 120 chars).
- Surfaces: sidebar destination `/scheduled` is primary (required); Settings section holds global defaults only.
- Per-task permission: `read-only` (mutating tools blocked) or `full` (mutating tools run silently). No `ask` for scheduled runs. Agent tool recommends the level at creation time.
- Agent exposure: single compressed `schedule_task` tool in `buildAgentTools` (Hermes `cronjob` pattern); excluded from scheduled runs (no recursive scheduling).
- Script roots: `~/.aiden/scripts/` (global) and `<workspace>/.aiden/scripts/` (workspace wins on collision); basename-only names, traversal rejected.
- Run history: 50 most recent runs per task.
- Hermes is the behavior reference (`/Users/sambitbiswas/projects/opp/hermes-agent`), not a code source.

## Implementation outline

Phase 1 main-process foundation (store/service/execution/handlers/IPC/settings), Phase 2 Scheduled destination UI, Phase 3 agent tool, Phase 4 hardening. Persistence: `<userData>/schedules.json` + `<userData>/schedule-runs.json` via `DataStore`. LLM runs reuse `llmClient.start`; tools filtered by task permission.
