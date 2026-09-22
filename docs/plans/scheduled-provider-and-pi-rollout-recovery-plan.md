# Scheduled-Task Provider Recovery and Pi Rollout Generation Fix

Status: Implemented (2026-09-09) — Phases A, B2, and C are coded and green in
worktree `.worktrees/prod-error-recovery` (branch `fix/scheduled-provider-and-pi-rollout`);
B1 (operator stage advance) and machine remediation remain release-owner steps.
Originated from installed production diagnostics on 2026-09-09
(app v0.39.0, `~/Library/Application Support/Aiden Agent`).

## Problem

Two production failures surfaced from the installed app's logs and data:

1. **Scheduled LLM tasks fail forever with "Choose a provider before running
   this scheduled task."**
   - Thrown at `main/services/schedule-execution.ts:233` when both
     `task.providerId` and `settings.lastProviderId` are empty.
   - UI-created tasks never store a provider (`renderer/components/scheduled-tasks-view.tsx`
     `newTask()`; the editor has no provider picker), and the fallback key
     `settings.lastProviderId` is only ever written by the Telegram flow while
     the app's real selection lives in renderer localStorage
     (`renderer/lib/use-model-selection.ts`), invisible to the main-process
     scheduler.
2. **"Generation failed: Pi v4 journal creation is outside the active device
   rollout stage."**
   - Thrown at `main/services/pi-compaction-session-store.ts:675` when a chat
     has no v4 journal and the device-local rollout policy (stage
     `new_chats`, `activatedAt` = first launch of the Pi-upgrade build) marks
     the chat as pre-activation.
   - `main/services/llm-client.ts` opens the journal unconditionally and
     hard-fails generation without one, so every chat created before
     activation is blocked from generating until the operator advances the
   rollout stage.
3. **Remote 4xx bursts** in rotated diagnostics
   (`remote-request-failed`, route categories workspaces/chats/schedules/usage)
   — cause unknown; needs route/version evidence before a fix.

## Fix design

### Phase A — scheduled-task provider resolution

- **A1 (main):** attended renderer chat starts persist
  `lastProviderId`/`lastModel` into app settings so the documented scheduler
  fallback resolves the selection the app actually uses. Attended
  renderer-owned starts only; scheduled/subagent/bot streams must not
  overwrite the user default.
- **A2 (renderer + tool):** pin providers explicitly —
  `newTask()`/templates prefill from the current model selection; the task
  editor gains a provider/model picker (default "App default"); chat-driven
  `schedule_task` creation stops displaying "Scheduler default" when nothing
  resolves and rejects creation instead of saving a task that can only fail.
- **A3:** editor + parse guardrail warns when an LLM task has no provider and
  no app default exists yet.
- Contract unchanged: `providerId` stays optional; remote/mobile-created
  tasks already pin concrete providers.

### Phase B — Pi rollout generation block

- **B1 (operational, release owner):** advance the device per
  `docs/testing/pi-compaction-phase7-rollout-gates.md` (evaluation receipt →
  installed receipt → `npm run pi-upgrade:advance -- migrated_low_risk_chats`).
  Note `AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0` does not restore generation for
  journal-less chats.
- **B2 (code):** generation must never be hard-blocked by the rollout gate,
  while preserving the fail-closed contract that a pre-existing chat is never
  silently given a v4 journal or migrated:
  - `pi-compaction-session-store.ts` gains `openChatIfEligible()` returning
    either a session or a structured rollout-ineligible/legacy-deferred
    reason; `openChat()` keeps its throws for background callers.
  - `llm-client.ts` uses the probe and, when ineligible, runs the turn
    journalless over an in-memory session (child-agent precedent): no v4
    journal is created, effect recovery is never marked durable, and store
    quarantine can never fire for an in-memory failure. VCC recall is
    omitted; todo replay runs against the empty in-memory journal.
  - `chats:todoSnapshot` and the context-lifecycle compaction caller skip
    instead of throwing for ineligible chats.

### Phase C — remote 4xx evidence

Add route/method/client-version fields to `remote-request-failed` journal
events, correlate with the paired mobile build, then fix the wrong side
(route alias or client refresh backoff) with a router regression test.

## Machine remediation (after ship)

- Salman Guardian task heals via the A1 fallback after one attended send, or
  by pinning a provider in the new editor.
- Pre-activation chats heal immediately via B1; B2 protects every device.

## Verification

`npm run type-check`, `npm run lint`, focused suites (`test:scheduled`,
`test:assistant-automations`, `test:compaction`, `test:google-provider`,
`test:command-system`, `test:aiden-remote`), then the full `npm run test`
chain. New test files must be registered in `package.json`.
