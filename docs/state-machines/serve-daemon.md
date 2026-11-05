# `aiden serve` daemon state machines: transition worksheets

Lane D of the explicit state-machine migration. These worksheets record how the `aiden serve` owners behave at this baseline so an extraction can be checked against them. IDs are `cli-native:Cnn` from the state-machine inventory. A ranking there is architectural priority, not a confirmed defect. A defect is named here only when a test reproduces it.

Baseline: `bc663001f`. Oracles live in `packages/cli/tests/daemon-turns.test.mjs` (C09, C10, C11) and `packages/cli/tests/serve-lifetime.test.mjs` (C03, C04, real processes), plus the existing `tests/parity.test.mjs` lifecycle cases and `tests/runtime.test.mjs`.

Local baseline before any extraction: every CLI suite passes. A fresh worktree first fails one `tests/extensions.test.mjs` case that evaluates `src/` directly, because `build/native/aiden-lease-flock` does not exist until the native helpers are built. That is checkout state, not a product failure.

## C09: daemon turn admission and handoff

Owner: `DaemonTurnOwner` in `packages/cli/src/daemon-turn-lifecycle.ts`, over the shared `ChatTurnAdmission`, whose axes (authority, preparation) it reuses. It is the single writer of per-chat custody. `isChatBusy`, capacity, idle waits and shutdown all read that one map.

Custody is `lease` (with preparation `pending` or `settled`), `settling` (revoked, admitted work still running), `generation`, or idle. Intake is `open` or `closed`.

| Event | Prior custody | Guard | Next | Effect | Linearization point | Visible result |
|---|---|---|---|---|---|---|
| `beginChatTurn` | idle | intake open, chat not deleting, fewer than 3 chats in `lease` or `generation`, admission accepts | `lease`, `pending` | lease with 60 s expiry | `admission.tryBegin` | lease |
| `beginChatTurn` | anything else, or a guard fails | | unchanged | none | | `null` |
| `settleAsyncWork` | `lease`, `pending` | same lease | `lease`, `settled` | wakes idle waiters | | |
| `settleAsyncWork` | `settling` | same lease | idle | wakes idle waiters | | |
| lease release or expiry, `cancelChat` | `lease`, `settled` | same lease | idle | frees the slot | `lease.release` | |
| lease release or expiry, `cancelChat` | `lease`, `pending` | same lease | `settling`: no capacity, chat still busy, shutdown waits | | `lease.release` | later `start` refuses |
| `start` | `lease`, `settled` | intake open, owner live, same chat, turn and owner | `generation` | session-file lease, then `handoff` registers custody, activity and run journal, then releases the lease | `admission.handoff`, one synchronous step | `true` |
| `start` | anything else | | unchanged | session-file lease released if taken | | `false`, no event |
| generation released | `generation` | same run | idle | run's `settled` resolves | `turns.release` | |
| `stop` | any | | intake closed | revokes every lease, cancels with `application_shutdown`, waits for every held chat | `closeIntake`, before the first await | `beginChatTurn` and `start` refuse |

A lease or run whose chat has moved on to a newer entry changes nothing. Stale events are dropped by entry identity.

Capacity stays as it was: a `settling` chat takes no slot, because it can start nothing. Its bytes stay charged in `ChatTurnAdmission`.

Retained: `ChatTurnAdmission` and `ChatDeletionGate` are the shared owners. Lane A owns their internals.

## C10: daemon generation execution and persistence

Owner: `DaemonGenerationRun` in `daemon-turn-lifecycle.ts`, driven by `perform` in `daemon-chats.ts`.

| Stage | Entered by | Stop request | Failure | Terminal |
|---|---|---|---|---|
| preparing (chat, Bot authority, workspace, runtime, extensions) | `start` | seen at the next `assertAuthority` | `chat:error`, no answer saved | `failed` or `cancelled` |
| session bound | `createAgentSession` | session abort | same | same |
| prompting and tools | `session.prompt` | session abort, approval lapses | partial answer saved once when any text or message exists | same |
| final save | prompt ended with a final assistant message | not observed, the save completes | save failure: `chat:error`, then one retry as the partial answer | `completed` only once `appendMessage` returned |
| cleanup | always | | handler errors stay contained: Pi's `emit` catches them | `session_shutdown`, dispose, closers, usage |
| released | `perform` settled | | each cleanup step runs whatever an earlier one threw | custody cleared, activity settled, run journal settled, session-file lease released, `settled` resolved |

Independent axes: stop request (`requestStop`, with its first origin), terminal persistence (`none`, `final_saved`, `partial_saved`, `partial_lost`), client delivery, physical release. `chat:done` is sent after the durable save and before cleanup, so a chat stays busy briefly after `chat:done`. A timeout or lost owner is a stop with no origin.

Kept as it was, and worth a product decision: when the final save fails, `chat:error` carries a timeline already finished as `completed`, because the timeline is written into the message being saved.

## Defects fixed during extraction

Each has a reproduction in `packages/cli/tests/daemon-turns.test.mjs` that failed before its fix.

- **Shutdown did not wait for revoked work.** `stop()` listed only live leases and running generations. A cancelled or expired reservation whose append was still in flight was dropped from the list, so the process could exit under the write.
- **A stop during a Bot authority check did not stop the prompt.** The Bot branch of `assertAuthority` returned straight after its awaited revalidation. A stop landing there let `session.prompt` run: the session abort had already come and gone, and Pi contains the `before_agent_start` rejection, so a provider request went out. The tool path had the same gap.
- **A failed session-lease removal hung idle waiters.** An exception in `release` skipped resolving `settled`, so `waitForChatIdle` and shutdown never returned.
- **A throwing activity listener reported idle with the session lease held.** One `try` covered activity, run journal and lease removal, so a listener that threw skipped the other two while `settled` still resolved. The next turn on that chat then failed to take its lease. Each step now runs on its own.
- **A run that failed to register held the chat forever.** If `activity.begin` or the run journal threw inside `handoff`, custody stayed `generation` with a run that nothing would ever start or release, so the chat stayed busy and `stop()` hung. `start` now returns the chat and rethrows.

## C11: daemon tool approval

Owner: the shared `ToolApprovalCoordinator` (`main/services/tool-approval.ts`, Lane B's), which holds one-shot settlement, owner scoping and abort. `packages/cli/src/daemon-approvals.ts` adapts it and adds only the 300 s expiry, the `approval_` id and the journal decision. The `tool_call` handler in `daemon-chats.ts` keeps the grant recheck. `full` runs with no prompt, `none` blocks, `ask` prompts. Bot tools follow the capability grant instead.

| Event | Prior | Guard | Next | Effect | Visible result |
|---|---|---|---|---|---|
| tool call, `ask` | | arguments at most 1,700 bytes, run not stopping | pending | registered, expiry armed, attention raised | `chat:approval` |
| publish throws | pending | | unavailable | attention withdrawn | tool blocked |
| owner answer | pending | same owner | allowed or denied | journal records the decision, attention withdrawn | `approve` returns `true` |
| host answer | pending | `runs:control` at the caller | allowed or denied | same | `approveAsHost` returns `true` |
| any answer | not pending, or another owner | | unchanged | none | `false` |
| expiry | pending | | expired | journal records `expired` | tool blocked |
| turn abort | pending | | cancelled | journal records `cancelled` | tool blocked |
| grant recheck | allowed | authority current, arguments unchanged, access not `none` | dispatched | tool runs | `chat:tool` result |
| grant recheck | allowed | any check fails | blocked | none | model hears the refusal |

A publish callback that settles its own prompt synchronously leaves raised attention unwithdrawn in the coordinator on `main`. That belongs to the shared owner, and Lane B's `publishing` phase in #738 handles it.

Linearization: the grant is checked again after the wait, so a late `allow` cannot outrun a revocation. The generation's own 300 s timer starts first, so in practice it ends a waiting prompt as `cancelled` before that prompt's expiry can fire.

## C03: serve admission and resource lifetime

Owners: `ServeLifetime` in `packages/cli/src/serve-lifetime.ts` for the control socket's phase and accepted commands, driven by `serve` and `serveOwned` in `packages/cli/src/serve.ts`.

| Phase | Entered by | Control socket | Chat admission | Leaves when |
|---|---|---|---|---|
| lease held | `acquireLease` | absent | none yet | a throw releases the lease |
| `starting` | Remote, socket, scheduler, Telegram | answers once bound | open | ready, failure or a signal, into draining |
| `serving` | `markServing`, before `onReady` | answers | open | signal |
| `draining`: ingress closed | `beginDrain` | refuses new connections and commands | `chats.stop()` closes it synchronously | |
| `draining`: services | `Promise.allSettled` of chats, Bots, Telegram, Remote, scheduler | accepted commands keep running | closed | all settled |
| `draining`: commands | `settleCommands` | clients destroyed only afterwards | closed | every accepted command answered and its reply flushed, or its client gone |
| released | socket removed, MCP recording stopped, lease released | absent | closed | process exit |

Order matters in two places: `chats.stop()` runs first so no other stopping ingress can begin a turn, and every accepted command settles before the lease is released. A hung command therefore holds shutdown: `aiden serve stop` escalates to KILL at its deadline, and a second signal ends a foreground server.

A signal in `starting` drains the socket at once and skips every later startup step, without reporting ready. A step already running finishes first, so one that never settles is ended by `aiden serve stop` at its deadline.

**Defect fixed:** a signal during startup was not seen until all of startup had finished. The socket kept taking commands, the scheduler and Telegram still started, and `onReady` still fired.

**Defect fixed:** an accepted command was not tracked, so shutdown destroyed its client and released the lease while it was still changing state. The client saw `Daemon closed without a response`, and the write could land with no owner. Reproduced in `tests/serve-lifetime.test.mjs`.

## C01 and C02: daemon ownership, startup, shutdown and stale recovery

Owner: `packages/cli/src/serve-lifecycle.ts`, over `acquireLease` (`state.ts`). Covered by the `tests/parity.test.mjs` lifecycle cases: stale `flock-v1` metadata, legacy live owners, recycled PIDs, lease replacement during stop, forced stop with and without a detached group, recorded MCP groups, and failed startup.

Start: start lease, recover stale lease, refuse when running, spawn, poll until the socket answers and `owner.pid` is the spawned PID, or TERM, wait 2 s, KILL the group.

Stop decisions are pure tables in `packages/cli/src/serve-ownership.ts`. Signals, polling and cleanup stay in `serve-lifecycle.ts`. Startup stays there too: it is one linear path under its start lease, so a machine would add nothing.

| When | Observed | Decision |
|---|---|---|
| Before signalling | `daemon` | TERM, then poll |
| | `gone` or `foreign` | clear artifacts under the guard, report `not running` |
| | `aiden` | refuse: a one-shot command holds the lock |
| | `unknown` | refuse: nothing can verify it |
| While polling | lease gone or owner changed | stopped |
| | PID gone, or `foreign` on the periodic check | clear artifacts, stopped |
| At the deadline | owner changed | stopped: a replacement is not the daemon asked to stop |
| | same owner, `daemon` | KILL (its group only when `detached` and it leads the group) plus recorded MCP groups, then wait for `pidAlive` to confirm exit |
| | same owner, `gone` or `foreign` | clear artifacts, stopped |
| | same owner, `aiden` or `unknown` | report that the stop is unconfirmed, keep the lock, and advise no signal |

Evidence of exit is `pidAlive`, never the signal.

**Defect fixed:** the periodic `foreign` check ran only every tenth poll, so a PID that stopped being ours just before the deadline fell through to `did not stop ... try kill -9 <pid>`, sending the person to kill an unrelated process. Reproduced in `tests/serve-lifetime.test.mjs` with a process that `exec`s into something else.

## C04: local daemon command framing

Owners: `remoteDaemonCommand` (`daemon-control.ts`) and the socket handler in `serve.ts`. One request per connection, framed by a newline, 64 KiB request ceiling, 8 MiB response ceiling, UTF-8 decoded across chunks. The client settles once for result, error, closed without a frame, oversized reply and transport error. It is a stream parser, not a product mode. Retained as it was, with no state model: that would add nothing to a one-shot parser.

**Defect fixed:** both ends parsed their whole buffer, so a frame followed by more bytes in the same chunk failed as bad JSON, while the same bytes in two chunks succeeded. Each end now reads only its first frame, and its ceiling applies to that frame alone.

**Defect fixed:** when the chunk that crossed the 8 MiB ceiling also completed the frame, the client destroyed the socket and then parsed and returned the reply anyway, so the ceiling did not hold on the last chunk.
