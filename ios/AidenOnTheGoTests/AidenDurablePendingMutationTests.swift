import Foundation
import XCTest
@testable import AidenOnTheGo

private struct TestDurableAttempt: AidenDurablePendingAttempt {
    let id: UUID
    let createdAt: Date
    let payload: String

    var pendingAttemptID: UUID? { id }
    var pendingAttemptCreatedAt: Date { createdAt }
}

private func durableTestServerError(_ status: Int, _ code: String) throws -> AidenRemoteClientError {
    let body = try AidenRemoteJSONDecoder.decode(
        AidenRemoteErrorEnvelope.Body.self,
        from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req_durable_1","retryable":false}"#.utf8)
    )
    return .server(statusCode: status, body: body)
}

@MainActor
final class AidenDurablePendingMutationTests: XCTestCase {
    func testStorageReadFailureBlocksAllWritesFailClosed() {
        var engine = AidenDurablePendingMutation<TestDurableAttempt>(storageReadFailed: true)
        XCTAssertEqual(engine.phase, .storageBlocked(retained: nil))
        XCTAssertTrue(engine.isStorageBlocked)
        XCTAssertFalse(engine.canWrite)
        XCTAssertNil(engine.pending)

        var persistCalls = 0
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "first")
        let result = engine.begin(attempt) { _ in
            persistCalls += 1
            return .saved
        }
        XCTAssertEqual(result, .unavailable)
        XCTAssertEqual(persistCalls, 0)
        XCTAssertEqual(engine.beginRetry(), .unavailable)
    }

    func testPersistBeforeSendFailureTransitionsToStorageBlockedWithoutStarting() {
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "write-fail")

        let result = engine.begin(attempt) { _ in .storageFailed }
        XCTAssertEqual(result, .storageBlocked)
        XCTAssertEqual(engine.phase, .storageBlocked(retained: nil))
        XCTAssertTrue(engine.isStorageBlocked)
        XCTAssertFalse(engine.isInFlight)
        XCTAssertFalse(engine.canWrite)
        XCTAssertNil(engine.pending)
    }

    func testRejectedBeforeWriteReturnsToIdleWithoutBlockingStorage() {
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "invalid-draft")

        let result = engine.begin(attempt) { _ in .rejectedBeforeWrite }
        XCTAssertEqual(result, .rejectedBeforeWrite)
        XCTAssertEqual(engine.phase, .idle)
        XCTAssertFalse(engine.isStorageBlocked)
        XCTAssertTrue(engine.canWrite)
    }

    func testStorageGenerationDriftBlocksFreshBeginAndRetry() {
        var generation = "0:0"
        let restored = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "restored")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>(
            restoredAttempt: restored,
            storageGeneration: generation,
            currentStorageGeneration: { generation }
        )
        XCTAssertTrue(engine.storageIsCurrent)
        XCTAssertTrue(engine.canWrite)

        generation = "1:0"
        XCTAssertFalse(engine.storageIsCurrent)
        XCTAssertFalse(engine.canWrite)
        XCTAssertEqual(engine.beginRetry(), .unavailable)

        var freshEngine = AidenDurablePendingMutation<TestDurableAttempt>(
            storageGeneration: "0:0",
            currentStorageGeneration: { generation }
        )
        XCTAssertFalse(freshEngine.canWrite)
        XCTAssertEqual(
            freshEngine.begin(TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "x")) { _ in .saved },
            .unavailable
        )
    }

    func testReplayWindowBoundsAndExemptions() {
        let createdAt = Date(timeIntervalSince1970: 100_000)
        let attempt = TestDurableAttempt(id: UUID(), createdAt: createdAt, payload: "stop")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>(restoredAttempt: attempt)

        // Clock rollback (negative age) is rejected by bounded and nonNegativeAgeOnly.
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(-1), policy: .bounded()),
            .expired(attempt)
        )
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(-1), policy: .nonNegativeAgeOnly),
            .expired(attempt)
        )
        // Exact 23-hour boundary is rejected by default bounded policy.
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(23 * 3600), policy: .bounded()),
            .expired(attempt)
        )
        // PeerExchange protection (.nonNegativeAgeOnly) allows >= 23 hours when age >= 0.
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(25 * 3600), policy: .nonNegativeAgeOnly),
            .started(attempt)
        )
        XCTAssertEqual(engine.phase, .inFlight(attempt: attempt, previouslyUnknown: true))
        engine.markUncertain(matching: attempt.id)

        // OpenWork .isStop exemption (.unrestricted) allows >= 23h and clock skew.
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(48 * 3600), policy: .unrestricted),
            .started(attempt)
        )
        engine.markUncertain(matching: attempt.id)
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(-5), policy: .unrestricted),
            .started(attempt)
        )
        engine.markUncertain(matching: attempt.id)

        // Inside 23-hour window succeeds under default bounded policy.
        XCTAssertEqual(
            engine.beginRetry(now: createdAt.addingTimeInterval(23 * 3600 - 1)),
            .started(attempt)
        )
    }

    func testFirst409InFlightRetainsUncertainAndPreviouslyUnknownStickinessSurvivesDefiniteRefusals() throws {
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "mutation")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()
        XCTAssertEqual(engine.begin(attempt) { _ in .saved }, .started)
        XCTAssertFalse(engine.isUncertain)

        // First send hits 409 idempotency_in_flight -> MUST remain uncertain.
        let first = engine.resolveFailure(
            matching: attempt.id,
            error: try durableTestServerError(409, "idempotency_in_flight")
        ) { _ in
            XCTFail("Ambiguous failure must not clear durable storage")
            return .saved
        }
        XCTAssertEqual(first, .retainedUncertain)
        XCTAssertEqual(engine.phase, .uncertain(attempt: attempt))
        XCTAssertTrue(engine.isUncertain)

        // Retry enters inFlight(previouslyUnknown: true), then receives a definite 403 capability_denied.
        XCTAssertEqual(engine.beginRetry(now: attempt.createdAt.addingTimeInterval(10)), .started(attempt))
        XCTAssertTrue(engine.isUncertain, "Retrying an already-unknown attempt stays uncertain for concurrent load() reconciliation")
        let retryFailure = engine.resolveFailure(
            matching: attempt.id,
            error: try durableTestServerError(403, "capability_denied")
        ) { _ in
            XCTFail("previouslyUnknown stickiness must prevent clearing on a later guard refusal")
            return .saved
        }
        XCTAssertEqual(retryFailure, .retainedUncertain)
        XCTAssertEqual(engine.phase, .uncertain(attempt: attempt))

        // Same stickiness applies to structured non-unavailable rejections on retry.
        XCTAssertEqual(engine.beginRetry(now: attempt.createdAt.addingTimeInterval(20)), .started(attempt))
        let retryRejection = engine.resolveRejection(
            matching: attempt.id,
            isUncertainOutcome: false
        ) { _ in
            XCTFail("previouslyUnknown stickiness must prevent clearing on structured rejection")
            return .saved
        }
        XCTAssertEqual(retryRejection, .retainedUncertain)
        XCTAssertEqual(engine.phase, .uncertain(attempt: attempt))
    }

    func testFirstDefiniteBeforeEffectRefusalClearsPendingAndPersistsSettlingID() throws {
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "first-refusal")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()
        XCTAssertEqual(engine.begin(attempt) { _ in .saved }, .started)

        var settledIDs: [UUID] = []
        let resolution = engine.resolveFailure(
            matching: attempt.id,
            error: try durableTestServerError(409, "revision_conflict")
        ) { id in
            settledIDs.append(id)
            return .saved
        }
        XCTAssertEqual(resolution, .clearedDefiniteRefusal(storageBlocked: false))
        XCTAssertEqual(settledIDs, [attempt.id])
        XCTAssertEqual(engine.phase, .idle)
        XCTAssertNil(engine.pending)
    }

    func testConcurrentAuthoritativeLoadSettlementWinsOverLateRetryFailure() throws {
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "concurrent-load")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>(restoredAttempt: attempt)

        XCTAssertEqual(engine.beginRetry(now: attempt.createdAt.addingTimeInterval(5)), .started(attempt))
        XCTAssertTrue(engine.isInFlight)
        XCTAssertTrue(engine.isUncertain)

        // Concurrent load() observes authoritative receipt and settles the attempt while retry is in flight.
        var settledID: UUID?
        let settled = engine.settle(matching: attempt.id) { id in
            settledID = id
            return .saved
        }
        XCTAssertTrue(settled)
        XCTAssertEqual(settledID, attempt.id)
        XCTAssertEqual(engine.phase, .idle)

        // Late retry failure arrives -> MUST return .superseded and NOT re-mark uncertain.
        let late = engine.resolveFailure(
            matching: attempt.id,
            error: URLError(.networkConnectionLost)
        ) { _ in
            XCTFail("Superseded failure must not touch storage")
            return .saved
        }
        XCTAssertEqual(late, .superseded)
        XCTAssertEqual(engine.phase, .idle)
        XCTAssertFalse(engine.isUncertain)
        XCTAssertNil(engine.pending)
    }

    func testAbandonInFlightIfUnsettledPreservesIdentityAndClearsInFlight() {
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "stale-visit")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()
        XCTAssertEqual(engine.begin(attempt) { _ in .saved }, .started)
        XCTAssertTrue(engine.isInFlight)

        engine.abandonInFlightIfUnsettled(matching: attempt.id)
        XCTAssertFalse(engine.isInFlight)
        XCTAssertEqual(engine.phase, .uncertain(attempt: attempt))
        XCTAssertTrue(engine.isUncertain)
    }

    func testAdoptUncertainAndExternalStorageFailureRetainPendingAttempt() {
        let attempt = TestDurableAttempt(id: UUID(), createdAt: Date(), payload: "adopted")
        var engine = AidenDurablePendingMutation<TestDurableAttempt>()

        XCTAssertTrue(engine.adoptUncertain(attempt) { _ in .saved })
        XCTAssertEqual(engine.phase, .uncertain(attempt: attempt))

        engine.recordStorageFailure()
        XCTAssertEqual(engine.phase, .storageBlocked(retained: attempt))
        XCTAssertTrue(engine.isStorageBlocked)
        XCTAssertEqual(engine.pending, attempt)
        XCTAssertFalse(engine.canWrite)
    }
}
