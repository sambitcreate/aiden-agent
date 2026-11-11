# Generation run worksheet

Inventory: `backend:M005`, `backend:M177`, and the terminal boundary of rank 8. Owner: `main/services/llm-client.ts`, with settlement in `main/services/generation-settlement.ts`. `llm-client.ts` is not split into one enum: Pi journal faults, cut-off continuation and visible-versus-durable reconciliation stay child owners (`backend:M173` to `M176`).

## Axes

| Axis | Values | Where it lives |
|---|---|---|
| Phase | initializing, running, settled | Which map holds the entry. `active.set` happens before `initializing.delete`, with no await between. Settled means neither map holds it. |
| Stop | not requested, requested with first origin | `cancelRequested` and `cancellationOrigin` on the entry. A later origin never replaces the first. |
| Renderer | attached, detached | `rendererDetached`. Detaching does not cancel work. |
| Terminal report | failed, empty, finished | `decideGenerationTerminal`, from the runtime outcome and whether anything visible exists. |
| Save outcome | saved, not saved | `persisted.error`. A finished reply that did not save reports `chat:error`, never `chat:done`. |

## Ending a run

| Path | Who ends it | Terminal event |
|---|---|---|
| Registration throws inside `handoff` | `start`, after the lease is released | `start` rejects |
| Preparation throws, Stop requested | Catch around `prepareGeneration` | `chat:done` with `cancelled`, `start` resolves `false` |
| Preparation throws, no Stop | The same catch | `start` rejects |
| Agent setup throws | Catch around setup, with or without Stop as above | As above |
| Stop arrives just after promotion | `abandonPromotedRun` | `chat:done` with `cancelled`, `start` resolves `false` |
| Anything else thrown before the completion task | `runAdmittedGeneration` through `escape.settle` | `start` rejects |
| Runtime returns or throws | The completion task's `finally` | `chat:done` or `chat:error` |

`settleGeneration` is the only exit. It runs once per entry, so paths may overlap safely. It runs every step even if one throws, and rethrows the first failure afterwards. It removes only its own entry from the map, so a replacement under the same stream ID stays. The order is: skill reservation, Bot authority, approved artifacts, map entry, owner listener, approvals, questionnaires, settled broadcast. The broadcast is last so `chats:settled` never reaches a client while the chat still looks busy.

`escape.settle` always describes the current step. It settles the initializing entry, then the promoted run once `active` holds it, and does nothing once the completion task exists. From there the task's `finally` owns the run: a throw in the steps before `settleGeneration` cannot skip it, and `designRun.onSettled` still runs. Physical teardown of a promoted run happens once, even when the escape path follows a teardown that failed.

## Owed turn

An ordinary chat run (no Bot, Assistant mode, interaction surface or other owner) opens an entry in the owed-turn registry (`main/services/chat-owed-turns.ts`) just before it is published as active. Input admission holds that entry while it saves a message. An input saved after Pi closed its queue is registered there, and only then is its receipt `follow-up`; if registration fails the receipt is committed-but-not-admitted. Each settlement path calls `settleRun`, which ends ownership through `settleGeneration` and then, in a `finally`, settles the entry with the committed queue items Pi never drained and whether the run recorded a Stop, so a throwing cleanup step never skips it. Once every hold is released, the registry starts one ordinary chat turn for the owed input, or nothing if the run recorded a Stop, the chat is being deleted, or Aiden is quitting. A Stop that reaches the stream after it recorded its outcome is kept on the entry, and the owed turn is stopped as soon as it registers. While holds are open, `chatHasGenerationOwnership` treats the chat as busy.

The owed turn's owner is headless (`id: 0`), like a phone's. Its `send` keeps the turn's approval and question cards in `main/services/chat-owed-turn-prompts.ts`. The desktop reads them through `remote:getPendingApproval` and `remote:getPendingQuestion` after a phone turn's card, and answers through the same host IPC; phones answer through `runs:control`. Settlement is one-shot in the coordinators, so the first answer wins, and an unanswered card is denied or closed after five minutes.

## Commit points

- **Ownership:** registration inside `chatTurnAdmission.handoff`.
- **Durable reply:** `persistAssistant` returning without `error`, then `finalizePiTurnPersistence`.
- **Visible terminal:** `chat:done` or `chat:error`, always after the save attempt.
- **Physical release:** `settleGeneration`. Stop alone releases nothing.

A terminal event is not proof of a durable save. `chat:error` says so when the save failed.

## Stale events

- A late path from an old run cannot delete a replacement in the same map slot, whether or not the old entry had settled.
- `persistGenerationInitializationTerminal` writes only while its entry is still current.
- `cancel` and `detachRenderer` check the owner's document ID against the entry.

## Not covered

A throw between setup finishing and promotion settles the initializing entry but does not reset the candidate agent. No such throw is known: that stretch only defines closures, apart from `observePendingUserGuidance`.
