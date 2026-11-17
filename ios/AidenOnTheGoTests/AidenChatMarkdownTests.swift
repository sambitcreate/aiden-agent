import Darwin
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// Code blocks can be copied, and chat text follows the reader's text size.
@MainActor
final class AidenChatMarkdownTests: XCTestCase {

    override func setUp() {
        super.setUp()
        Self.setAccessibilityAutomation(true)
        UIPasteboard.general.string = ""
    }

    override func tearDown() {
        Self.setAccessibilityAutomation(false)
        super.tearDown()
    }

    private static func setAccessibilityAutomation(_ isEnabled: Bool) {
        typealias Setter = @convention(c) (Int32) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else {
            XCTFail("_AXSSetAutomationEnabled is missing, so the accessibility tree can't be read")
            return
        }
        unsafeBitCast(symbol, to: Setter.self)(isEnabled ? 1 : 0)
    }

    // MARK: - Copy

    func testCopyProvidesTheRawSourceWithoutFences() throws {
        let markdown = "Here it is.\n\n```swift\nlet greeting = \"hi\"\nprint(greeting)\n```\n\nThat is all."
        let window = try show(AidenMarkdownView(content: markdown))
        defer { close(window) }

        try copyButton(in: window).activate()

        XCTAssertEqual(UIPasteboard.general.string, "let greeting = \"hi\"\nprint(greeting)")
    }

    func testCopyKeepsFenceLookalikesThatAreInsideTheCode() throws {
        let markdown = "````markdown\n```swift\nlet x = 1\n```\n````"
        let window = try show(AidenMarkdownView(content: markdown))
        defer { close(window) }

        try copyButton(in: window).activate()

        XCTAssertEqual(UIPasteboard.general.string, "```swift\nlet x = 1\n```")
    }

    func testCopyWorksOnATildeFenceAndAnIndentedBlock() throws {
        let tilde = try show(AidenMarkdownView(content: "~~~sh\nls -la\n~~~"))
        try copyButton(in: tilde).activate()
        close(tilde)
        XCTAssertEqual(UIPasteboard.general.string, "ls -la")

        let indented = try show(AidenMarkdownView(content: "Run:\n\n    make build\n    make test"))
        defer { close(indented) }
        try copyButton(in: indented).activate()
        XCTAssertEqual(UIPasteboard.general.string, "make build\nmake test")
    }

    func testEachBlockCopiesItsOwnSource() throws {
        let markdown = "```sh\none\n```\n\ntext\n\n```sh\ntwo\n```"
        let window = try show(AidenMarkdownView(content: markdown))
        defer { close(window) }

        let buttons = copyButtons(in: window)
        XCTAssertEqual(buttons.count, 2)
        buttons[1].activate()
        XCTAssertEqual(UIPasteboard.general.string, "two")
        buttons[0].activate()
        XCTAssertEqual(UIPasteboard.general.string, "one")
    }

    func testCopyWhileStreamingGivesWhatHasArrived() throws {
        let host = Host(AidenMarkdownView(content: "Before.\n\n```py\nprint(1)\nprint(", isStreaming: true))
        let window = try show(host)
        defer { close(window) }

        try copyButton(in: window).activate()
        XCTAssertEqual(UIPasteboard.general.string, "print(1)\nprint(")

        host.update(AidenMarkdownView(content: "Before.\n\n```py\nprint(1)\nprint(2)\nprint(3", isStreaming: true))
        drainMainLoop()
        // "Copied" is still showing, and pressing again copies what has arrived since.
        try copyButton(in: window, label: "Copied").activate()
        XCTAssertEqual(UIPasteboard.general.string, "print(1)\nprint(2)\nprint(3")
    }

    /// A streaming reply is redrawn on every token. The block being written must stay the
    /// same block through that, or "Copied" ends at the next token and a press that
    /// spans tokens is lost.
    func testCopiedSurvivesTheTokensThatArriveAfterThePress() throws {
        func reply(_ code: String) -> AidenMarkdownView {
            AidenMarkdownView(content: "Before.\n\n```py\n\(code)", isStreaming: true)
        }
        let host = Host(reply("print(1)\nprint("))
        let window = try show(host)
        defer { close(window) }

        try copyButton(in: window).activate()
        XCTAssertEqual(UIPasteboard.general.string, "print(1)\nprint(")
        for token in ["print(1)\nprint(2", "print(1)\nprint(2)\nprint(", "print(1)\nprint(2)\nprint(3)\nx"] {
            host.update(reply(token))
            drainMainLoop(seconds: 0.1)
            XCTAssertNotNil(
                try? copyButton(in: window, label: "Copied"),
                "\"Copied\" ended when more of the block arrived"
            )
        }
        // The press already copied what had arrived, and the next press copies what has arrived since.
        XCTAssertEqual(UIPasteboard.general.string, "print(1)\nprint(")
    }

    func testAPressDuringAStreamIsNotLostToTheNextToken() throws {
        func reply(_ code: String) -> AidenMarkdownView {
            AidenMarkdownView(content: "```sh\n\(code)", isStreaming: true)
        }
        let host = Host(reply("one"))
        let window = try show(host)
        defer { close(window) }
        let button = try copyButton(in: window).element

        host.update(reply("one\ntwo"))
        // Wait for the token to be drawn rather than for a fixed time: a slow runner can take
        // longer than a moment to redraw, and the press would then copy the old source.
        XCTAssertTrue(
            runMainLoop(until: { self.accessibleElements(in: window).contains { $0.accessibilityLabel == "one\ntwo" } }),
            "The next token was never drawn"
        )
        // The element read before the token is the one pressed after it, as a finger that went down earlier would.
        XCTAssertTrue(button.accessibilityActivate())
        XCTAssertEqual(UIPasteboard.general.string, "one\ntwo")
    }

    func testAnOpenFenceIsReadAsTheCodeThatHasArrived() {
        let open = AidenStreamingMarkdownTail.openCodeBlock(in: "```swift title=\"a.swift\"\nlet x = 1\n\nlet y")
        XCTAssertEqual(open, .init(info: "swift title=\"a.swift\"", code: "let x = 1\n\nlet y"))
        // A newline after the last line that arrived is not code.
        XCTAssertEqual(AidenStreamingMarkdownTail.openCodeBlock(in: "~~~\nls\n")?.code, "ls")
        XCTAssertEqual(AidenStreamingMarkdownTail.openCodeBlock(in: "```py\n")?.code, "")
        XCTAssertEqual(AidenStreamingMarkdownTail.openCodeBlock(in: "```py")?.info, "py")
        // Indentation of the fence comes off the code, as in the settled block.
        XCTAssertEqual(AidenStreamingMarkdownTail.openCodeBlock(in: "  ```\n  a\n    b")?.code, "a\n  b")
        // A longer fence is not closed by a shorter run inside the code.
        XCTAssertEqual(AidenStreamingMarkdownTail.openCodeBlock(in: "````md\n```swift\nlet x")?.code, "```swift\nlet x")
    }

    func testOnlyABlockStillBeingWrittenIsReadAsOpenCode() {
        XCTAssertNil(AidenStreamingMarkdownTail.openCodeBlock(in: "```sh\nls\n```"), "A closed block")
        XCTAssertNil(AidenStreamingMarkdownTail.openCodeBlock(in: "```sh\nls\n```\n\nAfter"), "A closed block with text after it")
        XCTAssertNil(AidenStreamingMarkdownTail.openCodeBlock(in: "Text first\n```sh\nls"), "Text before the fence")
        XCTAssertNil(AidenStreamingMarkdownTail.openCodeBlock(in: "    indented()"), "An indented block")
        XCTAssertNil(AidenStreamingMarkdownTail.openCodeBlock(in: ""))
    }

    func testOnlyTheStreamingTailIsDrawnAsOpenCode() {
        let cache = AidenMarkdownContentCache()
        let markdown = "```sh\nfirst\n```\n\nText.\n\n```py\nprint("
        let streaming = cache.chunks(for: markdown, streaming: true)
        XCTAssertEqual(streaming.map { $0.openCode?.code }, [nil, nil, "print("], "Only the open tail, never a sealed chunk")
        XCTAssertEqual(cache.chunks(for: markdown, streaming: false).compactMap(\.openCode).count, 0, "A settled reply uses the ordinary block")
    }

    func testTheLanguageNamesTheButtonAndFenceOptionsAreDropped() {
        XCTAssertEqual(AidenCodeBlockView.languageName(fromFenceInfo: "swift"), "swift")
        XCTAssertEqual(AidenCodeBlockView.languageName(fromFenceInfo: "swift title=\"a.swift\""), "swift")
        XCTAssertEqual(AidenCodeBlockView.languageName(fromFenceInfo: "  python  "), "python")
        XCTAssertNil(AidenCodeBlockView.languageName(fromFenceInfo: ""))
        XCTAssertNil(AidenCodeBlockView.languageName(fromFenceInfo: nil))
        XCTAssertNil(AidenCodeBlockView.languageName(fromFenceInfo: "{.numberLines}"))
    }

    func testTheCopyButtonNamesWhatItCopies() throws {
        let window = try show(AidenMarkdownView(content: "```swift\nlet x = 1\n```\n\n```\nplain\n```"))
        defer { close(window) }

        let labels = copyButtons(in: window).map { $0.element.accessibilityLabel }
        XCTAssertEqual(labels, ["Copy swift code", "Copy code"])
        for button in copyButtons(in: window) {
            XCTAssertTrue(button.element.accessibilityTraits.contains(.button))
        }
    }

    func testTheCopyButtonIsAtLeast44PointsAtEveryTextSize() throws {
        for size in [DynamicTypeSize.xSmall, .large, .accessibility3, .accessibility5] {
            let window = try show(
                AidenMarkdownView(content: "```swift\nlet x = 1\n```").dynamicTypeSize(size)
            )
            defer { close(window) }

            let frame = try copyButton(in: window).element.accessibilityFrame
            XCTAssertGreaterThanOrEqual(frame.height, 44, "Copy is under 44 pt tall at \(size)")
            XCTAssertGreaterThanOrEqual(frame.width, 44, "Copy is under 44 pt wide at \(size)")
            XCTAssertLessThanOrEqual(frame.maxX, 390 + 0.5, "Copy ran off the screen at \(size)")
        }
    }

    func testLongCodeScrollsSidewaysInsteadOfWideningTheRow() throws {
        let longLine = String(repeating: "let value = compute(argument)  // ", count: 20)
        let window = try show(AidenMarkdownView(content: "```swift\n\(longLine)\n```"))
        defer { close(window) }

        let scrollViews = allViews(of: UIScrollView.self, in: window)
        let sideways = scrollViews.first { $0.contentSize.width > $0.bounds.width + 100 }
        XCTAssertNotNil(sideways, "Long code did not get a horizontal scroll view")
        for scrollView in scrollViews {
            let frame = scrollView.convert(scrollView.bounds, to: window)
            XCTAssertLessThanOrEqual(frame.maxX, 390 + 0.5, "The code block is wider than the screen")
        }
    }

    // MARK: - Copy confirmation

    func testCopyConfirmationEndsWithinTwoSeconds() async throws {
        let timer = ManualTimer()
        var written: [String] = []
        let copy = AidenCodeCopyController(write: { written.append($0) }, announce: { _ in }, sleep: { try await timer.sleep($0) })

        copy.copy("echo hi")
        XCTAssertEqual(written, ["echo hi"])
        XCTAssertTrue(copy.isConfirming)
        await timer.waitForSleeper()
        XCTAssertLessThanOrEqual(try XCTUnwrap(timer.requested.last), .seconds(2))
        XCTAssertGreaterThan(try XCTUnwrap(timer.requested.last), .zero)

        timer.finish()
        await copy.waitForConfirmationToEnd()
        XCTAssertFalse(copy.isConfirming)
        XCTAssertFalse(copy.hasPendingConfirmation)
    }

    func testTheConfirmationIsAnnouncedOnceAndNamesWhatWasCopied() async {
        let timer = ManualTimer()
        var announced: [String] = []
        let copy = AidenCodeCopyController(write: { _ in }, announce: { announced.append($0) }, sleep: { try await timer.sleep($0) })

        copy.copy("a")
        XCTAssertEqual(announced, ["Copied code"])
        copy.cancel()
    }

    func testALeavingRowLeavesNoTimerBehind() async {
        let timer = ManualTimer()
        let copy = AidenCodeCopyController(write: { _ in }, announce: { _ in }, sleep: { try await timer.sleep($0) })

        copy.copy("a")
        await timer.waitForSleeper()
        copy.cancel()
        await timer.waitForCancellation()

        XCTAssertTrue(timer.sawCancellation, "The timer kept sleeping after the row left")
        XCTAssertFalse(copy.isConfirming)
        XCTAssertFalse(copy.hasPendingConfirmation)
    }

    func testAnotherCopyRestartsTheConfirmationRatherThanEndingItEarly() async {
        let timer = ManualTimer()
        let copy = AidenCodeCopyController(write: { _ in }, announce: { _ in }, sleep: { try await timer.sleep($0) })

        copy.copy("first")
        await timer.waitForSleeper()
        copy.copy("second")
        await timer.waitForSleeper(count: 2)
        // The first timer was cancelled, not allowed to clear the second confirmation.
        await timer.waitForCancellation()
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(timer.cancelledCount, 1)
        XCTAssertEqual(timer.pendingCount, 1)
        XCTAssertTrue(copy.isConfirming)

        timer.finish()
        await copy.waitForConfirmationToEnd()
        XCTAssertFalse(copy.isConfirming)
    }

    func testTheConfirmationEndsWhenTheBlockLeavesTheScreen() async throws {
        let timer = ManualTimer()
        let copy = AidenCodeCopyController(write: { _ in }, announce: { _ in }, sleep: { try await timer.sleep($0) })
        let screen = Screen()
        let window = try show(ScreenHost(screen: screen, copy: copy))
        defer { close(window) }

        try copyButton(in: window).activate()
        await timer.waitForSleeper()
        XCTAssertTrue(copy.isConfirming)

        screen.showsBlock = false
        drainMainLoop()
        await timer.waitForCancellation()

        XCTAssertTrue(timer.sawCancellation, "The timer kept running after the block left the screen")
        XCTAssertFalse(copy.isConfirming)
        XCTAssertFalse(copy.hasPendingConfirmation)
    }

    func testCopyShowsTheConfirmationInTheButton() throws {
        let window = try show(AidenMarkdownView(content: "```sh\nls\n```"))
        defer { close(window) }

        let button = try copyButton(in: window)
        button.activate()
        drainMainLoop()

        XCTAssertEqual(try copyButton(in: window, label: "Copied").element.accessibilityLabel, "Copied code")
    }

    // MARK: - Dynamic Type

    func testBodySizeGrowsWithDynamicType() {
        XCTAssertEqual(AidenMarkdownMetrics.bodySize(for: .large), 16)
        XCTAssertGreaterThan(AidenMarkdownMetrics.bodySize(for: .accessibility3), AidenMarkdownMetrics.bodySize(for: .large))
        XCTAssertLessThan(AidenMarkdownMetrics.bodySize(for: .xSmall), 16)

        let ascending: [DynamicTypeSize] = [
            .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
            .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5,
        ]
        let sizes = ascending.map(AidenMarkdownMetrics.bodySize(for:))
        XCTAssertEqual(sizes, sizes.sorted())
        XCTAssertEqual(Set(sizes).count, sizes.count, "Two text sizes drew the same chat text")
    }

    /// MarkdownUI already scales the theme's font size with the reader's text size. A
    /// size that was scaled before it was handed over grows twice, so the reply is
    /// measured against ordinary body text: it may be a little taller (line spacing, a
    /// 16 pt base), never a multiple of it.
    func testChatTextGrowsLikeBodyTextAndNotFasterAtEverySize() throws {
        let sentence = "A long line of reply text that wraps onto several lines. "
        let markdown = String(repeating: sentence, count: 8)
        for size in [DynamicTypeSize.large, .xxxLarge, .accessibility3, .accessibility5] {
            let reply = try renderedHeight(of: AidenMarkdownView(content: markdown).dynamicTypeSize(size))
            let body = try renderedHeight(of: Text(verbatim: markdown).font(.body).dynamicTypeSize(size)
                .frame(maxWidth: .infinity, alignment: .leading))
            XCTAssertLessThanOrEqual(reply, body * 1.4, "Reply text is far taller than body text at \(size): \(reply) against \(body)")
            XCTAssertGreaterThanOrEqual(reply, body * 0.65, "Reply text is far shorter than body text at \(size): \(reply) against \(body)")
        }
    }

    func testChatTextGrowsWhenTheTextSizeGrows() throws {
        let markdown = String(repeating: "A long line of reply text that wraps onto several lines. ", count: 8)
        let normal = try renderedHeight(of: AidenMarkdownView(content: markdown).dynamicTypeSize(.large))
        let large = try renderedHeight(of: AidenMarkdownView(content: markdown).dynamicTypeSize(.accessibility3))
        XCTAssertGreaterThan(large, normal * 1.8)
        let bodyNormal = try renderedHeight(of: Text(verbatim: markdown).font(.body).dynamicTypeSize(.large)
            .frame(maxWidth: .infinity, alignment: .leading))
        let bodyLarge = try renderedHeight(of: Text(verbatim: markdown).font(.body).dynamicTypeSize(.accessibility3)
            .frame(maxWidth: .infinity, alignment: .leading))
        XCTAssertLessThan(large / normal, bodyLarge / bodyNormal * 1.3, "Reply text grows faster than body text")
    }

    func testSettledChunksRedrawWhenTheTextSizeChanges() throws {
        // Two paragraphs: the first is sealed, so it is drawn through the cached, equatable chunk.
        let markdown = "First paragraph of the reply, long enough to wrap onto a second line when it grows.\n\nSecond paragraph, still streaming in."
        let host = Host(AidenMarkdownView(content: markdown, isStreaming: true).dynamicTypeSize(.large))
        let window = try show(host)
        defer { close(window) }
        let before = host.fittingHeight()

        host.update(AidenMarkdownView(content: markdown, isStreaming: true).dynamicTypeSize(.accessibility3))
        drainMainLoop()
        let grown = host.fittingHeight()
        XCTAssertGreaterThan(grown, before * 1.8)
        // Body text goes from 17 to 40 pt, so the reply cannot more than triple once it wraps more.
        XCTAssertLessThan(grown, before * 4.5, "The reply grew by more than its text size did")

        host.update(AidenMarkdownView(content: markdown, isStreaming: true).dynamicTypeSize(.large))
        drainMainLoop()
        XCTAssertEqual(host.fittingHeight(), before, accuracy: 1)
    }

    func testChangingTheTextSizeDoesNotParseSettledChunksAgain() throws {
        let markdown = "One settled paragraph.\n\nAnother settled paragraph.\n\nThe open tail"
        let host = Host(AidenMarkdownView(content: markdown, isStreaming: true).dynamicTypeSize(.large))
        let window = try show(host)
        defer { close(window) }
        let parsed = AidenMarkdownContentCache.shared.parsedCharacterCount

        host.update(AidenMarkdownView(content: markdown, isStreaming: true).dynamicTypeSize(.accessibility2))
        drainMainLoop()

        // MarkdownUI draws the new size itself, so the reply may not be parsed at all. If it
        // is, only the open tail is parsed on a render and the sealed chunk comes from the cache.
        // A sealed chunk parsed again would add its own length, which is not a whole number of tails.
        let split = AidenMarkdownBlockSplitter.split(markdown)
        XCTAssertFalse(split.settled.isEmpty)
        let tail = split.tail.utf8.count
        let parsedSince = AidenMarkdownContentCache.shared.parsedCharacterCount - parsed
        XCTAssertEqual(parsedSince % tail, 0, "A sealed chunk was parsed again after the size change")
    }

    func testCodeTextGrowsWithTheTextSizeAndStaysSmallerThanBodyText() throws {
        XCTAssertLessThan(AidenMarkdownMetrics.codeScale, 1)
        XCTAssertGreaterThan(AidenMarkdownMetrics.codeScale, 0.75, "Code is much smaller than the text around it")

        let code = "```swift\nlet value = 1\nlet other = 2\nlet third = 3\n```"
        let normal = try renderedHeight(of: AidenMarkdownView(content: code).dynamicTypeSize(.large))
        let large = try renderedHeight(of: AidenMarkdownView(content: code).dynamicTypeSize(.accessibility3))
        XCTAssertGreaterThan(large, normal)
        // Three lines of code at about 0.85 of the body size, plus a header that does not scale with it.
        XCTAssertLessThan(large, normal * 3.2, "Code text grows faster than body text")
    }

    // MARK: - Hosting

    /// Keeps the hosting controller so a test can change what it shows.
    private final class Host: UIHostingController<AnyView> {
        init(_ view: some View) {
            super.init(rootView: AnyView(view.environment(AidenHapticCenter())))
        }

        @available(*, unavailable)
        required init?(coder aDecoder: NSCoder) { fatalError() }

        func update(_ view: some View) {
            rootView = AnyView(view.environment(AidenHapticCenter()))
        }

        func fittingHeight() -> CGFloat {
            view.layoutIfNeeded()
            return sizeThatFits(in: CGSize(width: 390, height: 20_000)).height
        }
    }

    private func show(_ view: some View) throws -> UIWindow {
        try show(Host(view))
    }

    private func show(_ host: Host) throws -> UIWindow {
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 10)
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        let wrapper = UIViewController()
        wrapper.addChild(host)
        wrapper.view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: wrapper.view.leadingAnchor, constant: 16),
            host.view.trailingAnchor.constraint(equalTo: wrapper.view.trailingAnchor, constant: -16),
            host.view.topAnchor.constraint(equalTo: wrapper.view.safeAreaLayoutGuide.topAnchor, constant: 20),
        ])
        host.didMove(toParent: wrapper)
        window.rootViewController = wrapper
        window.makeKeyAndVisible()
        drainMainLoop()
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func renderedHeight(of view: some View) throws -> CGFloat {
        let host = Host(view)
        let window = try show(host)
        defer { close(window) }
        return host.fittingHeight()
    }

    // MARK: - Accessibility tree

    private struct Button {
        let element: NSObject

        @discardableResult
        func activate() -> Bool { element.accessibilityActivate() }
    }

    private func copyButtons(in root: NSObject) -> [Button] {
        accessibleElements(in: root)
            .filter { $0.accessibilityLabel?.hasPrefix("Copy") == true }
            .map(Button.init)
    }

    private func copyButton(in root: NSObject, label: String = "Copy") throws -> Button {
        let found = accessibleElements(in: root).filter { $0.accessibilityLabel?.hasPrefix(label) == true }
        return Button(element: try XCTUnwrap(found.first, "No \"\(label)\" button in the accessibility tree"))
    }

    private func accessibleElements(in root: NSObject) -> [NSObject] {
        var found: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.isAccessibilityElement {
                found.append(object)
                return
            }
            if let elements = object.accessibilityElements {
                elements.compactMap { $0 as? NSObject }.forEach(walk)
            }
            (object as? UIView)?.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    private func allViews<V: UIView>(of type: V.Type, in root: UIView) -> [V] {
        var found: [V] = []
        func walk(_ view: UIView) {
            if let match = view as? V { found.append(match) }
            view.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func drainMainLoop(seconds: TimeInterval = 0.25) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }
}

/// A sleep a test finishes by hand, so a confirmation's timing is checked
/// without waiting for a clock. Each call is its own sleep: cancelling one
/// ends only that one, by throwing, as `Task.sleep` does.
@MainActor
private final class ManualTimer {
    private(set) var requested: [Duration] = []
    private(set) var cancelledCount = 0
    private var pending: [Int: CheckedContinuation<Void, Error>] = [:]
    private var cancelledBeforeStart: Set<Int> = []
    private var nextID = 0

    var sawCancellation: Bool { cancelledCount > 0 }
    var pendingCount: Int { pending.count }

    func sleep(_ duration: Duration) async throws {
        requested.append(duration)
        let id = nextID
        nextID += 1
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if cancelledBeforeStart.remove(id) != nil || Task.isCancelled {
                    cancelledCount += 1
                    continuation.resume(throwing: CancellationError())
                } else {
                    pending[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancel(id) }
        }
    }

    private func cancel(_ id: Int) {
        guard let continuation = pending.removeValue(forKey: id) else {
            cancelledBeforeStart.insert(id)
            return
        }
        cancelledCount += 1
        continuation.resume(throwing: CancellationError())
    }

    func waitForSleeper(count: Int = 1) async {
        for _ in 0..<1000 where requested.count < count { await Task.yield() }
    }

    func waitForCancellation(count: Int = 1) async {
        for _ in 0..<1000 where cancelledCount < count { await Task.yield() }
    }

    func finish() {
        let all = pending
        pending.removeAll()
        all.values.forEach { $0.resume() }
    }
}

@Observable
private final class Screen {
    var showsBlock = true
}

private struct ScreenHost: View {
    let screen: Screen
    let copy: AidenCodeCopyController

    var body: some View {
        if screen.showsBlock {
            AidenCodeBlockView(source: "ls -la", language: "sh", copyController: copy)
        } else {
            Text(verbatim: "Gone")
        }
    }
}
