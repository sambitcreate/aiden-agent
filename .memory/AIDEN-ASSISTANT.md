# Aiden Assistant (proactive in-app assistant)

Status: planned only — `docs/aiden-assistant-plan.md` (2026-07-23). No code yet.

Feature: standalone compact assistant chat window ("Aiden") that can chat about
the app, read/change settings via tools (approval-gated), and proactively nudge
about uncommitted changes, untouched projects, and config changes. Proactivity
patterns adapted from hermes-agent (`~/projects/opp/hermes-agent`).

Key decisions:
- Window modeled on `main/windows/pill-window.ts` but focusable/closable;
  3 build touch points (vite input, root HTML, esbuild preload).
- Assistant threads = plain chats in a reserved workspace id; reuses
  `startGeneration` streaming and `rendererDocumentOwner` ownership.
- System prompt gets a params-driven "assistant" variant in
  `buildSystemPrompt` (`main/services/llm-client.ts`).
- Tools registered in `buildAgentTools`: settings read/write (whitelist parity
  with `settings:set` in `main/handlers/providers.ts`), project status via
  existing `gitInfo` (`GitInfo.uncommitted` already exists).
- Proactive engine in `main/services/assistant/`: mechanical collectors +
  one batched LLM decision call (urgency ≥ 7), strict `[SILENT]` parser,
  nudge store with permanent dismiss latching by dedupKey, quiet hours,
  daily cap, first-run deferral, fail-closed on broken model pin.
- Delivery: macOS `Notification` using the shipped Scheduled Tasks
  delivery/navigation boundary + `assistant:nudge` broadcast + mirrored
  dedicated chat thread.
- Scheduled Tasks is implemented through Phase 4. Reuse its `croner`
  dependency, cancellation/shutdown rules, notification navigation, dedicated
  chat pattern, and usage attribution, but keep assistant cadence/state
  separate from user-authored `ScheduledTask` records and `/scheduled`.
- No file watcher exists (no chokidar/fs.watch); real-time watching deferred
  to Phase 4 as an explicit dependency decision.
