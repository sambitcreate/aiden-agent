import XCTest

final class AidenShellUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// The real shell opens against every demo scenario. This is the CI smoke test.
    func testShellLaunchesForEveryScenario() {
        for scenario in AidenStateMatrix.Scenario.allCases {
            let app = AidenStateMatrix.launch(scenario: scenario)
            XCTAssertTrue(
                AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10),
                "No first screen for \(scenario.rawValue)"
            )
            app.terminate()
        }
    }

    /// Light, dark and the largest accessibility text, so later work has a
    /// "before" to compare with. A screen that cannot be reached fails the test
    /// instead of being skipped.
    func testCaptureBaselineScreens() {
        let variants: [(AidenStateMatrix.Appearance, AidenStateMatrix.ContentSize)] = [
            (.light, .large),
            (.dark, .large),
            (.light, .accessibilityExtraExtraExtraLarge),
        ]
        for (appearance, size) in variants {
            let tag = "\(appearance.rawValue)-\(size.label)"
            let app = AidenStateMatrix.launch(scenario: .busy, appearance: appearance, contentSize: size)
            XCTAssertTrue(AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10), tag)

            // Inbox: the chat list on the Workspaces side of the shell.
            let firstChat = openInbox(in: app)
            XCTAssertTrue(firstChat.waitForExistence(timeout: 10), "No chat rows in the inbox (\(tag))")
            AidenStateMatrix.capture("inbox-\(tag)", in: self)

            // A chat.
            firstChat.tap()
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
                    .waitForExistence(timeout: 10),
                "The chat did not open (\(tag))"
            )
            AidenStateMatrix.capture("chat-\(tag)", in: self)
            goBack(in: app)

            // Workspaces: the list behind the "Workspaces" row.
            let workspacesRow = app.buttons["Workspaces"].firstMatch
            XCTAssertTrue(workspacesRow.waitForExistence(timeout: 10), "No Workspaces row (\(tag))")
            workspacesRow.tap()
            AidenStateMatrix.capture("workspaces-\(tag)", in: self)
            goBack(in: app)

            // Settings.
            let profile = app.buttons["Profile and app settings"].firstMatch
            XCTAssertTrue(profile.waitForExistence(timeout: 10), "No settings button (\(tag))")
            profile.tap()
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10), "Settings did not open (\(tag))")
            AidenStateMatrix.capture("settings-\(tag)", in: self)
            dismissSheet(in: app)

            // Bots: the home, then a Bot.
            AidenStateMatrix.openArea("Bots", in: app)
            let bot = botRow(in: app)
            XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots home (\(tag))")
            AidenStateMatrix.capture("bots-\(tag)", in: self)
            bot.tap()
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                    .waitForExistence(timeout: 10),
                "The Bot did not open (\(tag))"
            )
            AidenStateMatrix.capture("bot-\(tag)", in: self)
            app.terminate()
        }
    }

    /// Counts what the system audit finds today. It never fails on an issue:
    /// the count is the baseline the later accessibility gate starts from.
    func testRecordAccessibilityAuditBaseline() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10))

        var report: [String] = []
        for screen in ["inbox", "bots"] {
            // Audit a screen with its content on it, not a loading state.
            if screen == "inbox" {
                XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
            } else {
                AidenStateMatrix.openArea("Bots", in: app)
                XCTAssertTrue(botRow(in: app).waitForExistence(timeout: 10), "No Bot on the Bots home")
            }
            var issueCount = 0
            try app.performAccessibilityAudit { _ in
                issueCount += 1
                return true
            }
            report.append("\(screen): \(issueCount)")
        }

        let attachment = XCTAttachment(string: report.joined(separator: "\n"))
        attachment.name = "accessibility-audit-issue-counts"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: Navigation

    /// Opens the Workspaces side and opens the first workspace, whose chats are
    /// the inbox. Returns the first chat row.
    private func openInbox(in app: XCUIApplication) -> XCUIElement {
        AidenStateMatrix.openArea("Workspaces", in: app)
        let expand = app.buttons["Expand Aiden Agent"].firstMatch
        if expand.waitForExistence(timeout: 5) { expand.tap() }
        return app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")
        ).firstMatch
    }

    private func botRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
    }

    private func goBack(in app: XCUIApplication) {
        let back = app.navigationBars.buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
    }

    private func dismissSheet(in app: XCUIApplication) {
        let done = app.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 3) {
            done.tap()
        } else {
            app.swipeDown(velocity: .fast)
        }
    }
}
