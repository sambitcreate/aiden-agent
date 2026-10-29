# Generation timeline step bound (2026-10-29)

Every timeline reader rejects more than 200 steps (`MAX_GENERATION_TIMELINE_STEPS` in `renderer/shared/generation-timeline.ts`; iOS `AidenGenerationTimeline`, Android `AidenChat.kt`, OpenAPI `maxItems: 200`). Before this change `GenerationTimelineProjector` had no cap, so a run past 200 steps (about 100 tool calls with a thinking model) was saved with no timeline at all (`chat-store-core` `appendMessage` parses it), and Remote `run-event-projection` ignored every timeline event after step 200, freezing phone progress.

- The projector keeps every step internally (its `stepIndex` map and reasoning reconciliation use internal indexes); only `snapshot()` is bounded, through `boundGenerationTimelineSteps`.
- Fold order (reworked after review): drop the oldest settled tool steps by rank (routine read-only calls; plain calls, now including `run_command`; calls with a recap or that anchor images/visuals; failed ones). When a drop leaves two finished thinking steps adjacent at the same `contentOffset`, they merge, so thoughts stay in chronological place and reasoning stays fully covered. `subagent` and recording steps never fold. A drop is skipped if it would join two reply text rows (no kept neighbour at the same offset) or change the first step of an activity row holding an anchor or subagent (row keys use the first step id, so a change would remount iframes). The newest 40 fold only in a second pass when older steps cannot.
- Folding is sticky: the projector keeps a `GenerationTimelineFolds` (`dropped` ids, `mergedInto` map) and passes it on every `snapshot()`, so a step that settles later cannot bring back an earlier-dropped one.
- Trade-off: the summary sentence ("Explored N files") counts only the steps kept; a "N earlier steps" marker was considered and not built.
- No protocol revision: phones already accepted up to 200.
- Tests: the four long-run cases at the end of `main/services/generation-timeline.test.ts`.
