# iOS run alerts and "Needs your answer" (2026-10-05)

Branch `feat/ios-blocking-alerts-needs-answer`.

- **iOS alerts.** `AidenRunAlertNotifier`, `AidenRunAlertPolicy`, and `AidenRunAlertKind` live at the end of
  `ios/AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift`. They share that file to avoid pbxproj churn.
  - `AidenChatViewModel.alertRun(_:id:)` calls the notifier from four places: approval/question restore,
    `.done`/`.error` events, missing-stream resolution, and the `apply(AidenStreamStatus)` terminal states.
  - Policy:
    - An active app never alerts.
    - An inactive app alerts only when the chat is not on screen.
    - A backgrounded app always alerts.
    - Dedupe keys are `instance|prompt|id` and `instance|run|streamId`. They persist in `UserDefaults`, capped at 500.
  - Permission is requested only for `.completed` while the app is active, once (`aiden.runAlerts.permissionRequested`).
  - Blocking alerts use `.timeSensitive`, which needs the `com.apple.developer.usernotifications.time-sensitive`
    entitlement and may need the App ID capability for signed builds. Completion and failure alerts use `.active`.
  - A tapped alert opens `userInfo["aidenURL"]` from the `didReceive` handler, after validating it with
    `AidenDeepLink.request(from:)`.
  - `AidenRunAlertNotifier.shared` is disabled under the XCTest host.
- **Question state.** The Remote wire projects a question as `waiting_for_approval`. Both clients derive the question
  state on the phone through `AgentRunBlockingStatus.status(hasPendingApproval:hasPendingQuestion:)`, where an
  approval takes precedence. The derived state is `AgentRunActivityStatus.waitingForAnswer` (iOS) or
  `WAITING_FOR_ANSWER` (Android).
  - Activity lines read "Needs your approval" and "Needs your answer".
  - `isAwaitingUser` covers both waits. Stale handling (PR #351's `AgentRunStalePresentation`) should use it so a
    question wait stays a question when stale.
  - iOS `refreshedWaiting(state:)` keeps an existing `.waitingForAnswer` when a server snapshot reports
    `waiting_for_approval`.
- **Tests.**
  - iOS: `AidenRunAlertTests` in `AidenChatTests.swift`, plus three status tests at the end of
    `AidenNativeIntegrationTests`.
  - Android: `AidenQuietOpenChatTest`.
