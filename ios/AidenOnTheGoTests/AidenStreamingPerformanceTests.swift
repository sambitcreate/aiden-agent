import XCTest
import MarkdownUI
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

    // MARK: - Markdown prefix reuse

    private static let markdownFixtures: [String] = [
        """
        # Plan

        First paragraph with **bold** and `code`.
        It continues on a second line.

        - item one
        - item two

          nested paragraph in item two

        - item three
        1. ordered
        2. list

        Paragraph after the list.

        ```swift
        let a = 1

        let b = 2
        ```

        ~~~
        tilde fence
        ~~~

        | a | b |
        |---|---|
        | 1 | 2 |

        > quote line

        > another quote

            indented code

        Setext heading
        ==============

        * * *

        Final words.

        """,
        "Line one\r\n\r\nLine two\r\n\r\n- a\r\n\r\n  b\r\n\r\nEnd\r\n",
        "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.invalid\n",
        "Intro\n\n<!-- note\n\nstill comment -->\n\nAfter.\n",
        "Unclosed fence\n\n```\ncode\n\nmore code\n\nstill code\n",
        "````\n```\n\nnot closed by a shorter fence\n````\n\nAfter.\n",
    ]

    @MainActor
    func testChunkedParseMatchesAFullParseForEveryStreamedPrefix() {
        for fixture in Self.markdownFixtures {
            let cache = AidenMarkdownContentCache()
            var prefix = ""
            for character in fixture {
                prefix.append(character)
                XCTAssertEqual(
                    cache.content(for: prefix),
                    MarkdownContent(prefix),
                    "Chunked parse diverged at prefix: \(prefix.debugDescription)"
                )
            }
        }
    }

    @MainActor
    func testStreamingALongReplyParsesRoughlyLinearCharacters() {
        let paragraphs = (0..<200).map { "Paragraph \($0) with some **markdown** text to render." }
        let reply = paragraphs.joined(separator: "\n\n")
        let cache = AidenMarkdownContentCache()
        var prefix = ""
        var updates = 0
        for word in reply.split(separator: " ", omittingEmptySubsequences: false) {
            prefix += prefix.isEmpty ? String(word) : " " + word
            _ = cache.content(for: prefix)
            updates += 1
        }
        // A full reparse per update would hand the parser about
        // updates * reply.count / 2 characters; chunk reuse keeps it to the
        // settled chunks once plus a short tail per update.
        let quadratic = updates * reply.utf8.count / 2
        XCTAssertLessThan(cache.parsedCharacterCount, quadratic / 20)
        XCTAssertEqual(cache.content(for: reply), MarkdownContent(reply))
    }

    @MainActor
    func testMarkdownCacheStaysWithinItsEntryAndCharacterBudgets() {
        let cache = AidenMarkdownContentCache(maximumEntries: 8, maximumCharacters: 400)
        for message in 0..<50 {
            let text = (0..<4).map { "Message \(message) paragraph \($0)." }.joined(separator: "\n\n")
            XCTAssertEqual(cache.content(for: text), MarkdownContent(text))
            XCTAssertLessThanOrEqual(cache.entryCount, 8)
        }

        // A recently used message keeps its settled chunks: rendering it
        // again parses only the final block, which may still be growing.
        let recent = "Recent one.\n\nRecent two.\n\nTail.\n"
        _ = cache.content(for: recent)
        let parsedBefore = cache.parsedCharacterCount
        XCTAssertEqual(cache.content(for: recent), MarkdownContent(recent))
        XCTAssertEqual(cache.parsedCharacterCount - parsedBefore, "Tail.\n".utf8.count)
    }

    // MARK: - SSE line decoding

    private func decodeLines(_ text: String) async throws -> [String] {
        try await decodeLines(Array(text.utf8))
    }

    private func decodeLines(_ bytes: [UInt8], maximumLineBytes: Int = 1_024) async throws -> [String] {
        var lines: [String] = []
        try await AidenSSELineDecoder.forEachLine(
            in: AsyncStream<UInt8> { continuation in
                bytes.forEach { continuation.yield($0) }
                continuation.finish()
            },
            maximumLineBytes: maximumLineBytes
        ) { lines.append($0) }
        return lines
    }

    func testSSELineDecoderKeepsBlankDelimitersAndNormalizesCRLF() async throws {
        let lines = try await decodeLines(": heartbeat\r\n\r\nid: 7\nevent: x\r\ndata: a\ndata: b\n\n")
        XCTAssertEqual(lines, [": heartbeat", "", "id: 7", "event: x", "data: a", "data: b", ""])
    }

    func testSSELineDecoderDiscardsAnUnterminatedTailAtEOF() async throws {
        let lines = try await decodeLines("data: done\n\ndata: partial")
        XCTAssertEqual(lines, ["data: done", ""])
        // A multi-byte scalar split by EOF is discarded, not rejected.
        let truncated = Array("data: ok\n".utf8) + Array("é".utf8).prefix(1)
        let truncatedLines = try await decodeLines(truncated)
        XCTAssertEqual(truncatedLines, ["data: ok"])
    }

    func testSSELineDecoderRejectsInvalidUTF8AndOversizedLines() async throws {
        do {
            _ = try await decodeLines(Array("data: ".utf8) + [0xFF, 0x0A])
            XCTFail("Invalid UTF-8 must be rejected")
        } catch {
            guard case .invalidResponse? = error as? AidenRemoteClientError else {
                return XCTFail("Expected invalidResponse, received \(error)")
            }
        }
        let exact = try await decodeLines(Array(repeating: 0x78, count: 16) + [0x0A], maximumLineBytes: 16)
        XCTAssertEqual(exact, [String(repeating: "x", count: 16)])
        do {
            _ = try await decodeLines(Array(repeating: 0x78, count: 17) + [0x0A], maximumLineBytes: 16)
            XCTFail("An oversized line must be rejected")
        } catch {
            XCTAssertEqual(error as? AidenSSEParserError, .frameTooLarge)
        }
    }

    func testSSELineDecoderFeedsTheParserMultiLineDataFrames() async throws {
        let frame = """
        : keep-alive\r
        id: 3\r
        event: heartbeat\r
        data: {"protocolVersion":1,"streamId":"stream-1","sequence":3,\r
        data: "timestamp":"2026-08-19T07:00:00.000Z","type":"heartbeat","terminal":false,"payload":{}}\r
        \r

        """
        var parser = AidenSSEParser()
        var events: [AidenRemoteStreamEvent] = []
        try await AidenSSELineDecoder.forEachLine(
            in: AsyncStream<UInt8> { continuation in
                frame.utf8.forEach { continuation.yield($0) }
                continuation.finish()
            }
        ) { line in
            if let event = try parser.consume(line: line) { events.append(event) }
        }
        XCTAssertEqual(events.map(\.sequence), [3])
        XCTAssertEqual(events.first?.streamId, "stream-1")
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
