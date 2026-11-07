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
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), "Search has no field")
        app.terminate()
    }

    /// The largest text makes the list taller than the screen, so it can scroll.
    func testTheTabBarMinimizesOnScrollDownAndComesBack() {
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
        let badge = AidenStateMatrix.tab("Inbox", in: app).value as? String
        XCTAssertTrue(badge?.contains("3") == true, "The Inbox badge said \(badge ?? "nothing")")
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
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
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
        let installations = offline.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Paired Installations")
        ).firstMatch
        XCTAssertTrue(installations.waitForExistence(timeout: 10))
        installations.tap()
        let laptop = offline.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "No offline machine to select")
        laptop.tap()
        let failure = offline.alerts.buttons["OK"].firstMatch
        if failure.waitForExistence(timeout: 5) { failure.tap() }
        Thread.sleep(forTimeInterval: 1)
        AidenStateMatrix.capture("tabs-offline-settings", in: self)
        goBack(in: offline)
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
