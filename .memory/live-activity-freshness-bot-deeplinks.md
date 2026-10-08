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

## ActivityKit end-state race in integration tests (2026-10-07)

- `Activity.activities` returns a separate instance per call. The manager's `endAll`/`finish` ends its own instance, and ActivityKit propagates `.ended`/`.dismissed` to the instance a test holds asynchronously, the same way content echoes are delayed (see `deliveredContent`, PR #308).
- Reading `activity.activityState` right after `await manager.endAll(...)` was flaky on loaded CI simulators (run 37530293739 attempt 2, line 480, `XCTAssertTrue failed`, 0.13 s).
- Tests now `await assertDeliveredEnd(of:)`, which subscribes to `activityStateUpdates` before reading the current state and uses the same failure-only 30 s ceiling. `deliveredContent` and `assertDeliveredEnd` share the generic `AidenDeliveryRace`.
- Branch `fix/ios-activitykit-end-state-race`.

## Chat view-model tests are kept off ActivityKit (2026-10-08)

- `AidenChatTests.testForeignRunResponseStaysVisibleUntilAFailedTranscriptReadRecovers` failed intermittently on PR #377 CI (runs 37721736343, 37805265233) with `Timed out waiting for failed transcript read`; every later assertion passed.
- Cause: `makeProgressLifecycleModel` used `AidenRemoteLiveActivityManager.shared`, so the model drove the simulator's real ActivityKit. A foreign run's `.ended` effect awaits `liveActivities.finish` (`activity.end`) before `endForeignRunQuietly` reads the transcript; on a loaded CI simulator that await took longer than the test's ~5 s poll (the xcresult shows live `Updating content for activity` lines and an ActivityKit `XPC connection interrupted` inside the test). Owned streams also await `finish` before `finishStream`.
- Reproduced locally by delaying `finish` by 6 s: the same single failure message. With the fix, that delay no longer reaches the test.
- Fix: `AidenRemoteLiveActivityManager(drivesActivityKit: false)` requests, updates and ends nothing and sees no system activities; chat view-model test helpers inject it. Production keeps `.shared` (default `true`). `AidenNativeIntegrationTests` still exercises the real ActivityKit.
- Found while verifying: `AidenRemoteClientTests.testBotDeleteSendsTheBotRevisionAndOnlyWhenTheHostAdvertisesIt` failed once locally with `Unexpected Bot delete request: GET /api/aiden/v1/bot-capabilities`. The previous test's `AidenBotChatToolsModel.refresh` leaves its cancelled `async let` catalog request to reach `startLoading` after the next test installs its handler. `AidenRemoteMockURLProtocol` now stamps each `makeSession()` with a per-test epoch header and fails requests from an earlier epoch with `URLError(.cancelled)`.
