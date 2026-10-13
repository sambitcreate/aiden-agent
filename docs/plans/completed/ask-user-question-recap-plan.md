# Ask User Question recap and composer spacing

Status: Merged in [PR #441](https://github.com/sambitcreate/aiden-agent/pull/441) on 2026-10-13 after exact-head CI and reviews passed. Aiden Remote contract revision 29.

## Problem

Once an `ask_user_question` card closes, the transcript shows only an "Ask a question" activity line. Neither the owner nor anyone scrolling back later can see what was asked or chosen. The open card also sits flush against the window's bottom edge because its dock wrapper lacks the composer's padding, and its number-key shortcuts are invisible.

## Decisions

- **Recap on the timeline step (option A).** The extension returns a renderer-safe `AskUserQuestionRecapV1` as the tool result `details`. The projector copies it onto the completed step as `questionnaire`. It persists with `ChatMessage.timeline` and reaches Aiden Remote through `parseGenerationTimeline`, the same route as `lineChanges` and `producedFile`.
  - The recap carries question text, header, a kind (`option`, `multi`, `custom`, `skipped`) and the chosen labels or custom text. Custom text is clipped to 1,000 characters.
  - Outcomes are `answered`, `dismissed` (owner closed the card) and `expired`.
  - A stopped run gets no recap and keeps its cancelled activity line.
- **Transcript presentation.** A questionnaire step becomes its own presentation row at its content offset and is left out of activity groups and the tool-call tally.
  - Each question renders as a right-aligned card: muted question text over the answer at medium weight, on `surface-well` with a hairline inset.
  - Custom answers are quoted; skipped questions read as "Skipped", "Dismissed" or "No answer".
- **Strict validation.** `parseAskUserQuestionRecap` rejects malformed recaps. A recap on any step other than a completed `ask_user_question` step on a v3 timeline invalidates the timeline. The builder returns only recaps that pass the parser.
- **Composer spacing (P1) and key hints.**
  - The questionnaire dock gets the composer's `pb-4 pt-3 sm:pb-5`.
  - A tertiary footnote lists the live shortcuts: `1–5` choose/toggle, `↵` next on the chosen row (`⌘↵` for multi-select, accepted for both), and `esc` skip.
  - The footnote hides while a custom answer is being written.
  - Next and Skip expose `aria-keyshortcuts`.
- **Aiden Remote.** Contract revision 29 adds the optional `questionnaire` field on `GenerationToolStep` (revision 28 went to inline visuals first). iOS and Android render the same cards. `tool_started` is unchanged: installed clients reject unknown keys on that event.

## Contract and clients

- `openapi.json` describes `AskUserQuestionRecap` and its item schema, and closes both objects to extra keys. An `if`/`then` rule ties the field to completed `ask_user_question` steps on version 3 timelines. An Ajv test in `aiden-remote-protocol.test.ts` checks that the schema and `parseGenerationTimeline` agree on 35 accept and reject cases.
- The shared fixture's timeline event carries an answered recap with one option item and one skipped item. Desktop, iOS (`AidenRemotePhase0Tests`) and Android (`AidenChatTest`) each decode it from the fixture.
- Unlike the desktop parser, iOS and Android drop a malformed or misplaced recap and keep the step, so a bad recap degrades to the plain activity line rather than losing the chat.

## Verification

| Surface | Suite | Result |
| --- | --- | --- |
| Desktop | `npx tsc --noEmit` | clean |
| Desktop | `npm run test:ask-user-question` | pass |
| Desktop | `agent-steps` and `generation-timeline` | pass |
| Desktop | `npm run test:aiden-remote` | pass |
| Desktop | Playwright `assistant-scheduled-profile.spec.ts` questionnaire specs | pass |
| Android | `AidenChatTest`, `AidenBotContractTest` | pass |
| Android | full unit suite, `compileDebugAndroidTestKotlin`, `lintDebug` | pass |
| iOS | `AidenChatTests`, `AidenRemotePhase0Tests`, `AidenRemoteClientTests`, `AidenBotContractTests` on the simulator | 461 pass, 0 fail |
| Hosted CI | all 27 checks on the merged head `18d4a9f2` | pass |

The Playwright specs now check that the recap list appears after submit, and that the open card keeps at least 16px of clearance above the window's bottom edge.

Not run locally:
- Android `AidenQuestionnaireRecapUiTest`: it needs an emulator, and CI runs it.
- The native cards were not checked on screen or with VoiceOver/TalkBack.

## Follow-ups

- Android's live fallback (no chronological rows) listed the stream's live tools, so a question showed its plain row mid-turn. Done in the Android follow-up: that fallback now renders from timeline steps and shows the recap mid-turn, and the recap cards became a Material 3 Expressive connected group.
- Bot chats answer through A–E quick replies and still show a plain bubble; give them the same recap if it reads well there.
- The CLI's terminal questionnaire is unaffected.
