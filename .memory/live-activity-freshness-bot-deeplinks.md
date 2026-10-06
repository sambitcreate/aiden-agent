# Live Activity freshness chips and Bot deep links (2026-09-27)

Branch: `feature/live-activity-freshness`. Plan: `docs/plans/completed/live-activity-freshness-bot-deeplinks-plan.md`.

## Live Activity state and chips

- `ContentState.toolCallCount` has a custom `init(from:)` so older payloads still decode.
  - Keep new ContentState fields optional-decoded, because running activities survive app updates.
- The shared helpers live in `AgentRunFreshness`, which is compiled into both the app and the widget:
  - `toolCallLabel` produces "1 tool", "N tools" or "99+ tools";
  - `isStale` combines the reducer's stale flag with `context.isStale` and ignores final runs.
- `AgentRunActivityReducer.stale()` keeps the last `updatedAt`, so "Stale 3m ago" reports real agent progress.
- Foreground stream-status reconciliation updates the displayed state without replacing the last progress time. ActivityKit's `staleDate` is always derived from that progress timestamp, so a status poll cannot restart the five-minute freshness window; title and excerpt-clearing updates also preserve it.
- The Dynamic Island's expanded badge, trailing status, compact mark, and freshness chips all combine the reducer stale flag with ActivityKit's `context.isStale` signal.

## Bot deep link

- Link shape: `aiden-otg://bot/{botId}/chat[?instance=]`.
  - iOS: `AidenDeepLink.botChatURL` and `.botChat` handled in `AidenProductShellView`.
  - Android: `AidenDeepLink.botChatUrl` and `AidenNavigationDestination.BotChat` handled in `MainActivity`.
- Resolution: `aidenResolvedBotDeepLink` on both platforms reuses the canonical Bot conversation ordering.
- A link never creates a chat. With no chat, iOS lands on the Bot with a notice and Android opens BotProfile.

## Coordination

PR #119 adds `AidenBotLiveActivityStateTests.swift` and edits the pbxproj. This branch adds no new iOS files, to avoid conflicting with it.

Status (2026-10-01): merged in PR #276 (on main after 0.51.0); plan moved to `docs/plans/completed/`.

## Stale waiting-for-approval (2026-10-05)

- `AgentRunStalePresentation.copy(for:systemMarkedStale:)` (shared app/widget) decides stale Lock Screen and expanded island copy.
  - Stale `waitingForApproval` keeps the "Waiting for approval" lead and adds an "Open to answer" action.
  - Every other stale status keeps "Latest status shown" with no action; fresh or final runs return `nil`.
- Stale styling (dot, keyline, freshness chip, trailing "Latest") is unchanged; only the copy differs.
- Branch `fix/la-stale-keeps-waiting`; adapted from the Hermex stale-Bot fix, without Bot-specific copy.
