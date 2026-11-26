import XCTest

/// The dock's recents: a tap on the chosen tab, with its list showing, opens
/// that tab's newest few rows over the page.
final class AidenDockRecentsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchOnWorkspaces(
        appearance: AidenStateMatrix.Appearance = .light
    ) throws -> XCUIApplication {
        let app = AidenStateMatrix.launch(scenario: .busy, appearance: appearance, startingTab: "workspaces")
        XCTAssertTrue(AidenStateMatrix.bottomTabs(in: app).waitForExistence(timeout: 10), "No tabs")
        try XCTSkipUnless(AidenStateMatrix.dock(in: app).exists, "The dock is for compact width")
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10), "Workspaces didn't open")
        XCTAssertTrue(AidenStateMatrix.dockTab("Workspaces", in: app).isSelected)
        return app
    }

    private func row(_ index: Int, in app: XCUIApplication) -> XCUIElement {
        app.buttons["aiden.dockRecents.row.\(index)"].firstMatch
    }

    func testTheChosenTabShowsItsRecentsAndARowOpensIt() throws {
        for appearance in [AidenStateMatrix.Appearance.light, .dark] {
            let app = try launchOnWorkspaces(appearance: appearance)
            let recents = AidenStateMatrix.dockRecents(in: app)
            XCTAssertFalse(recents.exists, "The recents were up before the tab was tapped")
            AidenStateMatrix.capture("dock-workspaces-\(appearance.rawValue)", in: self)

            AidenStateMatrix.dockTab("Workspaces", in: app).tap()

            XCTAssertTrue(recents.waitForExistence(timeout: 5), "A tap on the chosen tab didn't show its recents")
            XCTAssertTrue(app.buttons["New workspace chat"].exists, "The recents don't offer a new workspace chat")
            let first = row(0, in: app)
            XCTAssertTrue(first.exists, "The recents list no workspace")
            XCTAssertFalse(row(4, in: app).exists, "The recents list more than four")
            // The list sits above the dock, on the screen, and the dock stays in reach.
            let dock = AidenStateMatrix.dock(in: app)
            XCTAssertTrue(AidenStateMatrix.window(of: app).frame.contains(recents.frame), "The recents run off the window")
            XCTAssertLessThanOrEqual(recents.frame.maxY, dock.frame.minY + 1, "The recents cover the dock")
            XCTAssertTrue(AidenStateMatrix.dockTab("Workspaces", in: app).isSelected)
            AidenStateMatrix.capture("dock-recents-\(appearance.rawValue)", in: self)

            // The row names its workspace first; its page carries the same name.
            let name = first.label.components(separatedBy: ", ").first ?? first.label
            first.tap()

            XCTAssertTrue(recents.waitForNonExistence(timeout: 5), "The recents stayed after a row was chosen")
            XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 10), "The row didn't open \(name)")
            app.terminate()
        }
    }

    func testTheRecentsCloseFromOutsideFromTheChosenTabAndForAnotherTab() throws {
        let app = try launchOnWorkspaces()
        let recents = AidenStateMatrix.dockRecents(in: app)
        let workspaces = AidenStateMatrix.dockTab("Workspaces", in: app)

        workspaces.tap()
        XCTAssertTrue(recents.waitForExistence(timeout: 5))
        // Outside the list: the page behind it.
        AidenStateMatrix.window(of: app).coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.2)).tap()
        XCTAssertTrue(recents.waitForNonExistence(timeout: 5), "A tap outside left the recents up")
        XCTAssertTrue(app.navigationBars["Workspaces"].exists, "Closing the recents left the tab")

        workspaces.tap()
        XCTAssertTrue(recents.waitForExistence(timeout: 5), "The recents didn't open a second time")
        AidenStateMatrix.dockTab("Workspaces", in: app).tap()
        XCTAssertTrue(recents.waitForNonExistence(timeout: 5), "The chosen tab didn't close its recents")
        XCTAssertTrue(app.navigationBars["Workspaces"].exists)

        workspaces.tap()
        XCTAssertTrue(recents.waitForExistence(timeout: 5))
        AidenStateMatrix.dockTab("Bots", in: app).tap()
        XCTAssertTrue(recents.waitForNonExistence(timeout: 5), "Another tab left the recents up")
        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10), "Another tab didn't open")

        // Bots was just chosen, so its first tap switched; only the next one lists.
        XCTAssertFalse(recents.exists)
        app.terminate()
    }

    func testTheChosenTabGoesBackToItsListBeforeItShowsRecents() throws {
        let app = try launchOnWorkspaces()
        let recents = AidenStateMatrix.dockRecents(in: app)
        AidenStateMatrix.dockTab("Workspaces", in: app).tap()
        XCTAssertTrue(recents.waitForExistence(timeout: 5))
        row(0, in: app).tap()
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForNonExistence(timeout: 10), "The row opened nothing")

        // With a page over the list the tab goes back, as a tab bar does.
        AidenStateMatrix.dockTab("Workspaces", in: app).tap()

        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10), "The tab didn't go back to its list")
        XCTAssertFalse(recents.exists, "Going back to the list opened the recents")
        app.terminate()
    }

    func testNewWorkspaceChatAsksWhichWorkspace() throws {
        let app = try launchOnWorkspaces()
        AidenStateMatrix.dockTab("Workspaces", in: app).tap()
        let action = app.buttons["aiden.dockRecents.footer"].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 5), "No new workspace chat in the recents")

        action.tap()

        XCTAssertTrue(AidenStateMatrix.dockRecents(in: app).waitForNonExistence(timeout: 5), "The recents stayed up")
        XCTAssertTrue(
            app.navigationBars["Choose workspace"].waitForExistence(timeout: 10),
            "New workspace chat didn't ask for a workspace"
        )
        app.terminate()
    }
}
