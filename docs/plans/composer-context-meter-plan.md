# Composer Context Meter

Status: Implemented in [PR #187](https://github.com/sambitcreate/aiden-agent/pull/187); review and visual acceptance pending.

## Objective

Show how full the next provider request will be, beside the model picker, using the same projection the runtime uses to decide compaction. No second token estimator.

## Scope change

PR #187 originally also carried ordered thinking traces (reasoning offsets on thinking steps, mobile decoders, a per-thought disclosure inside work groups). [PR #224](https://github.com/sambitcreate/aiden-agent/pull/224) ([Chronological Chat Motion](chronological-chat-motion-plan.md)) shipped that on main with `reasoningStartOffset`/`reasoningEndOffset`, canonical reconciliation, standalone reasoning rows, and iOS/Android parity. The 0.50.0 update keeps main's implementation and lands only the context meter from this PR. The Remote protocol, fixtures, and native clients are unchanged.

## Contract

- `projectChatContextPressure` and `chatContextPressureFromProjection` in `main/services/generation-context.ts` turn `projectNextContextUsage()` into the renderer-safe `ChatContextPressureV1` (`renderer/shared/context-pressure.ts`).
- The headline number is `percentOfUsableInput`. It reaches 100 exactly where `shouldCompact` trips and is never clamped. Estimated figures render with `~`.
- `main/services/context-pressure.ts` serves `chats:contextPressure`. It reuses the live options of the chat's last generation when the provider, model, window, and image support still match. Otherwise it builds an ambient estimate with `buildSystemPrompt` from `chat-system-prompt.ts` and local tools only. It never opens MCP connections. The composer's draft text, attachment sizes, and unsaved model selection are folded into the projection.
- `PiAgentRuntimeHarness` emits `onContextProjection` at every compaction check and after a message swap. `llm-client` pushes those projections as `chat:context-pressure`. Observer errors never affect the run.
- A manual compaction invalidates the journal snapshot and pushes a fresh projection to the requesting document. Deleting a chat releases its cached profiles.

## Presentation

`ContextMeter` is a transparent `Button` with a gauge icon and the percentage. It opens a popover with projected, window, and reserved tokens, the conversation vs. system/tools split, and one state line. The warning tone appears only when compaction is pending or running. The 80% "approaching" phase is presentation-only.

## Testing

`generation-context.test.ts`, `renderer/shared/context-pressure.test.ts`, `renderer/components/context-meter.test.tsx`, `chat-session-params.test.ts`, the harness observer test in `pi-agent-runtime-harness.test.ts`, and the `ipc-stream.test.ts` subscription count. Visual acceptance in light and dark themes remains open.
