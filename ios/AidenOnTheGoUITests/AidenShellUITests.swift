import XCTest

final class AidenShellUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// The shell opens against every demo scenario. This is the CI smoke test.
    func testShellLaunchesForEveryScenario() {
        for scenario in AidenStateMatrix.Scenario.allCases {
            let app = AidenStateMatrix.launch(scenario: scenario)
            XCTAssertTrue(
                AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10),
                "No first screen for \(scenario.rawValue)"
            )
            app.terminate()
        }
    }

    func testAllFourTabsExistInEveryScenario() {
        for scenario in AidenStateMatrix.Scenario.allCases {
            let app = AidenStateMatrix.launch(scenario: scenario)
            XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10), scenario.rawValue)
            for title in ["Bots", "Workspaces", "Search", "Inbox"] {
                AidenStateMatrix.leaveSearch(in: app)
                let tab = AidenStateMatrix.tab(title, in: app)
                XCTAssertTrue(tab.waitForExistence(timeout: 5), "No \(title) tab in \(scenario.rawValue)")
                tab.tap()
                XCTAssertEqual(app.state, .runningForeground, "\(title) in \(scenario.rawValue)")
            }
            app.terminate()
        }
    }

    /// A tab is never hidden, because on iOS 27 a selection pointing at a hidden
    /// tab crashes. Bots stays selectable and says why it has nothing to show.
    func testBotsTabStaysSelectableWhenBotsAreUnavailable() {
        let app = AidenStateMatrix.launch(scenario: .oldHost)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))

        AidenStateMatrix.openArea("Bots", in: app)

        XCTAssertTrue(app.staticTexts["Bots unavailable"].waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "newer version of Aiden Agent"))
                .firstMatch.exists,
            "The tab did not say why"
        )
        XCTAssertEqual(app.state, .runningForeground)

        AidenStateMatrix.openArea("Inbox", in: app)
        XCTAssertEqual(app.state, .runningForeground)
        app.terminate()
    }

    func testBotsTabDoesNotExplainAnythingWhenBotsAreAvailable() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))

        AidenStateMatrix.openArea("Bots", in: app)

        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Bots unavailable"].exists)
        app.terminate()
    }

    func testOnlyTheSearchTabHasASearchField() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        XCTAssertFalse(app.searchFields.firstMatch.exists, "Inbox has a search field")

        for title in ["Bots", "Workspaces"] {
            AidenStateMatrix.openArea(title, in: app)
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
            XCTAssertFalse(app.searchFields.firstMatch.exists, "\(title) has a search field")
        }

        AidenStateMatrix.openArea("Search", in: app)
        XCTAssertTrue(searchField(in: app).exists, "Search has no field")
        app.terminate()
    }

    /// The largest text makes the list taller than the screen, so it can scroll.
    func testTheTabBarMinimizesOnScrollDownAndComesBack() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "A tab bar minimizes on iPhone")
        let app = AidenStateMatrix.launch(
            scenario: .busy,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        let bots = app.tabBars.buttons["Bots"].firstMatch
        XCTAssertTrue(bots.waitForExistence(timeout: 5))

        app.swipeUp(velocity: .slow)
        let minimized = NSPredicate(format: "exists == false OR hittable == false")
        wait(for: [XCTNSPredicateExpectation(predicate: minimized, object: bots)], timeout: 5)
        AidenStateMatrix.capture("tabs-inbox-minimized", in: self)

        app.swipeDown(velocity: .slow)
        XCTAssertTrue(bots.waitForExistence(timeout: 5), "The tab bar did not come back")
        app.terminate()
    }

    /// Running chats live above the tab bar, and only while there are any.
    func testAccessoryAppearsOnlyWhileRunning() {
        let busy = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: busy).waitForExistence(timeout: 10), "No chat rows in the inbox")
        let accessory = AidenStateMatrix.runningAccessory(in: busy)
        XCTAssertTrue(accessory.waitForExistence(timeout: 10), "No accessory while a chat runs")
        XCTAssertTrue(accessory.label.contains("Plan the Q3 roadmap"), "The accessory said \(accessory.label)")
        XCTAssertFalse(accessory.label.contains("more"), "One running chat was counted as several")

        accessory.tap()
        XCTAssertTrue(busy.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "One running chat did not open")
        XCTAssertTrue(accessory.waitForNonExistence(timeout: 5), "The accessory stayed under the composer")

        goBack(in: busy)
        XCTAssertTrue(accessory.waitForExistence(timeout: 10), "The accessory did not come back with the Inbox")
        busy.terminate()

        let empty = AidenStateMatrix.launch(scenario: .empty)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: empty).waitForExistence(timeout: 10))
        XCTAssertTrue(empty.staticTexts["No chats yet"].waitForExistence(timeout: 10))
        XCTAssertFalse(AidenStateMatrix.runningAccessory(in: empty).exists, "An accessory with nothing running")
        empty.terminate()
    }

    /// More than one running chat is a list to choose from.
    func testAccessoryWithSeveralRunningChatsOpensASheet() {
        let app = AidenStateMatrix.launch(scenario: .four)
        let accessory = AidenStateMatrix.runningAccessory(in: app)
        XCTAssertTrue(accessory.waitForExistence(timeout: 15), "No accessory while chats run")
        XCTAssertTrue(accessory.label.contains("1 more"), "The accessory said \(accessory.label)")
        hideOverlaySidebar(in: app)

        accessory.tap()

        let sheet = app.navigationBars["Running chats"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "No sheet of running chats")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan the Q3 roadmap")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The sheet did not list the chat")
        row.tap()

        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(sheet.exists, "The sheet stayed up over the chat")
        app.terminate()
    }

    /// Four chats need the person across two machines. Next walks them all, then
    /// says it's finished, and the Inbox is one Back away the whole time.
    func testCatchUpWalksEveryMachineThenFinishes() {
        let app = AidenStateMatrix.launch(scenario: .four)
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
        XCTAssertTrue(catchUp.label.contains("4 chats"), "The row said \(catchUp.label)")
        hideOverlaySidebar(in: app)

        catchUp.tap()

        // The two approvals tie, so their order isn't fixed. The mini's is the other
        // machine's chat, and a walk that stayed on one chat would never reach it.
        var left: Set = [
            "Fix the flaky upload test", "Rename the onboarding assets",
            "Summarise the design review", "Refactor the settings screen",
        ]
        let next = app.navigationBars.buttons["Next"]
        for step in 1...4 {
            XCTAssertTrue(next.waitForExistence(timeout: 10), "No Next on chat \(step)")
            let chatOnScreen = NSPredicate { _, _ in left.contains { app.navigationBars[$0].exists } }
            wait(for: [XCTNSPredicateExpectation(predicate: chatOnScreen, object: nil)], timeout: 10)
            left = left.filter { !app.navigationBars[$0].exists }
            XCTAssertEqual(left.count, 4 - step, "Chat \(step) wasn't a new one")
            next.tap()
        }
        XCTAssertTrue(app.staticTexts["Catch Up finished"].waitForExistence(timeout: 10), "No finished state")
        XCTAssertFalse(next.exists, "Next outlived the run")

        app.buttons["Back to Inbox"].firstMatch.tap()
        XCTAssertTrue(AidenStateMatrix.tab("Inbox", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(catchUp.waitForExistence(timeout: 10), "The chats still need the person")
        app.terminate()
    }

    func testNextShowsOnlyDuringCatchUp() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(app.navigationBars.buttons["Next"].exists, "Next showed outside a run")
        goBack(in: app)

        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 10), "No Catch Up row")
        catchUp.tap()
        XCTAssertTrue(app.navigationBars.buttons["Next"].waitForExistence(timeout: 10), "No Next during the run")
        goBack(in: app)

        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(app.navigationBars.buttons["Next"].exists, "Next outlived the run")
        app.terminate()
    }

    /// Only the words are saved with a chat, so Next says so before it loses a photo.
    func testNextAsksBeforeLeavingAttachmentsBehind() {
        let app = AidenStateMatrix.launch(
            scenario: .four,
            extraArguments: ["-AidenDemoStagedAttachment", "YES"]
        )
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
        hideOverlaySidebar(in: app)
        catchUp.tap()
        let next = app.navigationBars.buttons["Next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10), "No Next")
        Thread.sleep(forTimeInterval: 1)
        let firstChat = app.navigationBars.firstMatch.identifier

        next.tap()

        let discard = app.buttons["Discard attachments"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5), "Next left without asking")
        AidenStateMatrix.capture("catch-up-discard-attachments", in: self)
        XCTAssertEqual(app.navigationBars.firstMatch.identifier, firstChat, "Next moved on before the answer")

        discard.tap()

        let moved = NSPredicate { _, _ in app.navigationBars.firstMatch.identifier != firstChat }
        wait(for: [XCTNSPredicateExpectation(predicate: moved, object: nil)], timeout: 10)
        app.terminate()
    }

    /// The words typed last are the ones a timed save would miss.
    func testDraftTextSurvivesNext() {
        let draft = "Keep these words"
        let app = AidenStateMatrix.launch(scenario: .four)
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
        hideOverlaySidebar(in: app)
        catchUp.tap()

        // A chat asking something shows a card where the composer goes.
        let next = app.navigationBars.buttons["Next"]
        let composer = app.descendants(matching: .any).matching(NSPredicate(
            format: "elementType == %d OR elementType == %d",
            XCUIElement.ElementType.textField.rawValue,
            XCUIElement.ElementType.textView.rawValue
        )).firstMatch
        for _ in 1...4 {
            XCTAssertTrue(next.waitForExistence(timeout: 10), "The run ended with no composer")
            if composer.waitForExistence(timeout: 3) { break }
            next.tap()
        }
        XCTAssertTrue(composer.exists, "No chat in the run has a composer")
        let title = app.navigationBars.firstMatch.identifier
        composer.tap()
        composer.typeText(draft)

        next.tap()
        let moved = NSPredicate { _, _ in app.navigationBars.firstMatch.identifier != title }
        wait(for: [XCTNSPredicateExpectation(predicate: moved, object: nil)], timeout: 10)
        goBack(in: app)

        let chat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "\(title) isn't in the Inbox")
        chat.tap()
        let kept = NSPredicate(format: "value CONTAINS %@", draft)
        wait(for: [XCTNSPredicateExpectation(predicate: kept, object: composer)], timeout: 10)

        // The demo chats are shared with the other tests.
        composer.tap()
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count))
        Thread.sleep(forTimeInterval: 1)
        app.terminate()
    }

    /// The composer owns the bottom edge of a pushed chat.
    func testAPushedChatHidesTheTabBarUntilItIsLeft() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")

        chat.tap()

        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The tab bar stayed over the chat")

        goBack(in: app)

        XCTAssertTrue(chat.waitForExistence(timeout: 10), "Back did not return to the Inbox")
        XCTAssertTrue(AidenStateMatrix.tab("Inbox", in: app).isHittable, "The tab bar did not come back")
        app.terminate()
    }

    /// The composer's height is the transcript's bottom inset, and it settles
    /// after the first layout. A chat taller than the screen must still open on
    /// its latest words, with nothing left to jump to.
    func testALongChatOpensOnItsLatestWords() {
        let app = AidenStateMatrix.launch(scenario: .busy, contentSize: .accessibilityExtraExtraExtraLarge)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")

        Thread.sleep(forTimeInterval: 2)

        let jump = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "latest")).firstMatch
        XCTAssertFalse(jump.exists, "The chat opened short of its latest words")
        app.terminate()
    }

    /// Following the bottom never pulls a chat shorter than the screen down from the top.
    func testAShortChatStaysAtTheTop() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        chat.tap()
        let firstMessage = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
        XCTAssertTrue(firstMessage.waitForExistence(timeout: 10), "The chat did not open")

        let navigationBar = app.navigationBars.firstMatch.frame
        XCTAssertLessThan(firstMessage.frame.minY - navigationBar.maxY, 48, "The chat opened below the top of the screen")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertLessThan(firstMessage.frame.minY - navigationBar.maxY, 48, "The chat moved down the screen")
        app.terminate()
    }

    /// Needs you above Updates above Earlier, whichever machine a row came from.
    func testInboxShowsNeedsYouUpdatesEarlierInOrder() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        func heading(_ title: String) -> XCUIElement {
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        }
        let needsYou = heading("Needs you")
        let updates = heading("Updates")
        let earlier = heading("Earlier")
        for section in [needsYou, updates, earlier] {
            XCTAssertTrue(section.waitForExistence(timeout: 10), "\(section) is missing")
        }

        XCTAssertLessThan(needsYou.frame.minY, updates.frame.minY)
        XCTAssertLessThan(updates.frame.minY, earlier.frame.minY)

        // Two prompts and a failed run wait on the person. The running chat doesn't.
        // A tab bar gives the count as a value, and a sidebar row in its label.
        let inbox = AidenStateMatrix.tab("Inbox", in: app)
        let badge = "\(inbox.label) \(inbox.value as? String ?? "")"
        XCTAssertTrue(badge.contains("3"), "The Inbox badge said \(badge)")
        AidenStateMatrix.capture("tabs-inbox-sections", in: self)
        app.terminate()
    }

    /// A row's menu opens with what its swipes offer, and a row waiting on a
    /// decision offers neither Done nor Snooze either way.
    func testRowMenusMatchTheirSwipes() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let prompt = openInbox(in: app)
        XCTAssertTrue(prompt.waitForExistence(timeout: 10), "No chat rows in the inbox")
        let idle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Compare two caching strategies")).firstMatch
        XCTAssertTrue(idle.waitForExistence(timeout: 10), "No Earlier row")

        idle.swipeLeft()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5), "The swipe offered no Done")
        XCTAssertTrue(app.buttons["Snooze"].exists, "The swipe offered no Snooze")
        AidenStateMatrix.capture("tabs-inbox-swipe", in: self)
        idle.swipeRight()
        XCTAssertTrue(app.buttons["Done"].waitForNonExistence(timeout: 5))

        idle.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5), "The menu offered no Done")
        XCTAssertTrue(app.buttons["Snooze"].exists, "The menu offered no Snooze")
        AidenStateMatrix.capture("tabs-inbox-menu", in: self)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
        XCTAssertTrue(app.buttons["Done"].waitForNonExistence(timeout: 5))

        prompt.swipeLeft()
        XCTAssertFalse(app.buttons["Done"].waitForExistence(timeout: 2), "A prompt row offered Done")
        XCTAssertFalse(app.buttons["Snooze"].exists, "A prompt row offered Snooze")
        app.terminate()
    }

    /// Every tab and a pushed chat, for a person to look at. A screen that cannot
    /// be reached fails the test.
    ///
    /// Search comes last, so nothing here reads what Search leaves behind. The
    /// launch also ignores any saved navigation (`AidenStateMatrix.launch`).
    func testCaptureTabShellScreens() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        AidenStateMatrix.capture("tabs-inbox", in: self)

        hideOverlaySidebar(in: app)
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        AidenStateMatrix.capture("tabs-pushed-chat", in: self)
        goBack(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "Back did not return to the Inbox")

        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-landscape", in: self)
        XCUIDevice.shared.orientation = .portrait

        AidenStateMatrix.openArea("Bots", in: app)
        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-bots", in: self)

        AidenStateMatrix.openArea("Workspaces", in: app)
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-workspaces", in: self)

        AidenStateMatrix.openArea("Search", in: app)
        XCTAssertTrue(searchField(in: app).exists)
        AidenStateMatrix.capture("tabs-search", in: self)
        app.terminate()

        let oldHost = AidenStateMatrix.launch(scenario: .oldHost)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: oldHost).waitForExistence(timeout: 10))
        AidenStateMatrix.openArea("Bots", in: oldHost)
        XCTAssertTrue(oldHost.staticTexts["Bots unavailable"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-bots-unavailable", in: self)
        oldHost.terminate()
    }

    /// Every page the tabs reach, for the review of what the tab bar and the
    /// toolbars do on each one.
    func testCaptureTabDestinations() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        if UIDevice.current.userInterfaceIdiom == .pad {
            try AidenStateMatrix.widenTheWindow(of: app)
        }
        openInboxMenu(in: app)
        XCTAssertTrue(app.buttons["Settings"].firstMatch.waitForExistence(timeout: 5))
        AidenStateMatrix.capture("tabs-inbox-menu", in: self)
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-settings", in: self)
        goBack(in: app)

        openInboxMenu(in: app)
        app.buttons["Scheduled tasks"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Scheduled tasks"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-scheduled", in: self)
        goBack(in: app)

        openInboxMenu(in: app)
        app.buttons["Usage"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Usage"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-usage", in: self)
        goBack(in: app)

        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        app.navigationBars.buttons["New chat"].firstMatch.tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Existing Workspace")).firstMatch
                .waitForExistence(timeout: 5)
        )
        AidenStateMatrix.capture("tabs-compose", in: self)
        AidenStateMatrix.tapOutsidePopover(in: app)
        Thread.sleep(forTimeInterval: 0.5)

        // A chat pushed from a workspace page, and its fork: neither shows the tab bar.
        AidenStateMatrix.openArea("Workspaces", in: app)
        let workspace = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Aiden Agent")).firstMatch
        XCTAssertTrue(workspace.waitForExistence(timeout: 10))
        workspace.tap()
        XCTAssertTrue(app.navigationBars["Aiden Agent"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-workspace-page", in: self)
        let chat = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")
        ).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat on the workspace page")
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The tab bar stayed over a workspace's chat")
        AidenStateMatrix.capture("tabs-workspace-chat", in: self)

        app.navigationBars.buttons["More"].firstMatch.tap()
        let fork = app.buttons["Fork"].firstMatch
        XCTAssertTrue(fork.waitForExistence(timeout: 5), "No Fork in the chat's menu")
        fork.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(fork)")).firstMatch
                .waitForExistence(timeout: 10),
            "The fork did not open"
        )
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The tab bar stayed over a fork")
        AidenStateMatrix.capture("tabs-fork", in: self)
        goBack(in: app)
        goBack(in: app)
        goBack(in: app)

        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10)
        )
        AidenStateMatrix.capture("tabs-bot-chat", in: self)
        app.terminate()

        let offline = AidenStateMatrix.launch(scenario: .offlineMix)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: offline).waitForExistence(timeout: 10))
        openInboxMenu(in: offline)
        offline.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: offline)
        XCTAssertTrue(machines.waitForExistence(timeout: 10))
        machines.tap()
        let laptop = offline.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "No offline machine to select")
        laptop.tap()
        let change = offline.buttons["Make this the default machine"].firstMatch
        // Far down a lazy form: it isn't built until it's scrolled to.
        for _ in 0..<6 where !change.waitForExistence(timeout: 1) { offline.swipeUp() }
        XCTAssertTrue(change.exists, "No way to select the offline machine")
        change.tap()
        let failure = offline.alerts.buttons["OK"].firstMatch
        if failure.waitForExistence(timeout: 5) { failure.tap() }
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-offline-settings", in: self)
        for _ in 0..<3 where !offline.navigationBars["Inbox"].exists { goBack(in: offline) }
        XCTAssertTrue(offline.navigationBars["Inbox"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-offline-inbox", in: self)
        AidenStateMatrix.openArea("Bots", in: offline)
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-offline-bots", in: self)
        AidenStateMatrix.openArea("Workspaces", in: offline)
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-offline-workspaces", in: self)
        offline.terminate()
    }

    // MARK: Everything the old home reached

    /// Settings, Scheduled tasks, Usage, Workspaces, Bots and a new chat, all from
    /// the tabs. A destination that cannot be reached fails the test.
    func testEveryOldHomeDestinationIsReachable() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        for (entry, title) in [("Settings", "App settings"), ("Scheduled tasks", "Scheduled tasks"), ("Usage", "Usage")] {
            openInboxMenu(in: app)
            let item = app.buttons[entry].firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 5), "No \(entry) in the Inbox menu")
            item.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(entry) did not open")
            goBack(in: app)
            XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "\(entry) did not go back")
        }

        AidenStateMatrix.openArea("Workspaces", in: app)
        let workspace = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Aiden Agent")).firstMatch
        XCTAssertTrue(workspace.waitForExistence(timeout: 10), "No workspace in the list")
        workspace.tap()
        XCTAssertTrue(app.navigationBars["Aiden Agent"].waitForExistence(timeout: 10), "The workspace did not open")
        goBack(in: app)

        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots tab")
        bot.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10),
            "The Bot did not open"
        )
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The tab bar stayed over the Bot chat")
        goBack(in: app)

        for area in ["Inbox", "Workspaces"] {
            AidenStateMatrix.openArea(area, in: app)
            let compose = app.navigationBars.buttons["New chat"].firstMatch
            XCTAssertTrue(compose.waitForExistence(timeout: 10), "No compose button on \(area)")
            compose.tap()
            XCTAssertTrue(
                app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Existing Workspace")).firstMatch
                    .waitForExistence(timeout: 5),
                "Compose on \(area) did not offer a workspace"
            )
            AidenStateMatrix.tapOutsidePopover(in: app)
            Thread.sleep(forTimeInterval: 0.5)
        }

        // The whole flow, through to an open chat.
        AidenStateMatrix.openArea("Workspaces", in: app)
        app.navigationBars.buttons["New chat"].firstMatch.tap()
        let existing = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Existing Workspace")).firstMatch
        XCTAssertTrue(existing.waitForExistence(timeout: 5))
        existing.tap()
        let choice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Aiden Agent")).firstMatch
        XCTAssertTrue(app.navigationBars["Choose workspace"].waitForExistence(timeout: 5), "No workspace picker")
        choice.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The new chat did not open")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The tab bar stayed over the new chat")
        app.terminate()
    }

    /// Pushed Settings has no sheet of its own for pairing: it asks the shell for one.
    func testPairAMachineOpensFromPushedSettings() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        openInboxMenu(in: app)
        app.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: app)
        XCTAssertTrue(machines.waitForExistence(timeout: 10), "No Machines in Settings")
        machines.tap()
        let pair = app.buttons["Pair a machine"].firstMatch
        XCTAssertTrue(pair.waitForExistence(timeout: 10), "No way to pair another machine")
        pair.tap()
        XCTAssertTrue(app.navigationBars["Pair Aiden"].waitForExistence(timeout: 10), "Pairing did not open")
        app.terminate()
    }

    /// Every step is a route: the tab's stack holds nothing else.
    func testAMachineOpensFromSettingsAndBackRetracesTheWay() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        openInboxMenu(in: app)
        app.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: app)
        XCTAssertTrue(machines.waitForExistence(timeout: 10), "No Machines in Settings")
        machines.tap()
        let laptop = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "No machine in the list")
        laptop.tap()
        XCTAssertTrue(app.navigationBars["Laptop"].waitForExistence(timeout: 10), "The machine did not open")

        goBack(in: app)
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10), "Back left Machines")
        goBack(in: app)
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10), "Back left Settings")
        app.terminate()
    }

    func testAPushedRouteHidesTheTabBarAndBackReturnsIt() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat rows in the inbox")
        if UIDevice.current.userInterfaceIdiom == .pad {
            restoreTheWindowAfterwards(of: app)
            try AidenStateMatrix.narrowTheWindow(of: app)
        }
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 10), "No tab bar at compact width")
        XCTAssertTrue(tabBar.isHittable)

        row.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertFalse(tabBar.isHittable, "The tab bar stayed over the chat")

        goBack(in: app)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "Back did not reach the Inbox")
        let returned = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: tabBar)
        wait(for: [returned], timeout: 5)
        app.terminate()
    }

    /// A window that changes size class rebuilds the shell. What's open stays open.
    func testAnOpenChatSurvivesAResize() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "A phone's window can't change size")
        let app = AidenStateMatrix.launch(scenario: .busy)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat rows in the inbox")
        try AidenStateMatrix.widenTheWindow(of: app)
        hideOverlaySidebar(in: app)
        row.tap()
        let send = app.buttons["Send message"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "The chat did not open")

        restoreTheWindowAfterwards(of: app)
        try AidenStateMatrix.narrowTheWindow(of: app)
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Narrowing the window closed the chat")
        XCTAssertFalse(app.navigationBars["Inbox"].exists, "Narrowing the window went back to the Inbox")

        try AidenStateMatrix.widenTheWindow(of: app)
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Widening the window closed the chat")
        XCTAssertFalse(app.navigationBars["Inbox"].exists, "Widening the window went back to the Inbox")
        hideOverlaySidebar(in: app)
        goBack(in: app)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "The stack did not survive")
        app.terminate()
    }

    func testTheInboxSaysWhileItsMachineConnects() {
        let app = AidenStateMatrix.launch(scenario: .one, extraArguments: ["-AidenDemoSlowConnect", "YES"])
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        let hint = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", "Connecting to Studio Mac")
        ).firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 10), "The Inbox gave no sign it was connecting")
        app.terminate()
    }

    func testAChatWithoutAWorkspaceCanBeDeletedFromTheInbox() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoNoWorkspaceChat", "YES"])
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat without a workspace in the Inbox")
        hideOverlaySidebar(in: app)

        row.press(forDuration: 1.2)
        let delete = app.buttons["Delete"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "The row's menu has no Delete")
        delete.tap()
        let confirm = app.buttons["Delete chat"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Delete did not ask first")
        XCTAssertTrue(row.exists, "Delete went ahead before it was confirmed")
        confirm.tap()

        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)
        wait(for: [gone], timeout: 5)
        app.terminate()
    }

    /// The tabs become a sidebar when the window has the width for one. It opens
    /// on the tab strip, the system's default, and the sidebar is one tap away.
    func testIPadUsesASidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Needs a regular-width window")
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        try AidenStateMatrix.widenTheWindow(of: app)
        let toggle = app.buttons.matching(NSPredicate(format: "identifier ==[c] %@", "ToggleSidebar")).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "No sidebar button in a regular width")
        if !AidenStateMatrix.sidebarRow("Inbox", in: app).exists { toggle.tap() }
        for title in ["Inbox", "Bots", "Workspaces", "Search"] {
            XCTAssertTrue(
                AidenStateMatrix.sidebarRow(title, in: app).waitForExistence(timeout: 10),
                "\(title) is not in the sidebar"
            )
        }
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A tab bar showed beside the sidebar")
        AidenStateMatrix.capture("tabs-ipad-sidebar", in: self)

        for title in ["Bots", "Workspaces", "Inbox"] {
            // In a window this narrow the sidebar sits over the page and closes on a tap.
            let row = AidenStateMatrix.sidebarRow(title, in: app)
            if !row.exists {
                app.buttons.matching(NSPredicate(format: "identifier ==[c] %@", "ToggleSidebar")).firstMatch.tap()
            }
            XCTAssertTrue(row.waitForExistence(timeout: 5), "The sidebar did not come back for \(title)")
            row.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(title) did not open from the sidebar")
        }
        app.terminate()
    }

    /// In a regular width, Search with its field up still leaves the way back
    /// to the other tabs.
    func testSearchInARegularWidthLeavesAWayBackToTheOtherTabs() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Needs a regular-width window")
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        try AidenStateMatrix.widenTheWindow(of: app)
        search("flaky", in: app)
        XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10), "No Search results")

        let row = AidenStateMatrix.sidebarRow("Workspaces", in: app)
        if !row.isHittable {
            let toggle = app.buttons.matching(NSPredicate(format: "identifier ==[c] %@", "ToggleSidebar")).firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "Search left no way back to the other tabs")
            toggle.tap()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The sidebar did not come back")
        AidenStateMatrix.capture("search-ipad-way-back", in: self)
        row.tap()
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10), "Workspaces did not open from Search")
        app.terminate()
    }

    /// Size classes pick the layout, never the device: a narrow window on an iPad
    /// gets the same bottom tabs as a phone.
    func testCompactWidthUsesTabs() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        if UIDevice.current.userInterfaceIdiom == .pad {
            restoreTheWindowAfterwards(of: app)
            try AidenStateMatrix.narrowTheWindow(of: app)
            AidenStateMatrix.capture("tabs-ipad-compact-window", in: self)
        }

        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10), "No tab bar at compact width")
        for title in ["Inbox", "Bots", "Workspaces"] {
            XCTAssertTrue(app.tabBars.buttons[title].firstMatch.exists, "No \(title) tab at compact width")
        }
        XCTAssertFalse(AidenStateMatrix.sidebarRow("Bots", in: app).exists, "A sidebar showed at compact width")
        app.terminate()
    }

    /// The window keeps its size into the next launch, so a test that narrows it
    /// gives the next test a full one back, pass or fail. A window that won't
    /// widen again can't turn this test's result into a skip.
    private func restoreTheWindowAfterwards(of app: XCUIApplication) {
        addTeardownBlock {
            if app.state == .notRunning { app.launch() }
            try? AidenStateMatrix.widenTheWindow(of: app)
            app.terminate()
        }
    }

    // MARK: Machines

    func testTheStatusItemCountsMachinesAndOpensThem() {
        let app = AidenStateMatrix.launch(scenario: .offlineMix)
        let item = app.buttons["aiden.machine-status"]
        XCTAssertTrue(item.waitForExistence(timeout: 10), "The Inbox has no status item")
        let settled = NSPredicate(format: "label == %@", "2 of 4 machines online")
        expectation(for: settled, evaluatedWith: item)
        waitForExpectations(timeout: 15)
        hideOverlaySidebar(in: app)

        item.tap()

        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10), "The item didn't open Machines")
    }

    func testTheStripNarrowsTheInboxToOneMachine() {
        let app = AidenStateMatrix.launch(scenario: .four)
        let studioRow = openInbox(in: app)
        XCTAssertTrue(studioRow.waitForExistence(timeout: 15), "No chat rows in the Inbox")
        let onStudio = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "On Studio Mac")).firstMatch
        XCTAssertTrue(onStudio.waitForExistence(timeout: 10), "With several machines a row says which")

        let laptop = app.buttons["Laptop"].firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "The strip has no chip for the machine")
        laptop.tap()

        // Laptop's rows stay, and with only one machine listed they carry no chip.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: onStudio)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(studioRow.exists, "The filter left the Inbox empty")

        app.buttons["All machines"].firstMatch.tap()
        XCTAssertTrue(onStudio.waitForExistence(timeout: 10), "All brings every machine back")
    }

    /// Compose on the Workspaces tab starts on the machine picker with several
    /// machines, on the default machine, or on the one the strip is filtered to.
    func testWorkspacesComposeStartsOnThePickerAtTheFilteredMachine() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 15), "No chat rows in the Inbox")
        AidenStateMatrix.openArea("Workspaces", in: app)
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        let compose = app.navigationBars.buttons["New chat"].firstMatch
        let machine = app.buttons["Machine"].firstMatch

        compose.tap()
        XCTAssertTrue(machine.waitForExistence(timeout: 5), "Compose on Workspaces has no machine picker")
        XCTAssertTrue((machine.value as? String)?.hasPrefix("Studio Mac") == true, "\(String(describing: machine.value))")
        AidenStateMatrix.tapOutsidePopover(in: app)
        Thread.sleep(forTimeInterval: 0.5)

        let laptop = app.buttons["Laptop"].firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "The Workspaces strip has no chip for the machine")
        laptop.tap()
        compose.tap()
        XCTAssertTrue(machine.waitForExistence(timeout: 5), "Compose lost its picker under a filter")
        XCTAssertTrue((machine.value as? String)?.hasPrefix("Laptop") == true, "\(String(describing: machine.value))")
        AidenStateMatrix.tapOutsidePopover(in: app)
        app.terminate()
    }

    /// Hide is the Inbox's. The Workspaces strip still lists a hidden machine,
    /// and compose there, filtered to it, starts on it.
    func testWorkspacesComposeStartsOnAHiddenMachineItIsFilteredTo() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 15), "No chat rows in the Inbox")
        hideOverlaySidebar(in: app)
        app.buttons["aiden.machine-status"].tap()
        let laptopRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop,")).firstMatch
        XCTAssertTrue(laptopRow.waitForExistence(timeout: 10), "Machines doesn't list the laptop")
        laptopRow.tap()
        let hide = app.switches["Hide from Inbox"].firstMatch
        for _ in 0..<6 where !hide.isHittable { app.swipeUp() }
        XCTAssertTrue(hide.waitForExistence(timeout: 5), "The machine page has no Hide from Inbox")
        hide.switches.firstMatch.exists ? hide.switches.firstMatch.tap() : hide.tap()
        XCTAssertEqual(hide.value as? String, "1", "The laptop didn't hide")

        // Back past Machines to the Inbox, then over to Workspaces.
        goBack(in: app)
        goBack(in: app)
        // Scrolling down to the switch minimised the tab bar; scroll back up.
        let workspacesTab = app.tabBars.buttons["Workspaces"].firstMatch
        for _ in 0..<3 where !workspacesTab.exists { app.swipeDown(velocity: .slow) }
        AidenStateMatrix.openArea("Workspaces", in: app)
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        let laptop = app.buttons["Laptop"].firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "The Workspaces strip leaves the hidden machine out")
        laptop.tap()

        let compose = app.navigationBars.buttons["New chat"].firstMatch
        let machine = app.buttons["Machine"].firstMatch
        compose.tap()
        XCTAssertTrue(machine.waitForExistence(timeout: 5), "Compose on Workspaces has no machine picker")
        XCTAssertTrue(
            (machine.value as? String)?.hasPrefix("Laptop") == true,
            "Compose didn't start on the hidden machine: \(String(describing: machine.value))"
        )
        AidenStateMatrix.tapOutsidePopover(in: app)
        app.terminate()
    }

    func testTheMachinePageCountsItsOpenChats() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 15), "No chat rows in the Inbox")
        app.buttons["aiden.machine-status"].tap()
        let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac,")).firstMatch
        XCTAssertTrue(studio.waitForExistence(timeout: 10), "Machines doesn't list the machine")
        studio.tap()

        let openChats = app.staticTexts["Open chats"]
        for _ in 0..<6 where !openChats.exists { app.swipeUp() }

        XCTAssertTrue(openChats.exists, "The machine page doesn't count its open chats")
        // The demo Studio Mac has six chats, and none is done. The row reads as one
        // element, its label then its value.
        let count = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Open chats,")).firstMatch
        XCTAssertTrue(count.exists, "The Open chats row reads no value")
        XCTAssertEqual(count.label, "Open chats, 6")
    }

    func testOneMachineHasNoStrip() {
        let app = AidenStateMatrix.launch(scenario: .one)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "No chat rows in the Inbox")
        XCTAssertFalse(app.buttons["All machines"].exists)
        XCTAssertFalse(row.label.contains("On Studio Mac"), "One machine has nothing to tell apart: \(row.label)")
    }

    func testAChatNamesItsMachineWithSeveralMachines() {
        let app = AidenStateMatrix.launch(scenario: .four)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "No chat rows in the Inbox")
        row.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")

        XCTAssertTrue(
            app.navigationBars.staticTexts["Studio Mac"].waitForExistence(timeout: 5),
            "The toolbar doesn't name the machine"
        )
    }

    func testCaptureMachineChromeScreens() {
        for appearance in AidenStateMatrix.Appearance.allCases {
            for size in AidenStateMatrix.ContentSize.allCases {
                let tag = "\(appearance.rawValue)-\(size.label)"
                let app = AidenStateMatrix.launch(scenario: .offlineMix, appearance: appearance, contentSize: size)
                let item = app.buttons["aiden.machine-status"]
                XCTAssertTrue(item.waitForExistence(timeout: 10))
                XCTAssertTrue(reconnectButton(in: app).waitForExistence(timeout: 15))
                hideOverlaySidebar(in: app)
                Thread.sleep(forTimeInterval: 2)
                AidenStateMatrix.capture("machines-inbox-\(tag)", in: self)
                app.swipeUp()
                Thread.sleep(forTimeInterval: 1)
                AidenStateMatrix.capture("machines-inbox-scrolled-\(tag)", in: self)
                if size == .large {
                    app.swipeDown()
                    let all = app.buttons["All machines"].firstMatch
                    XCTAssertTrue(all.waitForExistence(timeout: 5))
                    all.swipeLeft()
                    Thread.sleep(forTimeInterval: 1)
                    app.buttons["Build Box"].firstMatch.tap()
                    Thread.sleep(forTimeInterval: 1)
                    AidenStateMatrix.capture("machines-inbox-filtered-\(tag)", in: self)
                }
                app.terminate()
            }
            let one = AidenStateMatrix.launch(scenario: .one, appearance: appearance)
            XCTAssertTrue(openInbox(in: one).waitForExistence(timeout: 15))
            AidenStateMatrix.capture("machines-one-\(appearance.rawValue)", in: self)
            openInbox(in: one).tap()
            XCTAssertTrue(one.buttons["Send message"].firstMatch.waitForExistence(timeout: 10))
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("machines-one-chat-\(appearance.rawValue)", in: self)
            one.terminate()

            let four = AidenStateMatrix.launch(scenario: .four, appearance: appearance)
            let row = openInbox(in: four)
            XCTAssertTrue(row.waitForExistence(timeout: 15))
            row.tap()
            XCTAssertTrue(four.buttons["Send message"].firstMatch.waitForExistence(timeout: 10))
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("machines-chat-\(appearance.rawValue)", in: self)
            goBack(in: four)
            search("Fix", in: four)
            Thread.sleep(forTimeInterval: 2)
            AidenStateMatrix.capture("machines-search-\(appearance.rawValue)", in: self)
            four.terminate()
        }
    }

    /// The accessory in both forms and a whole Catch Up, for a person to look at.
    /// A screen that cannot be reached fails the test.
    func testCaptureRunningAccessoryAndCatchUp() {
        for appearance in AidenStateMatrix.Appearance.allCases {
            let tag = appearance.rawValue
            let app = AidenStateMatrix.launch(scenario: .four, appearance: appearance)
            let accessory = AidenStateMatrix.runningAccessory(in: app)
            XCTAssertTrue(accessory.waitForExistence(timeout: 15), "No accessory (\(tag))")
            hideOverlaySidebar(in: app)
            AidenStateMatrix.capture("accessory-expanded-\(tag)", in: self)

            app.swipeUp(velocity: .slow)
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("accessory-compact-\(tag)", in: self)
            app.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 1)

            accessory.tap()
            XCTAssertTrue(app.navigationBars["Running chats"].waitForExistence(timeout: 10), "No sheet (\(tag))")
            AidenStateMatrix.capture("running-sheet-\(tag)", in: self)
            app.buttons["Done"].firstMatch.tap()

            let catchUp = AidenStateMatrix.catchUpRow(in: app)
            XCTAssertTrue(catchUp.waitForExistence(timeout: 10), "No Catch Up row (\(tag))")
            catchUp.tap()
            let next = app.navigationBars.buttons["Next"]
            XCTAssertTrue(next.waitForExistence(timeout: 10), "No Next (\(tag))")
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("catch-up-first-\(tag)", in: self)
            next.tap()
            XCTAssertTrue(next.waitForExistence(timeout: 10), "No Next on the second chat (\(tag))")
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("catch-up-second-\(tag)", in: self)
            for _ in 1...3 {
                XCTAssertTrue(next.waitForExistence(timeout: 10), "No Next (\(tag))")
                next.tap()
            }
            XCTAssertTrue(app.staticTexts["Catch Up finished"].waitForExistence(timeout: 10), "No finished state (\(tag))")
            Thread.sleep(forTimeInterval: 1)
            AidenStateMatrix.capture("catch-up-finished-\(tag)", in: self)
            app.terminate()
        }
    }

    // MARK: Search

    /// Types into the Search tab's field. The demo machines answer from a
    /// responder in the app, so this reaches no real machine.
    private func search(_ text: String, in app: XCUIApplication, submit: Bool = true) {
        AidenStateMatrix.openArea("Search", in: app)
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Search has no field")
        field.tap()
        field.typeText(text)
        // The Search key puts the keyboard away and keeps the query, so the results are in view.
        if submit { field.typeText("\n") }
    }

    private func searchRow(_ prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func testSearchFindsAChatAndABotConversationAndOpensTheChat() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        search("flaky", in: app)

        let chat = searchRow("Fix the flaky upload test, chat on Studio Mac", in: app)
        let bot = searchRow("Scout, Bot conversation on Studio Mac", in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat result")
        XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot result")
        // One element each, naming what it is and which machine has it.
        XCTAssertEqual(bot.value as? String, "Flagged the flaky upload test again this week")

        chat.tap()

        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        app.terminate()
    }

    /// Chats come from the Inbox store, so a machine that isn't selected has its
    /// chats searched too, and says which machine.
    func testSearchFindsChatsOnAMachineThatIsNotSelected() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        search("e", in: app)

        let other = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ", chat on Laptop")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 20), "No chat from Laptop, which isn't selected")
        XCTAssertTrue(searchRow("Fix the flaky upload test, chat on Studio Mac", in: app).exists || app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ", chat on Studio Mac")).firstMatch.exists)
        app.terminate()
    }

    func testSearchSaysItCoversLoadedChatsWhenNothingMatches() {
        let app = AidenStateMatrix.launch(scenario: .one)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        search("zzzz", in: app)

        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "chats Aiden has loaded"))
                .firstMatch.exists,
            "The empty state did not say what search covers"
        )
        app.terminate()
    }

    /// A drag that XCUITest's `swipeUp()` doesn't make: slow, from one spot to another.
    /// A flick from `swipeUp()` left the list where it was, which is why an earlier
    /// attempt saw no scroll and no change of keyboard.
    /// Measured on the window: a narrowed iPad window can sit away from the
    /// screen's left edge while the app's frame still starts at zero.
    private func dragResults(in app: XCUIApplication, from: Double = 0.45, to: Double = 0.1) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    /// The largest text makes the list taller than the space above the keyboard.
    func testDraggingTheResultsPutsTheKeyboardAwayAndKeepsTheQuery() {
        let app = AidenStateMatrix.launch(
            scenario: .four,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        search("flaky", in: app, submit: false)
        XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The keyboard was not up to begin with")

        dragResults(in: app)

        let gone = NSPredicate(format: "exists == false")
        wait(for: [XCTNSPredicateExpectation(predicate: gone, object: app.keyboards.firstMatch)], timeout: 5)
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "flaky", "The query went with the keyboard")
        app.terminate()
    }

    func testTheSearchKeyPutsTheKeyboardAwayAndKeepsTheQuery() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        search("flaky", in: app, submit: false)
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The keyboard was not up to begin with")

        app.searchFields.firstMatch.typeText("\n")

        let gone = NSPredicate(format: "exists == false")
        wait(for: [XCTNSPredicateExpectation(predicate: gone, object: app.keyboards.firstMatch)], timeout: 5)
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "flaky")
        XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).exists, "The results went with the keyboard")
        app.terminate()
    }

    /// A name given on this phone is the name Search shows, for chats and Bots
    /// alike. The demo keeps each launch's machine choices apart.
    func testSearchShowsTheNameThisPhoneGaveTheMachine() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 15), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        app.buttons["aiden.machine-status"].tap()
        let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac,")).firstMatch
        XCTAssertTrue(studio.waitForExistence(timeout: 10), "Machines doesn't list the machine")
        studio.tap()
        let name = app.textFields["aiden.machine-name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10), "The machine editor did not open")
        name.tap()
        name.typeText("Desk\n")
        XCTAssertTrue(app.navigationBars["Desk"].waitForExistence(timeout: 5), "The name didn't save")
        goBack(in: app)
        goBack(in: app)

        search("flaky", in: app)

        XCTAssertTrue(
            searchRow("Fix the flaky upload test, chat on Desk", in: app).waitForExistence(timeout: 10),
            "The chat result doesn't use the new name"
        )
        XCTAssertTrue(
            searchRow("Scout, Bot conversation on Desk", in: app).waitForExistence(timeout: 10),
            "The Bot result doesn't use the new name"
        )
        let oldName = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "on Studio Mac")).firstMatch
        XCTAssertFalse(oldName.exists, "A result still says \(oldName.label)")
        app.terminate()
    }

    /// The composer of whichever chat is open.
    private func composer(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(
            format: "elementType == %d OR elementType == %d",
            XCUIElement.ElementType.textField.rawValue,
            XCUIElement.ElementType.textView.rawValue
        )).firstMatch
    }

    /// Types `draft` into an empty composer, then checks that `putAway` sends the
    /// keyboard away and leaves the words in the composer.
    private func typeThenPutTheKeyboardAway(
        _ draft: String,
        in app: XCUIApplication,
        _ what: String,
        putAway: (XCUIElement) -> Void
    ) {
        let composer = composer(in: app)
        let keyboard = app.keyboards.firstMatch
        composer.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The keyboard did not come up (\(what))")
        // A run that stopped early leaves its draft, which the demo keeps.
        let left = (composer.value as? String)?.count ?? 0
        if left > 0 { composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left)) }
        composer.typeText(draft)
        putAway(AidenStateMatrix.window(of: app))
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "The keyboard stayed up (\(what))")
        let kept = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", draft), object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [kept], timeout: 5), .completed, "The draft was lost (\(what))")
    }

    /// Empties the composer, because the demo keeps drafts between launches.
    private func clearTheDraft(in app: XCUIApplication) {
        let composer = composer(in: app)
        composer.tap()
        let left = (composer.value as? String)?.count ?? 0
        if left > 0 { composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left)) }
        Thread.sleep(forTimeInterval: 1)
    }

    private static func drag(_ window: XCUIElement) {
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).press(
            forDuration: 0.05,
            thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)),
            withVelocity: .slow,
            thenHoldForDuration: 0.1
        )
    }

    private static func tapTheTranscript(_ window: XCUIElement) {
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
    }

    /// In a chat, a drag down the transcript or a tap on it puts the keyboard
    /// away, and the words typed so far stay in the composer. The tap is a UIKit
    /// recognizer (`AidenTranscriptTap`) because on iOS 26 a SwiftUI tap gesture
    /// on the transcript never fires.
    func testTheKeyboardGoesAwayInAChatAndKeepsTheDraft() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: 5), "The chat has no composer")

        typeThenPutTheKeyboardAway("Half a thought", in: app, "drag", putAway: Self.drag)
        AidenStateMatrix.capture("chat-keyboard-away", in: self)
        typeThenPutTheKeyboardAway("Another half", in: app, "tap", putAway: Self.tapTheTranscript)

        clearTheDraft(in: app)
        app.terminate()
    }

    /// A message's time and Copy show only once it is tapped: one message at a
    /// time, and a tap elsewhere in the transcript hides it again.
    func testAMessageShowsItsTimeAndCopyOnlyOnTap() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        chat.tap()
        let question = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
        let reply = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@ OR label BEGINSWITH %@",
            "I found the cause", "Here is a first pass", "The review had three themes"
        )).firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "The chat has no reply")
        let copyQuestion = app.buttons["Copy message"].firstMatch
        let copyReply = app.buttons["Copy response"].firstMatch
        XCTAssertFalse(copyQuestion.exists, "A footer showed before any tap")
        XCTAssertFalse(copyReply.exists, "A footer showed before any tap")
        // A drag on a message scrolls; it never shows the footer.
        // A real drag: `swipeDown()` on a one-line reply (iPad) moves only a few points.
        let middle = reply.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: 120)))
        XCTAssertFalse(copyReply.waitForExistence(timeout: 1), "A drag on the reply showed its footer")

        question.tap()
        XCTAssertTrue(copyQuestion.waitForExistence(timeout: 3), "A tap on the question didn't show its footer")
        XCTAssertFalse(copyReply.exists)

        reply.tap()
        XCTAssertTrue(copyReply.waitForExistence(timeout: 3), "A tap on the reply didn't show its footer")
        XCTAssertTrue(waitForAbsence(copyQuestion), "Two footers showed at once")
        AidenStateMatrix.capture("chat-footer-on-tap", in: self)

        reply.tap()
        XCTAssertTrue(waitForAbsence(copyReply), "A second tap on the reply left its footer")

        reply.tap()
        XCTAssertTrue(copyReply.waitForExistence(timeout: 3))
        tapClearOfTheMessages(in: app, question: question, reply: reply)
        XCTAssertTrue(waitForAbsence(copyReply), "A tap elsewhere in the transcript left the footer")
        XCTAssertFalse(copyQuestion.exists)
        app.terminate()
    }

    /// The footer's own Copy and Read Aloud work and leave it shown. While the
    /// reply reads aloud its footer stays, even through a tap elsewhere.
    func testTheFootersOwnCopyAndReadAloudLeaveItShown() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoReadAloud"])
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        chat.tap()
        let question = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
        let reply = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@ OR label BEGINSWITH %@ OR label BEGINSWITH %@",
            "I found the cause", "Here is a first pass", "The review had three themes"
        )).firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 10), "The chat did not open")
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "The chat has no reply")
        let copyReply = app.buttons["Copy response"].firstMatch
        let readAloud = app.buttons["Read response aloud"].firstMatch
        let stop = app.buttons["Stop reading aloud"].firstMatch

        reply.tap()
        XCTAssertTrue(copyReply.waitForExistence(timeout: 3), "A tap on the reply didn't show its footer")

        copyReply.tap()
        XCTAssertFalse(waitForAbsence(copyReply, timeout: 1.5), "Copy hid the footer")

        XCTAssertTrue(readAloud.waitForExistence(timeout: 3), "The reply's footer has no Read Aloud")
        readAloud.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 5), "Read Aloud didn't start")
        XCTAssertTrue(copyReply.exists, "Read Aloud hid the footer")
        stop.tap()
        XCTAssertTrue(readAloud.waitForExistence(timeout: 5), "Stop didn't stop")
        XCTAssertFalse(waitForAbsence(copyReply, timeout: 1.5), "Stop hid a footer the person showed")

        // Shown for playback alone, it stays through a tap elsewhere, and goes with Stop.
        readAloud.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 5), "Read Aloud didn't start again")
        tapClearOfTheMessages(in: app, question: question, reply: reply)
        XCTAssertFalse(waitForAbsence(stop, timeout: 1.5), "A tap elsewhere hid the footer while reading aloud")
        AidenStateMatrix.capture("chat-footer-reading-aloud", in: self)
        stop.tap()
        XCTAssertTrue(waitForAbsence(copyReply), "The footer stayed after playback it alone was shown for")

        // What Copy put on the pasteboard, pasted into the composer. The test
        // runner can't read the pasteboard itself without a paste prompt.
        let field = composer(in: app)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The keyboard didn't come up")
        field.press(forDuration: 1.2)
        let paste = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ AND (elementType == %d OR elementType == %d)",
            "Paste", XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue
        )).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "The composer offers no Paste")
        paste.tap()
        let pasted = field.value as? String ?? ""
        XCTAssertTrue(pasted.hasPrefix(String(reply.label.prefix(17))), "Copy didn't copy the reply: \(pasted)")
        clearTheDraft(in: app)
        app.terminate()
    }

    /// Taps the transcript somewhere clear of both messages and the reply's footer.
    private func tapClearOfTheMessages(in app: XCUIApplication, question: XCUIElement, reply: XCUIElement) {
        let window = app.windows.firstMatch
        let field = composer(in: app).frame
        let below = reply.frame.maxY + 56
        let y = field.minY - below > 40 ? below : question.frame.minY - 24
        window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: window.frame.midX, dy: y))
            .tap()
    }

    private func waitForAbsence(_ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter.wait(for: [gone], timeout: timeout) == .completed
    }

    /// The same in a Bot's chat.
    func testTheKeyboardGoesAwayInABotChatAndKeepsTheDraft() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots tab")
        hideOverlaySidebar(in: app)
        bot.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10),
            "The Bot did not open"
        )
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: 5), "The Bot chat has no composer")

        typeThenPutTheKeyboardAway("Half a thought", in: app, "drag", putAway: Self.drag)
        typeThenPutTheKeyboardAway("Another half", in: app, "tap", putAway: Self.tapTheTranscript)

        clearTheDraft(in: app)
        app.terminate()
    }

    /// An approval for a chat the person isn't looking at leaves their keyboard
    /// alone. Here the chat sits under its Bot's profile, still listening, while
    /// the person types the Bot's name; the approval arrives under the sheet.
    func testAnApprovalUnderASheetLeavesTheSheetsKeyboardUp() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoLateBotApproval"])
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots tab")
        hideOverlaySidebar(in: app)
        bot.tap()
        let opened = Date()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10),
            "The Bot did not open"
        )
        let card = app.staticTexts["Run this command?"]
        XCTAssertFalse(card.exists, "The approval came too soon to test")

        app.buttons["Scout"].firstMatch.tap()
        let name = app.textFields["Name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10), "The profile did not open")
        name.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The keyboard did not come up")

        // The approval is due 12 s after the chat first listened.
        let due = opened.addingTimeInterval(16).timeIntervalSinceNow
        if due > 0 { Thread.sleep(forTimeInterval: due) }
        XCTAssertTrue(keyboard.exists, "The approval under the sheet put the profile's keyboard away")

        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5), "The approval never came, so the test proved nothing")
        app.terminate()
    }

    /// With the default machine out of reach, the recovery banner sits above the
    /// tabs, not over their bars, and Switch connection opens the Machines page,
    /// where each machine reports its own state. The other machines' chats stay
    /// in the Inbox under it.
    func testTheRecoveryBannerSitsAboveTheTabsAndOpensMachines() {
        let app = AidenStateMatrix.launch(scenario: .four, extraArguments: ["-AidenDemoDefaultOffline"])
        let switchConnection = app.buttons["Switch connection"].firstMatch
        XCTAssertTrue(switchConnection.waitForExistence(timeout: 15), "No recovery banner")
        let inbox = app.navigationBars["Inbox"].firstMatch
        XCTAssertTrue(inbox.waitForExistence(timeout: 10), "The Inbox went with the default machine")
        XCTAssertLessThanOrEqual(switchConnection.frame.maxY, inbox.frame.minY + 1, "The banner covers the Inbox's bar")
        // An Inbox row names its machine as "On Laptop".
        let laptopRow = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "On Laptop")).firstMatch
        XCTAssertTrue(laptopRow.waitForExistence(timeout: 10), "The other machines' chats left the Inbox")

        switchConnection.tap()
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10), "Switch connection didn't open Machines")
        let studio = app.buttons.matching(NSPredicate(format: "label == %@", "Studio Mac, Offline")).firstMatch
        XCTAssertTrue(studio.waitForExistence(timeout: 10), "Machines doesn't say the default is offline")
        let laptop = app.buttons.matching(NSPredicate(format: "label == %@", "Laptop, Online")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "Machines doesn't say the laptop is online")
        app.terminate()
    }

    /// An approval that arrives while someone types puts the keyboard away, so
    /// the card isn't left behind it.
    func testAnApprovalThatArrivesWhileTypingPutsTheKeyboardAway() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoLateBotApproval"])
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots tab")
        hideOverlaySidebar(in: app)
        bot.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10),
            "The Bot did not open"
        )
        let composer = composer(in: app)
        let keyboard = app.keyboards.firstMatch
        let card = app.staticTexts["Run this command?"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "The Bot chat has no composer")
        composer.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The keyboard did not come up")
        XCTAssertFalse(card.exists, "The approval came before the keyboard was up")

        XCTAssertTrue(card.waitForExistence(timeout: 30), "The approval never came")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "The keyboard stayed up over the approval")
        AidenStateMatrix.capture("bot-approval-keyboard-away", in: self)
        app.terminate()
    }

    /// The same in a workspace chat: its run asks for approval while the person
    /// types, and the keyboard goes.
    func testAnApprovalThatArrivesWhileTypingInAChatPutsTheKeyboardAway() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoLateChatApproval"])
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        chat.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
                .waitForExistence(timeout: 10),
            "The chat did not open"
        )
        let composer = composer(in: app)
        let keyboard = app.keyboards.firstMatch
        let card = app.staticTexts["Run this command?"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "The chat has no composer")
        composer.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The keyboard did not come up")
        XCTAssertFalse(card.exists, "The approval came before the keyboard was up")

        XCTAssertTrue(card.waitForExistence(timeout: 30), "The approval never came")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "The keyboard stayed up over the approval")
        AidenStateMatrix.capture("chat-approval-keyboard-away", in: self)
        app.terminate()
    }

    /// Ask About This puts the message in the composer and brings the keyboard
    /// up to finish the question.
    func testAskingAboutAMessageBringsTheKeyboardUp() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        hideOverlaySidebar(in: app)
        chat.tap()
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Where do we stand?")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10), "The chat did not open")
        let keyboard = app.keyboards.firstMatch
        XCTAssertFalse(keyboard.exists, "The keyboard was up before asking")

        message.press(forDuration: 1.2)
        let ask = app.buttons["Ask About This"].firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "The message has no Ask About This")
        ask.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Asking about the message left the keyboard down")
        let draft = composer(in: app).value as? String ?? ""
        XCTAssertTrue(draft.contains("Where do we stand?"), "The message isn't in the composer: \(draft)")
        clearTheDraft(in: app)
        app.terminate()
    }

    /// Without a list the empty states still scroll, so none of their words or
    /// the note about unsearched machines can sit behind the field.
    func testTheEmptyStatesScrollClearOfTheField() {
        for size in [AidenStateMatrix.ContentSize.large, .accessibilityExtraExtraExtraLarge] {
            let app = AidenStateMatrix.launch(scenario: .offlineMix, contentSize: size)
            XCTAssertTrue(openOfflineMixInbox(in: app).waitForExistence(timeout: 10), "\(size)")
            search("zzzz", in: app, submit: false)
            let note = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t search")).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 10), "No note (\(size))")

            for _ in 0..<4 { dragResults(in: app, from: 0.4, to: 0.05) }
            // The field is at the bottom of a compact window and under the title of a
            // regular one. Either way, nothing may sit behind it.
            let field = app.searchFields.firstMatch
            XCTAssertFalse(note.frame.intersects(field.frame), "The note sits behind the field (\(size))")
            // Under a regular width's title the field can't cover the note, so the
            // note must also end where it can be read.
            let window = AidenStateMatrix.window(of: app).frame
            XCTAssertTrue(window.contains(note.frame), "The note isn't wholly in the window (\(size)): \(note.frame)")
            app.terminate()
        }

        let prompt = AidenStateMatrix.launch(
            scenario: .one,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: prompt).waitForExistence(timeout: 10))
        AidenStateMatrix.openArea("Search", in: prompt)
        let description = prompt.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "any of your machines")
        ).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 10), "No prompt")
        for _ in 0..<4 { dragResults(in: prompt, from: 0.4, to: 0.05) }
        XCTAssertFalse(description.frame.intersects(prompt.searchFields.firstMatch.frame), "The prompt is cut off by the field")
        XCTAssertTrue(
            AidenStateMatrix.window(of: prompt).frame.contains(description.frame),
            "The prompt isn't wholly in the window: \(description.frame)"
        )
        prompt.terminate()
    }

    /// Home Mini errors, and Laptop and Build Box are offline. Studio's results stay.
    func testSearchNamesTheMachinesItCouldNotSearch() {
        let app = AidenStateMatrix.launch(scenario: .offlineMix)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        search("flaky", in: app)

        XCTAssertTrue(searchRow("Scout, Bot conversation on Studio Mac", in: app).waitForExistence(timeout: 10))
        let note = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Couldn’t search Bot conversations on")
        ).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10), "No note about the machines that weren't searched")
        for name in ["Laptop", "Home Mini", "Build Box"] {
            XCTAssertTrue(note.label.contains(name), "\(name) is missing from: \(note.label)")
        }
        XCTAssertFalse(note.label.contains("Studio Mac"))
        XCTAssertFalse(app.alerts.firstMatch.exists, "A failing machine raised an app-wide alert")
        app.terminate()
    }

    /// Search with results in light, dark and the largest text, with no
    /// results, and with machines that couldn't be searched. A screen that
    /// cannot be reached fails the test.
    func testCaptureSearchScreens() {
        let variants: [(AidenStateMatrix.Appearance, AidenStateMatrix.ContentSize)] = [
            (.light, .large),
            (.dark, .large),
            (.light, .accessibilityExtraExtraExtraLarge),
        ]
        for (appearance, size) in variants {
            let tag = "\(appearance.rawValue)-\(size.label)"
            let app = AidenStateMatrix.launch(scenario: .four, appearance: appearance, contentSize: size)
            XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox (\(tag))")
            AidenStateMatrix.openArea("Search", in: app)
            XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), tag)
            AidenStateMatrix.capture("search-prompt-\(tag)", in: self)
            search("flaky", in: app)
            XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10), "No chat result (\(tag))")
            AidenStateMatrix.capture("search-results-\(tag)", in: self)
            if size == .accessibilityExtraExtraExtraLarge {
                // Every machine's chats come first, so the Bots are further down.
                for _ in 0..<6 where !searchRow("Scout", in: app).exists { dragResults(in: app, from: 0.6, to: 0.1) }
                AidenStateMatrix.capture("search-results-\(tag)-scrolled", in: self)
            }
            XCTAssertTrue(searchRow("Scout", in: app).waitForExistence(timeout: 10), "No Bot result (\(tag))")
            app.terminate()
        }

        let empty = AidenStateMatrix.launch(scenario: .one)
        XCTAssertTrue(openInbox(in: empty).waitForExistence(timeout: 10))
        search("zzzz", in: empty)
        XCTAssertTrue(empty.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results", in: self)
        empty.terminate()

        let mixed = AidenStateMatrix.launch(scenario: .offlineMix)
        XCTAssertTrue(openInbox(in: mixed).waitForExistence(timeout: 10))
        search("flaky", in: mixed)
        XCTAssertTrue(
            mixed.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t search"))
                .firstMatch.waitForExistence(timeout: 10)
        )
        AidenStateMatrix.capture("search-failing-machines", in: self)
        mixed.terminate()

        let largest = AidenStateMatrix.launch(
            scenario: .offlineMix,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openOfflineMixInbox(in: largest).waitForExistence(timeout: 10))
        search("zzzz", in: largest)
        XCTAssertTrue(largest.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results-failing-machines-accessibilityExtraExtraExtraLarge", in: self)
        for _ in 0..<4 { dragResults(in: largest, from: 0.4, to: 0.05) }
        AidenStateMatrix.capture("search-no-results-failing-machines-accessibilityExtraExtraExtraLarge-scrolled", in: self)
        largest.terminate()

        let noBots = AidenStateMatrix.launch(scenario: .offlineMix)
        XCTAssertTrue(openInbox(in: noBots).waitForExistence(timeout: 10))
        search("zzzz", in: noBots)
        XCTAssertTrue(noBots.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results-failing-machines", in: self)
        noBots.terminate()
    }

    // MARK: Accessibility

    /// The screens the audit must reach, in order, in each appearance. A screen
    /// that can't be reached fails the test instead of passing unaudited.
    private static let auditedScreens = [
        "inbox", "bots", "bot", "chat", "machines", "machine editor", "settings", "search",
    ]

    /// One issue the audit raised, with where it sat on screen.
    private struct AuditFinding {
        let screen: String
        let type: XCUIAccessibilityAuditType
        let summary: String
        let elementType: XCUIElement.ElementType?
        let label: String
        let frame: CGRect?
        /// The system bars, the bottom accessory, the search field and the Bot's
        /// connection hint: everything drawn on glass, as drawn when the audit ran.
        let bars: [CGRect]
        /// On iOS 26, the bands the soft scroll-edge effect fades: below the
        /// navigation bar, and above the tab bar and the accessory. None on iOS 27.
        let fadedEdges: [CGRect]
        /// The machine filter strip, when the screen has one.
        let strip: CGRect?
        /// iPad's floating tab strip at the top of a regular-width window, when it
        /// shows. It is glass too, so it is also one of `bars`.
        let tabStrip: CGRect?

        /// For contrast: the element touches glass, or on iOS 26 a band the
        /// scroll-edge effect fades. The search field and the connection hint draw
        /// no such edge, so nothing beside them counts.
        var touchesGlass: Bool {
            guard let frame else { return false }
            return (bars + fadedEdges).contains { $0.intersects(frame) }
        }

        /// For text size and clipping: at least half the element is inside one bar,
        /// so it is drawn in the bar, not a row scrolled partly under it.
        var liesInABar: Bool {
            guard let frame, frame.width > 0, frame.height > 0 else { return false }
            return bars.contains { bar in
                let inside = bar.intersection(frame)
                return !inside.isNull && inside.width * inside.height >= 0.5 * frame.width * frame.height
            }
        }
    }

    /// On iOS 26 the soft scroll-edge effect fades content for a band beyond each
    /// bar, and the audit reads the faded text as low contrast. The 26.5 runs put
    /// the faded text up to 39 pt from a bar's edge (the Inbox's "42m" and "Aiden
    /// Agent" above the accessory, Settings' "Aiden Agent" header under the
    /// navigation bar and "Memory" header above the accessory). The band is 44 pt,
    /// the accessory's own height, and covers contrast only. It lies only where the
    /// effect is drawn: below the navigation bar, above the tab bar and the
    /// accessory. iOS 27 draws no such band, so there it is 0.
    fileprivate static let scrollEdgeBand: CGFloat = majorSystemVersion < 27 ? 44 : 0

    /// iPad's floating tab strip: the frame around its tabs, when they show. The
    /// audit doesn't see it as a tab bar (`app.tabBars` is empty), so it's found
    /// by its tabs' buttons. Nil in a chat or a Bot, which hide it, and with the
    /// sidebar open in its place.
    private static func tabStrip(in app: XCUIApplication) -> CGRect? {
        let window = AidenStateMatrix.window(of: app).frame
        let tabs = ["Inbox", "Bots", "Workspaces", "Search"]
            .map { app.buttons.matching(NSPredicate(format: "label == %@", $0)).firstMatch }
            .filter { $0.exists && $0.isHittable && $0.frame.maxY < window.minY + 120 }
        guard !tabs.isEmpty else { return nil }
        return tabs.map(\.frame).reduce(CGRect.null) { $0.union($1) }
    }

    private static var majorSystemVersion: Int {
        Int(UIDevice.current.systemVersion.split(separator: ".").first ?? "") ?? 0
    }

    /// One kind of finding the gate lets through, with the reason it isn't a fault
    /// in the app and the most it may excuse on each screen in one appearance. A
    /// screen it doesn't name gets none, so a new finding of a known kind fails.
    /// `ceilingOnIOS26` is for a rule iOS 26 finds more of: the iOS 27 gate keeps
    /// its own lower count, so a new finding there can't hide in 26's excess.
    /// `ceilingInRegularWidth` is the same rule's ceiling in a regular-width
    /// window (iPad's tab strip and split views), which shows more of each screen.
    /// A rule without one excuses nothing there. `ceilingInRegularWidthOnIOS26`
    /// is to it what `ceilingOnIOS26` is to `ceiling`.
    private struct AuditAllowance {
        let reason: String
        let ceiling: [String: Int]
        var ceilingOnIOS26: [String: Int]? = nil
        var ceilingInRegularWidth: [String: Int] = [:]
        var ceilingInRegularWidthOnIOS26: [String: Int]? = nil
        let matches: (AuditFinding) -> Bool

        func ceiling(on screen: String, regularWidth: Bool) -> Int {
            let onIOS26 = AidenShellUITests.majorSystemVersion < 27
            let ceilings = regularWidth
                ? (onIOS26 ? ceilingInRegularWidthOnIOS26 ?? ceilingInRegularWidth : ceilingInRegularWidth)
                : (onIOS26 ? ceilingOnIOS26 ?? ceiling : ceiling)
            return ceilings[screen] ?? 0
        }
    }

    /// What the gate lets through, in both layouts. Anything else fails the test,
    /// and so does a rule that excuses more than its ceiling. `option-a-accessibility.md`
    /// lists these too, with what was checked by hand. The compact ceilings are the
    /// most each rule excused in one appearance on iOS 27 or 26.5 (fix round 1 runs);
    /// where 26.5 found more, it has its own (Task 35 fix round 1 runs,
    /// `task-35-f1-full.log` and `task-35-f1-ios26.log`). The regular-width ceilings
    /// are the most on "Aiden iPad Audit" (iPad Pro 11-inch, iOS 27.0), light or dark,
    /// and where iOS 26.5 found more, on "Aiden iPad Audit 26" (the same iPad).
    private static let auditAllowances: [AuditAllowance] = [
        AuditAllowance(
            // iPad's floating tab strip: the Inbox, Bots and Workspaces titles and
            // the Inbox badge (the audit's own descriptions name three `UILabel`s
            // and a `_UIBarBadgeView`). The system draws the strip at one size, as it
            // does the phone's tab bar, and the app neither draws nor sizes it.
            // XCTest can't resolve the strip's `_UIFloatingTabBarItemCell` to an
            // element, so the findings come with none. With the strip hidden (a
            // chat, a Bot) or the sidebar open in its place there are none.
            reason: "Text size of the floating tab strip's titles and badge, which the audit can't name",
            ceiling: [:],
            ceilingInRegularWidth: [
                "inbox": 4, "bots": 4, "machines": 4, "machine editor": 4, "settings": 4, "search": 4,
            ],
            matches: { $0.type == .dynamicType && $0.frame == nil && $0.tabStrip != nil }
        ),
        AuditAllowance(
            // Bars keep their height at every text size. The status item and the
            // running accessory offer the Large Content Viewer, the search field
            // is the system's, and VoiceOver reads each one whole.
            reason: "Text size or clipping of text drawn in a bar (the status item, the Bot's title, the search field)",
            ceiling: ["inbox": 1, "search": 1, "bot": 1],
            ceilingInRegularWidth: ["inbox": 1, "bot": 1],
            matches: { [.dynamicType, .textClipped].contains($0.type) && $0.liesInABar }
        ),
        AuditAllowance(
            // "Nearly passed" is 3:1 or better, short of 4.5:1. Settings, Machines
            // and the machine editor are Forms drawn in the system's own
            // secondary label colour (headers, footers, a row's second line),
            // which darkens under Increase Contrast. Under 3:1 ("failed") is never
            // let through, and the app's own colours on the other screens must
            // reach 4.5:1.
            reason: "System secondary text in a Form, between 3:1 and 4.5:1",
            // A regular width shows more of each Form, so more of its footers.
            ceiling: ["settings": 6, "machines": 6, "machine editor": 4],
            ceilingInRegularWidth: ["settings": 10, "machines": 6, "machine editor": 2],
            matches: { finding in
                finding.type == .contrast && finding.summary.contains("nearly passed")
                    && finding.elementType == .staticText
                    && ["settings", "machines", "machine editor"].contains(finding.screen)
            }
        ),
        AuditAllowance(
            // A filter chip is its name beside a coloured symbol tile. The audit
            // measures the whole 44 pt button, tile included, and the tile is a
            // graphic, whose bar is 3:1. The name itself is the foreground colour
            // on the raised surface, and the tile colours are checked against the
            // glyph in AidenMachineChromeTests.
            reason: "A machine filter chip, measured with its symbol tile, between 3:1 and 4.5:1",
            ceiling: ["inbox": 1, "bots": 1],
            ceilingInRegularWidth: ["inbox": 1, "bots": 1],
            matches: { finding in
                guard finding.type == .contrast, finding.summary.contains("nearly passed"),
                      let frame = finding.frame, let strip = finding.strip else { return false }
                return strip.intersects(frame)
            }
        ),
        AuditAllowance(
            // Transcript text is selectable, so the audit counts it as a target.
            // Text isn't a control, and a long press selects it at any size.
            reason: "Selectable transcript text read as a tap target",
            // In a regular width the reply's first line is one line, under 44 pt.
            // iOS 26.5 counts the Bot chat's lines and the code block's here too, as
            // it does on the phone ("Aiden iPad Audit 26").
            ceiling: ["chat": 2],
            ceilingOnIOS26: ["chat": 4, "bot": 5],
            ceilingInRegularWidth: ["chat": 3],
            ceilingInRegularWidthOnIOS26: ["chat": 5, "bot": 5],
            matches: { $0.type == .hitRegion && $0.elementType == .staticText }
        ),
        AuditAllowance(
            // The composer's growing text field (a vertical text view, which the
            // audit reports as a text field) sits in a field at least 44 pt high
            // (47 pt here), and a tap anywhere on the field focuses it.
            reason: "The composer's text view inside its 44 pt field",
            ceiling: ["chat": 1, "bot": 1],
            ceilingInRegularWidth: ["chat": 1, "bot": 1],
            matches: { $0.type == .hitRegion && [.textField, .textView].contains($0.elementType) }
        ),
        AuditAllowance(
            // UIKit's own clear button in the search field: 46 by 46 pt, the size
            // the system draws it at. The app doesn't draw or size it.
            reason: "The search field's system clear button",
            ceiling: ["search": 1],
            ceilingInRegularWidth: ["search": 1],
            matches: { $0.type == .hitRegion && $0.elementType == .button && $0.label == "Clear text" }
        ),
        AuditAllowance(
            // The Machines row's label, an icon and a word beside "3 of 4 online".
            // The screenshots at the largest standard size and at AX5
            // (xxxl-*-settings.png, ax5-*-settings.png) show the whole word, the
            // row stacking at the accessibility sizes. Nothing drawn is cut.
            reason: "Settings' Machines row label, whole at XXXL and AX5",
            ceiling: ["settings": 1],
            matches: { $0.type == .textClipped && $0.label == "Machines" }
        ),
        AuditAllowance(
            // The time under a message reads as "Sent November 10, 2026 at 3:14 AM"
            // to VoiceOver. The audit measures that against the "3:14 AM" drawn.
            reason: "A message time, whose spoken label is longer than the time drawn",
            ceiling: ["chat": 2],
            matches: { $0.type == .textClipped && $0.label.hasPrefix("Sent ") }
        ),
        AuditAllowance(
            // Each grows with the text size: the AX5 screenshots in
            // option-a-accessibility.md show them at full size. Larger text pushes
            // them below the bottom of the screen, and the audit reads text it can
            // no longer see as text that stopped growing. All are system text
            // styles: Form headers, footers and rows, and a footnote. In a regular
            // width the machine editor's lower sections and Settings' Read Aloud
            // footer go the same way: none of them is on the screen at AX5 (the
            // regular-width run record in option-a-accessibility.md). The editor's
            // Hide from Inbox footer, the section above them, is reported in some
            // runs and not others on iOS 27, and in every iOS 26.5 run.
            reason: "Text the larger sizes push below the screen (Machines footer and Pair a machine, the machine editor's lower sections, Settings' Read Aloud note, Search's unsearched note)",
            ceiling: ["machines": 2, "search": 1],
            ceilingInRegularWidth: ["machines": 2, "machine editor": 5, "settings": 1, "search": 1],
            matches: { finding in
                finding.type == .dynamicType
                    && AidenShellUITests.textPushedBelowTheScreen
                    .contains { finding.screen == $0.screen && finding.label.hasPrefix($0.label) }
            }
        ),
        AuditAllowance(
            // In a regular width the audit calls these "partially unsupported",
            // though each grows at every one of the nine text sizes from Large to
            // AX5 and stays on the screen (measured, in the regular-width run record
            // in option-a-accessibility.md). The reply is MarkdownUI's, scaled with
            // the body style; the Search rows are system text styles. The compact
            // gate audits the same lines, where they wrap, and finds nothing, so a
            // real limit on their size would fail there.
            reason: "Transcript and Search result text measured growing at every text size",
            ceiling: [:],
            ceilingInRegularWidth: ["bot": 4, "chat": 3, "search": 3],
            matches: { finding in
                finding.type == .dynamicType && finding.elementType == .staticText
                    && AidenShellUITests.textThatGrowsAtEverySize
                    .contains { finding.screen == $0.screen && finding.label.hasPrefix($0.label) }
            }
        ),
        AuditAllowance(
            // Chips in a sideways scroller, one line by design. A name only
            // truncates past 240 pt, and the chip speaks the whole name.
            reason: "A machine chip in the filter strip",
            ceiling: ["inbox": 1, "bots": 1],
            ceilingInRegularWidth: ["inbox": 1, "bots": 1],
            matches: { finding in
                guard finding.type == .textClipped, let frame = finding.frame, let strip = finding.strip else { return false }
                return strip.intersects(frame)
            }
        ),
        AuditAllowance(
            // Liquid Glass draws text in or under a bar with vibrancy over whatever
            // scrolls behind, and the audit can't read that contrast. With Reduce
            // Transparency on the glass turns solid, and the Bot's "Connecting…"
            // hint passes at full strength (task-34 run 7). See `scrollEdgeBand`
            // for the band beside each bar on iOS 26. Last, so a finding the
            // rules above explain is counted there. Settings went from 3 to 4 on
            // iOS 27 in the final review's fix: the Connected machine row (M4) is
            // gone, so one more Read Aloud row sits under the tab bar.
            reason: "Contrast of text in or under glass (navigation bar, tab bar, bottom accessory, search field, Bot connection hint)",
            ceiling: ["inbox": 8, "search": 1, "bots": 1, "bot": 2, "machines": 1, "settings": 4],
            ceilingOnIOS26: ["inbox": 12, "search": 1, "bot": 2, "machine editor": 2, "settings": 6],
            ceilingInRegularWidth: ["inbox": 1, "bot": 2],
            matches: { $0.type == .contrast && $0.touchesGlass }
        ),
    ]

    /// Text that larger sizes push below the bottom of the screen, by screen and
    /// the start of its label.
    private static let textPushedBelowTheScreen: [(screen: String, label: String)] = [
        ("machines", "Hiding a machine keeps it paired"), ("machines", "Pair a machine"),
        ("machine editor", "A hidden machine stays paired"), ("machine editor", "Connection"),
        ("machine editor", "Identity"), ("machine editor", "Reconnect"),
        ("settings", "Read Aloud is unavailable"),
        ("search", "Couldn’t search Bot conversations on "),
    ]

    /// Text the regular-width audit calls partially unsupported that grows at
    /// every size, by screen and the start of its label. The demo's Bot reply, the
    /// first chat's reply, and Search's Bot result.
    private static let textThatGrowsAtEverySize: [(screen: String, label: String)] = [
        ("bot", "Here is a first pass at your week."), ("bot", "Monday: roadmap review"),
        ("bot", "Wednesday: design critique"), ("bot", "Friday: release notes"),
        ("chat", "I found the cause."), ("chat", "Advance the clock in the fixture"), ("chat", "Drop the fixed sleep"),
        ("search", "Scout"), ("search", "Flagged the flaky upload test again this week"), ("search", "Bot conversation · "),
    ]

    /// The system audit finds nothing on any main screen of the tab shell, in
    /// light and in dark, in the compact layout and in a regular width. Every audit
    /// type runs, and an issue fails the test unless `auditAllowances` gives a
    /// reason for it, within that rule's ceiling for the layout. All findings are
    /// listed, not just the first, and the allowed ones are attached to the result.
    func testEveryMainScreenPassesTheAudit() throws {
        var findings: [String] = []
        var allowed: [String] = []
        for appearance in AidenStateMatrix.Appearance.allCases {
            // No content size override, so the audit's Dynamic Type checks can change it.
            let app = AidenStateMatrix.launch(scenario: .four, appearance: appearance, contentSize: .system)
            let regularWidth = AidenStateMatrix.window(of: app).frame.width > AidenStateMatrix.compactWidth
            var audited: [String] = []
            func audit(_ screen: String) throws {
                // An empty or loading screen would pass an audit with nothing to
                // find. The tab bar's own words don't count as content.
                let tabStrip = regularWidth ? Self.tabStrip(in: app) : nil
                let content = app.staticTexts.count + app.cells.count
                    - app.tabBars.descendants(matching: .staticText).count
                XCTAssertGreaterThanOrEqual(content, 4, "Almost nothing on \(screen) (\(appearance)) to audit")
                AidenStateMatrix.capture("audit-\(screen)-\(appearance.rawValue)", in: self)
                let navigationBar = app.navigationBars.firstMatch
                let bottomBars = [app.tabBars.firstMatch, AidenStateMatrix.runningAccessory(in: app)].filter(\.exists)
                let bars = ([navigationBar] + bottomBars + [
                    app.searchFields.firstMatch, app.otherElements["aiden.connection-hint"].firstMatch,
                ]).filter(\.exists).map(\.frame) + [tabStrip].compactMap { $0 }
                let band = Self.scrollEdgeBand
                let fadedEdges = band == 0 ? [] : (navigationBar.exists
                    ? [CGRect(x: navigationBar.frame.minX, y: navigationBar.frame.maxY, width: navigationBar.frame.width, height: band)]
                    : []) + bottomBars.map(\.frame).map { CGRect(x: $0.minX, y: $0.minY - band, width: $0.width, height: band) }
                let stripElement = app.buttons["All machines"].firstMatch
                let strip = stripElement.exists
                    ? CGRect(x: 0, y: stripElement.frame.minY, width: .greatestFiniteMagnitude, height: stripElement.frame.height)
                    : nil
                var excused: [String: Int] = [:]
                // Every type runs, in two passes. The Dynamic Type checks change the
                // text size and the screen lays itself out again, and checks that ran
                // in the same pass then lost their element ("Contrast failed on no
                // element"). Run alone, contrast names every element it fails.
                let sizeTypes: XCUIAccessibilityAuditType = [.dynamicType, .textClipped]
                for types in [XCUIAccessibilityAuditType.all.subtracting(sizeTypes), sizeTypes] {
                    try app.performAccessibilityAudit(for: types) { issue in
                        let element = issue.element
                        let finding = AuditFinding(
                            screen: screen,
                            type: issue.auditType,
                            summary: issue.compactDescription,
                            elementType: element?.elementType,
                            label: element?.label ?? "",
                            frame: element?.frame,
                            bars: bars,
                            fadedEdges: fadedEdges,
                            strip: strip,
                            tabStrip: tabStrip
                        )
                        let place = element.map { "\($0.elementType.rawValue) '\($0.label)' at \($0.frame)" } ?? "no element"
                        let line = "\(screen) (\(appearance)): \(issue.compactDescription) on \(place)"
                        if let allowance = Self.auditAllowances.first(where: { $0.matches(finding) }) {
                            excused[allowance.reason, default: 0] += 1
                            let ceiling = allowance.ceiling(on: screen, regularWidth: regularWidth)
                            if excused[allowance.reason]! <= ceiling {
                                print("AUDIT ALLOWED: \(line) -- \(allowance.reason)")
                                allowed.append("\(line) -- \(allowance.reason)")
                            } else {
                                print("AUDIT ISSUE: \(line), over the ceiling of \(ceiling) for: \(allowance.reason)")
                                findings.append("\(line), over the ceiling of \(ceiling) for: \(allowance.reason)")
                            }
                        } else {
                            print("AUDIT ISSUE: \(line). \(issue.detailedDescription) Bars: \(bars)")
                            findings.append("\(line). \(issue.detailedDescription)")
                        }
                        return true
                    }
                }
                audited.append(screen)
            }

            let row = openInbox(in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 15), "No chat rows in the Inbox")
            XCTAssertTrue(AidenStateMatrix.catchUpRow(in: app).waitForExistence(timeout: 10), "No Catch Up row")
            hideOverlaySidebar(in: app)
            try audit("inbox")

            AidenStateMatrix.openArea("Bots", in: app)
            let bot = botRow(in: app)
            XCTAssertTrue(bot.waitForExistence(timeout: 10), "No Bot on the Bots tab")
            hideOverlaySidebar(in: app)
            try audit("bots")
            bot.tap()
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                    .waitForExistence(timeout: 10),
                "The Bot did not open"
            )
            try audit("bot")
            goBack(in: app)

            AidenStateMatrix.openArea("Inbox", in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            hideOverlaySidebar(in: app)
            row.tap()
            XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
            try audit("chat")
            goBack(in: app)

            let status = app.buttons["aiden.machine-status"]
            XCTAssertTrue(status.waitForExistence(timeout: 10), "The Inbox has no status item")
            hideOverlaySidebar(in: app)
            status.tap()
            XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10), "Machines did not open")
            let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac,")).firstMatch
            XCTAssertTrue(studio.waitForExistence(timeout: 10), "Machines doesn't list the machine")
            try audit("machines")
            studio.tap()
            XCTAssertTrue(app.textFields["aiden.machine-name"].firstMatch.waitForExistence(timeout: 10), "The machine editor did not open")
            try audit("machine editor")
            goBack(in: app)
            goBack(in: app)

            openSettings(in: app)
            XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10), "Settings did not open")
            try audit("settings")

            // Last, because its field stays up: a screen audited after it would
            // need the way back that `testSearchInARegularWidthLeavesAWayBackToTheOtherTabs`
            // covers.
            search("flaky", in: app)
            XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10), "No Search results")
            XCTAssertTrue(searchRow("Scout", in: app).waitForExistence(timeout: 10), "No Bot result")
            try audit("search")

            XCTAssertEqual(audited, Self.auditedScreens, "The audit didn't reach every screen (\(appearance))")
            app.terminate()
        }
        let attachment = XCTAttachment(string: allowed.joined(separator: "\n"))
        attachment.name = "accessibility-audit-allowed"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertTrue(findings.isEmpty, "\(findings.count) audit issues:\n" + findings.joined(separator: "\n"))
    }

    /// The simulator half of the manual accessibility pass, for a person to look
    /// at. It runs only when asked, because it is slow and saves files:
    /// `TEST_RUNNER_AIDEN_CAPTURE_DIR=<folder>` says where the screenshots go,
    /// `TEST_RUNNER_AIDEN_CAPTURE_SET` picks `themes` (every theme, light and
    /// dark) or `screens` (each main screen once), and
    /// `TEST_RUNNER_AIDEN_CAPTURE_TAG` names the run. Text size, Reduce
    /// Transparency and Differentiate Without Colour are set on the simulator
    /// before the run; `TEST_RUNNER_AIDEN_CAPTURE_REDUCE_MOTION=1` turns on the
    /// app's own Reduce Motion. A screen that can't be reached fails the test.
    func testCaptureTheAccessibilityPass() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let folder = environment["AIDEN_CAPTURE_DIR"] else {
            throw XCTSkip("Set TEST_RUNNER_AIDEN_CAPTURE_DIR to capture the accessibility pass")
        }
        let tag = environment["AIDEN_CAPTURE_TAG"] ?? "pass"
        let extra = environment["AIDEN_CAPTURE_REDUCE_MOTION"] == "1" ? ["-aiden.appearance.reduceMotion", "on"] : []
        func save(_ name: String) {
            Thread.sleep(forTimeInterval: 1)
            let url = URL(fileURLWithPath: folder).appending(path: "\(tag)-\(name).png")
            XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: url), "Couldn't save \(name)")
        }

        if environment["AIDEN_CAPTURE_SET"] == "themes" {
            let themes = ["aiden", "slate", "berry", "moss", "paper", "calm", "graphite", "dusk", "midnight", "monochrome"]
            for theme in themes {
                for appearance in AidenStateMatrix.Appearance.allCases {
                    let app = AidenStateMatrix.launch(
                        scenario: .four, appearance: appearance, contentSize: .system,
                        theme: theme, extraArguments: extra
                    )
                    let catchUp = AidenStateMatrix.catchUpRow(in: app)
                    XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row (\(theme))")
                    hideOverlaySidebar(in: app)
                    save("\(theme)-\(appearance.rawValue)-inbox")
                    catchUp.tap()
                    XCTAssertTrue(app.navigationBars.buttons["Next"].waitForExistence(timeout: 10), "No Next (\(theme))")
                    save("\(theme)-\(appearance.rawValue)-catch-up")
                    app.terminate()
                }
            }
            return
        }

        for appearance in AidenStateMatrix.Appearance.allCases {
            let app = AidenStateMatrix.launch(
                scenario: .four, appearance: appearance, contentSize: .system, extraArguments: extra
            )
            let tagged = { (name: String) in save("\(appearance.rawValue)-\(name)") }
            let catchUp = AidenStateMatrix.catchUpRow(in: app)
            XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
            hideOverlaySidebar(in: app)
            tagged("inbox")
            dragResults(in: app, from: 0.7, to: 0.2)
            tagged("inbox-scrolled")
            app.swipeDown()
            catchUp.tap()
            XCTAssertTrue(app.navigationBars.buttons["Next"].waitForExistence(timeout: 10), "No Next")
            tagged("catch-up-approval")
            goBack(in: app)

            search("flaky", in: app)
            XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10))
            tagged("search")

            AidenStateMatrix.openArea("Bots", in: app)
            let bot = botRow(in: app)
            XCTAssertTrue(bot.waitForExistence(timeout: 10))
            tagged("bots")
            bot.tap()
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                    .waitForExistence(timeout: 10)
            )
            tagged("bot")
            goBack(in: app)

            AidenStateMatrix.openArea("Inbox", in: app)
            let status = app.buttons["aiden.machine-status"]
            XCTAssertTrue(status.waitForExistence(timeout: 10))
            status.tap()
            let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac,")).firstMatch
            XCTAssertTrue(studio.waitForExistence(timeout: 10))
            tagged("machines")
            studio.tap()
            XCTAssertTrue(app.textFields["aiden.machine-name"].firstMatch.waitForExistence(timeout: 10))
            tagged("machine-editor")
            goBack(in: app)
            goBack(in: app)

            openSettings(in: app)
            XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
            tagged("settings")
            dragResults(in: app, from: 0.7, to: 0.35)
            tagged("settings-scrolled")
            app.terminate()
        }
    }

    // MARK: Load earlier

    /// Load earlier adds rows above the reader. The message they were reading stays
    /// on screen instead of the screen landing on the top of the new page.
    func testLoadEarlierKeepsTheReaderOnTheMessageTheyWereReading() {
        let app = AidenStateMatrix.launch(scenario: .busy, extraArguments: ["-AidenDemoLongChat", "YES"])
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        openLongChat(in: app)

        let load = loadEarlierButton(in: app)
        scrollToTop(until: load, in: app)
        XCTAssertTrue(load.isHittable, "Never reached Load earlier")
        // The oldest message of the window the chat opened with.
        let reading = app.staticTexts["Turn 45."]
        XCTAssertTrue(reading.waitForExistence(timeout: 5), "The oldest message is not on screen")

        load.tap()

        let stayed = waitUntil(timeout: 8) { reading.exists && reading.isHittable && reading.frame.minY < 300 }
        XCTAssertTrue(stayed, "The reader lost their place: the message they were reading is on screen \(reading.exists && reading.isHittable), at y \(reading.frame.minY)")

        // Jump to latest still takes the reader to the end.
        let jump = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Jump to latest")).firstMatch
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "No Jump to latest after leaving the end")
        jump.tap()
        let newest = app.staticTexts["Turn 69."]
        XCTAssertTrue(waitUntil(timeout: 8) { newest.exists && newest.isHittable && !jump.exists }, "Jump to latest did not reach the end")
        app.terminate()
    }

    private func openLongChat(in app: XCUIApplication) {
        _ = openInbox(in: app)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Rename the onboarding assets")).firstMatch
        for _ in 0..<8 where !row.exists || !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No long chat in the inbox")
        // The list scrolls under the running accessory, and XCUITest calls a row
        // there hittable, but a tap on it opens the accessory's chat instead. The
        // accessory is under the list on a phone and beside the tabs at the top
        // of a regular width.
        let accessory = app.buttons["aiden.running-accessory"].firstMatch
        for _ in 0..<4 where accessory.exists && row.frame.intersects(accessory.frame) {
            dragResults(in: app, from: 0.6, to: 0.4)
        }
        if accessory.exists {
            XCTAssertFalse(row.frame.intersects(accessory.frame), "The long chat's row is still under the running accessory")
        }
        hideOverlaySidebar(in: app)
        row.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        let title = "Rename the onboarding assets"
        XCTAssertTrue(
            waitUntil(timeout: 5) { app.navigationBars[title].exists || app.navigationBars.staticTexts[title].exists },
            "The tap opened another chat, not the long one"
        )
    }

    private func loadEarlierButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Load earlier")).firstMatch
    }

    private func scrollToTop(until element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<40 where !(element.exists && element.isHittable) {
            app.swipeDown(velocity: .fast)
        }
        // Let the scroll come to rest before anything is measured.
        _ = waitUntil(timeout: 2) { false }
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return condition()
    }

    // MARK: Navigation

    /// Opens the Inbox and returns the first chat row.
    private func openInbox(in app: XCUIApplication) -> XCUIElement {
        AidenStateMatrix.openArea("Inbox", in: app)
        return app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")
        ).firstMatch
    }

    private func openInboxMenu(in app: XCUIApplication) {
        let menu = app.navigationBars.buttons["Inbox menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "No Inbox menu")
        menu.tap()
        // An open sidebar sits over the page in a narrow window: the first tap closes it.
        if !app.buttons["Settings"].firstMatch.waitForExistence(timeout: 2) { menu.tap() }
    }

    /// Settings from the Inbox menu. On iOS 26 a tap that lands while the menu
    /// is still opening can do nothing and leave the menu up, so it taps again.
    private func openSettings(in app: XCUIApplication) {
        openInboxMenu(in: app)
        let entry = app.buttons["Settings"].firstMatch
        entry.tap()
        if !app.navigationBars["App settings"].waitForExistence(timeout: 3), entry.exists, entry.isHittable {
            entry.tap()
        }
    }

    /// An open sidebar sits over the page in a narrow window and takes the next
    /// touch. A portrait iPad opens on it.
    private func hideOverlaySidebar(in app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        if toggle.exists, toggle.label == "Hide Sidebar" {
            toggle.tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// Picking the Search tab brings its field up, at any width.
    private func searchField(in app: XCUIApplication) -> XCUIElement {
        let field = app.searchFields.firstMatch
        _ = field.waitForExistence(timeout: 10)
        return field
    }

    private func machinesRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Machines")).firstMatch
    }

    /// Offline rows sit above the chats, and at the largest text they fill the first
    /// screen, so the list hasn't made a chat row yet. The first of them says the
    /// Inbox has settled at every size.
    private func openOfflineMixInbox(in app: XCUIApplication) -> XCUIElement {
        AidenStateMatrix.openArea("Inbox", in: app)
        return reconnectButton(in: app)
    }

    /// Each offline row's button names its machine, as in "Reconnect Laptop".
    private func reconnectButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reconnect ")).firstMatch
    }

    private func botRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
    }

    private func goBack(in app: XCUIApplication) {
        let named = app.navigationBars.buttons["BackButton"].firstMatch
        let back = named.waitForExistence(timeout: 2) ? named : app.navigationBars.buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
    }
}
