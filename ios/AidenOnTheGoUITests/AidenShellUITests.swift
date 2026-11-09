import XCTest

final class AidenShellUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Both shells open against every demo scenario. This is the CI smoke test.
    func testShellLaunchesForEveryScenario() {
        for shell in AidenStateMatrix.Shell.allCases {
            for scenario in AidenStateMatrix.Scenario.allCases {
                let app = AidenStateMatrix.launch(scenario: scenario, shell: shell)
                XCTAssertTrue(
                    AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10),
                    "No first screen for \(scenario.rawValue) in \(shell)"
                )
                app.terminate()
            }
        }
    }

    /// The flag is off, so nothing but a demo run that asks sees the tabs.
    func testTheMenuShellStaysTheDefault() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.firstMatch.exists, "The tab bar showed with the flag off")
        app.terminate()
    }

    func testAllFourTabsExistInEveryScenario() {
        for scenario in AidenStateMatrix.Scenario.allCases {
            let app = AidenStateMatrix.launch(scenario: scenario, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .oldHost, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))

        AidenStateMatrix.openArea("Bots", in: app)

        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Bots unavailable"].exists)
        app.terminate()
    }

    func testOnlyTheSearchTabHasASearchField() {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
            shell: .tabs,
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
        let busy = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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

        let empty = AidenStateMatrix.launch(scenario: .empty, shell: .tabs)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: empty).waitForExistence(timeout: 10))
        XCTAssertTrue(empty.staticTexts["No chats yet"].waitForExistence(timeout: 10))
        XCTAssertFalse(AidenStateMatrix.runningAccessory(in: empty).exists, "An accessory with nothing running")
        empty.terminate()
    }

    /// More than one running chat is a list to choose from.
    func testAccessoryWithSeveralRunningChatsOpensASheet() {
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
        let accessory = AidenStateMatrix.runningAccessory(in: app)
        XCTAssertTrue(accessory.waitForExistence(timeout: 15), "No accessory while chats run")
        XCTAssertTrue(accessory.label.contains("1 more"), "The accessory said \(accessory.label)")

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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
        XCTAssertTrue(catchUp.label.contains("4 chats"), "The row said \(catchUp.label)")

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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
            shell: .tabs,
            extraArguments: ["-AidenDemoStagedAttachment", "YES"]
        )
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
        let catchUp = AidenStateMatrix.catchUpRow(in: app)
        XCTAssertTrue(catchUp.waitForExistence(timeout: 15), "No Catch Up row")
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
        XCTAssertTrue(AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10))
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
        XCTAssertTrue(AidenStateMatrix.areaSwitcher(in: app).waitForExistence(timeout: 10))
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
    func testCaptureTabShellScreens() {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        let chat = openInbox(in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "No chat rows in the inbox")
        AidenStateMatrix.capture("tabs-inbox", in: self)

        AidenStateMatrix.openArea("Bots", in: app)
        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-bots", in: self)

        AidenStateMatrix.openArea("Workspaces", in: app)
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-workspaces", in: self)

        AidenStateMatrix.openArea("Search", in: app)
        XCTAssertTrue(searchField(in: app).exists)
        AidenStateMatrix.capture("tabs-search", in: self)

        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10))
        chat.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
        AidenStateMatrix.capture("tabs-pushed-chat", in: self)
        goBack(in: app)

        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-landscape", in: self)
        XCUIDevice.shared.orientation = .portrait
        app.terminate()

        let oldHost = AidenStateMatrix.launch(scenario: .oldHost, shell: .tabs)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: oldHost).waitForExistence(timeout: 10))
        AidenStateMatrix.openArea("Bots", in: oldHost)
        XCTAssertTrue(oldHost.staticTexts["Bots unavailable"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-bots-unavailable", in: self)
        oldHost.terminate()
    }

    /// Every page the tabs reach, for the review of what the tab bar and the
    /// toolbars do on each one.
    func testCaptureTabDestinations() throws {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        if UIDevice.current.userInterfaceIdiom == .pad {
            try AidenStateMatrix.widenTheWindow(of: app)
        }
        openInboxMenu(in: app)
        XCTAssertTrue(app.buttons["Settings"].firstMatch.waitForExistence(timeout: 5))
        AidenStateMatrix.capture("tabs-inbox-menu", in: self)
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["App Settings"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-settings", in: self)
        goBack(in: app)

        openInboxMenu(in: app)
        app.buttons["Scheduled tasks"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Scheduled Tasks"].waitForExistence(timeout: 10))
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

        let offline = AidenStateMatrix.launch(scenario: .offlineMix, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        for (entry, title) in [("Settings", "App Settings"), ("Scheduled tasks", "Scheduled Tasks"), ("Usage", "Usage")] {
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
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
        XCTAssertTrue(app.navigationBars["App Settings"].waitForExistence(timeout: 10), "Back left Settings")
        app.terminate()
    }

    func testAPushedRouteHidesTheTabBarAndBackReturnsIt() throws {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat rows in the inbox")
        if UIDevice.current.userInterfaceIdiom == .pad {
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
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat rows in the inbox")
        try AidenStateMatrix.widenTheWindow(of: app)
        hideOverlaySidebar(in: app)
        row.tap()
        let send = app.buttons["Send message"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "The chat did not open")

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
        let app = AidenStateMatrix.launch(scenario: .one, shell: .tabs, extraArguments: ["-AidenDemoSlowConnect", "YES"])
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        let hint = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", "Connecting to Studio Mac")
        ).firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 10), "The Inbox gave no sign it was connecting")
        app.terminate()
    }

    func testAChatWithoutAWorkspaceCanBeDeletedFromTheInbox() {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs, extraArguments: ["-AidenDemoNoWorkspaceChat", "YES"])
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

    /// The tabs become a sidebar when the window has the width for one.
    func testIPadUsesASidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Needs a regular-width window")
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        try AidenStateMatrix.widenTheWindow(of: app)
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

    /// Size classes pick the layout, never the device: a narrow window on an iPad
    /// gets the same bottom tabs as a phone.
    func testCompactWidthUsesTabs() throws {
        let app = AidenStateMatrix.launch(scenario: .busy, shell: .tabs)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        if UIDevice.current.userInterfaceIdiom == .pad {
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

    /// The accessory in both forms and a whole Catch Up, for a person to look at.
    /// A screen that cannot be reached fails the test.
    func testCaptureRunningAccessoryAndCatchUp() {
        for appearance in AidenStateMatrix.Appearance.allCases {
            let tag = appearance.rawValue
            let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs, appearance: appearance)
            let accessory = AidenStateMatrix.runningAccessory(in: app)
            XCTAssertTrue(accessory.waitForExistence(timeout: 15), "No accessory (\(tag))")
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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")

        search("e", in: app)

        let other = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ", chat on Laptop")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 20), "No chat from Laptop, which isn't selected")
        XCTAssertTrue(searchRow("Fix the flaky upload test, chat on Studio Mac", in: app).exists || app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ", chat on Studio Mac")).firstMatch.exists)
        app.terminate()
    }

    func testSearchSaysItCoversLoadedChatsWhenNothingMatches() {
        let app = AidenStateMatrix.launch(scenario: .one, shell: .tabs)
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
    private func dragResults(in app: XCUIApplication, from: Double = 0.45, to: Double = 0.1) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    /// The largest text makes the list taller than the space above the keyboard.
    func testDraggingTheResultsPutsTheKeyboardAwayAndKeepsTheQuery() {
        let app = AidenStateMatrix.launch(
            scenario: .four,
            shell: .tabs,
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
        let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs)
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

    /// Without a list the empty states still scroll, so none of their words or
    /// the note about unsearched machines can sit behind the field.
    func testTheEmptyStatesScrollClearOfTheField() {
        for size in [AidenStateMatrix.ContentSize.large, .accessibilityExtraExtraExtraLarge] {
            let app = AidenStateMatrix.launch(scenario: .offlineMix, shell: .tabs, contentSize: size)
            XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "\(size)")
            search("zzzz", in: app, submit: false)
            let note = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t search")).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 10), "No note (\(size))")

            for _ in 0..<4 { dragResults(in: app, from: 0.4, to: 0.05) }
            let field = app.searchFields.firstMatch
            XCTAssertLessThanOrEqual(note.frame.maxY, field.frame.minY, "The note sits behind the field (\(size))")
            app.terminate()
        }

        let prompt = AidenStateMatrix.launch(
            scenario: .one,
            shell: .tabs,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: prompt).waitForExistence(timeout: 10))
        AidenStateMatrix.openArea("Search", in: prompt)
        let description = prompt.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "any of your machines")
        ).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 10), "No prompt")
        for _ in 0..<4 { dragResults(in: prompt, from: 0.4, to: 0.05) }
        XCTAssertLessThanOrEqual(description.frame.maxY, prompt.searchFields.firstMatch.frame.minY, "The prompt is cut off by the field")
        prompt.terminate()
    }

    /// Home Mini errors, and Laptop and Build Box are offline. Studio's results stay.
    func testSearchNamesTheMachinesItCouldNotSearch() {
        let app = AidenStateMatrix.launch(scenario: .offlineMix, shell: .tabs)
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
            let app = AidenStateMatrix.launch(scenario: .four, shell: .tabs, appearance: appearance, contentSize: size)
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

        let empty = AidenStateMatrix.launch(scenario: .one, shell: .tabs)
        XCTAssertTrue(openInbox(in: empty).waitForExistence(timeout: 10))
        search("zzzz", in: empty)
        XCTAssertTrue(empty.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results", in: self)
        empty.terminate()

        let mixed = AidenStateMatrix.launch(scenario: .offlineMix, shell: .tabs)
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
            shell: .tabs,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: largest).waitForExistence(timeout: 10))
        search("zzzz", in: largest)
        XCTAssertTrue(largest.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results-failing-machines-accessibilityExtraExtraExtraLarge", in: self)
        for _ in 0..<4 { dragResults(in: largest, from: 0.4, to: 0.05) }
        AidenStateMatrix.capture("search-no-results-failing-machines-accessibilityExtraExtraExtraLarge-scrolled", in: self)
        largest.terminate()

        let noBots = AidenStateMatrix.launch(scenario: .offlineMix, shell: .tabs)
        XCTAssertTrue(openInbox(in: noBots).waitForExistence(timeout: 10))
        search("zzzz", in: noBots)
        XCTAssertTrue(noBots.staticTexts["No results"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("search-no-results-failing-machines", in: self)
        noBots.terminate()
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
            hideOverlaySidebar(in: app)
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
        hideOverlaySidebar(in: app)
        row.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
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

    /// Opens the Inbox and returns the first chat row. In the menu shell that is
    /// the Workspaces side with its first workspace open.
    private func openInbox(in app: XCUIApplication) -> XCUIElement {
        if app.launchArguments.contains("-AidenDemoTabShell") {
            AidenStateMatrix.openArea("Inbox", in: app)
        } else {
            AidenStateMatrix.openArea("Workspaces", in: app)
            let expand = app.buttons["Expand Aiden Agent"].firstMatch
            if expand.waitForExistence(timeout: 5) { expand.tap() }
        }
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

    /// An open sidebar sits over the page in a narrow window and takes the next touch.
    private func hideOverlaySidebar(in app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        if toggle.exists, toggle.label == "Hide Sidebar" {
            toggle.tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// An iPad keeps the field behind a toolbar button until it's asked for.
    private func searchField(in app: XCUIApplication) -> XCUIElement {
        let field = app.searchFields.firstMatch
        if !field.waitForExistence(timeout: 5) {
            app.navigationBars["Search"].buttons["Search"].firstMatch.tap()
            _ = field.waitForExistence(timeout: 5)
        }
        return field
    }

    private func machinesRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Machines")).firstMatch
    }

    private func botRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Scout")).firstMatch
    }

    private func goBack(in app: XCUIApplication) {
        let named = app.navigationBars.buttons["BackButton"].firstMatch
        let back = named.waitForExistence(timeout: 2) ? named : app.navigationBars.buttons.firstMatch
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
