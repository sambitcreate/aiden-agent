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
  typed operation/fault boundary.
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

1. Move durable session flush, compaction, retry, and checkpoint replacement
   fully behind the facade; they remain split between foreground and child
   owners today.
2. Return typed terminal outcomes (`completed`, app-cancelled,
   provider-failed, host-failed) instead of leaving terminal classification at
   each call site.
3. Add canonical main-process run/turn/event envelopes and separate durable
   reducers from best-effort renderer projection.
4. Adapt Aiden's leased skill snapshot and future prompt templates to explicit
   Pi resource snapshots. Add provider request/payload/response hooks and
   custom entry projectors.
5. Retain the owning Pi `Models` collection in resolved runtimes for a future
   native Harness migration.
6. Add durable operation/effect records with replay-safe versus never-replay
   metadata. Current journal recovery is not exactly-once external-effect
   recovery.
7. Isolate child inference in a killable worker/process before claiming hard
   termination of a transport that ignores abort.
8. Add a strict, zero-activity-only startup retry and finish the internal
   host/session failure taxonomy. Provider failure text is already closed at
   the child boundary.

## Gates

- Runtime adapter unit tests cover sequencing, extension isolation, critical
  subscriber failure, and contribution snapshots.
- Child/supervisor tests cover fork identity, empty completion, terminal-only
  output, hidden protocol limits, construction abort, aggregate budgets,
  exact queued cancellation, quarantine recovery, and renderer-safe activity.
- `npm run type-check`, `npm run test:compaction`, and
  `npm run test:subagents` must pass before release.
