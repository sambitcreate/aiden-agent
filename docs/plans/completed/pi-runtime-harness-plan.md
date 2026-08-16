# Pi Runtime Harness

Status: Complete

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
- Resolved foreground and child runtimes retain their owning Pi `Models`
  collection. Native/custom/Codex requests and compaction share the same
  connection authority; Codex keeps its credential-generation dispatch guard.
- Foreground contributions resolve once into an immutable revisioned snapshot.
  Atomic replacement is reload-safe, active operations keep their old snapshot,
  and future operations observe the new revision.
- Pi-compatible disk skill resources, prompt-template snapshots, curated
  provider request/payload/response hooks, and custom session entry projectors
  now share that operation snapshot. Provider hooks cannot observe credentials
  or replace host auth policy; `aiden.*` transaction/marker entries can never be
  projected into model context.
- Managed steer and follow-up queues return typed acceptance receipts and make
  every drained user message durable before the next provider boundary. Queue
  tracking uses a cloned structural fingerprint rather than Pi object identity,
  terminal provider failures recover already accepted input, and admission is
  capped at 32 messages. Legacy prompt/continue entry points reject on durable
  runtimes.
- Main-process runtime envelopes provide stable run/session/lane, monotonic
  sequence, attempt, and turn identity. Their critical reducer runs before
  ordered best-effort observers. The observer projection contains public prose
  and lifecycle/tool metadata, but no hidden reasoning, tool payloads, provider
  diagnostics, or raw errors; observer shutdown is abortable.
- Every managed tool call now has private, owner-bound operation/effect
  evidence outside the rollbackable Pi journal. Preparation commits before
  dispatch, terminal evidence commits before continuation, replay policy is
  closed (`safe` or default `never`), never-replay arguments are reduced to a
  canonical digest, and the store is private, bounded, crash-reconciled, and
  coordinated with chat deletion.
- Restart recovery installs one idempotent private no-repeat boundary in the Pi
  journal for any effect whose result may have been removed with an incomplete
  visible turn. The boundary contains tool names but no arguments, and the
  effect becomes capacity-prunable only after the boundary and marker commit.
  Aiden deliberately does not auto-replay even a `safe` effect after process
  death; it makes uncertainty explicit and requires state inspection or user
  confirmation instead.
- Child provider requests, including semantic-compaction requests, execute in
  a one-request Electron utility process while the Pi Agent, session, tools,
  approvals, MCP connections, and usage accounting remain main-owned. Stop and
  shutdown freeze stream admission, then escalate cooperative cancel to TERM
  and an exact launch-identity-checked SIGKILL; terminal events are withheld
  until process exit is verified. Codex preserves its credential-generation
  guard and only a closed authentication-failure hint crosses back to main.
- Provider isolation admits only reviewed environment inputs. Bedrock supports
  direct keys, bearer auth, ECS credentials (including authorization tokens),
  web identity, and profile/config chains that do not invoke a subprocess.
  Before provider modules load, the worker disables every Node child-process
  entry point, so `credential_process` fails closed instead of escaping the
  owned UtilityProcess; foreground model use is unchanged.
- The first isolated request in each child runtime has one strict startup-only
  retry envelope: at most four fresh worker launches with 250/750/1500 ms
  backoff. A retry is permitted only for a nonzero exit within two seconds and
  before any worker IPC, provider hook, model event, usage, or tool activity. A
  two-way ready/ack barrier prevents request-specific provider construction or
  network work until main has observed the worker. Cancellation owns the
  backoff, while launch, protocol, IPC, and main-owned provider-hook faults use
  private typed host provenance and never become Pi transcript messages or
  provider-usage aggregates.
- Foreground visible-turn commits acknowledge only foreground-lane effect
  evidence. Child Pi sessions are intentionally in-memory, so child effects
  remain recovery-pending across a foreground commit and process restart until
  an explicit private no-repeat boundary is durable in the foreground journal.

## Trusted contribution compatibility matrix

| Pi-shaped capability                                   | Aiden adapter                       | Boundary                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| System prompt and tools                                | Supported                           | Trusted foreground modules; one immutable operation snapshot; all tools sequential                                       |
| Skills                                                 | Supported for disk-backed resources | Same leased skill revision used by prompt/tool construction; configured in-memory skills retain Aiden's invocation lease |
| Prompt templates                                       | Snapshotted/exported                | No renderer command surface yet                                                                                          |
| Provider request/payload/response hooks                | Supported                           | Curated secret-free request options; host auth/payload policy last; response observers passive                           |
| Custom session entries                                 | Supported                           | Custom non-`aiden.*` types only; one bound Session projection across generation/compaction/retry                         |
| Canonical runtime events                               | Supported                           | Renderer-safe envelopes; observers never own durability or settlement                                                    |
| Steer/follow-up                                        | Supported in managed runtime        | Active run only; user messages only; durable on drain; product UI remains intentionally single-turn                      |
| Child contributions                                    | Not ambient                         | Requires explicit authority/budget narrowing before any future opt-in                                                    |
| Coding-agent commands/UI/process/provider registration | Unsupported                         | Requires a separately signed or sandboxed plugin loader                                                                  |

## Trust policy

The contribution registry accepts main-owned trusted modules. A user-selected
arbitrary TypeScript/JavaScript path is not loaded in the Electron main
process. Pi coding-agent's executable extension loader would grant ambient
filesystem, process, credential, and network authority and requires a separate
signed or sandboxed plugin design.

## Remaining work

None in the original delivery scope. New executable plugin-loading or broader
Pi coding-agent compatibility belongs in a separate signed/sandboxed plugin
plan rather than widening this trusted main-process adapter.

## Known lower-priority adapter limits

- Passive observer drains are deliberately excluded from run, cancellation,
  and disposal settlement. The explicit diagnostic `settleRuntimeObservers()`
  can still wait for a trusted observer that ignores its abort signal.
- Canonical observer delivery is bounded and may drop the oldest pending
  envelope under sustained backpressure; the current public envelope does not
  yet carry a dropped-event count.
- Runtime-event `attempt` is local to one input segment. If an already accepted
  queued user segment is recovered after a failed provider attempt, its attempt
  counter restarts at one while envelope sequence and turn identity remain
  monotonic for the overall managed run.
- Binding extension entry projectors reopens the Aiden-created Session storage
  with the operation snapshot. A future general plugin loader must compose or
  reject any pre-existing non-Aiden Session projector configuration instead of
  assuming the production Aiden Session factory.
- Passive legacy Agent-event observations share one bounded operation pool, so
  an especially noisy trusted observer can reduce best-effort delivery to its
  peers. Canonical reducer state and durability are unaffected.
- Trusted JavaScript contribution outputs receive structural cloning and the
  closed checks needed by each active boundary, but do not yet share one
  schema-level validator for every Pi message and tool-result variant.
- The private never-replay argument digest is unkeyed. Its file is `0600`, but
  a future store version should use a keychain-backed HMAC before treating the
  digest as resistant to same-user offline guessing of low-entropy arguments.
- A signed-package smoke that launches the real utility worker without making
  a provider request remains a release-soak improvement; build and package
  contracts currently prove the worker is emitted, bounded, and packed.
- The startup-duration window begins before launch verification. Slow launch
  overhead can conservatively suppress a retry, which preserves safety at the
  cost of availability.
- Process identity verification uses a bounded synchronous `ps` probe in the
  Electron main process. A future implementation should move it off the UI
  thread while preserving the exact nonce-bound identity proof.
- The helper-level retry and cancellation matrix is covered, but a signed-app
  end-to-end test of first-request-only retry and shutdown during backoff
  remains part of the packaged smoke above.
- The foreground V2 control registry does not currently produce run-state
  `unknown`; if it is later shared with background recovery, its terminal-state
  set must add `unknown` to match the renderer and lifecycle contracts.
- A worker that never receives its ready acknowledgement remains owned until
  the child deadline or cancellation. A short worker-side ready-ack watchdog
  would improve availability without changing the zero-activity retry proof.
- Main-owned provider-hook continuations are fenced from late protocol output
  but are not part of isolation shutdown settlement if a trusted hook ignores
  cancellation; a future bounded hook-drain registry would improve diagnostics.
- Map-reduce compaction keeps a 128-token minimum fragment. On an unusually
  small context window the accumulated summary plus that fragment can exceed
  the computed safe input, causing conservative compaction failure rather than
  producing an invalid request.
- The seal-current-turn fallback performs its final Session append/move repair
  directly. Moving those calls under the common journal-operation wrapper would
  improve fault taxonomy and quarantine diagnostics for storage failures.
- The worker environment allowlist preserves reviewed positive Bedrock
  credential sources but not every negative or ancillary AWS SDK control (for
  example `AWS_EC2_METADATA_DISABLED`); expand only with provider-parity tests.
- Package verification proves the bootstrap lockdown and that both worker
  artifacts are emitted and packed, but it does not yet execute or
  semantically hash the provider runtime artifact inside a signed app.

## Gates

- Runtime adapter unit tests cover sequencing, extension isolation, critical
  subscriber failure, contribution snapshots, durable-before-effect ordering,
  prior-tail repair, typed failure privacy, policy termination, and
  cancellation during retry, session/storage waits, and active compaction.
- Coverage injects a non-cooperative journal mutation during between-tool
  compaction and asserts its detached settlement remains exposed for the
  production-store quarantine.
- Child/supervisor tests cover fork identity, empty completion, terminal-only
  output, hidden protocol limits, construction abort, aggregate budgets,
  exact queued cancellation, quarantine recovery, and renderer-safe activity.
- Three final fresh-memory adversarial gates returned GO after the ready/ack,
  compaction-provenance, canonical-durability, usage-accounting, package
  lockdown, and child-effect recovery fixes.
- `npm run type-check`, `npm run lint`, `npm run test:compaction` (169 tests),
  the complete `npm run test:subagents` matrix (649 JS tests plus native helper
  and package gates), `npm run build:electron`, and package verification pass.
