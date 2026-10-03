import XCTest
@testable import AidenOnTheGo

/// Behavioral coverage for the streaming hot paths: Live Activity update
/// coalescing, markdown prefix reuse, SSE framing, and bounded caches.
final class AidenStreamingPerformanceTests: XCTestCase {

    // MARK: - Live Activity coalescing

    @MainActor
    func testFirstUpdateDeliversImmediatelyAndBurstCoalescesToTheNewestValue() async throws {
        let harness = ThrottleHarness()
        let throttle = harness.makeThrottle()

        await throttle.submit("token-1")
        XCTAssertEqual(harness.delivered, ["token-1"])

        harness.advance(by: .milliseconds(200))
        await throttle.submit("token-2")
        harness.advance(by: .milliseconds(200))
        await throttle.submit("token-3")
        XCTAssertEqual(harness.delivered, ["token-1"], "Updates inside the window must wait.")
        try await harness.waitForSleepRequests(1)
        XCTAssertEqual(harness.sleeper.requested, [.milliseconds(800)], "The trailing write lands when the window closes.")

        harness.advance(by: .milliseconds(600))
        harness.sleeper.resumeAll()
        await throttle.waitForScheduledFlush()
        XCTAssertEqual(harness.delivered, ["token-1", "token-3"], "Only the newest coalesced value is written.")
    }

    @MainActor
    func testUrgentUpdateBypassesTheWindowAndSupersedesPendingValues() async throws {
        let harness = ThrottleHarness()
        let throttle = harness.makeThrottle()

        await throttle.submit("token-1")
        harness.advance(by: .milliseconds(100))
        await throttle.submit("token-2")
        try await harness.waitForSleepRequests(1)

        await throttle.submitUrgent("waiting-for-approval")
        XCTAssertEqual(harness.delivered, ["token-1", "waiting-for-approval"])
        XCTAssertNil(throttle.pendingValue)

        // The superseded trailing write must not land after the urgent state.
        harness.sleeper.resumeAll()
        await throttle.waitForScheduledFlush()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(harness.delivered, ["token-1", "waiting-for-approval"])
    }

    @MainActor
    func testUpdatesAfterTheWindowDeliverInlineAndDuplicatesAreSkipped() async {
        let harness = ThrottleHarness()
        let throttle = harness.makeThrottle()

        // The initial content handed to ActivityKit opens the window too.
        throttle.markDelivered("started")
        await throttle.submit("started")
        XCTAssertEqual(harness.delivered, [], "Re-submitting the delivered state is a no-op.")

        harness.advance(by: .seconds(1))
        await throttle.submit("token-1")
        harness.advance(by: .milliseconds(1_500))
        await throttle.submit("token-2")
        XCTAssertEqual(harness.delivered, ["token-1", "token-2"])
        XCTAssertTrue(harness.sleeper.requested.isEmpty)
    }

    @MainActor
    func testCancelDropsThePendingValue() async throws {
        let harness = ThrottleHarness()
        let throttle = harness.makeThrottle()

        await throttle.submit("token-1")
        await throttle.submit("token-2")
        try await harness.waitForSleepRequests(1)
        throttle.cancel()
        XCTAssertNil(throttle.pendingValue)
        harness.sleeper.resumeAll()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(harness.delivered, ["token-1"])
    }

    @MainActor
    func testATwoThousandTokenReplyWritesAboutOncePerSecond() async throws {
        let harness = ThrottleHarness()
        let throttle = harness.makeThrottle()

        // 2,000 tokens at 40 tokens/s span 50 s of streaming.
        for token in 0..<2_000 {
            await throttle.submit("token-\(token)")
            harness.advance(by: .milliseconds(25))
            if !harness.sleeper.isEmpty {
                if harness.elapsedSinceLastDelivery >= .seconds(1) {
                    harness.sleeper.resumeAll()
                    await throttle.waitForScheduledFlush()
                }
            }
        }
        await throttle.submitUrgent("complete")
        harness.sleeper.resumeAll()

        XCTAssertLessThanOrEqual(harness.delivered.count, 52)
        XCTAssertGreaterThanOrEqual(harness.delivered.count, 40)
        XCTAssertEqual(harness.delivered.last, "complete")
    }
}

// MARK: - Test doubles

@MainActor
private final class ThrottleHarness {
    let sleeper = ManualSleeper()
    private(set) var delivered: [String] = []
    private let origin = ContinuousClock.now
    private var offset: Duration = .zero
    private var lastDeliveryOffset: Duration?

    var elapsedSinceLastDelivery: Duration {
        offset - (lastDeliveryOffset ?? .zero)
    }

    func advance(by duration: Duration) {
        offset += duration
    }

    func makeThrottle() -> AidenLatestValueThrottle<String> {
        AidenLatestValueThrottle<String>(
            interval: .seconds(1),
            now: { [unowned self] in self.origin + self.offset },
            sleep: { [sleeper] duration in try await sleeper.sleep(for: duration) },
            deliver: { [unowned self] value in
                self.delivered.append(value)
                self.lastDeliveryOffset = self.offset
            }
        )
    }

    func waitForSleepRequests(_ count: Int) async throws {
        for _ in 0..<200 where sleeper.requested.count < count {
            await Task.yield()
        }
        XCTAssertGreaterThanOrEqual(sleeper.requested.count, count)
    }
}

@MainActor
private final class ManualSleeper {
    private(set) var requested: [Duration] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var isEmpty: Bool { waiters.isEmpty }

    /// Suspends until the test resumes it, then reports cancellation the same
    /// way `Task.sleep` does.
    func sleep(for duration: Duration) async throws {
        requested.append(duration)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters.append(continuation)
        }
        try Task.checkCancellation()
    }

    func resumeAll() {
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}
