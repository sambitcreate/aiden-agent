# Reasoning steady row and end-of-turn action slot (2026-10-29)

Branch `feature/thinking-block-jitter-0da5d2`. Fixes the transcript jumping up and down at high tokens per second.

## Why
- The old `ReasoningBlock` opened a 144px tail preview on mount and removed it in one frame 1,000ms later, whatever the model was doing. With the transcript pinned to the bottom, each thinking block pushed history up about 190px and then pulled it down about 156px. Fast turns have many short thoughts, so this happened about once a second.
- The hidden copy/fork row (`MessageActions hidden`, `invisible`) sat under the newest text row and hopped to each new paragraph, moving every row between them.
- T3 Code (one live "Thinking" row, one-line work-log entries) and opencode (collapsed by default, latest heading as a live subtitle) never open reasoning on their own. The design follows them.

## Desktop
- `renderer/components/reasoning-block.tsx`: one `section` from the first moment (the empty-content case is the same element with `role="status"` and a disabled header, so nothing remounts or replays its entrance). Always starts collapsed; only the reader opens it, into the existing full-height layout with the sticky header.
- While `active && streaming`, the header shows `latestReasoningLine(content)` (`renderer/lib/reasoning-disclosure.ts`): the latest finished sentence or line, Markdown markers removed, unfinished tail ignored, so it changes once per finished thought. Keyed span replays `.reasoning-line-in` (opacity + 4px, gated on `data-reduce-motion="false"`). When thinking ends the line fades to `opacity-0` but keeps its text and the row stays 36px. It is `aria-hidden`.
- Reader toggles ease: open via `@starting-style` on `.reasoning-body` (grid rows 0fr to 1fr), close via the `closing` phase (`reduceReasoningDisclosure`), which unmounts on `transitionend` for `grid-template-rows` or a 320ms fallback. Reduce Motion closes at once.
- `renderer/components/message-list.tsx` `AssistantResponse`: assistant bubbles pass `showCopy={false}`; one `actions` node (copy of the whole reply, read aloud, footer, fork) renders last in both layouts, after media, visuals and UI visuals. The live and saved trees keep it in the same slot, so it settles in place.
- Hover reveal moved to a named group: `MessageActions` uses `group-hover/reply` and `group-focus-within/reply`; the assistant row wrapper in `SettledMessageRow` and the assistant `MessageBubble` carry `group/reply`. Hovering anywhere on a reply reveals its actions. `MessageActions` lost `mt-1` because the row's `gap-3` already gives the 12px it had inside the bubble.

## iOS and Android
Both had the same 1s auto-preview and now match the desktop row.
- iOS: `AidenReasoningCard` in `ios/AidenOnTheGo/Features/Remote/AidenChatFeature.swift` starts collapsed with no `.task` timer; the line sits in a `ZStack` between label and chevron, `.id(liveLine)` with opacity + 4pt offset, hidden from VoiceOver. Helper `AidenAgentActivityPresentation.latestReasoningLine` in `ios/AidenOnTheGo/Models/AidenChat.swift` (Unicode scalars, `[0-9]` instead of ICU `\d`). Tests in `AidenChatTests`; run with `xcodebuild test ... -only-testing:AidenOnTheGoTests/AidenChatTests` on an iOS simulator (passed 344/344 on 2026-10-29).
- Android: `AidenChronologicalReasoningCard` in `features/chat/AidenChatDetailScreen.kt` starts collapsed; `AnimatedContent` line slot with no size transform, alpha via `graphicsLayer`, `clearAndSetSemantics {}`. Helper `AidenReasoningLine.latest` in `features/chat/AidenReasoningLine.kt`, test `AidenReasoningLineTest`. Unit tests need `JAVA_HOME` from Android Studio's bundled JBR and `ANDROID_HOME=~/Library/Android/sdk`.

## Bots
Bot chats (`renderer/main/bots/bot-chat-pane.tsx`) are unaffected: they never mount `ReasoningBlock` and pass `showCopy={false}` to their bubbles. Their activity is already one calm status line.

## Tests
- `renderer/lib/reasoning-disclosure.test.ts` (line extraction, toggle phases), `renderer/components/reasoning-block.test.tsx` (DOM: never self-opens, line rolls and fades, eased close, same element from empty to readable).
- `renderer/components/message-list-settle.test.tsx`: "a streaming reply keeps one hidden action row after its last row" checks the row is the same element after a tool step and a new paragraph.
