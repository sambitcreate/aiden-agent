# Thinking Traces + Context Awareness

Two coupled UX primitives, both sourced from existing runtime truth:

1. **Ordered thinking traces** — `AgentThinkingStep` gains `reasoningStart`/`reasoningEnd` offsets into the persisted `ChatMessage.reasoning` buffer, so provider-exposed reasoning renders in true chronological position around tools and text instead of one flattened block. `contentOffset` still anchors visible text; reasoning text is never duplicated onto steps.
2. **Context meter** — the composer's quiet indicator + details popover surface `projectNextContextUsage()` (the same projection that drives runtime compaction). No second estimator.

Deferred: sticky Think/compaction headers, subagent sidebar chat, long-form compaction summaries.

## Rules that don't change

- Malformed offsets fail closed per step; legacy messages keep the legacy `ReasoningBlock` — no history migration.
- Only provider-exposed reasoning is displayed; no hidden chain-of-thought, no private Pi/runtime state in the renderer projection.
- Work groups collapse to `Worked for 23s · 4 tools · 3 thoughts`; expanding the group never expands the thoughts inside it.
- The meter's headline number is usable-input pressure (`percentOfUsableInput`, unclamped past 100%) so it matches the runtime compaction trigger; estimates render with `~`.

## Phases

| Phase | Status | Notes |
| ----- | ------ | ----- |
| P0.1 Context projection + composer meter | Implemented | `projectChatContextPressure`/`chatContextPressureFromProjection` in `main/services/generation-context.ts`; `context-pressure.ts` service with ambient profiles + journal; `chats:contextPressure` IPC; `ContextMeter` + popover; ambient `chat:context-pressure` pushes on projection/preflight/compaction. |
| P0.2 Reasoning segment offsets | Implemented | `GenerationTimeline` v3; projector `thinkingStarted/Ended(reasoningOffset)`, `toolStarted(..., offset)`, `reconcileReasoningOffsets`, `rewindReasoningOffset`; parse bounds start-only iff open, non-overlapping, `≤ reasoning.length`. |
| P0.3 Chronological transcript | Implemented | `assistantPresentationRows(content, reasoning, timeline)` emits thinking steps inside activity rows; `hasValidReasoningSegments` gates segmented render with whitespace-covered check. |
| P0.4 Collapsible work groups | Implemented | `ThoughtDisclosure` (independent, plain-text, 1s live preview); `TrailRow` milestone fallback; `workGroupSummary`. |
| P0.5 Mobile parity | Implemented | openapi.json + contract.json fixtures + iOS `reasoningStart`/`reasoningEnd` + `reasoningText(in:)` + Android equivalents; persisted projection unchanged (no reasoning text on the wire). |

## Testing

Focused suites: `generation-timeline`, `generation-context`, `agent-steps`, `activity-feed`, `chat-session-params`, `context-pressure` (new). iOS/Android focused decode/bounds tests added; physical-device acceptance remains a release gate.
