# Live subagent context window

Status: Complete (desktop) — merged in [PR #271](https://github.com/sambitcreate/aiden-agent/pull/271) on 2026-09-29 and shipped in 0.51.0. Remote, iOS and Android live context remain a follow-up. Source: pi-subagents #2448, reusing the #187 context meter's formatting and 80% warning threshold.

## Goal

While a child agent runs, show how full its context window is, so a user can see which child is close to its limit before it fails or compacts.

## Design

- **Figure.** After each child provider response, `SubagentEventProjector.usage()` builds `{tokens, window}`. `tokens` is the response's reported usage total, the same figure Pi uses as a response's context size. `window` is the child model's `contextWindow`. No reading is made when the model has no window or the provider reported nothing.
- **Transport.** The reading goes on a separate `chat:subagent-context` notification, emitted by `llm-client` through `sendGeneration`. It is **not** a snapshot field. The reasons:
  - Snapshot parsers use exact key sets, so older builds would reject a new field.
  - History and detail reads gate on revision monotonicity and exact replay, and a reading per response would bump revisions.
  - Durable writes are capped per run.
  - Remote progress would churn on every child response.
- **Renderer.** `renderer/lib/subagent-context-usage-store.ts` is a bounded, in-memory LRU of up to 32 chats × 64 runs. The panel shows a reading only while the run's view state is active. Terminal runs drop their reading.
- **UI.**
  - Each active roster row shows a gauge icon with the percentage, and says it in the row's accessible name.
  - The detail pane adds `Context window: 84K / 200K tokens (42%)` under the model line.
  - Both use the warning tone at 80% or more.

## Follow-ups

- Remote, iOS and Android: the Remote roster reads persisted snapshots, so live readings need a Remote side channel and a contract revision.
- Show readings in the message-list subagent chips.
- The percentage is of the full window, not the usable input budget (window minus reserved output).
- Readings sent before any subagents panel has mounted in the window are not replayed.
