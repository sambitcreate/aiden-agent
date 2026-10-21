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

    @MainActor
    func testStreamedChunksRenderTheSameDocumentAsAFullParse() {
        for fixture in Self.markdownFixtures {
            let cache = AidenMarkdownContentCache()
            var prefix = ""
            for character in fixture {
                prefix.append(character)
                let chunks = cache.chunks(for: prefix)
                XCTAssertEqual(chunks.map(\.index), Array(chunks.indices))
                XCTAssertEqual(chunks.map(\.text).joined(), prefix)
                XCTAssertEqual(
                    MarkdownContent { for chunk in chunks { chunk.content } },
                    MarkdownContent(prefix),
                    "Chunked rendering diverged at prefix: \(prefix.debugDescription)"
                )
            }
        }
    }

    @MainActor
    func testSealedChunksKeepTheirPlaceAndAreNeverReparsedWhileTheTailGrows() {
        let cache = AidenMarkdownContentCache()
        var reply = "# Plan\n\nFirst paragraph is long enough to matter.\n\nSecond paragraph\n"
        XCTAssertEqual(
            cache.chunks(for: reply).map(\.text),
            ["# Plan\n\n", "First paragraph is long enough to matter.\n\n", "Second paragraph\n"]
        )
        for word in ["keeps ", "streaming ", "in ", "words."] {
            let parsedBefore = cache.parsedCharacterCount
            reply += word
            let chunks = cache.chunks(for: reply)
            XCTAssertEqual(chunks.map(\.index), [0, 1, 2], "The growing tail keeps one identity")
            XCTAssertEqual(chunks[1].text, "First paragraph is long enough to matter.\n\n")
            XCTAssertEqual(
                cache.parsedCharacterCount - parsedBefore,
                chunks[2].text.utf8.count,
                "Each update parses only the open tail, never the sealed chunks"
            )
        }
    }

    @MainActor
    func testOnlyTextThatWasNotOnScreenFadesIn() {
        let cache = AidenMarkdownContentCache()
        let shown = "Intro paragraph.\n\nSecond paragraph strea"
        // The first render fades nothing.
        XCTAssertEqual(AidenMarkdownChunkReveal.newChunkIndices(cache.chunks(for: shown), previouslyRenderedUTF8Count: nil), [])

        // The second paragraph's first line completes and moves into its own
        // chunk; its text was already on screen in the tail, so it must not flash.
        let sealed = "Intro paragraph.\n\nSecond paragraph streams.\n"
        let sealedChunks = cache.chunks(for: sealed)
        XCTAssertEqual(sealedChunks.count, 2)
        XCTAssertEqual(
            AidenMarkdownChunkReveal.newChunkIndices(sealedChunks, previouslyRenderedUTF8Count: shown.utf8.count),
            []
        )

        // A burst (a terminal flush, or attaching to a run mid-reply) brings
        // whole new blocks at once: only those fade in.
        let burst = sealed + "\n## Next\n\nNew body text.\n"
        let burstChunks = cache.chunks(for: burst)
        XCTAssertEqual(burstChunks.map(\.text).suffix(2), ["## Next\n\n", "New body text.\n"])
        XCTAssertEqual(
            AidenMarkdownChunkReveal.newChunkIndices(burstChunks, previouslyRenderedUTF8Count: sealed.utf8.count),
            [2, 3]
        )
    }

    @MainActor
    func testChunkGapsMatchTheSingleDocumentBlockMargins() {
        let cases: [(previous: String, next: String, gap: CGFloat)] = [
            ("Paragraph.\n\n", "Next paragraph.", 16),
            ("Paragraph.\n\n", "```\ncode\n```", 16),
            ("1. one\n2. two\n\n", "```\ncode\n```", 16),
            ("- one\n- two\n\n", "After the list.", 16),
            ("Paragraph.\n\n", "## Heading", 24),
            ("Paragraph.\n\n", "Setext heading\n---", 24),
            ("## Heading\n\n", "Paragraph.", 16),
            ("```swift\nlet x = 1\n```\n\n", "Paragraph.", 16),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\n", "Paragraph.", 16),
            ("Paragraph.\n\n", "---", 24),
            ("---\n\n", "Paragraph.", 24),
            ("- item\n\n  ```\n  code\n  ```\n\n", "After the list.", 16),
            ("> quoted\n\n", "Paragraph.", 16),
            ("Paragraph.\n\n", "> # Quoted heading", 24),
        ]
        for testCase in cases {
            XCTAssertEqual(
                AidenMarkdownChunkSpacing.gap(after: testCase.previous, before: testCase.next),
                testCase.gap,
                "\(testCase.previous.debugDescription) -> \(testCase.next.debugDescription)"
            )
        }
    }

    // MARK: - Cumulative reply text

    private func cumulativeUpdate(_ text: String, received: String) -> (AidenCumulativeReplyText.Update, [Int]) {
        var requested: [Int] = []
        let update = AidenCumulativeReplyText.update(to: text, receivedUTF8Count: received.utf8.count) { count in
            requested.append(count)
            return Array(received.utf8.suffix(count))
        }
        return (update, requested)
    }

    func testCumulativeReplyAppendsOnlyTheNewText() {
        XCTAssertEqual(cumulativeUpdate("Hello world", received: "Hello ").0, .append("world"))
        XCTAssertEqual(cumulativeUpdate("Hello ", received: "Hello ").0, .append(""))
        XCTAssertEqual(cumulativeUpdate("café ☕️ olé", received: "café ☕️").0, .append(" olé"))
    }

    func testCumulativeReplyReadsABoundedTailOfALongReply() {
        let received = String(repeating: "word ", count: 20_000)
        let (update, requested) = cumulativeUpdate(received + "next", received: received)
        XCTAssertEqual(update, .append("next"))
        XCTAssertEqual(requested.count, 1)
        XCTAssertLessThanOrEqual(requested[0], 64)
    }

    func testCumulativeReplyThatNoLongerExtendsTheReceivedTextIsReplaced() {
        // A snapshot reset the run: shorter than what was received.
        XCTAssertEqual(cumulativeUpdate("Hi", received: "Hello there").0, .replace)
        // Rewritten before the join, then grown past it.
        XCTAssertEqual(cumulativeUpdate("Hullo there, friend", received: "Hello there").0, .replace)
        // The last received character was rewritten into a longer one.
        XCTAssertEqual(cumulativeUpdate("café", received: "cafe").0, .replace)
    }

    // MARK: - Streaming reveal gate

    /// Runs reveal ticks over `text` with nothing more arriving, returning
    /// what each tick showed.
    private func drain(_ text: String, maximumTicks: Int = 500) -> [String] {
        var pending = text
        var held = false
        var shown: [String] = []
        for _ in 0..<maximumTicks where !pending.isEmpty {
            let cut = AidenStreamingRevealGate.cut(pending, heldPreviousTick: held)
            XCTAssertEqual(cut.shown + cut.held, pending, "a cut must reproduce the buffer")
            shown.append(cut.shown)
            pending = cut.held
            held = !cut.held.isEmpty
        }
        XCTAssertEqual(pending, "", "the buffer drains")
        return shown
    }

    func testRevealShowsWholeWordsAndHoldsThePartialWord() {
        let cut = AidenStreamingRevealGate.cut("alpha beta gam", heldPreviousTick: false)
        XCTAssertEqual(cut.shown, "alpha ")
        XCTAssertEqual(cut.held, "beta gam")
    }

    func testRevealDrainsABufferInWholeWordsWithoutStalling() {
        let text = "alpha beta gamma delta epsilon zeta eta theta"
        let ticks = drain(text)
        XCTAssertEqual(ticks.joined(), text)
        XCTAssertFalse(ticks.contains(""), "every tick with text buffered shows some")
        for tick in ticks.dropLast() {
            XCTAssertEqual(tick.last?.isWhitespace, true, "no half-typed word: \(tick)")
        }
    }

    func testRevealPacesABurstOverSeveralTicks() {
        let words = (0..<100).map { "word\($0) " }.joined()
        let ticks = drain(words)
        XCTAssertEqual(ticks.joined(), words)
        XCTAssertLessThan(ticks[0].count, words.count / 4, "a burst does not land in one tick")
        XCTAssertGreaterThanOrEqual(ticks[0].count, words.count / AidenStreamingRevealGate.drainTicks)
        // ~700 characters drain in a second or two of ticks, not tens of seconds.
        XCTAssertLessThan(ticks.count, 60)
    }

    func testRevealCatchesUpAtOnceWhenFarBehind() {
        let words = String(repeating: "lorem ipsum ", count: 500)
        let first = AidenStreamingRevealGate.cut(words, heldPreviousTick: false)
        XCTAssertLessThanOrEqual(
            first.held.count,
            AidenStreamingRevealGate.maximumBacklogCharacters,
            "the display never trails received text by more than the cap"
        )
        XCTAssertEqual(first.shown + first.held, words)
    }

    func testUnpacedRevealShowsEveryWholeWordInOneTick() {
        // Reduce Motion: no pacing, just the word boundary.
        let cut = AidenStreamingRevealGate.cut("alpha beta gam", heldPreviousTick: false, paced: false)
        XCTAssertEqual(cut.shown, "alpha beta ")
        XCTAssertEqual(cut.held, "gam")
        let words = (0..<100).map { "word\($0) " }.joined()
        XCTAssertEqual(AidenStreamingRevealGate.cut(words + "tail", heldPreviousTick: false, paced: false).shown, words)
    }

    func testRevealReleasesAFragmentHeldLastTickWithoutNewWhitespace() {
        XCTAssertEqual(AidenStreamingRevealGate.cut("gam", heldPreviousTick: false).held, "gam")
        let released = AidenStreamingRevealGate.cut("gamma", heldPreviousTick: true)
        XCTAssertEqual(released.shown, "gamma")
        XCTAssertEqual(released.held, "")
    }

    func testRevealShowsAHeldFragmentFinishedByWhitespaceWithTheCut() {
        let cut = AidenStreamingRevealGate.cut("gamma delt", heldPreviousTick: true)
        XCTAssertEqual(cut.shown, "gamma ")
        XCTAssertEqual(cut.held, "delt")
    }

    func testRevealHoldsCJKWithoutWhitespaceForOneTickThenReleasesIt() {
        let first = AidenStreamingRevealGate.cut("你好世界", heldPreviousTick: false)
        XCTAssertEqual(first.shown, "")
        XCTAssertEqual(first.held, "你好世界")
        let second = AidenStreamingRevealGate.cut("你好世界，再见", heldPreviousTick: true)
        XCTAssertEqual(second.shown, "你好世界，再见")
        XCTAssertEqual(second.held, "")
    }

    func testRevealPacesALongRunWithoutWhitespaceInsteadOfStalling() {
        let url = "https://example.com/" + String(repeating: "a", count: 300)
        let ticks = drain(url)
        XCTAssertEqual(ticks.first, "", "held for one tick in case whitespace follows")
        XCTAssertGreaterThan(ticks.count, 3, "then paced out")
        XCTAssertEqual(ticks.joined(), url)
    }

    func testRevealOfAnEmptyBufferShowsAndHoldsNothing() {
        for held in [false, true] {
            let cut = AidenStreamingRevealGate.cut("", heldPreviousTick: held)
            XCTAssertEqual(cut.shown, "")
            XCTAssertEqual(cut.held, "")
        }
    }

    func testRevealNeverSplitsAGraphemeCluster() {
        let text = "café 👩‍👩‍👧‍👦"
        let cut = AidenStreamingRevealGate.cut(text, heldPreviousTick: false)
        XCTAssertEqual(cut.shown, "café ")
        XCTAssertEqual(cut.held, "👩‍👩‍👧‍👦")
        XCTAssertEqual(cut.shown + cut.held, text)
        let decomposed = "cafe\u{301} x"
        let decomposedCut = AidenStreamingRevealGate.cut(decomposed, heldPreviousTick: false)
        XCTAssertEqual(decomposedCut.shown, "cafe\u{301} ")
        XCTAssertEqual(decomposedCut.held, "x")
        let family = String(repeating: "👩‍👩‍👧‍👦", count: 40)
        XCTAssertEqual(drain(family).joined(), family)
    }

    // MARK: - Streaming Markdown tail

    private func tail(_ text: String) -> String {
        AidenStreamingMarkdownTail.displayText(text)
    }

    func testStreamingTailClosesOpenInlineMarkup() {
        XCTAssertEqual(tail("Hello **wor"), "Hello **wor**")
        XCTAssertEqual(tail("Run `npm ins"), "Run `npm ins`")
        XCTAssertEqual(tail("**done** and *it"), "**done** and *it*")
        XCTAssertEqual(tail("That was ~~wro"), "That was ~~wro~~")
        XCTAssertEqual(tail("- item **bo"), "- item **bo**")
        XCTAssertEqual(tail("Nested **bold *ita"), "Nested **bold *ita***")
    }

    func testStreamingTailHidesAnOpenerWithNothingAfterIt() {
        XCTAssertEqual(tail("Hello **"), "Hello ")
        XCTAssertEqual(tail("Run `"), "Run ")
    }

    func testStreamingTailLeavesFinishedOrLiteralMarkupAlone() {
        for text in [
            "**a** and *b* and `c`",
            "5 * 3 = 15",
            "snake_case_name and __init__",
            "* bullet item",
            "Escaped \\*star",
            "A [link](https://example.com) here",
            "`code with ** inside`",
        ] {
            XCTAssertEqual(tail(text), text, text)
        }
    }

    func testStreamingTailShowsALinkStillArrivingAsItsLabel() {
        XCTAssertEqual(tail("See [the docs](https://exa"), "See the docs")
        XCTAssertEqual(tail("Look ![chart](https://exa"), "Look ")
    }

    func testStreamingTailHidesAnUnfinishedBlockMarkerLine() {
        // Under a paragraph a lone `-` would make it a setext heading.
        XCTAssertEqual(tail("Intro\n-"), "Intro\n")
        XCTAssertEqual(tail("Intro\n- "), "Intro\n")
        XCTAssertEqual(tail("Steps\n\n1."), "Steps\n\n")
        XCTAssertEqual(tail("#"), "")
        // A finished line, or one with content, stays.
        XCTAssertEqual(tail("Intro\n- one"), "Intro\n- one")
        XCTAssertEqual(tail("Total\n42"), "Total\n42")
    }

    func testStreamingTailLeavesAnOpenCodeFenceAlone() {
        let fenced = "```swift\nlet a = **b\n"
        XCTAssertEqual(tail(fenced), fenced)
    }

    @MainActor
    func testStreamingTailOnlyChangesTheOpenTailNeverSealedChunks() {
        let cache = AidenMarkdownContentCache()
        let text = "First **paragraph** done.\n\nSecond line.\nThird **par"
        let streaming = cache.chunks(for: text, streaming: true)
        let settled = cache.chunks(for: text)
        XCTAssertEqual(streaming.count, settled.count)
        XCTAssertEqual(streaming.dropLast().map(\.text), settled.dropLast().map(\.text))
        XCTAssertGreaterThan(streaming.count, 1, "the first paragraph sealed")
        XCTAssertEqual(streaming.last?.text, "Second line.\nThird **par**")
        XCTAssertEqual(settled.last?.text, "Second line.\nThird **par")
    }

    // MARK: - Scene refresh

    func testTransientInactiveBouncesNeverRefetchButBackgroundReturnsDo() {
        var gate = AidenSceneRefreshGate(refreshOnFirstActivation: false)
        // Control Center, the app switcher, and system prompts.
        for _ in 0..<5 {
            XCTAssertEqual(gate.transition(to: .inactive), .none)
            XCTAssertEqual(gate.transition(to: .active), .resume)
        }
        XCTAssertEqual(gate.transition(to: .inactive), .none)
        XCTAssertEqual(gate.transition(to: .background), .suspend)
        XCTAssertEqual(gate.transition(to: .inactive), .none)
        XCTAssertEqual(gate.transition(to: .active), .refresh)
        XCTAssertEqual(gate.transition(to: .active), .resume, "One return refreshes once.")

        // Repeated background trips before activation still refresh once.
        _ = gate.transition(to: .background)
        _ = gate.transition(to: .background)
        XCTAssertEqual(gate.transition(to: .active), .refresh)
        XCTAssertEqual(gate.transition(to: .active), .resume)
    }

    func testAGateThatOwnsTheInitialLoadRefreshesOnFirstActivation() {
        var gate = AidenSceneRefreshGate(refreshOnFirstActivation: true)
        XCTAssertEqual(gate.transition(to: .inactive), .none)
        XCTAssertEqual(gate.transition(to: .active), .refresh)
        XCTAssertEqual(gate.transition(to: .inactive), .none)
        XCTAssertEqual(gate.transition(to: .active), .resume)
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
