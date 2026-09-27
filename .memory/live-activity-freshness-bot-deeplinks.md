# Live Activity freshness chips and Bot deep links (2026-09-27)

Branch: `feature/live-activity-freshness`. Plan: `docs/plans/live-activity-freshness-bot-deeplinks-plan.md`.

## Live Activity state and chips

- `ContentState.toolCallCount` has a custom `init(from:)` so older payloads still decode.
  - Keep new ContentState fields optional-decoded, because running activities survive app updates.
- The shared helpers live in `AgentRunFreshness`, which is compiled into both the app and the widget:
  - `toolCallLabel` produces "1 tool", "N tools" or "99+ tools";
  - `isStale` combines the reducer's stale flag with `context.isStale` and ignores final runs.
- `AgentRunActivityReducer.stale()` keeps the last `updatedAt`, so "Stale 3m ago" reports real agent progress.

## Bot deep link

- Link shape: `aiden-otg://bot/{botId}/chat[?instance=]`.
  - iOS: `AidenDeepLink.botChatURL` and `.botChat` handled in `AidenProductShellView`.
  - Android: `AidenDeepLink.botChatUrl` and `AidenNavigationDestination.BotChat` handled in `MainActivity`.
- Resolution: `aidenResolvedBotDeepLink` on both platforms reuses the canonical Bot conversation ordering.
- A link never creates a chat. With no chat, iOS lands on the Bot with a notice and Android opens BotProfile.

## Coordination

PR #119 adds `AidenBotLiveActivityStateTests.swift` and edits the pbxproj. This branch adds no new iOS files, to avoid conflicting with it.
