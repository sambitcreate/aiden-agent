# P1 owners kept as they are

Each owner below was traced for the state-machine migration and already centralizes its transitions, so an extraction would add a layer without removing a writer. `retain` means the existing code stays authoritative.

| Inventory | Owner | Disposition | Why |
|---|---|---|---|
| `backend:M008` | `main/services/chat-run-input-admission.ts` | Retain, one fix | One linear function with a single writer. The probe, persist, recheck and queue steps are already ordered, and `chat-run-input-admission.test.ts` covers each race. |
| `backend:M009` | `main/services/renderer-document-owner.ts`, `chat-generation-owner.ts` | Retain | Invalidation is one-way and listeners are removed once. The inventory places it in rank 1, so any identity change belongs with the authority work. |
| `backend:M015` | `main/services/host-run-registry.ts` | Retain | Every run state change goes through `commit`. A terminal event clears prompts, and otherwise pending prompts decide the state. |
| `backend:M178` | `AidenRemoteStateRegistry` in `main/services/aiden-remote-state.ts` | Retain | The block is set before the durable write, a failed write lifts it, and the drain waits only after the revocation is durable. |

`backend:M012` (`main/services/pi-agent-runtime-harness.ts`) is partly extracted. The run gate moved into `pi-managed-run-state.ts`: whether a managed run is live, whether its queue is open, and whether a Stop applies. Queue contents, tool maps, durable operations and abort controllers stay in the harness. Compaction, persistence and model completion remain separate transitions there.

`reset` keeps `shutdownInterrupted`, as it did before. Harnesses serve one generation, so it cannot reach another run through `llm-client`.

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
