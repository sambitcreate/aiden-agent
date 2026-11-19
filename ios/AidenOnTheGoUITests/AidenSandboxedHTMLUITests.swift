import XCTest

/// Real finger touches on a sandboxed HTML preview (`-AidenPreviewFixture`,
/// Debug builds). A tap on a link must reach the "Open link?" confirmation, a
/// scroll must still scroll, and the page's scripted clicks while scrolling
/// must not ask anything.
final class AidenSandboxedHTMLUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testATapOnAPreviewLinkAsksFirstAndAScrollNeverDoes() {
        let app = XCUIApplication()
        app.launchArguments = ["-AidenPreviewFixture", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        let top = app.links["Top link"]
        XCTAssertTrue(top.waitForExistence(timeout: 20))
        let alert = app.alerts["Open link?"]

        // A tap asks, naming the tapped link.
        top.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "a real tap must offer the link")
        XCTAssertTrue(alert.staticTexts["https://example.com/top"].exists)
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 5))

        // A scroll scrolls, and the page's clicks on every scroll event offer nothing.
        let webView = app.webViews.firstMatch
        let topBefore = top.frame.minY
        webView.swipeUp()
        XCTAssertFalse(alert.waitForExistence(timeout: 3), "a scroll must not open the gate for scripted clicks: \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        XCTAssertLessThan(top.frame.minY, topBefore - 50, "the preview did not scroll")

        let bottom = app.links["Bottom link"]
        for _ in 0..<6 where !bottom.isHittable {
            webView.swipeUp()
        }
        XCTAssertTrue(bottom.isHittable)
        XCTAssertFalse(alert.waitForExistence(timeout: 3))

        // A tap after scrolling still asks, for the link that was tapped.
        bottom.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts["https://example.com/bottom"].exists, alert.debugDescription)
    }
}
