# Pi Runtime Harness

Status: Partial

## Goal

Make the main process own one Pi-shaped runtime boundary for foreground and
child agents so trusted Pi-compatible contributions primarily need renderer
projection work, not a second model/tool/session integration.

## Version boundary

Aiden pins `@earendil-works/pi-agent-core` and `pi-ai` `0.80.10`.

- The released Pi `AgentHarness` is functional, but cannot resume Aiden's
  already-journaled durable user tail, does not expose global sequential tool
  execution, and does not provide Aiden's between-tool-turn automatic
  compaction and visible-chat transaction.
- The adjacent Pi repository's durable lane/operation Harness is an
  implementation specification plus scaffold. Restore, prompt, tools, queues,
  cancellation, and compaction are not yet a usable replacement.
- Aiden therefore uses `PiAgentRuntimeHarness`, an adapter over Pi's low-level
  `Agent`, until the durable Harness can satisfy the same production
  invariants. The adapter, not the renderer, is the future migration seam.

## Shipped in this milestone

- Both foreground and child runs are constructed through one runtime facade.
- Effectful tool batches are always sequential even though Pi defaults to
  parallel execution.
- `continueFromDurableTail()` names the no-duplicate resume contract.
- Critical lifecycle subscriber failures abort the run and surface as a typed
  host error. Active context/tool policy hooks fail closed; passive observers
  receive detached events and can neither mutate nor delay Pi's event sequence.
- A process-owned trusted contribution registry snapshots Pi tools, system
  prompt additions, context hooks, before/after-tool hooks, and passive events
  for every new foreground run. Duplicate contribution and tool identities
  fail closed, static contributions participate in capacity accounting, and
  the host capacity transform always runs last.
- Child runs use the same Pi facade but intentionally do not inherit global
  contribution tools. Child contributions require a future authority-aware
  adapter that narrows tools, approval bindings, and budgets before dispatch.
- Cancellation has one `cancelAndSettle()` operation for destructive lifecycle
  callers, and it waits through both Pi's internal idle point and the facade's
  typed operation/fault boundary. Non-abortable storage callbacks are tracked
  separately: foreground quarantines the chat journal until the detached write
  settles and its visible-turn transaction is rolled back and reconciled.
- `runManaged()` now owns the complete durable operation: exact current-input
  journaling, prior failed-tail repair, preflight and between-tool compaction,
  awaited message commits, checkpoint installation, one retry/backoff, and a
  unified cancellation boundary across provider, storage, hooks, and
  compaction (implemented with nested, parent-linked controllers). An
  assistant tool plan is durable before its effect executes, and its result is
  durable before another provider request can start.
- Managed callers receive one closed terminal union: `completed`,
  `app_cancelled`, `provider_failed`, or `host_failed`. Foreground and child
  adapters no longer infer terminal provenance independently, and raw provider
  or host exceptions never enter renderer/parent failure text.
- Foreground visible-chat persistence uses a `PiVisibleTurnLease`: prior failed
  attempts are abandoned before the new envelope opens, the exact enriched
  skill/user turn is appended once, and every rollback after an executed tool
  restores private effect evidence plus a no-repeat safety boundary. Removing
  a failed assistant from an already committed visible turn also re-closes its
  enclosing transaction so restart recovery cannot discard later turns. A
  failed rollback or evidence repair keeps the journal quarantined for the
  rest of the process; restart then applies normal transaction recovery.
- If retry recovery abandons the terminal Pi assistant, the closed outcome
  carries that disposition so foreground persists one safe visible partial
  before its marker. Healthy multi-assistant tool loops stay canonical and do
  not gain a duplicate aggregate assistant.
- Host and extension approval-policy exceptions terminate before another
  provider request. Lifecycle faults outrank simultaneous app cancellation,
  while a user Stop during retry, storage, or active compaction remains an
  `app_cancelled` outcome and cannot launch more model/tool work.
- Child lifecycle hardening covers exact terminal-output accounting,
  protocol-less and tool-use-only completion failure, hidden protocol bounds,
  abortable tool construction, deployment cleanup quarantine, truthful
  activity classes, exact queued-run cancellation, sibling isolation, and
  aggregate tree turn/network/output/protocol budgets.
- Provider failure details remain private; parent and renderer projections see
  a closed categorical failure message rather than raw provider text.
- Typed public host errors expose only a closed fault kind. Raw hook/subscriber
  exceptions stay inside the trusted diagnostic callback and never become an
  enumerable error cause that a caller could log.

## Trust policy

The contribution registry accepts main-owned trusted modules. A user-selected
arbitrary TypeScript/JavaScript path is not loaded in the Electron main
process. Pi coding-agent's executable extension loader would grant ambient
filesystem, process, credential, and network authority and requires a separate
signed or sandboxed plugin design.

## Remaining work

1. Add canonical main-process run/turn/event envelopes and separate durable
   reducers from best-effort renderer projection.
2. Adapt Aiden's leased skill snapshot and future prompt templates to explicit
   Pi resource snapshots. Add provider request/payload/response hooks and
   custom entry projectors.
3. Retain the owning Pi `Models` collection in resolved runtimes for a future
   native Harness migration.
4. Add durable operation/effect records with replay-safe versus never-replay
   metadata. Current journal recovery is not exactly-once external-effect
   recovery.
5. Isolate child inference in a killable worker/process before claiming hard
   termination of a transport that ignores abort.
6. Add a strict, zero-activity-only startup retry and finish the internal
   host/session failure taxonomy. Provider failure text is already closed at
   the child boundary.

## Gates

- Runtime adapter unit tests cover sequencing, extension isolation, critical
  subscriber failure, contribution snapshots, durable-before-effect ordering,
  prior-tail repair, typed failure privacy, policy termination, and
  cancellation during retry, session/storage waits, and active compaction.
- Follow-up coverage should inject a non-cooperative journal mutation during
  between-tool compaction and assert detached settlement plus production-store
  quarantine; the shared mutation path is currently covered by adversarial
  review probes.
- Child/supervisor tests cover fork identity, empty completion, terminal-only
  output, hidden protocol limits, construction abort, aggregate budgets,
  exact queued cancellation, quarantine recovery, and renderer-safe activity.
- `npm run type-check`, `npm run test:compaction`, and
  `npm run test:subagents` must pass before release.
