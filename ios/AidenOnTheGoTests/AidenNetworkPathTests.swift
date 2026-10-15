import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenNetworkPathTests: XCTestCase {
    func testDecisionTableParksOfflineAndSpendsBackoffOnlyOnline() {
        var policy = AidenStreamRecoveryPolicy()
        XCTAssertEqual(policy.afterStreamFailure(isNetworkAvailable: false), .waitForNetwork)
        XCTAssertEqual(policy.afterStreamFailure(isNetworkAvailable: true), .probeStatus)

        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: false), .waitForNetwork)
        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: false), .waitForNetwork)
        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: true), .backoff(attempt: 0))
        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: true), .backoff(attempt: 1))

        policy.backoffInterruptedByNetworkLoss()
        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: true), .backoff(attempt: 1))

        policy.recordHealthy()
        XCTAssertEqual(policy.afterProbeFailure(isNetworkAvailable: true), .backoff(attempt: 0))
    }

    func testOfflineStreamFailureParksWithoutProbingThenReconnectsWhenOnline() async throws {
        let path = AidenNetworkAvailability(isNetworkAvailable: false)
        let sleeper = ManualSleeper()
        let recovery = AidenStreamNetworkRecovery(path: path, sleep: sleeper.sleep)
        let recorder = WaitRecorder()

        let parked = Task { try await recovery.shouldProbeAfterStreamFailure(onWaiting: recorder.record) }
        try await eventually { recorder.states == [true] }
        path.setAvailable(true)

        let shouldProbe = try await parked.value
        XCTAssertFalse(shouldProbe, "network return reopens the stream directly, without a status probe")
        XCTAssertEqual(recorder.states, [true, false])
        XCTAssertTrue(sleeper.requests.isEmpty)
        XCTAssertEqual(recovery.policy.retryAttempt, 0)

        let online = try await recovery.shouldProbeAfterStreamFailure(onWaiting: recorder.record)
        XCTAssertTrue(online)
        XCTAssertEqual(recorder.states, [true, false], "an online failure never reports waiting")
    }

    func testFlappingPathWakesTheParkedConsumerOnceAndNeverSpendsBackoff() async throws {
        let path = AidenNetworkAvailability(isNetworkAvailable: false)
        let sleeper = ManualSleeper()
        let recovery = AidenStreamNetworkRecovery(path: path, sleep: sleeper.sleep)
        let recorder = WaitRecorder()
        let wakes = Counter()

        let first = Task { [recovery] in
            let probe = try await recovery.shouldProbeAfterStreamFailure(onWaiting: recorder.record)
            wakes.value += 1
            return probe
        }
        try await eventually { recorder.states == [true] }
        // Online, offline, online, online before the parked consumer even runs.
        path.setAvailable(true)
        path.setAvailable(false)
        path.setAvailable(true)
        path.setAvailable(true)
        let firstProbe = try await first.value
        XCTAssertFalse(firstProbe)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(wakes.value, 1, "one parked consumer reconnects once however often the path flaps")

        // The reopened stream fails again because the path dropped once more:
        // a probe failure while offline parks again instead of backing off.
        path.setAvailable(false)
        let second = Task { [recovery] in
            var recovery = recovery
            let outcome = try await recovery.recoverAfterProbeFailure(
                onBackoff: { XCTFail("no backoff while offline") },
                onWaiting: recorder.record
            )
            return (outcome, recovery.policy.retryAttempt)
        }
        try await eventually { recorder.states == [true, false, true] }
        path.setAvailable(true)
        let (outcome, attempt) = try await second.value
        XCTAssertEqual(outcome, .networkReturned)
        XCTAssertEqual(attempt, 0)
        XCTAssertTrue(sleeper.requests.isEmpty)
        XCTAssertEqual(recorder.states, [true, false, true, false])
    }

    func testPathDropDuringBackoffRefundsTheAttemptAndWaitsForNetwork() async throws {
        let path = AidenNetworkAvailability(isNetworkAvailable: true)
        let sleeper = ManualSleeper()
        let recovery = AidenStreamNetworkRecovery(
            path: path,
            sleep: sleeper.sleep,
            delayMilliseconds: { 1_000 * ($0 + 1) }
        )
        let recorder = WaitRecorder()
        let backoffs = Counter()

        let interrupted = Task { [recovery] in
            var recovery = recovery
            let outcome = try await recovery.recoverAfterProbeFailure(
                onBackoff: { backoffs.value += 1 },
                onWaiting: recorder.record
            )
            return (outcome, recovery)
        }
        try await eventually { sleeper.requests == [1_000] }
        XCTAssertEqual(backoffs.value, 1)
        path.setAvailable(false)
        try await eventually { recorder.states == [true] }
        XCTAssertTrue(sleeper.wasCancelled, "the backoff sleep ends as soon as the path drops")
        path.setAvailable(true)
        var (outcome, resumed) = try await interrupted.value
        XCTAssertEqual(outcome, .networkReturned)
        XCTAssertEqual(recorder.states, [true, false])
        XCTAssertEqual(resumed.policy.retryAttempt, 0, "the interrupted backoff is refunded")

        // The next online failure starts from the same first delay.
        sleeper.completesImmediately = true
        let next = try await resumed.recoverAfterProbeFailure(onBackoff: { backoffs.value += 1 }, onWaiting: recorder.record)
        XCTAssertEqual(next, .backoffElapsed)
        XCTAssertEqual(sleeper.requests, [1_000, 1_000])
    }

    func testOnlineProbeFailuresKeepGrowingTheBackoff() async throws {
        let path = AidenNetworkAvailability(isNetworkAvailable: true)
        let sleeper = ManualSleeper()
        sleeper.completesImmediately = true
        var recovery = AidenStreamNetworkRecovery(path: path, sleep: sleeper.sleep, delayMilliseconds: { 1_000 * ($0 + 1) })
        let recorder = WaitRecorder()
        for _ in 0..<3 {
            let outcome = try await recovery.recoverAfterProbeFailure(onBackoff: {}, onWaiting: recorder.record)
            XCTAssertEqual(outcome, .backoffElapsed)
        }
        XCTAssertEqual(sleeper.requests, [1_000, 2_000, 3_000])
        XCTAssertTrue(recorder.states.isEmpty)
        recovery.recordHealthy()
        _ = try await recovery.recoverAfterProbeFailure(onBackoff: {}, onWaiting: recorder.record)
        XCTAssertEqual(sleeper.requests.last, 1_000)
    }

    func testCancellingAParkedConsumerEndsTheWaitAndClearsTheWaitingState() async throws {
        let path = AidenNetworkAvailability(isNetworkAvailable: false)
        let recovery = AidenStreamNetworkRecovery(path: path, sleep: { _ in })
        let recorder = WaitRecorder()
        let parked = Task { try await recovery.shouldProbeAfterStreamFailure(onWaiting: recorder.record) }
        try await eventually { recorder.states == [true] }
        parked.cancel()
        do {
            _ = try await parked.value
            XCTFail("a cancelled wait must not report a reconnect")
        } catch is CancellationError {}
        XCTAssertEqual(recorder.states, [true, false])
        XCTAssertFalse(path.isNetworkAvailable)
    }

    private func eventually(
        _ condition: () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<400 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition not met", file: file, line: line)
    }
}

@MainActor
private final class WaitRecorder {
    private(set) var states: [Bool] = []
    func record(_ waiting: Bool) async { states.append(waiting) }
}

@MainActor
private final class Counter {
    var value = 0
}

/// Records requested delays and suspends until cancelled, unless told to
/// complete immediately.
@MainActor
private final class ManualSleeper {
    private(set) var requests: [Int] = []
    private(set) var wasCancelled = false
    var completesImmediately = false

    func sleep(_ milliseconds: Int) async throws {
        requests.append(milliseconds)
        if completesImmediately { return }
        do {
            try await Task.sleep(for: .seconds(60))
        } catch {
            wasCancelled = true
            throw error
        }
    }
}
