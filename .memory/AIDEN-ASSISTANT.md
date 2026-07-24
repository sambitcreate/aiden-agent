# Aiden Assistant

Status: detailed plan, not yet implemented. Full plan in `docs/aiden-assistant-plan.md` (2026-07-23).

## What it is
A standalone, first-class assistant chat inside the app ("Aiden") that manages the app: changes settings/config, answers app-help questions, reminds about uncommitted changes, nudges about neglected projects, and proactively sends chat messages + macOS notifications. It is a **persona + tool set + proactive loop** on the existing Pi core + chat UI, building on the frozen scheduled-tasks engine (`docs/scheduled-tasks-plan.md`).

## Key decisions (plan)
- Scheduled tasks = the proactive engine. Assistant layer consumes it; proactive runs are recurring scheduled tasks owned by the assistant.
- New `/assistant` route + pinned sidebar row; reuses `MessageList`/`Composer`/streaming pipeline against a persistent `kind:"assistant"` chat.
- Proactive delivery can't use the document-scoped generation owner; background runs append finalized messages + broadcast `assistant:message`; interactive runs stream normally.
- Hermes-inspired proactive loop: deterministic fetch (`listWorkspaces` + `git.ts`) → batched cheap-LLM urgency score → threshold (default 7) → `[SILENT]` gate → deliver. Default is silence.
- Consent-first: master enable off by default; proactive sub-toggle + cadence; latched dismissal (24h TTL) + pending cap.
- Memory: `<userData>/assistant/MEMORY.md` + `USER.md`, frozen-snapshot injection into system prompt (preserves prefix cache); `assistant_memory` tool with content scan.
- Tools (gated to assistant chat in `buildAgentTools`): `app_setting`, `provider_config`, `schedule_task` (reuse), `app_help`, `assistant_memory`, `list_workspaces`/`workspace_status`. Interactive setting changes require inline Accept; proactive runs auto-deny mutating tools.
- App sends zero OS notifications today — this + scheduled tasks introduce `new Notification(...)` from main (click → focus + navigate `/assistant`).
- New IPC prefix `"assistant:"` + channels `assistant:message` / `assistant:nudge` / `assistant:setting-change-request`; add to `preload-channels.ts` + `ipc-contract.test.ts`.
- New `SettingsSection = "aiden"` in Agent nav group.

## Phases
Phase 1 identity + chat surface + interactive tools; Phase 2 proactive loop + notifications; Phase 3 suggestions catalog; Phase 4 memory learning loop + hardening.

## Hermes reference (behavior, not code)
`cron/scheduler.py:298` ([SILENT]); `cron/scripts/classify_items.py` (urgency); `cron/suggestions.py` (consent/latched dismiss); `tools/memory_tool.py` (frozen snapshot); `agent/background_review.py:637` (auto-deny); `agent/turn_context.py:493` (turn-count learning trigger).
