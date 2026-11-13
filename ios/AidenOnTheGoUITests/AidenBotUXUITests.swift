import XCTest

/// Contract revision 61 on a phone (`-AidenDemoBotUX`): the screens the Bot UX
/// simplification adds or changes, walked and captured in light and dark.
final class AidenBotUXUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    func testCaptureBotUXScreensLight() { walk(.light) }
    func testCaptureBotUXScreensDark() { walk(.dark) }

    private func walk(_ appearance: AidenStateMatrix.Appearance) {
        func shoot(_ name: String) {
            let full = "phase6b-\(appearance.rawValue)-\(name)"
            AidenStateMatrix.capture(full, in: self)
            // Run with TEST_RUNNER_AIDEN_SCREENSHOT_DIR=<folder> to also get the PNGs on disk.
            if let folder = ProcessInfo.processInfo.environment["AIDEN_SCREENSHOT_DIR"], !folder.isEmpty {
                let url = URL(fileURLWithPath: folder).appendingPathComponent("\(full).png")
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            }
        }

        // The Bot's chat: the new cards and the typed approval card.
        var app = AidenStateMatrix.launch(scenario: .one, appearance: appearance, extraArguments: ["-AidenDemoBotUX"])
        AidenStateMatrix.openArea("Bots", in: app)
        let bot = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "No Bot on the Bots tab")
        bot.tap()
        let card = app.staticTexts["Review before Fetch web page → example.com"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15), "The typed approval card did not show")
        shoot("bot-approval-card")
        app.swipeDown()
        app.swipeDown()
        shoot("bot-cards-learning")
        app.swipeDown()
        shoot("bot-cards-settings-change")
        app.swipeUp()
        app.swipeUp()
        app.swipeUp()
        let allowOnce = app.buttons["Allow once"].firstMatch
        if allowOnce.waitForExistence(timeout: 5) {
            allowOnce.tap()
            XCTAssertTrue(app.staticTexts["Allowed once"].firstMatch.waitForExistence(timeout: 5), "No answered line")
            shoot("bot-approval-answered")
        }
        goBack(in: app)

        // Templates, and one-field New Bot.
        let newBot = app.navigationBars.buttons["New Bot"].firstMatch
        XCTAssertTrue(newBot.waitForExistence(timeout: 10), "No New Bot")
        newBot.tap()
        let templates = app.buttons["Templates"].firstMatch
        if templates.waitForExistence(timeout: 5) {
            templates.tap()
            XCTAssertTrue(app.navigationBars["Templates"].waitForExistence(timeout: 5), "Templates did not open")
            shoot("templates")
            app.navigationBars.buttons["Close"].firstMatch.tap()
            newBot.tap()
        }
        let create = app.buttons["New Bot"].firstMatch
        if create.waitForExistence(timeout: 5) { create.tap() }
        XCTAssertTrue(app.textFields["Name your Bot"].firstMatch.waitForExistence(timeout: 10), "New Bot is not one field")
        shoot("new-bot-one-field")
        app.navigationBars.buttons["Cancel"].firstMatch.tap()

        // Advanced: one messaging switch, Disable a Tool, no per-Bot chat activity page.
        bot.press(forDuration: 1.0)
        let advanced = app.buttons["Advanced"].firstMatch
        if advanced.waitForExistence(timeout: 5) {
            advanced.tap()
            XCTAssertTrue(app.staticTexts["What it can use"].firstMatch.waitForExistence(timeout: 15), "Advanced did not open")
            shoot("bot-advanced")
            app.swipeUp()
            shoot("bot-advanced-messaging")
            let disable = app.buttons["Disable a Tool"].firstMatch
            if disable.waitForExistence(timeout: 3) {
                disable.tap()
                shoot("bot-advanced-disable-tool")
                AidenStateMatrix.tapOutsidePopover(in: app)
            }
        }
        app.terminate()

        // Settings: Approvals and Show tool activity.
        app = AidenStateMatrix.launch(scenario: .one, appearance: appearance, extraArguments: ["-AidenDemoBotUX"])
        AidenStateMatrix.openArea("Inbox", in: app)
        let menu = app.navigationBars.buttons["Inbox menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "No Inbox menu")
        menu.tap()
        if !app.buttons["Settings"].firstMatch.waitForExistence(timeout: 2) { menu.tap() }
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
        let approvals = app.buttons["Approvals"].firstMatch
        XCTAssertTrue(approvals.waitForExistence(timeout: 10), "No Approvals in Settings")
        app.swipeUp()
        shoot("app-settings")
        app.swipeDown()
        if !approvals.isHittable { app.swipeUp() }
        approvals.tap()
        XCTAssertTrue(app.staticTexts["When Aiden asks"].firstMatch.waitForExistence(timeout: 10), "Approvals did not open")
        XCTAssertTrue(app.staticTexts["Send email"].firstMatch.waitForExistence(timeout: 10), "No rules")
        shoot("approvals-mode")
        app.swipeUp()
        shoot("approvals-rules")
        app.navigationBars.buttons["Add Rule"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Calendar"].firstMatch.waitForExistence(timeout: 10), "No picker")
        app.staticTexts["Calendar"].firstMatch.tap()
        shoot("approvals-add-rule")
        app.terminate()

        // A chat's run approval as the Mac's card.
        app = AidenStateMatrix.launch(
            scenario: .one, appearance: appearance,
            extraArguments: ["-AidenDemoBotUX", "-AidenDemoLateChatApproval"]
        )
        AidenStateMatrix.openArea("Inbox", in: app)
        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")).firstMatch
        if chat.waitForExistence(timeout: 10) {
            chat.tap()
            if app.staticTexts["Run on your Mac?"].firstMatch.waitForExistence(timeout: 20) {
                shoot("chat-approval-card")
            } else {
                XCTFail("The chat's typed approval card did not show")
            }
        }
        app.terminate()

        // The two-step Needs-you card.
        app = AidenStateMatrix.launch(
            scenario: .one, appearance: appearance,
            extraArguments: ["-AidenDemoBotUX", "-AidenDemoBotUXHandoff"]
        )
        AidenStateMatrix.openArea("Bots", in: app)
        let scout = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
        if scout.waitForExistence(timeout: 15) {
            scout.tap()
            let take = app.buttons["Take Control"].firstMatch
            XCTAssertTrue(take.waitForExistence(timeout: 15), "No Take Control")
            shoot("handoff-take-control")
            take.tap()
            // Take Control opens the page in Safari; come back for the answers.
            Thread.sleep(forTimeInterval: 2)
            app.activate()
            XCTAssertTrue(app.buttons["I’m Done"].firstMatch.waitForExistence(timeout: 10), "No second step")
            shoot("handoff-answers")
        }
        app.terminate()
    }

    private func goBack(in app: XCUIApplication) {
        let named = app.navigationBars.buttons["BackButton"].firstMatch
        let back = named.waitForExistence(timeout: 2) ? named : app.navigationBars.buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
    }
}
