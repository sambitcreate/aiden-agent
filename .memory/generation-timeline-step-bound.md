# Generation timeline step bound (2026-10-29)

Every timeline reader rejects more than 200 steps (`MAX_GENERATION_TIMELINE_STEPS` in `renderer/shared/generation-timeline.ts`; iOS `AidenGenerationTimeline`, Android `AidenChat.kt`, OpenAPI `maxItems: 200`). Before this change `GenerationTimelineProjector` had no cap, so a run past 200 steps (about 100 tool calls with a thinking model) was saved with no timeline at all (`chat-store-core` `appendMessage` parses it), and Remote `run-event-projection` ignored every timeline event after step 200, freezing phone progress.

- The projector keeps every step internally (its `stepIndex` map and reasoning reconciliation use internal indexes); only `snapshot()` is bounded, through `boundGenerationTimelineSteps`.
- Fold order: merge older finished thinking steps into the first one (its reasoning span covers theirs, durations sum, so `assistantPresentationRows` still shows all reasoning), then drop the oldest settled tool steps by rank: routine read-only calls, plain calls, calls with a recap or that anchor images/visuals (`display_image`, `share_image`, `generate_image`, `render_artifact`, `render_ui`), then failed ones. Running steps and the newest 40 are never folded. `order` is renumbered; ids and public `call-N` ids are unchanged.
- Trade-off: when tools alone exceed 200, the summary sentence ("Explored N files") counts only the steps kept.
- No protocol revision: phones already accepted up to 200.
- Tests: the two long-run cases at the end of `main/services/generation-timeline.test.ts`.
