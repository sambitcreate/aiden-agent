import XCTest

/// The workspace file editor on a cached `.html` file
/// (`-AidenWorkspaceHTMLFixture`, Debug builds): it opens on a running,
/// themed Preview, switches to Source and back, asks before opening a tapped
/// link, and a file cut short by the size cap stays on Source.
final class AidenWorkspaceHTMLUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch(_ fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [fixture, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        return app
    }

    func testAnHtmlFileOpensOnPreviewSwitchesToSourceAndAsksBeforeALink() {
        let app = launch("-AidenWorkspaceHTMLFixture")

        // The page's own script ran.
        XCTAssertTrue(app.staticTexts["Scripts ran"].waitForExistence(timeout: 20), app.debugDescription)
        let preview = app.segmentedControls.buttons["Preview"]
        let source = app.segmentedControls.buttons["Source"]
        XCTAssertTrue(preview.isSelected)
        // The switch took the title's place; the file is still named.
        XCTAssertTrue(app.staticTexts["site/report.html"].exists, app.navigationBars.firstMatch.debugDescription)

        source.tap()
        XCTAssertTrue(source.isSelected)
        XCTAssertTrue(app.staticTexts["<h1>Report</h1>"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.webViews.firstMatch.exists)

        preview.tap()
        XCTAssertTrue(preview.isSelected)
        let link = app.links["Details"]
        XCTAssertTrue(link.waitForExistence(timeout: 20))

        // A tapped link asks first, naming the site; Cancel opens nothing.
        link.tap()
        let alert = app.alerts["Open link?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts["example.com"].exists, alert.debugDescription)
        XCTAssertTrue(alert.buttons["Open"].exists)
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
    }

    func testATruncatedHtmlFileStaysOnSourceWithANote() {
        let app = launch("-AidenWorkspaceHTMLFixtureTruncated")

        XCTAssertTrue(app.staticTexts["This file is too large to preview."].waitForExistence(timeout: 20), app.debugDescription)
        let preview = app.segmentedControls.buttons["Preview"]
        XCTAssertTrue(app.segmentedControls.buttons["Source"].isSelected)
        XCTAssertFalse(preview.isEnabled)
        XCTAssertTrue(app.staticTexts["<h1>Report</h1>"].exists)
        XCTAssertFalse(app.webViews.firstMatch.exists)
    }
}
