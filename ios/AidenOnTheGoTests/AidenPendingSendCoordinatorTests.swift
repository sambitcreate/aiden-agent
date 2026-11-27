import Foundation
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenPendingSendCoordinatorTests: XCTestCase {
    @MainActor
    private final class DelayRecorder {
        var delays: [Duration] = []
        func append(_ delay: Duration) { delays.append(delay) }
    }

    private func makeDraftStore() -> AidenChatDraftStore {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-pending-send-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        return AidenChatDraftStore(root: root, excludeFromBackup: { _ in })
    }

    private func rateLimitError(retryAfterSeconds: Int? = nil) throws -> AidenRemoteClientError {
        let details = retryAfterSeconds.map { #","details":{"retryAfterSeconds":\#($0)}"# } ?? ""
        let json = #"{"code":"rate_limited","message":"Busy.","requestId":"req-429","retryable":true\#(details)}"#
        let body = try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.Body.self, from: Data(json.utf8))
        return .server(statusCode: 429, body: body)
    }

    func testNineTermCanRetryPredicateGuardsEveryCondition() async throws {
        let store = makeDraftStore()
        let coordinator = AidenPendingSendCoordinator(draftStore: store)
        let session = await store.beginSession(instanceId: "inst-1", chatId: "chat-1")
        let now = Date(timeIntervalSince1970: 100_000)

        let baseline = AidenPendingSendCoordinator.RetryEligibilityInputs(
            isConnected: true,
            isOwnerLive: true,
            isStarting: false,
            isSubmittingRunInput: false,
            isRestoringStream: false,
            hasActiveStream: false,
            isStreaming: false
        )

        // 1. No pendingSend -> false
        XCTAssertFalse(coordinator.canRetry(inputs: baseline, now: now))

        let attempt = coordinator.makeTurnAttempt(
            deviceId: "dev-1",
            request: AidenTurnStart(text: "Hello"),
            attachments: [],
            now: now
        )
        try await coordinator.persistBeforeSend(attempt, session: session)
        coordinator.adoptPersistedAttempt(attempt)

        XCTAssertTrue(coordinator.canRetry(inputs: baseline, now: now))

        // 2. Expired retry window (>= 24h) -> false
        XCTAssertFalse(coordinator.canRetry(inputs: baseline, now: now.addingTimeInterval(24 * 60 * 60)))
        // 3. Disconnected -> false
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: false, isOwnerLive: true, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: false, isStreaming: false
        ), now: now))
        // 4. Owner not live -> false
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: false, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: false, isStreaming: false
        ), now: now))
        // 5. Starting -> false
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: true, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: false, isStreaming: false
        ), now: now))
        // 6. Submitting run input -> false
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: false, isSubmittingRunInput: true,
            isRestoringStream: false, hasActiveStream: false, isStreaming: false
        ), now: now))
        // 7. Restoring stream -> false
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: true, hasActiveStream: false, isStreaming: false
        ), now: now))
        // 8. Active stream blocks a fresh turn retry
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: true, isStreaming: false
        ), now: now))
        // 9. Streaming blocks a fresh turn retry
        XCTAssertFalse(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: false, isStreaming: true
        ), now: now))

        // Run-input pending send (streamId != nil) IS retryable while streaming/activeStream.
        try await coordinator.discard(session: session)
        let runInputAttempt = AidenChatDraftStore.PendingSend(
            deviceId: "dev-1",
            request: AidenTurnStart(text: "Steer"),
            key: UUID(),
            createdAt: now,
            attachments: [],
            streamId: "stream-1",
            inputMode: .steer
        )
        try await coordinator.persistBeforeSend(runInputAttempt, session: session)
        coordinator.adoptPersistedAttempt(runInputAttempt)
        XCTAssertTrue(coordinator.canRetry(inputs: .init(
            isConnected: true, isOwnerLive: true, isStarting: false, isSubmittingRunInput: false,
            isRestoringStream: false, hasActiveStream: true, isStreaming: true
        ), now: now))
    }

    func testScheduleRateLimitedSendRetryEnforcesMaxBudgetOfThreeAndRotatesKeys() async throws {
        let store = makeDraftStore()
        let coordinator = AidenPendingSendCoordinator(draftStore: store)
        let session = await store.beginSession(instanceId: "inst-1", chatId: "chat-1")
        let error = try rateLimitError(retryAfterSeconds: 2)

        let recorder = DelayRecorder()
        coordinator.rateLimitedSendRetrySleep = { delay in
            await recorder.append(delay)
        }

        let initial = coordinator.makeTurnAttempt(
            deviceId: "dev-1",
            request: AidenTurnStart(text: "Hello"),
            attachments: []
        )
        try await coordinator.persistBeforeSend(initial, session: session)
        coordinator.adoptPersistedAttempt(initial)

        var current = initial
        var seenKeys: Set<UUID> = [initial.key]
        var automaticTriggers = 0

        for expectedRetryNumber in 1...AidenPendingSendCoordinator.maxRateLimitedSendRetries {
            let triggered = expectation(description: "automatic retry \(expectedRetryNumber)")
            let scheduled = await coordinator.scheduleRateLimitedSendRetry(
                replacing: current,
                error: error,
                session: session,
                isContextLive: { true },
                onRetry: {
                    automaticTriggers += 1
                    triggered.fulfill()
                }
            )
            XCTAssertTrue(scheduled)
            XCTAssertTrue(coordinator.isWaitingToRetryRateLimitedSend)
            XCTAssertFalse(coordinator.isPendingSendRefusedBecauseBusy)
            let fresh = try XCTUnwrap(coordinator.pendingSend)
            XCTAssertTrue(seenKeys.insert(fresh.key).inserted, "Each 429 retry must rotate to a fresh Idempotency-Key")
            current = fresh

            await fulfillment(of: [triggered], timeout: 2)
            XCTAssertFalse(coordinator.isWaitingToRetryRateLimitedSend)
        }

        XCTAssertEqual(automaticTriggers, AidenPendingSendCoordinator.maxRateLimitedSendRetries)
        XCTAssertEqual(recorder.delays, [.seconds(2), .seconds(2), .seconds(2)])

        // 4th 429 exhausts automatic retries and leaves Retry to the user.
        var fourthTriggered = false
        let fourthScheduled = await coordinator.scheduleRateLimitedSendRetry(
            replacing: current,
            error: error,
            session: session,
            isContextLive: { true },
            onRetry: { fourthTriggered = true }
        )
        XCTAssertTrue(fourthScheduled)
        XCTAssertFalse(coordinator.isWaitingToRetryRateLimitedSend)
        XCTAssertTrue(coordinator.isPendingSendRefusedBecauseBusy)
        XCTAssertFalse(fourthTriggered)
        XCTAssertEqual(
            coordinator.recoveryMessage(isStarting: false, isSubmittingRunInput: false),
            "Aiden Agent is still busy. Your message wasn’t sent; try again in a moment."
        )

        // Manual retry clears busy state and resets the retry budget.
        coordinator.cancelAutomaticRetryForManualAction()
        XCTAssertFalse(coordinator.isPendingSendRefusedBecauseBusy)
        XCTAssertEqual(coordinator.rateLimitedSendRetries, 0)
        XCTAssertEqual(
            coordinator.recoveryMessage(isStarting: false, isSubmittingRunInput: false),
            "Couldn’t confirm delivery. Retry uses the same saved request within its safe retry window."
        )
    }

    func testScheduleRateLimitedSendRetryStopsAutomaticallyWhenContextNotLiveOrStoreWriteFails() async throws {
        let store = makeDraftStore()
        let coordinator = AidenPendingSendCoordinator(draftStore: store)
        let session = await store.beginSession(instanceId: "inst-1", chatId: "chat-1")
        let error = try rateLimitError()

        let attempt = coordinator.makeTurnAttempt(
            deviceId: "dev-1",
            request: AidenTurnStart(text: "Hello"),
            attachments: []
        )
        try await coordinator.persistBeforeSend(attempt, session: session)
        coordinator.adoptPersistedAttempt(attempt)

        // Dead context keeps the rotated pending send on disk but does not schedule automatic resend.
        let scheduledDead = await coordinator.scheduleRateLimitedSendRetry(
            replacing: attempt,
            error: error,
            session: session,
            isContextLive: { false },
            onRetry: { XCTFail("Dead context must not fire automatic retry") }
        )
        XCTAssertTrue(scheduledDead)
        XCTAssertFalse(coordinator.isWaitingToRetryRateLimitedSend)
        XCTAssertTrue(coordinator.isPendingSendRefusedBecauseBusy)

        // Invalidated draft session causes savePendingSend to throw CancellationError -> returns false.
        _ = await store.beginSession(instanceId: "inst-1", chatId: "chat-1")
        let current = try XCTUnwrap(coordinator.pendingSend)
        let scheduledStaleSession = await coordinator.scheduleRateLimitedSendRetry(
            replacing: current,
            error: error,
            session: session,
            isContextLive: { true },
            onRetry: { XCTFail("Failed store write must not schedule retry") }
        )
        XCTAssertFalse(scheduledStaleSession)
    }
}
