# P1 owners kept as they are

Each owner below was traced for the state-machine migration and already centralizes its transitions, so an extraction would add a layer without removing a writer. `retain` means the existing code stays authoritative.

| Inventory | Owner | Disposition | Why |
|---|---|---|---|
| `backend:M008` | `main/services/chat-run-input-admission.ts` | Retain, one fix | One linear function with a single writer. The probe, persist, recheck and queue steps are already ordered, and `chat-run-input-admission.test.ts` covers each race. |
| `backend:M009` | `main/services/renderer-document-owner.ts`, `chat-generation-owner.ts` | Retain | Invalidation is one-way and listeners are removed once. The inventory places it in rank 1, so any identity change belongs with the authority work. |
| `backend:M015` | `main/services/host-run-registry.ts` | Retain | After `begin` sets `working`, every run state change goes through `commit`. A terminal event clears prompts, and otherwise pending prompts decide the state. |
| `backend:M178` | `AidenRemoteStateRegistry` in `main/services/aiden-remote-state.ts` | Retain | The block is set before the durable write, a failed write lifts it, and the drain waits only after the revocation is durable. |

`backend:M012` (`main/services/pi-agent-runtime-harness.ts`) is partly extracted. The run gate moved into `pi-managed-run-state.ts`: whether a managed run is live, whether its queue is open, and whether a Stop applies. Queue contents, tool maps, durable operations and abort controllers stay in the harness. Compaction, persistence and model completion remain separate transitions there.

`reset` keeps `shutdownInterrupted`, as it did before. Harnesses serve one generation, so it cannot reach another run through `llm-client`.

## Host and harness owners

Audited by a read-only review. Except where marked, these are inspection results, not exhaustive proof.

| Inventory | Owner | Disposition | Why |
|---|---|---|---|
| `backend:M021` | `rpiv-btw/service-core.ts` | Retain, one fix | Reservation ownership is local to the service. A throwing owner hook no longer keeps the slot. |
| `backend:M023` | `bot-runtime/harness-host.ts` | Retain | Per-Bot serialization owns open and close, and failed teardown keeps ownership. |
| `backend:M024` | `bot-runtime/bot-session-service.ts` | Retain | Mutating commands use the per-Bot serializer, and durable harness state is the source of truth. |
| `backend:M035` | `bot-lifecycle-journal-core.ts` | Retain | Serialized operations validate predecessor stages and write cloned documents. |
| `backend:M100` | `subagents/subagent-supervisor-core.ts` | Deferred | Cancellation, cleanup and budget settlement are spread across nested and top-level paths, so extraction would be useful. No ordering defect was found, and it needs the P5a process-settlement work first. |
| `backend:M101` | `subagents/subagent-nesting-core.ts` | Retain | The ledger and scheduler each own their counters. |
| `backend:M105` | `subagents/subagent-control-v2.ts` | Retain | Updates converge on `publish` and terminal cleanup. |
| `backend:M106` | `subagents/background-subagent-coordinator-v2.ts` | Retain, six fixes | The durable lifecycle stays the authority. A launch registers itself before durable acceptance and holds requests until `active` has the child, so a Stop cannot be acknowledged as queued. A launch that fails before its child starts stops that child. A bulk invalidation stops an installing child itself before it returns, and one that beats acceptance leaves a failed run instead of a queued one. It reads the store again after aborting, so a run that went live after the first read still ends durably. While either read runs, a launch the invalidation covers is refused, so nothing can be accepted behind the last read. All were reproduced in `background-subagent-coordinator-v2.test.ts`. |

## First send and terminal persistence

| Inventory | Owner | Disposition | Why |
|---|---|---|---|
| `backend:M007` | `main/services/chat-first-message-commit.ts` | Retain | `committed` and `workSettled` are two locals in one function, and the turn lease already holds the state that outlives it. An owner lost during the durable write keeps the workspace operation until that write settles, and the sender's answer agrees with the disk. `chat-first-message-commit.test.ts` covers that order. The ranking also lists this under P3 for retry and idempotency; those stay with P3. |
| `backend:M013`, `M173`, `M174`, `M175`, `M176` | Generation timeline and Pi journal child owners in `llm-client` and its helpers | Retain as child owners | P1 settles the generation terminal boundary around them and does not flatten them into the run phase. Their internals were not audited here. Durable reconciliation belongs to P4. |
| `backend:M022`, `M159`, `M194` | Fork summary, Pi session compaction journal, subagent activation journal | Not changed | They do not cross the generation terminal boundary. Not audited here; they stay with P4. |

## Renderer adapters

The P1b work changed no IPC, so these needed no adapter change.

| Inventory | Owner | Disposition | Why |
|---|---|---|---|
| `clients:C02` | `renderer/lib/chat-message-queue.ts` | Retain | `claim`, `settle` and `deliverQueuedMessage` are the only route for delivering a queued message, and `chat-message-queue.test.ts` covers stale chats, drafts and unknown appends. |
| `clients:C03` | `renderer/main/chat-pane.tsx` | Deferred | The orchestration is spread through a 4,166-line view. Moving it needs a UI test harness first, and it holds no authority of its own: the host decides. |
| `clients:C04` | `renderer/lib/generation-stream.ts` | Retain, one fix | One subscription per stream. The first terminal event now blocks any later terminal event, because listeners stay on while an async `onDone` settles. Disposal runs even if a terminal handler throws. |
| `clients:C05` | `renderer/lib/chat-terminal-sync.ts` | Retain | Identity-keyed registries with bounded retries, covered by `chat-terminal-sync.test.ts`. Not re-audited beyond the entry points. |
| `clients:C11` | `renderer/lib/hosts/remote-queue-fence.ts` | Retain | `remoteQueueFenceHolds` is pure and tested. Two overlapping `sendFencedTurn` calls can replace each other's fence. The 120 s stall bounds how long a fence can hold, but not the ordering. Whether two can overlap in practice was not established. |
| `clients:N15` | iOS `AidenChatFeature.swift` | Unchanged, not audited | No shared contract changed, so nothing here needed native work. That says nothing about how its ownership is structured. |

## Run input transitions

| Step | Guard | Result if refused | Draft |
|---|---|---|---|
| Identify | Stream is live, chat and owner match, input open | `run_not_active` | Kept |
| Stop check | No Stop, chat not being deleted | `cancelled` | Kept |
| Queue probe | Queue would accept | The probe's reason | Kept |
| Persist | Still the live run and not stopped, checked inside the store write | `cancelled` or `run_not_active` | Kept |
| Recheck | Still the live run, not stopped | Same reasons, with `committed: true` | Consumed |
| Queue | Receipt accepted | The receipt's reason, with `committed: true` | Consumed |

A persist whose outcome is unknown throws `AidenOperationUnknownOutcomeError`, as does a queue call that throws. Once the message is saved it stays saved: a late refusal reports `committed: true` and never replays the input.

The one fix: both the persist and recheck steps now treat a chat deletion that began during the save as a stop. Before, only the first check saw it, so input could reach a run whose chat was being deleted.
