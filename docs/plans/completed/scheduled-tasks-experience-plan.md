# Scheduled Tasks Experience and Chat Creation

Status: Complete
Date: 2026-08-30
Original foundation: [`scheduled-tasks-plan.md`](scheduled-tasks-plan.md)

## Goal

Make scheduled work feel like an Aiden capability instead of a cron form. A user can ask for
an automation from any eligible attended Aiden chat, review the exact proposed action and
authority, and approve it once. The Scheduled Tasks destination becomes the calm place to
search, inspect, pause, resume, run, edit, and remove tasks across desktop, iOS, and Android.

## Product decisions

1. Natural-language creation is primary. The Scheduled Tasks page routes creation through an
   Aiden prompt and explains that the same request works in ordinary chats.
2. Ordinary attended chats receive the existing `schedule_task` tool. The Aiden Assistant keeps
   its stricter model-pinned Assistant automation profile. Bots receive scheduling only when
   their main-owned capability policy explicitly includes `schedules`; Telegram remains excluded.
3. Every chat-originated mutation pauses for an owner-bound approval. A paired phone must have
   both `approval:respond` and `schedule:write` to allow a `schedule_task` mutation; denial remains
   available with approval authority alone.
4. Common schedules use human controls and human summaries. Cron remains the persisted wire and
   storage contract, with lossless advanced editing for existing custom expressions.
5. Existing task persistence and Remote projections remain compatible. This follow-up adds no
   required stored fields and therefore needs no destructive data migration.
6. Read-only, Full, workspace, MCP, Web Search, provider/model fingerprint, revision,
   idempotency, and unattended execution checks remain main-owned and fail closed.

## Delivery tracks

### Desktop

- [x] Audit the existing tool, approval, scheduler, store, and Scheduled Tasks UI.
- [x] Ship a natural-language-first header/create flow and denser searchable task list.
- [x] Replace raw cron as the default editor with human cadence/time/timezone controls.
- [x] Preserve advanced custom cron, run previews, task detail, and management actions.
- [x] Cover light/dark, reduced motion, text-entry focus, keyboard focus, and empty/error states.

### Shared authority and contracts

- [x] Confirm standard chats and attended Assistant threads can propose schedules.
- [x] Confirm Bot scheduling remains capability-gated and unavailable from Telegram.
- [x] Require `schedule:write` in addition to `approval:respond` for remote Allow decisions.
- [x] Review legacy task normalization, invalid schedule quarantine, revision races, and custom
  cron round trips.

### iOS and Android

- [x] Present `schedule_task` approvals with clear automation language while trusting only the
  host-provided bounded summary and `canAllow` decision.
- [x] Expose task search/detail/status and safe management actions using existing revisioned,
  idempotent Remote endpoints.
- [x] Keep natural-language creation in chat and capability-gate management surfaces.
- [x] Run focused native contract and presentation tests on both clients.

### Verification and delivery

- [x] Run focused scheduler, Remote, renderer, iOS, and Android suites.
- [x] Run desktop type-check, lint, test, and build gates.
- [x] Complete a separate migration/security/edge-case review and remediate findings.
- [x] Open a PR, watch required CI through completion, and resolve failures before integration.

## Compatibility and migration notes

- `ScheduledTask.cron` stays the canonical schedule. Common five-field expressions, including
  supported minute intervals, project into human controls; second-level, list, range, named, or
  otherwise unsupported expressions stay custom and are never rewritten merely by opening an
  editor.
- Tasks that fail existing normalization remain disabled with `Needs attention` rather than being
  dropped or run with guessed authority.
- Assistant execution profiles and exact MCP/provider fingerprints are unchanged. Ordinary UI or
  Remote edits cannot widen those protected profiles.
- Native clients continue to consume the v1 Remote task and approval envelopes. Remote run-now
  now requires the existing `If-Match` precondition; current clients send it, while older clients
  fail closed with `400` instead of running a definition newer than the one being displayed.
- Existing chat and desktop mutations now bind the exact `updatedAt` snapshot. Legacy global Full
  LLM tasks freeze inherited enabled MCP identities on their first approved edit and cannot be
  run or resumed from chat until that migration is reviewed.
