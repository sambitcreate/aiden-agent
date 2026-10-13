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
- When the active question changes and focus has left the card (the focused row was replaced), focus moves to the open custom field or the first option. Tab-strip arrow navigation keeps focus on its tab.
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
- Android's fallback lists every live tool rather than the timeline. It keeps showing the plain question row and shows no recap mid-turn; the settled transcript shows the recap. A proper fix renders that fallback from timeline steps.

Bot quick-reply questionnaires do not produce a recap yet.

Validation: `npm run test:ask-user-question`; `npx tsx --test renderer/lib/agent-steps.test.ts main/services/generation-timeline.test.ts`; `main/services/aiden-remote-protocol.test.ts` for the openapi schema and revision.
