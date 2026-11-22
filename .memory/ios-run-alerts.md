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
  - `notify` samples app state after each notification-center await, not before: a user returning to (or leaving)
    the app during the authorization lookup must not get an active-app alert (or a background permission prompt).
    `AidenNotificationPresentationDelegate.presentationOptions` also returns `[]` for `aiden.run.` alerts that land
    while the app is active; scheduled-run (`aiden.schedule.`) alerts keep their foreground banner.
- **Question state.** The Remote wire projects a question as `waiting_for_approval`. Both clients derive the question
  state on the phone through `AgentRunBlockingStatus.status(hasPendingApproval:hasPendingQuestion:)`, where an
  approval takes precedence. The derived state is `AgentRunActivityStatus.waitingForAnswer` (iOS) or
  `WAITING_FOR_ANSWER` (Android).
  - Activity lines read "Needs your approval" and "Needs your answer".
  - `isAwaitingUser` covers both waits. Stale handling (PR #351's `AgentRunStalePresentation`) should use it so a
    question wait stays a question when stale.
  - Resolving an approval on the Mac emits `question_required` with no running status in between. On a
    `question_required` event, both clients re-read the approval snapshot first when one is cached
    (`restorePendingApproval`), so a stale approval cannot keep precedence over the surviving question.
  - iOS `refreshedWaiting(state:)` keeps an existing `.waitingForAnswer` when a server snapshot reports
    `waiting_for_approval`.
- **Tests.**
  - iOS: `AidenRunAlertTests` in `AidenChatTests.swift`, plus three status tests at the end of
    `AidenNativeIntegrationTests`.
  - Android: `AidenQuietOpenChatTest`, plus `approvalResolvedOnMacHandsTheWaitToTheSurvivingQuestion` in
    `AidenChatTest` (iOS twin: `testApprovalResolvedOnMacHandsTheWaitToTheSurvivingQuestion`, which uses the
    `.questions` mode of `AidenChatProgressLifecycleURLProtocol` to push frames into a live event stream).

## Alert actions and Live Activity Deny (2026-11-22)

Branch `feature/aiden-ios-notifications-activities-62cf67`, plan `docs/plans/ios-alerts-app-only-plan.md`.

- `AidenRunAlertContent.make` builds every run alert. A blocking alert with an `AidenRunAlertDetail` shows the approval
  summary or the first question's text (sanitized, 180 chars) when message text is allowed, and sets a category from
  `AidenRunAlertCategory`: `approval` (Approve needs `.authenticationRequired`, Deny `.destructive`, Open chat),
  `approvalDenyOnly` when `canAllow` is false, `questionReply` (text input, needs unlock) for a single question, and
  `question` (Open chat only). Categories are registered in `installPresentationDelegate()`.
- `userInfo` carries only ids: `aidenURL`, `aidenInstance`, `aiden.chatID`, `aiden.approvalID`, `aiden.runID`,
  `aiden.promptID`. `AidenAlertAction(actionIdentifier:userInfo:replyText:)` parses them back; a blank reply is nil.
- `AidenNotificationPresentationDelegate.respond(...)` runs actions through `AidenBackgroundActionBroker.shared`
  (wired in `AidenOnTheGoApp` to `AidenAlertActionResponder`). `.openApp` queues the chat route via `openTap` and
  re-adds the original notification so an unanswered ask isn't mistaken for answered.
- Live Activity: `ContentState.approval` (only while `.waitingForApproval`) drives Review (a `Link`) and Deny
  (`DenyApprovalIntent`, a `LiveActivityIntent` that runs in the app process). Approve is never on the card.
- The responder answers once (scope nil); 409 with an `*_already_resolved`/`*_expired`/`approval_resolved` code counts
  as done; a forgotten Mac drops the action.
