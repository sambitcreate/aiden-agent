import Darwin
import Observation
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// Loading earlier messages adds rows above the reader. They stay on what they
/// were reading instead of landing at the top of the new page.
@MainActor
final class AidenTranscriptPlaceTests: XCTestCase {

    override func setUp() {
        super.setUp()
        Self.setAccessibilityAutomation(true)
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

    func testTheReaderStaysOnTheirMessageWhenAnEarlierPageLoads() throws {
        let transcript = PlaceTranscriptModel(rows: Array(30..<90))
        let window = try show(PlaceTranscript(model: transcript))
        defer { close(window) }
        XCTAssertNotNil(element(labeled: "row 30", in: window), "The transcript did not open at its first row")

        transcript.prependPage(Array(0..<30), keepingPlaceOn: "row 30")
        drainMainLoop(seconds: 1.0)

        let anchor = try XCTUnwrap(element(labeled: "row 30", in: window), "The reader's message left the screen")
        XCTAssertLessThan(anchor.accessibilityFrame.minY, 140, "The reader's message is not at the top of the screen")
        XCTAssertNil(element(labeled: "row 0", in: window), "The screen landed on the top of the new page")
    }

    func testARequestThatFindsNothingLapsesAndLaterGrowthMovesNobody() throws {
        let transcript = PlaceTranscriptModel(rows: Array(30..<90))
        let window = try show(PlaceTranscript(model: transcript))
        defer { close(window) }

        // A place was asked for that no row answers to, so there is nothing to scroll to
        // and the request has to lapse by itself.
        transcript.keptPlaceID = "no such row"
        drainMainLoop(seconds: 1.5)
        XCTAssertNil(transcript.keptPlaceID, "The request outlived its second")

        // Growth after that, such as a streaming reply, must not scroll anywhere.
        transcript.rows.append(contentsOf: 90..<100)
        drainMainLoop(seconds: 0.5)
        XCTAssertNotNil(element(labeled: "row 30", in: window), "Later growth moved the reader")
    }

    // MARK: - Whether the reader still wants their place kept

    func testThePlaceIsKeptWhenTheReaderHasNotMovedSinceTheTap() {
        let follow = readerAwayFromTheEnd()
        let ticket = follow.placeTicket()

        XCTAssertTrue(follow.keepsPlace(ticket))
    }

    func testThePlaceIsNotKeptWhenFollowIsOnAtArrival() {
        let follow = readerAwayFromTheEnd()
        let ticket = follow.placeTicket()

        // The reader scrolled back to the end during the load: follow has latched on again.
        follow.handle(.userScrollEnd(isAtBottom: true))

        XCTAssertFalse(follow.keepsPlace(ticket), "A page arriving would pull a following reader up the transcript")
    }

    func testThePlaceIsNotKeptAfterJumpToLatestOrASendDuringTheLoad() {
        let follow = readerAwayFromTheEnd()
        let ticket = follow.placeTicket()

        follow.handle(.reset)
        XCTAssertFalse(follow.keepsPlace(ticket))
        // Even if the reader then drags away again, that is a new decision, not the one the ticket was for.
        follow.handle(.userScrollBegin)
        follow.handle(.userScrollEnd(isAtBottom: false))
        XCTAssertFalse(follow.keepsPlace(ticket))
    }

    func testThePlaceIsNotKeptWhenTheReaderScrolledDuringTheLoad() {
        let follow = readerAwayFromTheEnd()
        let ticket = follow.placeTicket()

        follow.handle(.userScrollBegin)
        follow.handle(.userScrollEnd(isAtBottom: false))

        XCTAssertFalse(follow.keepsPlace(ticket), "The reader moved on, so the page must not move them back")
    }

    private func readerAwayFromTheEnd() -> AidenTranscriptFollowController {
        let follow = AidenTranscriptFollowController()
        follow.handle(.userScrollBegin)
        follow.handle(.userScrollEnd(isAtBottom: false))
        XCTAssertFalse(follow.isFollowing)
        return follow
    }

    // MARK: - Hosting

    private func show(_ view: some View) throws -> UIWindow {
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        let deadline = Date().addingTimeInterval(10)
        while connectedScene() == nil, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        drainMainLoop(seconds: 0.5)
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func drainMainLoop(seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func element(labeled label: String, in root: NSObject) -> NSObject? {
        var found: NSObject?
        func walk(_ object: NSObject) {
            guard found == nil else { return }
            if object.isAccessibilityElement {
                if object.accessibilityLabel == label { found = object }
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
}

@Observable
private final class PlaceTranscriptModel {
    var rows: [Int]
    var keptPlaceID: String?

    init(rows: [Int]) { self.rows = rows }

    /// What the chat does after a page arrives: the rows change, and in the same turn
    /// the message that was first is named.
    func prependPage(_ page: [Int], keepingPlaceOn id: String) {
        rows = page + rows
        keptPlaceID = id
    }
}

/// The transcript's own row stack and scroll view, with rows of different heights.
private struct PlaceTranscript: View {
    @Bindable var model: PlaceTranscriptModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                AidenTranscriptRowStack(spacing: 12, bottomAnchorID: "bottom") {
                    ForEach(model.rows, id: \.self) { row in
                        Text(verbatim: "row \(row)")
                            .frame(maxWidth: .infinity, minHeight: CGFloat(30 + (row * 37) % 110), alignment: .topLeading)
                            .background(Color.gray.opacity(0.15))
                            .accessibilityLabel("row \(row)")
                            .id("row \(row)")
                    }
                }
            }
            .aidenKeepsPlaceOnPrepend(anchorID: $model.keptPlaceID, proxy: proxy)
        }
    }
}
