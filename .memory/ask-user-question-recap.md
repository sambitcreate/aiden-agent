# Ask User Question recap — 2026-10-12

Merged in PR #441 (2026-10-13). Plan: `docs/plans/completed/ask-user-question-recap-plan.md`.

The `ask_user_question` tool result `details` is now an `AskUserQuestionRecapV1`, or null for a stopped run. `GenerationTimelineProjector.updateTool` copies a valid recap onto the completed step as `questionnaire`. Persisted chats and Aiden Remote get it through `parseGenerationTimeline`, which rejects the whole timeline when a recap is malformed or sits on any other tool or status. That strictness is why `buildAskUserQuestionRecap` returns its result through `parseAskUserQuestionRecap`. Never store an unparsed recap.

Renderer: `assistantPresentationRows` emits a `questionnaire` row for steps carrying a recap (`isQuestionnaireStep`). These steps never join activity groups, so they drop out of the "N tool calls" summary. `AskUserQuestionRecap` renders the cards. The legacy fallback path in `message-list.tsx` filters them out of `ActivityFeed` and renders cards after it.

Composer: the dock wrapper uses Composer's `pb-4 pt-3 sm:pb-5`. Key handling:
- Number keys select or toggle and move focus to that row.
- Enter on the already-chosen single-select row commits; on any other row Enter keeps its native click.
- ⌘/Ctrl+Enter commits.
- Esc skips the current question, which submits on the last one.
- None of these apply while the custom textarea is open.
- When the active question changes and focus has left the card (the focused row was replaced), focus moves to the open custom field, the preselected option, or the first option. Tab-strip arrow navigation keeps focus on its tab.
- In happy-dom tests, compare focused elements by identity inside `assert.ok`. A failing `assert.equal` on two nodes hangs while Node inspects the DOM graph.

Aiden Remote contract revision 29 (main took 28 for inline visuals) adds `questionnaire` to `GenerationToolStep` in `openapi.json`. An Ajv test checks that the schema and the runtime parser agree. The shared fixture's timeline event carries a recap, and desktop, iOS (`AidenRemotePhase0Tests`) and Android (`AidenChatTest`) each decode it.

Native clients:
- iOS: `AidenQuestionnaireRecap` in `Models/AidenChat.swift` and `AidenQuestionnaireRecapView` in `AidenChatFeature.swift`.
- Android: `models/AidenQuestionnaireRecap.kt` and `features/chat/AidenQuestionnaireRecapView.kt`.
- Both drop an invalid recap and keep the step, while the desktop rejects the whole timeline.
- Both get a `questionnaire` chronological row kind and leave questionnaire steps out of the activity tally.

Live fallback (no chronological rows):
- Live Remote tool rows carry the stream's own `tool_N` ids, which never match a timeline step's public `call-N` `toolCallId`. Pairing by order breaks after snapshot recovery.
- Adding a correlation field to `tool_started` was tried and reverted. Installed revision-27 iOS and Android codecs reject unknown `tool_started` keys and would loop on the event. Any new field there needs negotiation or a new event type that older clients ignore.
- iOS (`AidenAgentActivityPresentation.showsLiveToolRows`) hides the live tool card once the timeline has any tool step, recaps included. That is the pre-recap behavior, since questionnaire steps used to count as visible steps.
- Android (`AidenAgentActivityPresentation.liveToolSteps`, `questionnaireSteps`, `showsLiveToolRows`) renders that fallback from timeline steps: once the timeline has a tool step, `ActiveStreamingCard` lists its non-questionnaire calls and shows each recap mid-turn, and the stream's live rows only appear before the timeline knows any call.

Android recap styling is Material 3 Expressive: the cards form one borderless connected group (`AidenConnectedColumn` plus `aidenGroupItemShape`) on `surfaceContainerHigh`. In a live reply (`animateEntrance`) the group springs in from its trailing corner with `AidenMotion.spatial` and fades with `short()`, and both snap under reduced motion. `ActiveStreamingCard` remembers which recap step ids have already entered, so a recap that moves from the fallback into the chronological rows as the text catches up does not replay. Settled transcripts never animate it.

Bot quick-reply questionnaires do not produce a recap yet.

Validation: `npm run test:ask-user-question`; `npx tsx --test renderer/lib/agent-steps.test.ts main/services/generation-timeline.test.ts`; `main/services/aiden-remote-protocol.test.ts` for the openapi schema and revision.

## Recommended options (2026-10-29)

The agent marks a recommended option by ending its label with "(Recommended)" (any case); both tool descriptions (desktop and Bot) say so. No wire change: the full label stays the answer's identity, so `parseAskUserQuestionResponse` still matches it.
- Shared helpers in `renderer/shared/ask-user-question.ts`: `parseRecommendedOptionLabel`, `askUserOptionDisplayLabel`, `recommendedAskUserAnswer(s)`. Single choice preselects the first marked option; multi-select preselects every marked one.
- Desktop composer starts `answers` from `recommendedAskUserAnswers` and focuses the preselected row, so Enter accepts it. Esc still skips (no answer is sent). Tab check marks show for preselected questions too: they will be sent.
- Recaps (`buildAskUserQuestionRecap`) and `summarizeAskUserQuestionResponse` drop the marker, so phones need no recap change. The model-facing `formatAskUserQuestionAnswers` keeps the full label.
- iOS: `AidenQuestionAnswerDraft.recommendedLabel/recommendedSelections`, `AidenQuestionComposerDraft(questions:)` seeded in `AidenQuestionCard.init` (callers key the card by prompt id). Android: same names on `AidenQuestionAnswerDraft`, seeded in `remember(prompt.id)`.
