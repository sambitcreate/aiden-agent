import XCTest

/// Contract revision 66 on a phone (`-AidenDemoAgentSlider`): the composer's
/// slider chip opens the Agent Slider, a stop moves the chat, and the turn
/// runs on that stop's model and level, and so does a plain follow-up. The
/// demo Mac's reply names the stop whose model and level the turn asked for.
final class AidenAgentSliderUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testAStopChosenOnTheSliderIsTheModelTheTurnRunsOn() {
        // An earlier run's model picks are remembered on the phone; a string
        // reads as "nothing saved", so each run starts from the Mac's choice.
        let app = AidenStateMatrix.launch(
            scenario: .busy,
            extraArguments: ["-AidenDemoAgentSlider", "-aiden.model-preference.v1", "reset"]
        )
        AidenStateMatrix.openArea("Inbox", in: app)
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Draft release notes")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15), "No idle chat in the Inbox")
        hideOverlaySidebar(in: app)
        chat.tap()

        // The chat is on its own stop, here the home stop. A copy cached on an
        // earlier launch can show first, so wait for the Mac's chat.
        let chip = app.buttons["aiden.composer.agentSlider"].firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "The composer has no Agent Slider")
        let deadline = Date().addingTimeInterval(10)
        while !value(of: chip).contains("Balanced"), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(value(of: chip).contains("Balanced"), "The chip read \(value(of: chip))")
        shoot("composer-home")

        chip.tap()
        let deep = app.buttons["aiden.agentSlider.stop.stop_deep"].firstMatch
        XCTAssertTrue(deep.waitForExistence(timeout: 5), "The sheet has no Deep stop")
        let research = app.buttons["aiden.agentSlider.stop.stop_research"].firstMatch
        XCTAssertFalse(research.isEnabled, "A stop on a provider the Mac isn't signed in to can be chosen")
        shoot("sheet-home")

        deep.tap()
        XCTAssertTrue(app.buttons["aiden.agentSlider.reset"].firstMatch.isEnabled, "Off home, Reset to home is off")
        shoot("sheet-deep")
        app.buttons["aiden.agentSlider.done"].firstMatch.tap()
        XCTAssertTrue(deep.waitForNonExistence(timeout: 5), "Done left the sheet up")
        XCTAssertTrue(value(of: chip).contains("Deep"), "The chip read \(value(of: chip))")

        let composer = app.descendants(matching: .any).matching(NSPredicate(
            format: "elementType == %d OR elementType == %d",
            XCUIElement.ElementType.textField.rawValue,
            XCUIElement.ElementType.textView.rawValue
        )).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "No composer")
        composer.tap()
        composer.typeText("Think harder about this.")
        app.buttons["Send message"].firstMatch.tap()

        let reply = app.staticTexts["Answered on the Deep stop."].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15), "The turn didn't run on Deep's model and level")
        XCTAssertTrue(value(of: chip).contains("Deep"), "After the turn the chip read \(value(of: chip))")
        shoot("chat-answered-on-deep")

        // The pick asked the Mac to keep Deep's level as the chat's own, so a
        // plain follow-up still runs there.
        composer.tap()
        composer.typeText("And once more.")
        app.buttons["Send message"].firstMatch.tap()
        let replies = app.staticTexts.matching(NSPredicate(format: "label == %@", "Answered on the Deep stop."))
        let followUp = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count >= 2"), object: replies)
        XCTAssertEqual(XCTWaiter.wait(for: [followUp], timeout: 15), .completed, "The follow-up left Deep's level")
        XCTAssertTrue(value(of: chip).contains("Deep"), "After the follow-up the chip read \(value(of: chip))")
        app.terminate()
    }

    private func value(of element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    /// Run with TEST_RUNNER_AIDEN_SCREENSHOT_DIR=<folder> to also get the PNGs on disk.
    private func shoot(_ name: String) {
        let full = "agent-slider-\(name)"
        AidenStateMatrix.capture(full, in: self)
        if let folder = ProcessInfo.processInfo.environment["AIDEN_SCREENSHOT_DIR"], !folder.isEmpty {
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(full).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
        }
    }

    /// The tab view's own sidebar, which sits over the page in a narrow window
    /// and takes the next touch.
    private func hideOverlaySidebar(in app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        guard toggle.exists, toggle.label == "Hide Sidebar" else { return }
        toggle.tap()
        let shown = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "Hide Sidebar"),
            object: toggle
        )
        XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 5), .completed, "The sidebar stayed over the page")
    }
}
