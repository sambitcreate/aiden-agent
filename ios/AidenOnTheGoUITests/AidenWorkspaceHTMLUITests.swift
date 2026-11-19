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

    func testFileWrittenOpensTheFileInAWorkspaceChatOnly() {
        let app = launch("-AidenWorkspaceHTMLFixtureFromActivity")

        // A Bot chat's line is plain text; the workspace chat's is a button
        // that keeps its words.
        let label = "File written: site/report.html"
        let buttons = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", label))
        XCTAssertTrue(buttons.firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(buttons.count, 1, app.debugDescription)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch.exists, app.debugDescription)

        // The workspace line takes no more room than the Bot chat's plain
        // line: the gap between the two headings is the same as if it were
        // plain text (16-point spacing on each side of the line).
        let line = buttons.firstMatch
        let plainLine = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        let drawnHeight = plainLine.frame.height
        let gap = app.staticTexts["Bot chat"].frame.minY - app.staticTexts["Workspace chat"].frame.maxY
        XCTAssertEqual(gap, 16 + drawnHeight + 16, accuracy: 1, "The file line keeps the feed's rhythm")
        XCTAssertLessThan(drawnHeight, 40)

        // Its tap target is still 44 points, centred on the line, and a tap
        // near its top edge, above the drawn line, opens the file.
        XCTAssertGreaterThanOrEqual(line.frame.height, 43.5)
        let drawnTop = line.frame.midY - drawnHeight / 2
        let tapY = line.frame.minY + 2
        XCTAssertLessThan(tapY, drawnTop - 4, "The tap lands outside the drawn line")
        line.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0))
            .withOffset(CGVector(dx: 0, dy: 2))
            .tap()
        XCTAssertTrue(app.staticTexts["Scripts ran"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.segmentedControls.buttons["Preview"].isSelected)
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
