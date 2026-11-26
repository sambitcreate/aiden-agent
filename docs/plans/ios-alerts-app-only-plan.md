# iOS Alerts, Phase 1 (App Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Aiden On The Go's Live Activity, Dynamic Island and run alerts plain text on a clean background, and let people answer from them, without any server or contract change.

**Architecture:**
- **Presentation:** a pure `AgentRunTextPresentation` decides every word the widget shows. The widget only renders it with `.primary`/`.secondary` text on the system background.
- **Actions:** Live Activity buttons (`LiveActivityIntent`) and notification actions all go through one `AidenBackgroundActionBroker`. The broker calls the existing approval/question routes on the paired Mac.
- **Settings:** a new Notifications page stores its choices in `AidenNotificationPreferences`, and the alert notifier and Live Activity manager read them.

**Tech Stack:** Swift 6, SwiftUI, ActivityKit, WidgetKit, AppIntents (`LiveActivityIntent`), UserNotifications, XCTest. iOS 26 deployment target.

**Spec:** [`ios-alerts-live-activities-proposal.html`](ios-alerts-live-activities-proposal.html) (published at https://claude.ai/artifact/J9i8yfi8YcTWsgGCdpfaZj), sections 03 and 06 (Phase 1). Push, the relay and the Live Activity over push are in [`mobile-push-relay-plan.md`](mobile-push-relay-plan.md).

## Global Constraints

- **Text only, owner decision 2026-11-22.**
  - Remove all of these: status dot, status mark, progress rail, timer pill, tool/updated chips, status colors, tinted excerpt panel, `.keylineTint`, `.activityBackgroundTint`.
  - Text uses `.primary` and `.secondary` only, on the system Live Activity background.
- **Network.** No new hosts, no background polling and no contract revision. Actions use only the existing routes:
  - `POST approvals/{id}/respond`
  - `POST runs/{runId}/approvals/{approvalId}/respond`
  - `POST questions/{id}/respond`
  - `POST runs/{runId}/questions/{promptId}/respond`
- **Decoding.** Running activities survive app updates, so every new `ContentState` field decodes with `decodeIfPresent` and a default.
- **No migrations (pre-1.0).** Delete replaced code and its tests. Don't add shims.
- **Locked-device safety.**
  - Deny and Reply may run from the Lock Screen.
  - Approve runs only from a notification action with `.authenticationRequired`, and only when the approval's `canAllow` is true.
  - The Live Activity never offers Approve.
- **Fixed copy.** Bot handoff alerts (`notifyBotHandoff`) keep fixed copy whatever the settings say.
- **Exact strings.** UI copy comes from the spec. Use these strings exactly:
  - Statuses: "Needs your approval", "Has a question for you", "Done", "Stopped", "Latest status shown", "Waiting for approval · Open to answer"
  - Compact statuses: "Needs you", "Latest"
  - Actions: "Review", "Deny", "Approve", "Reply", "Open chat"
  - Settings rows: "Aiden needs an answer", "A response is ready", "A run fails", "A Bot needs me", "Show message text", "Reply text on Lock Screen", "Quiet in the open chat"
- **New files.** Add every new Swift file to `ios/AidenOnTheGo.xcodeproj/project.pbxproj` by hand. The project has no synchronized groups and uses fixed IDs. Each task names the targets a file belongs to.
- **iOS unit test command.** Run unit tests with:

  ```bash
  xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skip-testing:AidenOnTheGoUITests -only-testing:<Target/Class/test>
  ```

  Drop `-only-testing` for the full suite before each commit that touches shared files.
- **Tests (AGENTS.md).** Tests are behavioral: call the real function and assert on its output. No source-grep tests and no exact-string snapshots of SwiftUI trees. Extend `AidenNativeIntegrationTests` for Live Activity behavior, as the existing Live Activity tests do.
- **Docs in the same task.** Each task updates the docs it makes stale: `docs/aiden-on-the-go-remote-access.md`, `ios/CHANGELOG.md` (under `## Unreleased`), `ios/README.md`, `PRODUCT.md`, and the status row in `docs/plans/README.md`.

## Review Focus

1. **The approval was already answered on the Mac** when Deny/Approve arrives (`409` with `approval_resolved`, `approval_already_resolved` or `approval_expired`). The result is no error and the card leaves the waiting state. Covered by Task 3's `testResponderTreatsResolvedApprovalAsDone`.
2. **The action's Mac was forgotten or can't be reached.** A forgotten Mac drops the action silently, matching today's tap rule. An unreachable Mac opens the app on that chat. Covered by Task 3's `testResponderOpensChatWhenMacUnreachable` and `testResponderDropsActionForForgottenMac`.
3. **The card was started by an older build** without the new `approval` field. It decodes, shows no buttons and still renders as text. Covered by Task 3's `testStateWithoutApprovalTargetDecodesWithoutActions`.
4. **Two Macs each have one run.** There's no summary card, because the summary is per Mac. Covered by Task 6's `testRunsOnDifferentMacsNeverMergeIntoOneSummary`.
5. **Notifications are denied in iOS Settings** while every toggle is on. Nothing posts, and the page shows the system state with "Open Settings". Covered by Task 5's `testDeniedPermissionBlocksEveryKindAndShowsOpenSettings`.

---

### Task 1: Text-only presentation model

**Files:**
- Modify: `ios/AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift`. Add `AgentRunTextPresentation` next to `AgentRunStalePresentation` (the file is already in both the app and widget targets), and delete `AgentRunFreshness.toolCallLabel(count:)`.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`. Delete `testLiveActivityToolCallChipIsBoundedAndSingular` and add the tests below.

**Interfaces:**
- Consumes: `AgentRunActivityAttributes.ContentState`, `AgentRunFreshness.isStale(_:systemMarkedStale:)`, `AgentRunStalePresentation.copy(for:systemMarkedStale:)`, `AgentRunActivityStatus.compactTitle`.
- Produces:

```swift
struct AgentRunTextPresentation: Equatable {
    enum Timing: Equatable {
        case running(startedAt: Date)   // live elapsed timer
        case updated(at: Date)          // stale: system-drawn relative time
        case none                       // final
    }
    let title: String          // sanitized session title
    let status: String         // one line, sentence case
    let compactStatus: String  // Dynamic Island compact leading
    let detail: String?        // final reply excerpt; nil unless complete with an excerpt
    let timing: Timing
    static func make(state: AgentRunActivityAttributes.ContentState, systemMarkedStale: Bool) -> AgentRunTextPresentation
}
```

- [ ] **Step 1: Write the failing tests**

```swift
func testTextPresentationNamesBlockingWaitsInPlainWords() {
    let started = Date(timeIntervalSince1970: 1_000)
    let approval = state(status: .waitingForApproval, startedAt: started, updatedAt: started)
    let p = AgentRunTextPresentation.make(state: approval, systemMarkedStale: false)
    XCTAssertEqual(p.status, "Needs your approval")
    XCTAssertEqual(p.compactStatus, "Needs you")
    XCTAssertEqual(p.timing, .running(startedAt: started))
    XCTAssertEqual(AgentRunTextPresentation.make(state: state(status: .waitingForAnswer), systemMarkedStale: false).status,
                   "Has a question for you")
}

func testTextPresentationWorkingUsesTheSanitizedActivityLine() {
    let p = AgentRunTextPresentation.make(state: state(status: .runningCommand, activity: "Running npm test"), systemMarkedStale: false)
    XCTAssertEqual(p.status, "Running npm test")
    XCTAssertNil(p.detail)
}

func testTextPresentationForStaleRunsUsesLatestStatusCopy() {
    let updated = Date(timeIntervalSince1970: 2_000)
    let reading = AgentRunTextPresentation.make(state: state(status: .readingFiles, updatedAt: updated), systemMarkedStale: true)
    XCTAssertEqual(reading.status, "Latest status shown")
    XCTAssertEqual(reading.compactStatus, "Latest")
    XCTAssertEqual(reading.timing, .updated(at: updated))
    let waiting = AgentRunTextPresentation.make(state: state(status: .waitingForApproval), systemMarkedStale: true)
    XCTAssertEqual(waiting.status, "Waiting for approval · Open to answer")
}

func testTextPresentationFinalStates() {
    let done = AgentRunTextPresentation.make(state: state(status: .complete, excerpt: "All 12 tests pass.", isFinal: true), systemMarkedStale: true)
    XCTAssertEqual(done.status, "Done")
    XCTAssertEqual(done.detail, "All 12 tests pass.")
    XCTAssertEqual(done.timing, .none)
    XCTAssertEqual(AgentRunTextPresentation.make(state: state(status: .failed, error: "Mac went to sleep", isFinal: true), systemMarkedStale: false).status,
                   "Mac went to sleep")
    XCTAssertEqual(AgentRunTextPresentation.make(state: state(status: .cancelled, isFinal: true), systemMarkedStale: false).status, "Stopped")
}
```

`state(...)` is a private test helper that builds a `ContentState` with the given fields and defaults for the rest. Add it next to the existing Live Activity helpers if one doesn't fit.

- [ ] **Step 2: Run the tests to see them fail**

Run: the unit test command with `-only-testing:AidenOnTheGoTests/AidenNativeIntegrationTests/testTextPresentationNamesBlockingWaitsInPlainWords` (and the other three).
Expected: compile failure, `cannot find 'AgentRunTextPresentation' in scope`.

- [ ] **Step 3: Implement `AgentRunTextPresentation.make(state:systemMarkedStale:)`**

Rules, applied in this order:
1. **Final** (`state.isFinal`):
   - `.complete` → "Done". `detail` is the excerpt when it isn't empty.
   - `.failed` → `errorSummary` if set, otherwise "Failed".
   - `.cancelled` → "Stopped".
   - Timing `.none`. `compactStatus` is the same word as the status.
2. **Stale** (`AgentRunFreshness.isStale`):
   - `status` is the stale copy's `lead`, plus `" · " + action` when the copy has an action.
   - `compactStatus` is "Latest". Timing is `.updated(at: state.updatedAt)`.
3. **Blocking:**
   - `.waitingForApproval` → "Needs your approval". `.waitingForAnswer` → "Has a question for you".
   - `compactStatus` is "Needs you".
4. **Otherwise:**
   - `status` is `currentActivity`, or `status.title` when the activity is empty.
   - `compactStatus` is `status.compactTitle`.

Timing is `.running(startedAt:)` unless rule 1 or 2 set it.

- [ ] **Step 4: Run the tests to see them pass**

Run the same four tests, plus the existing `testStaleLiveActivityKeepsWaitingForApprovalAskAndOtherStatusesShowLatestStatus`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift
git commit -m "Add text-only Live Activity presentation"
```

### Task 2: Restyle the Live Activity and Dynamic Island as plain text

**Files:**
- Modify: `ios/AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`
  - Rebuild the Lock Screen, island and small-family views on `AgentRunTextPresentation`.
  - Delete `AgentRunIslandBadge`, `AgentRunIslandStatusView`, `AgentRunIslandCompactMark`, `AgentRunStatusDot`, `AgentRunStatusMark`, `AgentRunProgressRail`, `AgentRunTimerPill`, `AgentRunFreshnessChips`, `AgentRunStatusStyle`, `AgentRunLiveActivityTheme` and `AgentRunExpandedIslandBottomView`.
  - Keep `AgentRunElapsedTimerText`, which already fixes the timer width.
- Modify: `ios/CHANGELOG.md`, `ios/README.md` (if it describes the card).

**Interfaces:**
- Consumes: `AgentRunTextPresentation.make(state:systemMarkedStale:)` from Task 1, and `AidenDeepLink.chatURL(instanceId:chatId:)`.
- Produces: `private struct AgentRunTextCard: View`, initialized with `(presentation: AgentRunTextPresentation, chatURL: URL?)`. Task 3 adds actions to it.

- [ ] **Step 1: Rebuild the views**
  - **Lock Screen.** Use `AgentRunTextCard`, a `VStack(alignment: .leading, spacing: 2)` with 16 pt padding.
    - Row 1: the title (`.headline`, one line) and, trailing, the timing (`.subheadline`, `.secondary`, tabular digits).
      - `.running` uses `AgentRunElapsedTimerText`.
      - `.updated(at:)` uses `Text(date, style: .relative)` followed by " ago".
      - `.none` shows nothing.
    - Row 2: the status (`.subheadline`, `.secondary`, one line).
    - Row 3, only when `detail` is set: the detail (`.footnote`, `.secondary`, two lines).
  - **Remove decoration.** Drop `.activityBackgroundTint` and `.keylineTint`, and use no other colors.
  - **Dynamic Island.**
    - Compact leading: `Text(compactStatus)`. Compact trailing: the timing.
    - Minimal: `Text("A")`, the Aiden monogram (`.caption2.weight(.semibold)`).
    - Expanded: everything goes in `.bottom`, as an `AgentRunTextCard` with 4 pt horizontal padding. The leading and trailing regions are empty.
  - **Small family (Watch/CarPlay).** Add `.supplementalActivityFamilies([.small])`. When `activityFamily == .small`, show only the title and status.
  - **Always-On.** When `isLuminanceReduced`, hide the timing and the detail.
  - Keep `widgetURL` as it is.

- [ ] **Step 2: Build both targets**

Run: `xcodebuild build -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'generic/platform=iOS Simulator' -quiet`
Expected: `** BUILD SUCCEEDED **`, with no warnings about unused private types.

- [ ] **Step 3: Check it visually on the simulator**

Use the `device-interaction` skill.
- Run a chat against a demo host, lock the simulator and take a Lock Screen screenshot.
- Expand the island and take a screenshot.
- Repeat both in light and dark appearance.

Expected: only text, no colored marks, and the system background in both appearances. It should match the proposal's "Proposed" Lock Screen.

- [ ] **Step 4: Run the Live Activity tests**

Run: the unit test command with `-only-testing:AidenOnTheGoTests/AidenNativeIntegrationTests`. Expected: PASS.

- [ ] **Step 5: Commit**

Add a `ios/CHANGELOG.md` entry: "Live Activity and Dynamic Island show plain text on a clean background."

```bash
git add ios/AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift ios/CHANGELOG.md
git commit -m "Restyle the Live Activity and Dynamic Island as plain text"
```

### Task 3: Deny and Review on the card, and the shared action broker

**Files:**
- Modify: `ios/AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift`:
  - `ContentState.approval: AgentRunApprovalTarget?` (decoded with `decodeIfPresent`, default `nil`).
  - The reducer sets and clears it.
  - `AgentRunTextPresentation.actions`.
- Modify: `ios/AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift`:
  - `approvalRequired(instanceID:streamID:target:)`.
  - New `approvalAnswered(approvalID:decision:)`.
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatViewModel.swift:3537`. Pass `.init(approvalID: approval.id, runID: nil)` when `approval.canRespond`; otherwise pass `nil`.
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatViewModel+ForeignRuns.swift:350,460`. Pass `.init(approvalID: <run approval id>, runID: runId)` from the run's pending approval projection.
- Create: `ios/AidenOnTheGo/LiveActivities/AidenApprovalIntents.swift` (app **and** widget targets). It holds `DenyApprovalIntent`.
- Create: `ios/AidenOnTheGo/Features/Remote/AidenBackgroundActionBroker.swift` (app target). It holds the action types, the broker and the responder.
- Modify: `ios/AidenOnTheGo/AidenOnTheGoApp.swift`. In app init, next to the `openTap` wiring, wire `AidenBackgroundActionBroker.shared.perform`.
- Modify: `ios/AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`. `AgentRunTextCard` renders actions.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.

**Interfaces:**
- Consumes: `AidenRemoteClient.respondToApproval(id:decision:scope:idempotencyKey:)`, `respondToRunApproval(runId:approvalId:decision:scope:idempotencyKey:)`, `respondToQuestion(id:request:idempotencyKey:)`, `respondToRunQuestion(runId:promptId:request:idempotencyKey:)`, `AidenRemoteCoordinator.requestContext(for:)`, `remoteClient(for:)`, and `AidenRemoteClientError.server(statusCode:body:)`.
- Produces (Task 4 relies on these):

```swift
struct AgentRunApprovalTarget: Codable, Hashable, Sendable { let approvalID: String; let runID: String? }

enum AgentRunTextAction: Equatable { case review, deny }   // AgentRunTextPresentation.actions: [AgentRunTextAction]

enum AidenAlertAction: Equatable, Sendable {
    case approve(instanceID: String, chatID: String, target: AgentRunApprovalTarget)
    case deny(instanceID: String, chatID: String, target: AgentRunApprovalTarget)
    case reply(instanceID: String, chatID: String, promptID: String, runID: String?, text: String)
}
enum AidenAlertActionOutcome: Equatable, Sendable { case done, alreadyResolved, openApp(URL?), dropped }

protocol AidenAlertActionTransport: Sendable {   // AidenRemoteClient conforms in an extension
    func respondToApproval(id: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenApprovalResponse
    func respondToRunApproval(runId: String, approvalId: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenRemoteRunApprovalResult
    func respondToQuestion(id: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenQuestionRespondResponse
    func respondToRunQuestion(runId: String, promptId: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenRemoteRunQuestionResult
}

struct AidenAlertActionResponder {
    enum ClientLookup { case client(any AidenAlertActionTransport), unreachable, forgotten }
    let lookup: @MainActor (String) -> ClientLookup        // instanceID → client
    @MainActor func run(_ action: AidenAlertAction) async -> AidenAlertActionOutcome
}

@MainActor final class AidenBackgroundActionBroker {
    static let shared: AidenBackgroundActionBroker
    var perform: (@MainActor (AidenAlertAction) async -> AidenAlertActionOutcome)?
    func run(_ action: AidenAlertAction) async -> AidenAlertActionOutcome   // .openApp(nil) when perform is unset
}

struct DenyApprovalIntent: LiveActivityIntent   // @Parameter instanceID, chatID, approvalID, runID: String?
// AgentRunTextCard gains `deny: DenyApprovalIntent?`; the widget builds it from context.attributes.instanceID,
// context.state.sessionID and context.state.approval when .deny is among the actions.
```

- [ ] **Step 1: Write the failing tests**

```swift
func testApprovalTargetIsSetWhileWaitingAndClearedByAnyLaterTransition() {
    let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: nil)
    let waiting = AgentRunActivityStateReducer.waitingForApproval(state: base(), target: target)
    XCTAssertEqual(waiting.approval, target)
    XCTAssertNil(AgentRunActivityStateReducer.toolStarted(name: "bash", state: waiting).approval)
    XCTAssertNil(AgentRunActivityStateReducer.final(status: .complete, activity: "Done", state: waiting, errorSummary: nil).approval)
}

func testCardOffersReviewAndDenyOnlyForAFreshAnswerableApproval() {
    let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: nil)
    let fresh = AgentRunActivityStateReducer.waitingForApproval(state: base(), target: target)
    XCTAssertEqual(AgentRunTextPresentation.make(state: fresh, systemMarkedStale: false).actions, [.review, .deny])
    XCTAssertEqual(AgentRunTextPresentation.make(state: fresh, systemMarkedStale: true).actions, [.review])
    let unanswerable = AgentRunActivityStateReducer.waitingForApproval(state: base(), target: nil)
    XCTAssertEqual(AgentRunTextPresentation.make(state: unanswerable, systemMarkedStale: false).actions, [.review])
    XCTAssertEqual(AgentRunTextPresentation.make(state: base(), systemMarkedStale: false).actions, [])
}

func testStateWithoutApprovalTargetDecodesWithoutActions() throws {
    let json = /* a ContentState JSON encoded without the "approval" key, status "waitingForApproval" */
    let state = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: json)
    XCTAssertNil(state.approval)
    XCTAssertEqual(AgentRunTextPresentation.make(state: state, systemMarkedStale: false).actions, [.review])
}

@MainActor func testResponderDeniesOnTheStreamOrRunRoute() async {
    let fake = FakeAlertTransport()
    let responder = AidenAlertActionResponder(lookup: { _ in .client(fake) })
    XCTAssertEqual(await responder.run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil))), .done)
    XCTAssertEqual(await responder.run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: "r1"))), .done)
    XCTAssertEqual(fake.calls, [.streamApproval(id: "ap", decision: .deny), .runApproval(runId: "r1", approvalId: "ap", decision: .deny)])
}

@MainActor func testResponderTreatsResolvedApprovalAsDone() async {
    for code in ["approval_resolved", "approval_already_resolved", "approval_expired"] {
        let fake = FakeAlertTransport(failure: .server(statusCode: 409, body: .init(code: code)))
        let outcome = await AidenAlertActionResponder(lookup: { _ in .client(fake) })
            .run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .alreadyResolved, code)
    }
}

@MainActor func testResponderOpensChatWhenMacUnreachable() async {
    let outcome = await AidenAlertActionResponder(lookup: { _ in .unreachable })
        .run(.deny(instanceID: "mac", chatID: "c1", target: .init(approvalID: "ap", runID: nil)))
    XCTAssertEqual(outcome, .openApp(AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")))
}

@MainActor func testResponderDropsActionForForgottenMac() async {
    XCTAssertEqual(await AidenAlertActionResponder(lookup: { _ in .forgotten })
        .run(.deny(instanceID: "gone", chatID: "c", target: .init(approvalID: "ap", runID: nil))), .dropped)
}

@MainActor func testResponderRepliesAsTheFirstQuestionsCustomAnswer() async {
    let fake = FakeAlertTransport()
    _ = await AidenAlertActionResponder(lookup: { _ in .client(fake) })
        .run(.reply(instanceID: "mac", chatID: "c", promptID: "q1", runID: nil, text: "Just the App Store version"))
    XCTAssertEqual(fake.calls, [.question(id: "q1", request: .init(cancelled: false,
        answers: [.custom(questionIndex: 0, answer: "Just the App Store version")]))])
}
```

`FakeAlertTransport` is a test double that records calls and can throw a configured `AidenRemoteClientError`. Build its `body` with the envelope type's own initializer or decoder; match the real field names when writing the test.

- [ ] **Step 2: Run the tests to see them fail**

Run the unit test command for these tests. Expected: compile failures for the new names.

- [ ] **Step 3: Implement the state, reducer and presentation changes**
  - `waitingForApproval(state:target:)` sets `approval`.
  - Every other reducer transition that leaves `.waitingForApproval` sets `approval = nil`, including `final`, `stale` when the status changes, and `toolStarted`.
  - `actions` rules:
    - `[.review, .deny]` when the card is fresh, not final, `.waitingForApproval`, and `approval != nil`.
    - `[.review]` for every other `.waitingForApproval` or `.waitingForAnswer`.
    - Otherwise `[]`.

- [ ] **Step 4: Implement the responder, broker and intent**
  - **Responder:**
    - Deny and approve use scope `nil` (meaning once) and a fresh `UUID()` idempotency key.
    - A reply sends `.custom(questionIndex: 0, answer: text)`, routed by `runID`.
    - `.server(statusCode: 409, …)` with one of the resolved or expired codes (`approval_resolved`, `approval_already_resolved`, `approval_expired`, `question_already_resolved`, `question_expired`) returns `.alreadyResolved`.
    - Any other error returns `.openApp(chatURL)`.
  - **App wiring.** `perform` builds a responder whose `lookup` returns:
    - `.forgotten` when the coordinator has no installation for the ID;
    - `.unreachable` when `requestContext(for:)` throws;
    - otherwise `.client(remoteClient(for: context))`.
  - **`DenyApprovalIntent.perform()`:**
    - Calls `AidenBackgroundActionBroker.shared.run(.deny(...))`.
    - On `.done` or `.alreadyResolved`, calls `AidenRemoteLiveActivityManager.shared.approvalAnswered(approvalID:decision: .deny)`.
    - On `.openApp(url)`, returns an `OpensIntent` with that URL.
    - `approvalAnswered` sets the card back to `.thinking` with the activity line "Denied" and clears `approval`.
    - `static var isDiscoverable: Bool { false }`.
  - **Widget.** `AgentRunTextCard` renders the actions as a trailing-aligned `HStack(spacing: 22)` of plain text buttons:
    - Review: `Link(destination: chatURL)`, `.primary`, semibold.
    - Deny: `Button(intent: DenyApprovalIntent(...))`, `.secondary`, semibold.

- [ ] **Step 5: Run the tests to see them pass, then the full unit suite**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/AidenOnTheGo ios/AidenLiveActivityWidget ios/AidenOnTheGoTests ios/AidenOnTheGo.xcodeproj/project.pbxproj
git commit -m "Add Deny and Review to the Live Activity"
```

### Task 4: Approve, Deny and Reply on run alerts

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift`:
  - Pull the content building out of `AidenRunAlertNotifier.notify` into `AidenRunAlertContent`.
  - `notify` gains `detail: AidenRunAlertDetail?`.
  - `installPresentationDelegate()` registers the categories.
  - `AidenNotificationPresentationDelegate.userNotificationCenter(_:didReceive:)` turns non-default actions into an `AidenAlertAction`, runs it through the broker, and sends `.openApp(url)` to `openTap`.
- Modify: `ios/AidenOnTheGo/Features/Chat/AidenChatViewModel.swift`:
  - `alertRun(.needsApproval…)` (line 3529) passes `.approval(target:summary:canAllow:)`.
  - `alertRun(.needsAnswer…)` (line 3612) passes `.question(promptID:runID:text:acceptsReply:)`, where `acceptsReply` is `question.questions.count == 1`.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.
- Docs: `docs/aiden-on-the-go-remote-access.md`. Add a "Notifications" subsection covering actions, Face ID for Approve, and Deny anywhere.

**Interfaces:**
- Consumes: `AgentRunApprovalTarget`, `AidenAlertAction`, `AidenBackgroundActionBroker` (Task 3), and `AidenNotificationPreferences.showMessageText` (Task 5).
  - Task 4 can run before Task 5. In that case, hard-code `true` behind a `showMessageText: Bool` parameter, and Task 5 wires the preference in.
- Produces:

```swift
enum AidenRunAlertDetail: Equatable, Sendable {
    case approval(target: AgentRunApprovalTarget, summary: String, canAllow: Bool)
    case question(promptID: String, runID: String?, text: String, acceptsReply: Bool)
}
enum AidenRunAlertCategory {
    static let approval = "aiden.run.approval"            // Approve (authenticationRequired), Deny (destructive), Open chat
    static let approvalDenyOnly = "aiden.run.approval.deny" // Deny, Open chat
    static let questionReply = "aiden.run.question.reply"   // Reply (text input), Open chat
    static let question = "aiden.run.question"              // Open chat
    static let actionApprove = "aiden.action.approve", actionDeny = "aiden.action.deny",
               actionReply = "aiden.action.reply", actionOpen = "aiden.action.open"
    static func all() -> Set<UNNotificationCategory>
}
enum AidenRunAlertContent {
    static func make(kind: AidenRunAlertKind, detail: AidenRunAlertDetail?, instanceID: String, chatID: String,
                     chatTitle: String, deepLink: URL, showMessageText: Bool) -> UNMutableNotificationContent
}
extension AidenAlertAction {
    init?(actionIdentifier: String, userInfo: [AnyHashable: Any], replyText: String?)
}
```

- [ ] **Step 1: Write the failing tests**

```swift
func testApprovalAlertCarriesApproveOnlyWhenThePhoneMayAllow() {
    let target = AgentRunApprovalTarget(approvalID: "ap", runID: nil)
    let allowed = make(.needsApproval, .approval(target: target, summary: "Run npm run test:e2e", canAllow: true))
    XCTAssertEqual(allowed.categoryIdentifier, AidenRunAlertCategory.approval)
    let denyOnly = make(.needsApproval, .approval(target: target, summary: "Run npm run test:e2e", canAllow: false))
    XCTAssertEqual(denyOnly.categoryIdentifier, AidenRunAlertCategory.approvalDenyOnly)
}

func testAlertBodyShowsMessageTextOnlyWhenAllowed() {
    let detail = AidenRunAlertDetail.approval(target: .init(approvalID: "ap", runID: nil), summary: "Run npm run test:e2e", canAllow: true)
    XCTAssertEqual(make(.needsApproval, detail, showMessageText: true).body, "Run npm run test:e2e")
    XCTAssertEqual(make(.needsApproval, detail, showMessageText: false).body, AidenRunAlertKind.needsApproval.body)
}

func testMultiQuestionPromptGetsOpenOnly() {
    let content = make(.needsAnswer, .question(promptID: "q", runID: nil, text: "Which build?", acceptsReply: false))
    XCTAssertEqual(content.categoryIdentifier, AidenRunAlertCategory.question)
}

func testAlertActionRoundTripsThroughUserInfo() {
    let target = AgentRunApprovalTarget(approvalID: "ap", runID: "r1")
    let content = make(.needsApproval, .approval(target: target, summary: "x", canAllow: true))
    XCTAssertEqual(AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: content.userInfo, replyText: nil),
                   .deny(instanceID: "mac", chatID: "c1", target: target))
    XCTAssertNil(AidenAlertAction(actionIdentifier: "unknown", userInfo: content.userInfo, replyText: nil))
    XCTAssertNil(AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionReply, userInfo: content.userInfo, replyText: "  "))
}

func testRegisteredApproveActionRequiresUnlock() {
    let approval = AidenRunAlertCategory.all().first { $0.identifier == AidenRunAlertCategory.approval }!
    let approve = approval.actions.first { $0.identifier == AidenRunAlertCategory.actionApprove }!
    XCTAssertTrue(approve.options.contains(.authenticationRequired))
    XCTAssertTrue(approval.actions.first { $0.identifier == AidenRunAlertCategory.actionDeny }!.options.contains(.destructive))
}
```

`make(...)` is a test helper that calls `AidenRunAlertContent.make` with instance "mac", chat "c1", title "Fix flaky login test", and `showMessageText` defaulting to `true`.

- [ ] **Step 2: Run the tests to see them fail.** Expected: compile failures.

- [ ] **Step 3: Implement `AidenRunAlertContent`, the categories and the action parsing**
  - The title stays the sanitized chat title.
  - The body is the sanitized summary or question text (`AidenScheduledRunNotifier.displaySafe(_, limit: 180)`) when `showMessageText` is on. Otherwise it's `kind.body`.
  - `userInfo` keeps the existing deep link and instance keys, and adds `aiden.chatID`, `aiden.approvalID`, `aiden.runID`, `aiden.promptID`.
  - The thread identifier and interruption level stay unchanged.
  - Approve sends scope `nil` (once).
  - A blank Reply parses as `nil`; the delegate then treats it like Open chat.

- [ ] **Step 4: Run the tests to see them pass, then the full unit suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/AidenOnTheGo ios/AidenOnTheGoTests docs/aiden-on-the-go-remote-access.md ios/CHANGELOG.md
git commit -m "Add Approve, Deny and Reply to run alerts"
```

### Task 5: Settings → Notifications

**Files:**
- Create: `ios/AidenOnTheGo/Features/Remote/AidenNotificationPreferences.swift` (app target).
- Create: `ios/AidenOnTheGo/Features/Workspace/AidenNotificationSettingsView.swift` (app target).
- Modify: `ios/AidenOnTheGo/Features/Workspace/AidenAppSettingsView.swift`. Add a `Section { NavigationLink { AidenNotificationSettingsView() } label: { Label("Notifications", systemImage: "bell") } }` after Appearance.
- Modify: `ios/AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift`:
  - `AidenRunAlertPolicy.shouldPost` gains `preferences:`.
  - `notifyBotHandoff` honors `botNeedsMe`.
  - `showMessageText` feeds Task 4's content builder.
- Modify: `ios/AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift`. `appendResponse` and the excerpt in `finish` do nothing unless `replyTextOnLockScreen` is on.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.
- Docs: `docs/aiden-on-the-go-remote-access.md`, `ios/CHANGELOG.md`, `PRODUCT.md` (the iOS feature list).

**Interfaces:**
- Produces:

```swift
struct AidenNotificationPreferences: Codable, Equatable, Sendable {
    var needsAnswer = true, responseReady = true, runFailed = true, botNeedsMe = true
    var showMessageText = true, replyTextOnLockScreen = false, quietInOpenChat = true
    static let defaultsKey = "aiden.notifications.preferences"
    static func load(from defaults: UserDefaults) -> AidenNotificationPreferences
    func save(to defaults: UserDefaults)
    func allows(_ kind: AidenRunAlertKind) -> Bool   // needsApproval/needsAnswer → needsAnswer; completed → responseReady; failed → runFailed
}
enum AidenNotificationPermissionRow: Equatable {
    case on, off(canAsk: Bool)   // .off(canAsk: true) shows "Turn on"; .off(canAsk: false) shows "Open Settings"
    static func state(for status: UNAuthorizationStatus) -> AidenNotificationPermissionRow
}
```

- [ ] **Step 1: Write the failing tests**

```swift
func testPreferencesDefaultAndRoundTrip() {
    let suite = UserDefaults(suiteName: #function)!; suite.removePersistentDomain(forName: #function)
    var prefs = AidenNotificationPreferences.load(from: suite)
    XCTAssertTrue(prefs.showMessageText); XCTAssertFalse(prefs.replyTextOnLockScreen); XCTAssertTrue(prefs.quietInOpenChat)
    prefs.responseReady = false; prefs.save(to: suite)
    XCTAssertFalse(AidenNotificationPreferences.load(from: suite).responseReady)
}

func testPreferencesGateEachAlertKind() {
    var prefs = AidenNotificationPreferences(); prefs.needsAnswer = false
    XCTAssertFalse(AidenRunAlertPolicy.shouldPost(kind: .needsApproval, appState: .background, isChatOnScreen: false,
                                                  alreadyAlerted: false, isAuthorized: true, preferences: prefs))
    XCTAssertTrue(AidenRunAlertPolicy.shouldPost(kind: .completed, appState: .background, isChatOnScreen: false,
                                                 alreadyAlerted: false, isAuthorized: true, preferences: prefs))
}

func testQuietInOpenChatOffAlertsForTheChatOnScreenWhileInactive() {
    var prefs = AidenNotificationPreferences(); prefs.quietInOpenChat = false
    XCTAssertTrue(AidenRunAlertPolicy.shouldPost(kind: .completed, appState: .inactive, isChatOnScreen: true,
                                                 alreadyAlerted: false, isAuthorized: true, preferences: prefs))
    XCTAssertFalse(AidenRunAlertPolicy.shouldPost(kind: .completed, appState: .active, isChatOnScreen: true,
                                                  alreadyAlerted: false, isAuthorized: true, preferences: prefs))
}

func testDeniedPermissionBlocksEveryKindAndShowsOpenSettings() {
    for kind in [AidenRunAlertKind.needsApproval, .needsAnswer, .completed, .failed] {
        XCTAssertFalse(AidenRunAlertPolicy.shouldPost(kind: kind, appState: .background, isChatOnScreen: false,
                                                      alreadyAlerted: false, isAuthorized: false, preferences: .init()))
    }
    XCTAssertEqual(AidenNotificationPermissionRow.state(for: .denied), .off(canAsk: false))
    XCTAssertEqual(AidenNotificationPermissionRow.state(for: .notDetermined), .off(canAsk: true))
}

@MainActor func testReplyTextStaysOffTheLockScreenByDefault() async throws {
    // Real ActivityKit, using the existing integration helpers (deliveredContent):
    // start, appendResponse("All 12 tests pass."), finish(.complete), with the default preferences.
    // Assert the delivered final state's responseExcerpt is "", and AgentRunTextPresentation.detail is nil.
}
```

Update the existing `shouldPost` call sites and tests to pass `kind:` and `preferences:`. Today's behavior stays the default.

- [ ] **Step 2: Run the tests to see them fail.**

- [ ] **Step 3: Implement the preferences, the policy gating and the manager gating**
  - The manager gets its preferences through an `init` parameter `preferences: @escaping @MainActor () -> AidenNotificationPreferences`, defaulting to `.load(from: .standard)`.

- [ ] **Step 4: Build the page**
  - **Layout:** a `Form`.
  - **Permission section:** one row showing "On", or a "Turn on" / "Open Settings" button, depending on `AidenNotificationPermissionRow`.
    - "Turn on" calls `requestAuthorization([.alert, .sound])`.
    - "Open Settings" opens `UIApplication.openNotificationSettingsURLString`.
  - **"Tell me when" section:** the four toggles.
  - **"Privacy" section:** the three toggles, with the footer "Message text and replies stay on this iPhone."
  - **Storage:** use `@AppStorage`-backed bindings through `AidenNotificationPreferences.load`/`save`.
  - **Styling:** follow `docs/settings-design-system.md` grouping. No accent outlines on rows.

- [ ] **Step 5: Run the tests to see them pass, then the full unit suite. Then check the page on the simulator in light and dark.**

- [ ] **Step 6: Commit**

```bash
git add ios/AidenOnTheGo ios/AidenOnTheGoTests ios/AidenOnTheGo.xcodeproj/project.pbxproj docs/aiden-on-the-go-remote-access.md ios/CHANGELOG.md PRODUCT.md
git commit -m "Add Settings → Notifications on iPhone"
```

### Task 6: One summary card for several runs on the same Mac

**Files:**
- Create: `ios/AidenOnTheGo/LiveActivities/AidenRunsSummaryActivityAttributes.swift` (app **and** widget targets). It holds the attributes and `AidenRunsSummaryPolicy`.
- Create: `ios/AidenLiveActivityWidget/AidenRunsSummaryLiveActivityWidget.swift` (widget target).
- Modify: `ios/AidenLiveActivityWidget/AgentRunLiveActivityWidget.swift`. Add the new widget to `AidenLiveActivityWidgetBundle`.
- Modify: `ios/AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift`. Route a run into the summary when its Mac already has another live run.
  - `start(...)` gains `machineName: String`. Pass the installation's `name` from both `start` call sites in `AidenChatViewModel.swift` (lines 2000, 2965) and from `AidenChatViewModel+ForeignRuns.swift:342`.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.

**Interfaces:**
- Produces:

```swift
struct AidenRunsSummaryActivityAttributes: ActivityAttributes {
    struct Row: Codable, Hashable, Sendable {
        var streamID: String; var chatID: String; var title: String
        var status: AgentRunActivityStatus; var updatedAt: Date; var isFinal: Bool
    }
    struct ContentState: Codable, Hashable { var rows: [Row] }
    var instanceID: String; var deviceID: String?; var machineName: String
}
enum AidenRunsSummaryPolicy {
    static func ordered(_ rows: [Row]) -> [Row]        // waiting (approval/answer) → failed → working → complete/cancelled; ties newest first
    static func headline(rows: [Row], machineName: String) -> (title: String, trailing: String?)
    static func visible(_ rows: [Row]) -> (shown: [Row], hiddenCount: Int)   // at most 3 shown
    static func rowStatus(_ row: Row) -> String        // "Needs approval", "Has a question", status.title, "Done", "Failed", "Stopped"
    static func tapChatID(_ rows: [Row]) -> String?    // first ordered row
}
```

- [ ] **Step 1: Write the failing tests**

```swift
func testSummaryOrdersByUrgencyThenRecency() {
    let rows = [row("a", .complete, t: 5, final: true), row("b", .runningCommand, t: 4), row("c", .waitingForApproval, t: 1), row("d", .failed, t: 2, final: true)]
    XCTAssertEqual(AidenRunsSummaryPolicy.ordered(rows).map(\.chatID), ["c", "d", "b", "a"])
}

func testSummaryHeadlineCountsRunsAndAsks() {
    let rows = [row("a", .waitingForApproval), row("b", .thinking), row("c", .complete, final: true)]
    let headline = AidenRunsSummaryPolicy.headline(rows: rows, machineName: "MacBook Pro")
    XCTAssertEqual(headline.title, "3 runs on MacBook Pro"); XCTAssertEqual(headline.trailing, "1 needs you")
    XCTAssertNil(AidenRunsSummaryPolicy.headline(rows: [row("b", .thinking), row("c", .thinking)], machineName: "Mac").trailing)
}

func testSummaryShowsThreeRowsAndCountsTheRest() {
    let rows = (0..<5).map { row("r\($0)", .thinking, t: Double($0)) }
    XCTAssertEqual(AidenRunsSummaryPolicy.visible(rows).shown.count, 3)
    XCTAssertEqual(AidenRunsSummaryPolicy.visible(rows).hiddenCount, 2)
}

@MainActor func testSecondRunOnTheSameMacMergesIntoOneSummaryCard() async throws {
    // Real ActivityKit manager. start(instance "mac", stream "s1"), then start(instance "mac", stream "s2").
    // Assert: Activity<AgentRunActivityAttributes>.activities for "mac" are ended (use assertDeliveredEnd),
    //         and exactly one Activity<AidenRunsSummaryActivityAttributes> exists, with rows s1 and s2.
    // Then finish both; assert the summary ends.
}

@MainActor func testRunsOnDifferentMacsNeverMergeIntoOneSummary() async throws {
    // start(instance "mac-a", "s1"), start(instance "mac-b", "s2"): two AgentRun activities, zero summary activities.
}
```

- [ ] **Step 2: Run the tests to see them fail.**

- [ ] **Step 3: Implement the policy and the attributes.** The headline is "\(rows.count) runs on \(machineName)". The trailing text is "\(n) needs you" when n > 0, otherwise `nil`.

- [ ] **Step 4: Integrate with the manager**
  - **Second live run on a Mac:** when `start` sees another non-final run activity for the same `instanceID`, or that Mac's summary already exists:
    - end the per-run activities `.immediate`;
    - request or update the summary with a row for each live run.
  - **Summary rows track their runs:**
    - Later `update`/`finish` calls for a stream in the summary update its row, through the existing throttle keyed by the summary activity ID.
    - When every row is final, end the summary with `.after(now + 300)`.
  - **Stays a summary:** it doesn't split back into single cards while it's live.
  - **Reconcile:** extend `reconcile` so leftover summary activities from a forgotten Mac end.

- [ ] **Step 5: Add the summary widget**
  - **Layout:** the same text-only style as Task 2.
    - The headline title, with `trailing` as secondary text.
    - Then up to 3 rows: chat title in `.primary`, row status in `.secondary`, trailing.
    - Then "+\(hiddenCount) more" when it's above 0.
  - **Tap:** `widgetURL` points at `tapChatID`.
  - **Island:**
    - Compact leading: "\(count) runs".
    - Compact trailing: `trailing`, or nothing.
    - Minimal: `Text("A")`.

- [ ] **Step 6: Run the tests to see them pass, then the full suite. Then check the card on the simulator with two runs.**

- [ ] **Step 7: Commit**

```bash
git add ios/AidenOnTheGo ios/AidenLiveActivityWidget ios/AidenOnTheGoTests ios/AidenOnTheGo.xcodeproj/project.pbxproj ios/CHANGELOG.md
git commit -m "Merge several runs on one Mac into a summary Live Activity"
```

### Task 7: Background grace so a run that's about to finish still alerts

**Files:**
- Create: `ios/AidenOnTheGo/Features/Remote/AidenBackgroundGrace.swift` (app target).
- Modify: `ios/AidenOnTheGo/LiveActivities/AidenRemoteLiveActivityManager.swift`. Expose `var hasLiveRuns: Bool` and `var onLiveRunsChange: (@MainActor (Bool) -> Void)?`.
- Modify: `ios/AidenOnTheGo/AidenOnTheGoApp.swift`. On `scenePhase` `.background`, call `appDidEnterBackground`. On `.active`, call `appWillEnterForeground`. Wire `onLiveRunsChange` to `liveRunsDidChange`.
- Test: `ios/AidenOnTheGoTests/AidenNativeIntegrationTests.swift`.

**Interfaces:**
- Produces:

```swift
@MainActor protocol AidenBackgroundTaskHost: AnyObject {
    func beginBackgroundTask(expirationHandler: @escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier
    func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier)
}
@MainActor final class AidenBackgroundGrace {
    init(host: AidenBackgroundTaskHost)
    func appDidEnterBackground(hasLiveRuns: Bool)
    func liveRunsDidChange(hasLiveRuns: Bool)
    func appWillEnterForeground()
}
```

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor func testGraceBeginsOnlyWithLiveRunsAndEndsWhenTheyFinish() {
    let host = FakeTaskHost(); let grace = AidenBackgroundGrace(host: host)
    grace.appDidEnterBackground(hasLiveRuns: false); XCTAssertEqual(host.begun, 0)
    grace.appDidEnterBackground(hasLiveRuns: true);  XCTAssertEqual(host.begun, 1)
    grace.appDidEnterBackground(hasLiveRuns: true);  XCTAssertEqual(host.begun, 1, "never two tasks")
    grace.liveRunsDidChange(hasLiveRuns: false);     XCTAssertEqual(host.ended, 1)
}

@MainActor func testGraceEndsExactlyOnceOnExpirationOrForeground() {
    let host = FakeTaskHost(); let grace = AidenBackgroundGrace(host: host)
    grace.appDidEnterBackground(hasLiveRuns: true)
    host.expire(); grace.appWillEnterForeground(); grace.liveRunsDidChange(hasLiveRuns: false)
    XCTAssertEqual(host.ended, 1)
}
```

- [ ] **Step 2: Run the tests to see them fail. Step 3: Implement. Step 4: Run them to see them pass, then the full suite.**

- [ ] **Step 5: Check on a device or the simulator.** Start a short run, background the app, and wait for the run to finish. Expected: the "Response complete" alert arrives and the card shows "Done". Without Task 7, the card froze.

- [ ] **Step 6: Commit, and update the plan status row**

Change this plan's row in `docs/plans/README.md` to "Implemented, in review".

```bash
git add ios/AidenOnTheGo ios/AidenOnTheGoTests ios/AidenOnTheGo.xcodeproj/project.pbxproj ios/CHANGELOG.md docs/plans/README.md
git commit -m "Keep a finishing run alive briefly after the app goes to the background"
```
