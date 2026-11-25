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
            for title in ["Chats", "Bots", "Workspaces", "Inbox"] {
                AidenStateMatrix.closeDrawer(in: app)
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

    /// Search lives in the drawer, not on a tab.
    func testOnlyTheDrawerHasASearchField() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        for title in ["Inbox", "Chats", "Bots", "Workspaces"] {
            AidenStateMatrix.openArea(title, in: app)
            XCTAssertTrue(AidenStateMatrix.tabRoot(title, in: app).waitForExistence(timeout: 10))
            XCTAssertFalse(app.searchFields.firstMatch.exists, "\(title) has a search field")
            XCTAssertFalse(AidenStateMatrix.drawerSearchField(in: app).exists, "\(title) has a search field")
        }

        openDrawer(in: app)
        XCTAssertTrue(searchField(in: app).exists, "The drawer has no search field")
        app.terminate()
    }

    /// The menu button opens the drawer; its pages open on the tab that's
    /// showing, and Close menu puts it away.
    func testTheMenuButtonOpensTheDrawerAndItsPages() {
        let app = AidenStateMatrix.launch(scenario: .busy, startingTab: nil)
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10), "A first launch opens on Chats")
        openDrawer(in: app)
        XCTAssertTrue(app.staticTexts["Recents"].firstMatch.exists, "No Recents in the drawer")
        // The drawer is a lazy list: on a short display (a closed iPhone Duo's
        // outer one) More is below the fold until the list scrolls to it.
        XCTAssertTrue(drawerRow("Computers", in: app).exists, "No Computers in the drawer")
        XCTAssertTrue(app.staticTexts["More"].firstMatch.exists, "No More in the drawer")
        // The drawer is modal: what's under it is out of reach, to touch and to VoiceOver.
        // The elements can still be listed under the cover; a touch on them lands on the drawer.
        let menuButton = app.buttons["Open menu"].firstMatch
        let inboxTab = AidenStateMatrix.tab("Inbox", in: app)
        XCTAssertFalse(menuButton.exists && menuButton.isHittable, "The bar under the drawer stayed reachable")
        XCTAssertFalse(inboxTab.exists && inboxTab.isHittable, "The tab bar under the drawer stayed reachable")
        AidenStateMatrix.closeDrawer(in: app)
        XCTAssertTrue(app.buttons["Close menu"].waitForNonExistence(timeout: 5), "Close menu left the drawer up")

        openDrawer(in: app)
        drawerRow("Scheduled tasks", in: app).tap()
        XCTAssertTrue(app.navigationBars["Scheduled tasks"].waitForExistence(timeout: 10), "Scheduled tasks did not open")
        XCTAssertTrue(app.buttons["Close menu"].waitForNonExistence(timeout: 5), "Opening a page left the drawer up")
        goBack(in: app)
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10), "Back did not return to Chats")
        app.terminate()
    }

    /// Show all chats puts the chat list on screen. On a phone, opened from
    /// another tab, it lands on Chats' list. Beside the list, a list laid over the
    /// chat (an iPad, or an open iPhone Duo, in portrait) that the pick put
    /// away comes back over it.
    func testShowAllChatsPutsTheChatListOnScreen() {
        let app = AidenStateMatrix.launch(scenario: .busy, startingTab: nil)
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10), "A first launch opens on Chats")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No chat rows on Chats")
        if AidenStateMatrix.window(of: app).frame.width > AidenStateMatrix.compactWidth {
            // Beside the list: a pick puts an overlaid list away, and Show
            // all chats brings it back over the open chat.
            row.tap()
            XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
            waitForTheListToMoveAside(from: row, in: app)
        } else {
            // On a phone a pushed chat hides the tabs and has Back rather
            // than the menu, so the drawer is opened from another tab.
            XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "The Inbox did not open")
            let home = AidenStateMatrix.homeRoot(in: app)
            XCTAssertFalse(home.exists && home.isHittable, "The Inbox left Chats in view")
        }

        openDrawer(in: app)
        drawerRow("Show all chats", in: app).tap()
        XCTAssertTrue(app.buttons["Close menu"].waitForNonExistence(timeout: 5), "Show all chats left the drawer up")
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 5), "Show all chats did not land on Chats")
        let listed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: row)
        XCTAssertEqual(XCTWaiter().wait(for: [listed], timeout: 5), .completed, "Show all chats left the list off screen")
        app.terminate()
    }

    /// A swipe from the leading edge opens the drawer at a tab's root, and on
    /// a pushed page it's the stack's Back instead.
    func testAnEdgeSwipeOpensTheDrawerOnlyAtATabsRoot() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        try XCTSkipIf(
            AidenStateMatrix.window(of: app).frame.width > AidenStateMatrix.compactWidth,
            "Beside the list the edge belongs to the columns"
        )
        // A closed iPhone Duo puts the bars in a side rail, whose columns own
        // the edge, so there the swipe leaves the drawer shut.
        if showsSideRail(in: app) {
            edgeSwipe(in: app)
            XCTAssertFalse(
                app.buttons["Close menu"].waitForExistence(timeout: 3),
                "An edge swipe opened the drawer beside the side rail"
            )
            XCTAssertTrue(openInbox(in: app).exists, "The edge swipe left the Inbox")
            app.terminate()
            return
        }
        edgeSwipe(in: app)
        XCTAssertTrue(app.buttons["Close menu"].waitForExistence(timeout: 3), "The edge swipe did not open the drawer")
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
        // A swipe during the push's animation is dropped, so let it settle.
        XCTAssertTrue(app.buttons["Close menu"].waitForNonExistence(timeout: 5))
        let settled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: app.navigationBars["App settings"].buttons.firstMatch
        )
        XCTAssertEqual(XCTWaiter().wait(for: [settled], timeout: 5), .completed, "The push never settled")

        edgeSwipe(in: app)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "The edge swipe was not Back")
        XCTAssertFalse(app.buttons["Close menu"].exists, "The drawer opened over a pushed page")
        app.terminate()
    }

    /// The drawer's swipe claims only a thin strip at the leading edge and
    /// leaves the rest to what's under it: a row's own leading swipe, started
    /// clear of that strip, offers Mark read, and a tap there opens the chat.
    func testARowsLeadingSwipeAndATapAtItsEdgeStillReachTheRow() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        let unread = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "Unread")).firstMatch
        XCTAssertTrue(unread.waitForExistence(timeout: 10), "No unread row")
        // Clear of the running accessory and the tab bar, so the swipe lands on the row.
        for _ in 0..<4 where unread.frame.maxY > app.frame.height * 0.6 {
            app.swipeUp(velocity: .slow)
        }
        // A row's label is "Title, workspace, machine, …, Unread". Demo machines
        // reuse titles, so the row is pinned by its title, workspace and machine.
        let parts = unread.label.components(separatedBy: ", ")
        let title = parts[0]
        let stem = parts.prefix(3).joined(separator: ", ")
        let thisRowUnread = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", stem, "Unread")
        ).firstMatch
        let sameTitle = { app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).allElementsBoundByIndex.map(\.label) }
        let rollback = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "mark that chat read")).firstMatch
        // Held as a frame, from the row the label names: once read, it no longer matches.
        let row = thisRowUnread.frame
        // Well clear of the drawer's strip at the screen's edge, and inside the row.
        let edge = max(app.frame.minX + 24, row.minX + 8)
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: edge, dy: row.midY))
        // Far enough to reveal the action, short of a full swipe that would act on its own.
        start.press(
            forDuration: 0.05,
            thenDragTo: start.withOffset(CGVector(dx: min(90, row.width * 0.3), dy: 0)),
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        let markRead = app.buttons["Mark read"]
        XCTAssertTrue(markRead.waitForExistence(timeout: 5), "The row's leading swipe offered no Mark read")
        XCTAssertFalse(app.buttons["Close menu"].exists, "The row's swipe opened the drawer")
        XCTAssertTrue(thisRowUnread.exists, "The swipe itself read \(title), a full swipe")
        // A tap while the action is still sliding out can land beside it.
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: markRead)
        XCTAssertEqual(XCTWaiter().wait(for: [settled], timeout: 5), .completed, "Mark read never settled in reach")
        markRead.tap()
        XCTAssertTrue(markRead.waitForNonExistence(timeout: 5), "Mark read left the swipe action open")
        // The demo Mac takes the read, so the dot clears and stays clear.
        XCTAssertTrue(thisRowUnread.waitForNonExistence(timeout: 5), "Mark read left \(stem) unread; rows titled so: \(sameTitle()); rollback banner: \(rollback.exists)")
        XCTAssertFalse(rollback.waitForExistence(timeout: 2), "The demo Mac refused the read of \(title)")
        XCTAssertFalse(thisRowUnread.exists, "\(title) rolled back to unread")

        // Found again by title: a read row can sit elsewhere in the Inbox.
        // Its status and wait words change once read; its title and workspace don't.
        let readRow = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", parts.prefix(2).joined(separator: ", "))
        ).firstMatch
        XCTAssertTrue(readRow.waitForExistence(timeout: 5), "\(title) left the Inbox once read")
        if readRow.frame.maxY > app.frame.height * 0.6 { app.swipeUp(velocity: .slow) }
        origin.withOffset(CGVector(dx: max(app.frame.minX + 24, readRow.frame.minX + 8), dy: readRow.frame.midY)).tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "A tap at the row's edge did not open it")
        XCTAssertTrue(
            app.navigationBars.staticTexts[title].firstMatch.exists || app.staticTexts[title].firstMatch.exists,
            "The tap at the edge opened a chat other than \(title)"
        )
        XCTAssertFalse(app.buttons["Close menu"].exists, "A tap at the edge opened the drawer")
        app.terminate()
    }

    /// A Bot pinned from its row's menu shows in the drawer's Pinned and opens
    /// its chat from there, until it's unpinned from the drawer.
    func testAPinnedBotOpensFromTheDrawerUntilItIsUnpinned() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(AidenStateMatrix.firstScreen(in: app).waitForExistence(timeout: 10))
        openDrawer(in: app)
        XCTAssertFalse(app.staticTexts["Pinned"].exists, "A fresh launch kept an earlier launch's pins")

        AidenStateMatrix.openArea("Bots", in: app)
        let bot = botRow(in: app)
        XCTAssertTrue(bot.waitForExistence(timeout: 10))
        bot.press(forDuration: 1.2)
        let pin = app.buttons["Pin"].firstMatch
        XCTAssertTrue(pin.waitForExistence(timeout: 5), "The Bot's menu has no Pin")
        pin.tap()

        openDrawer(in: app)
        XCTAssertTrue(app.staticTexts["Pinned"].firstMatch.waitForExistence(timeout: 5), "The pin is not in the drawer")
        AidenStateMatrix.capture("drawer-open", in: self)
        let pinned = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Scout")).firstMatch
        XCTAssertTrue(pinned.exists, "No Scout under Pinned")
        pinned.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "first pass at your week")).firstMatch
                .waitForExistence(timeout: 10),
            "The pin did not open the Bot's chat"
        )
        XCTAssertTrue(app.buttons["Close menu"].waitForNonExistence(timeout: 5), "Opening a pin left the drawer up")

        goBack(in: app)
        openDrawer(in: app)
        let pinnedAgain = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Scout")).firstMatch
        XCTAssertTrue(pinnedAgain.waitForExistence(timeout: 5))
        pinnedAgain.press(forDuration: 1.2)
        let unpin = app.buttons["Unpin"].firstMatch
        XCTAssertTrue(unpin.waitForExistence(timeout: 5), "The pin's menu has no Unpin")
        unpin.tap()
        XCTAssertTrue(app.staticTexts["Pinned"].waitForNonExistence(timeout: 5), "Unpin left the pin in the drawer")
        app.terminate()
    }

    /// A row in the drawer's More section, scrolled into view below a long
    /// Recents list.
    private func drawerRow(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let row = app.buttons[title].firstMatch
        for _ in 0..<4 where !(row.exists && row.isHittable) {
            app.collectionViews.containing(.staticText, identifier: "Recents").firstMatch.swipeUp()
        }
        return row
    }

    /// A drag from the leading edge across most of the window, at a person's
    /// pace, so the stack's own Back gesture recognizes it as well as ours.
    private func edgeSwipe(in app: XCUIApplication) {
        let window = AidenStateMatrix.window(of: app)
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 4, dy: 0))
        let distance = window.frame.width * 0.75
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: distance, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0)
    }

    /// The dock stays in reach while a list scrolls under it, and says which
    /// tab is chosen. The largest text makes the list taller than the screen,
    /// so it can scroll.
    func testTheDockStaysInReachWhileTheListScrollsUnderIt() throws {
        let app = AidenStateMatrix.launch(
            scenario: .busy,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        try XCTSkipUnless(AidenStateMatrix.dock(in: app).exists, "The dock is for compact width")
        let inbox = AidenStateMatrix.dockTab("Inbox", in: app)
        let bots = AidenStateMatrix.dockTab("Bots", in: app)
        XCTAssertTrue(inbox.isSelected, "The Inbox's tab isn't the chosen one")
        XCTAssertFalse(bots.isSelected)

        app.swipeUp(velocity: .slow)
        app.swipeUp(velocity: .slow)
        AidenStateMatrix.capture("dock-inbox-scrolled", in: self)
        XCTAssertTrue(bots.isHittable, "The dock left as the list scrolled")
        // At the largest text the dock keeps its size: every tab is still on
        // the screen and in reach.
        XCTAssertTrue(inbox.isHittable, "The largest text pushed the Inbox's tab out of reach")
        let window = AidenStateMatrix.window(of: app).frame
        XCTAssertTrue(window.contains(AidenStateMatrix.dock(in: app).frame), "The dock overflowed the window")
        bots.tap()
        XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 10), "The dock's Bots tab didn't open Bots")
        XCTAssertTrue(bots.isSelected, "Bots' tab isn't the chosen one")
        XCTAssertFalse(inbox.isSelected)
        app.terminate()
    }

    /// The list's last row scrolls up clear of the dock and the running
    /// chats above it, so nothing at the end of a list is left under them.
    func testTheLastRowScrollsClearOfTheDock() throws {
        let app = AidenStateMatrix.launch(
            scenario: .busy,
            contentSize: .accessibilityExtraExtraExtraLarge
        )
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        let dock = AidenStateMatrix.dock(in: app)
        try XCTSkipUnless(dock.exists, "The dock is for compact width")

        func lastRow() -> XCUIElement? {
            app.cells.allElementsBoundByIndex.filter(\.exists).max { $0.frame.maxY < $1.frame.maxY }
        }
        var previous = ""
        for _ in 0..<8 {
            app.swipeUp(velocity: .fast)
            let label = lastRow()?.label ?? ""
            if label == previous { break }
            previous = label
        }
        // Let the scroll come to rest at the end.
        Thread.sleep(forTimeInterval: 1)
        let last = try XCTUnwrap(lastRow(), "No rows in the Inbox")
        AidenStateMatrix.capture("dock-inbox-end", in: self)

        let accessory = AidenStateMatrix.runningAccessory(in: app)
        let barTop = accessory.exists ? min(accessory.frame.minY, dock.frame.minY) : dock.frame.minY
        XCTAssertLessThanOrEqual(last.frame.maxY, barTop + 1, "The last row stayed under the dock")
        XCTAssertTrue(last.isHittable, "The last row is out of reach")
        app.terminate()
    }

    /// The keyboard takes the bottom edge: the dock steps aside while it's up
    /// and comes back when it goes.
    func testTheDockStepsAsideForTheKeyboard() throws {
        let app = AidenStateMatrix.launch(scenario: .full, startingTab: "chats")
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10), "Home didn't open")
        let dock = AidenStateMatrix.dock(in: app)
        try XCTSkipUnless(dock.waitForExistence(timeout: 5), "The dock is for compact width")
        let field = homeField(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 5), "No Home field")

        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The keyboard didn't come up")
        XCTAssertTrue(dock.waitForNonExistence(timeout: 5), "The dock stayed up with the keyboard")
        AidenStateMatrix.capture("dock-keyboard", in: self)

        // Home's menu is still in reach; the drawer puts the keyboard away.
        AidenStateMatrix.homeRoot(in: app).tap()
        XCTAssertTrue(app.buttons["Close menu"].waitForExistence(timeout: 5), "The drawer didn't open")
        AidenStateMatrix.closeDrawer(in: app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "The keyboard stayed up")
        XCTAssertTrue(dock.waitForExistence(timeout: 5), "The dock didn't come back after the keyboard")
        app.terminate()
    }

    /// A closed iPhone Duo's side rail carries the tab's bar items down the
    /// trailing edge, and the dock stays along the bottom, clear of it.
    func testTheClosedDuosSideRailAndTheDockShareTheScreen() throws {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        try XCTSkipUnless(showsSideRail(in: app), "Only a closed iPhone Duo has the side rail")
        let dock = AidenStateMatrix.dock(in: app)
        XCTAssertTrue(dock.exists, "No dock beside the side rail")
        let menu = app.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Open menu", "aiden.home.menu"
        )).firstMatch
        XCTAssertFalse(menu.frame.intersects(dock.frame), "The rail's menu sits under the dock")
        XCTAssertTrue(AidenStateMatrix.dockTab("Inbox", in: app).isHittable, "The dock's tabs are out of reach")

        menu.tap()
        XCTAssertTrue(app.buttons["Close menu"].waitForExistence(timeout: 5), "The rail's menu didn't open the drawer")
        AidenStateMatrix.closeDrawer(in: app)

        AidenStateMatrix.dockTab("Chats", in: app).tap()
        let homeMenu = app.buttons["aiden.home.menu"].firstMatch
        XCTAssertTrue(homeMenu.waitForExistence(timeout: 10), "No Home header beside the side rail")
        AidenStateMatrix.capture("duo-rail-home", in: self)
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
        // Each machine's chats land on their own, so the second running chat
        // can join the count a moment after the accessory first shows.
        let countsBoth = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "1 more"), object: accessory)
        XCTAssertEqual(XCTWaiter.wait(for: [countsBoth], timeout: 10), .completed, "The accessory said \(accessory.label)")
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
        XCTAssertFalse(AidenStateMatrix.bottomTabs(in: app).isHittable, "The tab bar stayed over the chat")

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

    /// Home greets the person by the name set on this phone, shows the Bots as
    /// sprites and at most three "From your Bots" rows above the chats, keeps a
    /// composer at the bottom, and Settings → Appearance holds the ambient
    /// background and the name.
    func testHomeGreetsShowsBotsDigestAndComposer() {
        let app = AidenStateMatrix.launch(scenario: .full, extraArguments: ["-aiden.home.name", "Sam"])
        AidenStateMatrix.openArea("Chats", in: app)

        let greeting = app.staticTexts["home.greeting"].firstMatch
        XCTAssertTrue(greeting.waitForExistence(timeout: 10), "No greeting")
        XCTAssertTrue(greeting.label.hasSuffix(", Sam"), "The greeting said \(greeting.label)")

        let sprites = app.buttons.matching(identifier: "home.bot")
        XCTAssertTrue(sprites.firstMatch.waitForExistence(timeout: 10), "No Bot sprites")
        // The full demo's Courier and Relay are running.
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == 'home.bot' AND label == 'Courier'")).firstMatch.exists)

        let rows = app.buttons.matching(identifier: "home.digest.row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "No digest rows")
        XCTAssertLessThanOrEqual(rows.count, 3)
        XCTAssertTrue(app.buttons["home.digest.seeAll"].firstMatch.exists, "No See all")

        let composer = app.descendants(matching: .any).matching(identifier: "home.composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "No Home composer")
        AidenStateMatrix.capture("home-full", in: self)

        openSettings(in: app)
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
        let appearance = app.buttons["Appearance"].firstMatch
        XCTAssertTrue(appearance.waitForExistence(timeout: 5), "No Appearance row")
        appearance.tap()
        let aurora = app.descendants(matching: .any).matching(identifier: "settings.appearance.aurora").firstMatch
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 10))
        for _ in 0..<6 where !aurora.exists { app.swipeUp() }
        XCTAssertTrue(aurora.waitForExistence(timeout: 5), "No Ambient background control")
        let name = app.textFields["settings.home.name"].firstMatch
        for _ in 0..<6 where !name.exists { app.swipeUp() }
        XCTAssertTrue(name.waitForExistence(timeout: 5), "No Home name field")
        XCTAssertEqual(name.value as? String, "Sam")
        AidenStateMatrix.capture("home-settings-appearance", in: self)
        app.terminate()
    }

    /// Home's ambient background shows the forced phase, and hides when the
    /// person turns it off.
    func testHomeAmbientBackgroundShowsItsPhase() {
        let app = AidenStateMatrix.launch(
            scenario: .full,
            extraArguments: ["-AidenAuroraForcePhase", "done", "-aiden.appearance.aurora", "subtle"]
        )
        AidenStateMatrix.openArea("Chats", in: app)
        let marker = app.descendants(matching: .any)["aurora.phase"].firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10), "No aurora phase marker on Home")
        XCTAssertEqual(marker.value as? String, "done")
        app.terminate()

        let off = AidenStateMatrix.launch(
            scenario: .full,
            extraArguments: ["-AidenAuroraForcePhase", "done", "-aiden.appearance.aurora", "off"]
        )
        AidenStateMatrix.openArea("Chats", in: off)
        let hidden = off.descendants(matching: .any)["aurora.phase"].firstMatch
        XCTAssertTrue(hidden.waitForExistence(timeout: 10), "No aurora phase marker on Home")
        XCTAssertEqual(hidden.value as? String, "hidden")
        off.terminate()
    }

    /// Home's Send starts a chat on the chosen computer and opens it with the
    /// words sent, leaving Home's field empty for the next thought.
    func testHomeSendStartsAChat() {
        let app = AidenStateMatrix.launch(scenario: .full)
        AidenStateMatrix.openArea("Chats", in: app)
        let home = app.descendants(matching: .any).matching(identifier: "home.composer").firstMatch
        XCTAssertTrue(home.waitForExistence(timeout: 10), "No Home composer")
        let field = homeField(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 5), "No Home field")
        field.tap()
        let prompt = "Plan the launch checklist"
        field.typeText(prompt)
        let send = app.buttons["Start chat"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 5), "No Start chat button")
        send.tap()

        // One press opens the new chat with the words in its transcript.
        let sent = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", prompt)).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 15), "The new chat doesn't show the words Home sent")
        AidenStateMatrix.capture("home-send-opened", in: self)
        app.terminate()
    }

    /// Send empties the field at once, even while the computer is still
    /// connecting; if no chat can start, the words come back with the reason.
    func testHomeSendEmptiesTheFieldAndGivesTheWordsBackIfNoChatStarts() {
        let app = AidenStateMatrix.launch(scenario: .full, extraArguments: ["-AidenDemoSlowConnect"])
        AidenStateMatrix.openArea("Chats", in: app)
        let field = homeField(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 10), "No Home field")
        field.tap()
        let prompt = "Draft the release notes"
        field.typeText(prompt)
        app.buttons["Start chat"].firstMatch.tap()

        let status = app.descendants(matching: .any)["home.composer.status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5), "No word that the chat is on its way")
        XCTAssertFalse((field.value as? String ?? "").contains(prompt), "Send left the words in the field")
        AidenStateMatrix.capture("home-send-starting", in: self)

        // The computer never connects, so after the readiness wait no chat starts.
        let notice = app.descendants(matching: .any)["home.composer.notice"].firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 45), "No reason the chat didn't start")
        XCTAssertTrue((field.value as? String ?? "").contains(prompt), "The words didn't come back")
        app.terminate()
    }

    private func homeField(in app: XCUIApplication) -> XCUIElement {
        // The composer is a container, so its field sits inside it.
        app.descendants(matching: .any).matching(identifier: "home.composer").firstMatch
            .descendants(matching: .any).matching(NSPredicate(
                format: "elementType == %d OR elementType == %d",
                XCUIElement.ElementType.textField.rawValue,
                XCUIElement.ElementType.textView.rawValue
            )).firstMatch
    }

    /// Home never shows an empty "Nothing new" for a state it can explain: a
    /// machine with no Bots offers the first one, an offline machine says so,
    /// and a machine still connecting shows skeletons.
    func testHomeExplainsEmptyOfflineAndLoading() {
        let empty = AidenStateMatrix.launch(scenario: .empty)
        AidenStateMatrix.openArea("Chats", in: empty)
        XCTAssertTrue(empty.buttons["home.bots.first"].firstMatch.waitForExistence(timeout: 10), "No Make your first Bot")
        XCTAssertFalse(digest(in: empty).exists, "Home showed a news card with no Bots")
        AidenStateMatrix.capture("home-no-bots", in: self)
        empty.terminate()

        let offline = AidenStateMatrix.launch(scenario: .one, extraArguments: ["-AidenDemoDefaultOffline"])
        AidenStateMatrix.openArea("Chats", in: offline)
        let note = offline.descendants(matching: .any)["home.bots.offline"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15), "No offline explanation")
        XCTAssertFalse(nothingNew(in: offline).exists, "Home said nothing new while offline")
        AidenStateMatrix.capture("home-offline", in: self)
        offline.terminate()

        let loading = AidenStateMatrix.launch(scenario: .full, extraArguments: ["-AidenDemoSlowConnect"])
        AidenStateMatrix.openArea("Chats", in: loading)
        let skeleton = loading.descendants(matching: .any)["home.bots.loading"].firstMatch
        XCTAssertTrue(skeleton.waitForExistence(timeout: 10), "No Bot skeletons while connecting")
        XCTAssertFalse(nothingNew(in: loading).exists, "Home said nothing new while connecting")
        AidenStateMatrix.capture("home-loading", in: self)
        loading.terminate()
    }

    /// Any part of Home's news card, whatever element type it lands as.
    private func digest(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "home.digest")).firstMatch
    }

    private func nothingNew(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["home.digest.empty"].firstMatch
    }

    /// A row's menu opens with what its swipes offer, and a row waiting on a
    /// decision offers neither Done nor Snooze either way.
    func testRowMenusMatchTheirSwipes() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        let prompt = openInbox(in: app)
        XCTAssertTrue(prompt.waitForExistence(timeout: 10), "No chat rows in the inbox")
        let idle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Compare two caching strategies")).firstMatch
        XCTAssertTrue(idle.waitForExistence(timeout: 10), "No Earlier row")
        // Clear of the running accessory and the tab bar, so the swipe lands on the row.
        for _ in 0..<4 where idle.frame.maxY > app.frame.height * 0.6 {
            app.swipeUp(velocity: .slow)
        }

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

        // Scrolling to the Earlier row may have taken the prompt off the top.
        for _ in 0..<4 where !prompt.isHittable { app.swipeDown(velocity: .slow) }
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

        AidenStateMatrix.openArea("Chats", in: app)
        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-chats", in: self)

        openDrawer(in: app)
        XCTAssertTrue(searchField(in: app).exists)
        AidenStateMatrix.capture("tabs-drawer", in: self)
        AidenStateMatrix.closeDrawer(in: app)
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
        openDrawer(in: app)
        XCTAssertTrue(app.buttons["Settings"].firstMatch.waitForExistence(timeout: 5))
        AidenStateMatrix.capture("tabs-drawer-menu", in: self)
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-settings", in: self)
        goBack(in: app)

        openDrawer(in: app)
        drawerRow("Scheduled tasks", in: app).tap()
        XCTAssertTrue(app.navigationBars["Scheduled tasks"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-scheduled", in: self)
        goBack(in: app)

        openDrawer(in: app)
        drawerRow("Usage", in: app).tap()
        XCTAssertTrue(app.navigationBars["Usage"].waitForExistence(timeout: 10))
        AidenStateMatrix.capture("tabs-usage", in: self)
        goBack(in: app)

        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        let newChat = barButton("New chat", in: app)
        XCTAssertTrue(newChat.exists, "No New chat in the Inbox's bar")
        newChat.tap()
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
        XCTAssertFalse(AidenStateMatrix.bottomTabs(in: app).isHittable, "The tab bar stayed over a workspace's chat")
        AidenStateMatrix.capture("tabs-workspace-chat", in: self)

        barButton("More", in: app).tap()
        let fork = app.buttons["Fork"].firstMatch
        XCTAssertTrue(fork.waitForExistence(timeout: 5), "No Fork in the chat's menu")
        fork.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(fork)")).firstMatch
                .waitForExistence(timeout: 10),
            "The fork did not open"
        )
        XCTAssertFalse(AidenStateMatrix.bottomTabs(in: app).isHittable, "The tab bar stayed over a fork")
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
        openDrawer(in: offline)
        offline.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: offline)
        XCTAssertTrue(machines.waitForExistence(timeout: 10))
        machines.tap()
        let laptop = offline.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "No offline machine to select")
        laptop.tap()
        let change = offline.buttons["Make this the default computer"].firstMatch
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
            openDrawer(in: app)
            let item = drawerRow(entry, in: app)
            XCTAssertTrue(item.waitForExistence(timeout: 5), "No \(entry) in the drawer")
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
        XCTAssertFalse(AidenStateMatrix.bottomTabs(in: app).isHittable, "The tab bar stayed over the Bot chat")
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
        XCTAssertFalse(AidenStateMatrix.bottomTabs(in: app).isHittable, "The tab bar stayed over the new chat")
        app.terminate()
    }

    /// Pushed Settings has no sheet of its own for pairing: it asks the shell for one.
    func testPairAMachineOpensFromPushedSettings() {
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        openDrawer(in: app)
        app.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: app)
        XCTAssertTrue(machines.waitForExistence(timeout: 10), "No Machines in Settings")
        machines.tap()
        let pair = app.buttons["Pair a computer"].firstMatch
        XCTAssertTrue(pair.waitForExistence(timeout: 10), "No way to pair another machine")
        pair.tap()
        XCTAssertTrue(app.navigationBars["Add Computer"].waitForExistence(timeout: 10), "Pairing did not open")
        app.terminate()
    }

    /// Zero paired computers launches straight into the shell, asks whether the
    /// desktop app is installed, offers Mac/Linux/Server links, and opens Add Computer.
    /// Set `TEST_RUNNER_AIDEN_CAPTURE_DIR` to capture screenshots of each screen.
    func testUnpairedShellFirstRunWalksDesktopCheckDownloadLinksAndAddComputer() {
        let captureDir = ProcessInfo.processInfo.environment["AIDEN_CAPTURE_DIR"]
        let appearances: [String] = captureDir != nil ? ["light", "dark"] : ["light"]

        func capture(_ name: String) {
            guard let captureDir else { return }
            Thread.sleep(forTimeInterval: 0.6)
            let url = URL(fileURLWithPath: captureDir).appending(path: "\(name).png")
            XCTAssertNoThrow(
                try XCUIScreen.main.screenshot().pngRepresentation.write(to: url),
                "Couldn't save \(name)"
            )
        }

        for appearance in appearances {
            let app = XCUIApplication()
            app.launchArguments = [
                "-aiden.appearance.mode", appearance,
                "-aiden.product-navigation.v1", "reset",
                "-aiden.product-navigation.v2", "reset",
                "-aiden.product-navigation.v3", "reset",
                "-aiden.appearance.aurora", "off",
                "-AppleLanguages", "(en)",
                "-AppleLocale", "en_US",
            ]
            app.launch()

            XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10), "Unpaired launch should enter the shell")
            XCTAssertTrue(app.staticTexts["No computers connected"].waitForExistence(timeout: 5), "Empty state title missing")
            capture("sim_\(appearance)_1_chats")

            let addComputer = app.buttons["Add Computer"].firstMatch
            XCTAssertTrue(addComputer.waitForExistence(timeout: 5), "Add Computer CTA missing")
            addComputer.tap()

            XCTAssertTrue(app.navigationBars["Connect Aiden"].waitForExistence(timeout: 10), "Desktop check step did not open")
            XCTAssertTrue(app.staticTexts["Do you have Aiden on your computer?"].exists)
            capture("sim_\(appearance)_2_desktop_check")

            let notYet = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Not yet")).firstMatch
            XCTAssertTrue(notYet.waitForExistence(timeout: 5), "Not yet option missing")
            notYet.tap()

            XCTAssertTrue(app.navigationBars["Get Aiden"].waitForExistence(timeout: 10), "Download links page did not open")
            XCTAssertTrue(app.buttons["Mac, chatwithaiden.com"].waitForExistence(timeout: 5), "Mac website link missing")
            XCTAssertTrue(app.buttons["Linux, github.com/sambitcreate/aiden-agent"].exists, "Linux GitHub link missing")
            XCTAssertTrue(app.buttons["Server, aiden serve · GitHub"].exists, "Server GitHub link missing")
            capture("sim_\(appearance)_3_get_aiden")

            let haveAiden = app.buttons["I Have Aiden — Continue"].firstMatch
            XCTAssertTrue(haveAiden.waitForExistence(timeout: 5), "Continue CTA missing on Get Aiden")
            haveAiden.tap()

            XCTAssertTrue(app.navigationBars["Add Computer"].waitForExistence(timeout: 10), "Add Computer screen did not open")
            XCTAssertTrue(app.buttons["Scan QR code"].waitForExistence(timeout: 5), "Inline scan card missing")
            XCTAssertTrue(app.textFields["Computer address"].exists, "Address input missing")
            XCTAssertTrue(app.textFields["Setup code or pairing payload"].exists, "Code input missing")
            capture("sim_\(appearance)_4_add_computer")
            app.terminate()
        }
    }

    func testUnpairedChatsOffersPairingAndExplainsInvalidManualInput() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-aiden.product-navigation.v1", "reset",
            "-aiden.product-navigation.v2", "reset",
            "-aiden.product-navigation.v3", "reset",
            "-aiden.appearance.aurora", "off",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()

        XCTAssertTrue(AidenStateMatrix.homeRoot(in: app).waitForExistence(timeout: 10))
        let addComputer = app.buttons["Add Computer"].firstMatch
        XCTAssertTrue(addComputer.waitForExistence(timeout: 10))
        addComputer.tap()

        let installed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Yes")).firstMatch
        XCTAssertTrue(installed.waitForExistence(timeout: 10))
        installed.tap()

        let navigation = app.navigationBars["Add Computer"]
        XCTAssertTrue(navigation.waitForExistence(timeout: 10))
        let address = app.textFields["Computer address"]
        address.tap()
        address.typeText("http://mac.local")
        let code = app.textFields["Setup code or pairing payload"]
        code.tap()
        code.typeText("SHORT")
        code.typeText("\n")
        let addressError = app.staticTexts["Use an HTTPS address. Copy the address shown on your computer."]
        XCTAssertTrue(addressError.waitForExistence(timeout: 5))

        address.tap()
        address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "http://mac.local".count))
        address.typeText("mac.local:49220")
        XCTAssertFalse(addressError.exists)
        navigation.buttons["Add Computer"].tap()
        XCTAssertTrue(app.staticTexts["Enter the 20-character setup code shown on your computer."].waitForExistence(timeout: 5))
        app.terminate()
    }

    /// Every step is a route: the tab's stack holds nothing else.
    func testAMachineOpensFromSettingsAndBackRetracesTheWay() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        openDrawer(in: app)
        app.buttons["Settings"].firstMatch.tap()
        let machines = machinesRow(in: app)
        XCTAssertTrue(machines.waitForExistence(timeout: 10), "No Machines in Settings")
        machines.tap()
        let laptop = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "No machine in the list")
        laptop.tap()
        XCTAssertTrue(app.navigationBars["Laptop"].waitForExistence(timeout: 10), "The machine did not open")

        goBack(in: app)
        XCTAssertTrue(app.navigationBars["Computers"].waitForExistence(timeout: 10), "Back left Machines")
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
        XCTAssertTrue(
            AidenStateMatrix.dock(in: app).waitForExistence(timeout: 10) || app.tabBars.firstMatch.exists,
            "No tab bar at compact width"
        )
        let tabBar = AidenStateMatrix.bottomTabs(in: app)
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
        for title in ["Chats", "Bots", "Workspaces", "Inbox"] {
            XCTAssertTrue(
                AidenStateMatrix.sidebarRow(title, in: app).waitForExistence(timeout: 10),
                "\(title) is not in the sidebar"
            )
        }
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "A tab bar showed beside the sidebar")
        XCTAssertFalse(AidenStateMatrix.dock(in: app).exists, "The dock showed beside the sidebar")
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

    /// In a regular width the drawer lays over the columns, and closing it
    /// leaves the sidebar's way to the other tabs.
    func testTheDrawerInARegularWidthLeavesAWayBackToTheOtherTabs() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Needs a regular-width window")
        let app = AidenStateMatrix.launch(scenario: .busy)
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        try AidenStateMatrix.widenTheWindow(of: app)
        search("flaky", in: app)
        XCTAssertTrue(searchRow("Fix the flaky upload test", in: app).waitForExistence(timeout: 10), "No Search results")
        AidenStateMatrix.closeDrawer(in: app)

        let row = AidenStateMatrix.sidebarRow("Workspaces", in: app)
        if !row.isHittable {
            let toggle = app.buttons.matching(NSPredicate(format: "identifier ==[c] %@", "ToggleSidebar")).firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 5), "Search left no way back to the other tabs")
            toggle.tap()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The sidebar did not come back")
        AidenStateMatrix.capture("search-ipad-way-back", in: self)
        row.tap()
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10), "Workspaces did not open after the drawer")
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

        // At compact width, a closed iPhone Duo's included, Aiden's dock
        // takes the place of the system tab bar.
        XCTAssertTrue(AidenStateMatrix.dock(in: app).waitForExistence(timeout: 10), "No dock at compact width")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "The system tab bar showed with the dock")
        for title in ["Chats", "Inbox", "Bots", "Workspaces"] {
            XCTAssertTrue(AidenStateMatrix.dockTab(title, in: app).isHittable, "No \(title) tab at compact width")
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
        let settled = NSPredicate(format: "label == %@", "2 of 4 computers online")
        expectation(for: settled, evaluatedWith: item)
        waitForExpectations(timeout: 15)
        hideOverlaySidebar(in: app)

        item.tap()

        XCTAssertTrue(app.navigationBars["Computers"].waitForExistence(timeout: 10), "The item didn't open Machines")
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

        app.buttons["All computers"].firstMatch.tap()
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
        let machine = app.buttons["Computer"].firstMatch

        compose.tap()
        XCTAssertTrue(machine.waitForExistence(timeout: 5), "Compose on Workspaces has no machine picker")
        XCTAssertTrue((machine.value as? String)?.hasPrefix("Studio Mac") == true, "\(String(describing: machine.value))")

        // The picker's menu lists each machine as a toggle, and choosing one picks it.
        machine.tap()
        let menuLaptop = app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch
        XCTAssertTrue(menuLaptop.waitForExistence(timeout: 5), "The machine menu has no Laptop item: \(app.debugDescription)")
        menuLaptop.tap()
        let pickedLaptop = expectation(for: NSPredicate(format: "value BEGINSWITH %@", "Laptop"), evaluatedWith: machine)
        wait(for: [pickedLaptop], timeout: 5)
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
        AidenStateMatrix.openArea("Workspaces", in: app)
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        let laptop = app.buttons["Laptop"].firstMatch
        XCTAssertTrue(laptop.waitForExistence(timeout: 10), "The Workspaces strip leaves the hidden machine out")
        laptop.tap()

        let compose = app.navigationBars.buttons["New chat"].firstMatch
        let machine = app.buttons["Computer"].firstMatch
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
        XCTAssertFalse(app.buttons["All computers"].exists)
        XCTAssertFalse(row.label.contains("On Studio Mac"), "One machine has nothing to tell apart: \(row.label)")
    }

    func testAChatNamesItsMachineWithSeveralMachines() {
        let app = AidenStateMatrix.launch(scenario: .four)
        let row = openInbox(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "No chat rows in the Inbox")
        row.tap()
        XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")

        // The title capsule's status line names it.
        let title = app.buttons["chat-title-capsule"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5), "No title capsule")
        XCTAssertTrue(
            (title.value as? String)?.contains("Studio Mac") == true,
            "The toolbar doesn't name the machine: \(String(describing: title.value))"
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
                    let all = app.buttons["All computers"].firstMatch
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

    /// Types into the drawer's search field. The demo machines answer from a
    /// responder in the app, so this reaches no real machine.
    private func search(_ text: String, in app: XCUIApplication, submit: Bool = true) {
        openDrawer(in: app)
        let field = AidenStateMatrix.drawerSearchField(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The drawer has no search field")
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
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists, "The keyboard was not up to begin with")

        // Drag up through the results, which sit above the drawer's bottom
        // field, so the press never lands on the field or the keyboard,
        // whatever height the device or the text size gives them.
        let window = app.windows.firstMatch
        let field = AidenStateMatrix.drawerSearchField(in: app).frame
        XCTAssertLessThan(field.maxY, keyboard.frame.minY, "The keyboard covers the search field")
        XCTAssertGreaterThan(field.minY - window.frame.minY, 160, "No room for results above the field")
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: window.frame.midX, dy: field.minY - 24))
        let end = origin.withOffset(CGVector(dx: window.frame.midX, dy: max(window.frame.minY + 80, field.minY - 224)))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)

        let gone = NSPredicate(format: "exists == false")
        wait(for: [XCTNSPredicateExpectation(predicate: gone, object: app.keyboards.firstMatch)], timeout: 5)
        XCTAssertEqual(AidenStateMatrix.drawerSearchField(in: app).value as? String, "flaky", "The query went with the keyboard")
        app.terminate()
    }

    func testTheSearchKeyPutsTheKeyboardAwayAndKeepsTheQuery() {
        let app = AidenStateMatrix.launch(scenario: .four)
        XCTAssertTrue(openInbox(in: app).waitForExistence(timeout: 10), "No chat rows in the inbox")
        search("flaky", in: app, submit: false)
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The keyboard was not up to begin with")

        AidenStateMatrix.drawerSearchField(in: app).typeText("\n")

        let gone = NSPredicate(format: "exists == false")
        wait(for: [XCTNSPredicateExpectation(predicate: gone, object: app.keyboards.firstMatch)], timeout: 5)
        XCTAssertEqual(AidenStateMatrix.drawerSearchField(in: app).value as? String, "flaky")
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
        XCTAssertTrue(app.navigationBars["Computers"].waitForExistence(timeout: 10), "Switch connection didn't open Machines")
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
            let field = AidenStateMatrix.drawerSearchField(in: app)
            XCTAssertFalse(note.frame.intersects(field.frame), "The note sits behind the field (\(size))")
            // Under a regular width's title the field can't cover the note, so the
            // note must also end where it can be read.
            let window = AidenStateMatrix.window(of: app).frame
            XCTAssertTrue(window.contains(note.frame), "The note isn't wholly in the window (\(size)): \(note.frame)")
            app.terminate()
        }
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
        // The drawer is a modal, which XCUITest lists as an alert, so put it
        // away first; an app-wide alert would still be up.
        AidenStateMatrix.closeDrawer(in: app)
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
            openDrawer(in: app)
            XCTAssertTrue(searchField(in: app).exists, tag)
            AidenStateMatrix.capture("drawer-\(tag)", in: self)
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
        /// The part of the strip on screen, whose edges fade when more chips lie past them.
        let stripVisible: CGRect?
        /// iPad's floating tab strip at the top of a regular-width window, when it
        /// shows. It is glass too, so it is also one of `bars`.
        let tabStrip: CGRect?
        /// The app's window, whose bottom edge cuts a row scrolled partly past it.
        let window: CGRect
        /// The list rows the window's bottom edge runs through.
        let cutRows: [CGRect]

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
        let tabs = ["Chats", "Bots", "Workspaces", "Inbox"]
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
            // element, so the findings come with none. With the sidebar open in
            // its place there are none. A chat or a Bot opens in the list's
            // detail column, which keeps the strip up as the list does, so
            // they count the same four.
            reason: "Text size of the floating tab strip's titles and badge, which the audit can't name",
            ceiling: [:],
            ceilingInRegularWidth: [
                "inbox": 4, "bots": 4, "bot": 4, "chat": 4, "machines": 4, "machine editor": 4, "settings": 4,
                "search": 4,
            ],
            matches: { $0.type == .dynamicType && $0.frame == nil && $0.tabStrip != nil }
        ),
        AuditAllowance(
            // Bars keep their height at every text size. The status item and the
            // running accessory offer the Large Content Viewer, the search field
            // is the system's, and VoiceOver reads each one whole. The running
            // accessory shows on every tab while a chat runs, and its one-line
            // title truncates as the tab bar's do, so each tab screen counts it
            // once (the Inbox twice, with its status item). The drawer hides it,
            // so the search screen's one is the drawer's search field.
            reason: "Text size or clipping of text drawn in a bar (the status item, the Bot's title, the search field)",
            ceiling: [
                "inbox": 2, "bots": 1, "machines": 1, "machine editor": 1, "settings": 1, "search": 1, "bot": 1,
            ],
            ceilingInRegularWidth: ["inbox": 1, "bot": 1],
            // Only those elements, so a new bar label that truncates still fails.
            matches: { finding in
                guard [.dynamicType, .textClipped].contains(finding.type), finding.liesInABar else { return false }
                let isStatusItem = finding.label.range(of: #"^\d+ of \d+$"#, options: .regularExpression) != nil
                let isRunningChat = finding.label == "Plan the Q3 roadmap"
                let isBotTitle = finding.screen == "bot" && finding.label == "Scout"
                let isSearchField = finding.screen == "search"
                    && (finding.elementType.map { [.searchField, .textField].contains($0) } ?? false)
                return isStatusItem || isRunningChat || isBotTitle || isSearchField
            }
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
            // The chip row fades out at an edge with more chips past it
            // (`AidenMachineStrip.Fades`), so a chip that edge cuts is drawn
            // faded on purpose and reads as low contrast. Only a chip running
            // past the strip's visible frame counts: a whole chip must pass, or
            // fall under the symbol-tile rule below.
            reason: "A machine filter chip cut and faded by the strip's edge",
            ceiling: ["inbox": 1, "bots": 1],
            ceilingInRegularWidth: ["inbox": 1, "bots": 1],
            matches: { finding in
                guard finding.type == .contrast, let frame = finding.frame,
                      let visible = finding.stripVisible else { return false }
                return frame.intersects(visible) && !visible.contains(frame)
            }
        ),
        AuditAllowance(
            // With no bar along the bottom (a regular width), the window's edge
            // cuts the last row the list scrolls past it, and the audit reads the
            // cut text as low contrast. Only a row's text the edge runs through
            // counts: text wholly on the screen, and controls and graphics
            // anywhere, must pass. On a phone, Settings is pushed from the drawer
            // with the tab bar hidden, so its last row runs past the edge too.
            reason: "A list row's text the window's bottom edge cuts",
            ceiling: ["settings": 1],
            ceilingInRegularWidth: ["inbox": 1],
            matches: { finding in
                guard finding.type == .contrast, finding.elementType == .staticText,
                      let frame = finding.frame else { return false }
                let edge = finding.window.maxY
                return frame.minY < edge && frame.maxY > edge
                    && finding.cutRows.contains { $0.intersects(frame) }
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
            matches: { $0.type == .textClipped && $0.label == "Computers" }
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
            // The Inbox's Updates heading sits just above the running accessory
            // at the default size, so the Needs you rows push it under the
            // accessory as they grow.
            reason: "Text the larger sizes push below the screen (Computers footer and Pair a computer, the computer editor's lower sections, Settings' Read Aloud note, Search's unsearched note, the Inbox's Updates heading)",
            ceiling: ["machines": 2, "search": 1, "inbox": 1],
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
            ceilingInRegularWidth: ["bot": 5, "chat": 3, "search": 3],
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
        ("machines", "Hiding a computer keeps it paired"), ("machines", "Pair a computer"),
        ("machine editor", "A hidden computer stays paired"), ("machine editor", "Connection"),
        ("machine editor", "Identity"), ("machine editor", "Reconnect"),
        ("settings", "Read Aloud is unavailable"),
        ("search", "Couldn’t search Bot conversations on "),
        ("inbox", "Updates"),
    ]

    /// Text the regular-width audit calls partially unsupported that grows at
    /// every size, by screen and the start of its label. The demo's Bot reply and
    /// your message above it, the first chat's reply, and Search's Bot result.
    private static let textThatGrowsAtEverySize: [(screen: String, label: String)] = [
        ("bot", "Plan my week, please."), ("bot", "Here is a first pass at your week."), ("bot", "Monday: roadmap review"),
        ("bot", "Wednesday: design critique"), ("bot", "Friday: release notes"),
        ("chat", "I found the cause."), ("chat", "Advance the clock in the fixture"), ("chat", "Drop the fixed sleep"),
        ("search", "Scout"), ("search", "Flagged the flaky upload test again this week"), ("search", "Bot conversation · "),
    ]

    /// Every list row's frame in `snapshot`, read in one query.
    private static func cells(in snapshot: XCUIElementSnapshot) -> [CGRect] {
        (snapshot.elementType == .cell ? [snapshot.frame] : [])
            + snapshot.children.flatMap { cells(in: $0) }
    }

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
                    - AidenStateMatrix.bottomTabs(in: app).descendants(matching: .staticText).count
                XCTAssertGreaterThanOrEqual(content, 4, "Almost nothing on \(screen) (\(appearance)) to audit")
                AidenStateMatrix.capture("audit-\(screen)-\(appearance.rawValue)", in: self)
                let navigationBar = app.navigationBars.firstMatch
                let bottomBars = [AidenStateMatrix.bottomTabs(in: app), AidenStateMatrix.runningAccessory(in: app)].filter(\.exists)
                let bars = ([navigationBar] + bottomBars + [
                    app.searchFields.firstMatch, app.otherElements["aiden.connection-hint"].firstMatch,
                ]).filter(\.exists).map(\.frame) + [tabStrip].compactMap { $0 }
                let band = Self.scrollEdgeBand
                let fadedEdges = band == 0 ? [] : (navigationBar.exists
                    ? [CGRect(x: navigationBar.frame.minX, y: navigationBar.frame.maxY, width: navigationBar.frame.width, height: band)]
                    : []) + bottomBars.map(\.frame).map { CGRect(x: $0.minX, y: $0.minY - band, width: $0.width, height: band) }
                let stripElement = app.buttons["All computers"].firstMatch
                let strip = stripElement.exists
                    ? CGRect(x: 0, y: stripElement.frame.minY, width: .greatestFiniteMagnitude, height: stripElement.frame.height)
                    : nil
                let stripContainer = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Filter by computer")).firstMatch
                let stripVisible = stripContainer.exists ? stripContainer.frame : nil
                let window = AidenStateMatrix.window(of: app).frame
                let cutRows = ((try? app.snapshot()).map(Self.cells) ?? [])
                    .filter { $0.minY < window.maxY && $0.maxY > window.maxY }
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
                            stripVisible: stripVisible,
                            tabStrip: tabStrip,
                            window: window,
                            cutRows: cutRows
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
            waitForTheListToMoveAside(from: bot, in: app)
            try audit("bot")
            goBack(in: app)

            AidenStateMatrix.openArea("Inbox", in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            hideOverlaySidebar(in: app)
            row.tap()
            XCTAssertTrue(app.buttons["Send message"].firstMatch.waitForExistence(timeout: 10), "The chat did not open")
            waitForTheListToMoveAside(from: row, in: app)
            try audit("chat")
            goBack(in: app)

            let status = app.buttons["aiden.machine-status"]
            XCTAssertTrue(status.waitForExistence(timeout: 10), "The Inbox has no status item")
            hideOverlaySidebar(in: app)
            status.tap()
            XCTAssertTrue(app.navigationBars["Computers"].waitForExistence(timeout: 10), "Machines did not open")
            let studio = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac,")).firstMatch
            XCTAssertTrue(studio.waitForExistence(timeout: 10), "Machines doesn't list the machine")
            waitForTheListToMoveAside(from: status, in: app)
            try audit("machines")
            studio.tap()
            XCTAssertTrue(app.textFields["aiden.machine-name"].firstMatch.waitForExistence(timeout: 10), "The machine editor did not open")
            try audit("machine editor")
            goBack(in: app)
            goBack(in: app)

            openSettings(in: app)
            XCTAssertTrue(app.navigationBars["App settings"].waitForExistence(timeout: 10), "Settings did not open")
            try audit("settings")
            // Search is in the drawer, which opens from a tab's root.
            goBack(in: app)
            XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "Settings did not go back")

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
        let row = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Fix the flaky upload test")
        ).firstMatch
        // At the largest text on a short display (a closed iPhone Duo) the
        // computers strip, an offline notice and Catch Up fill the first
        // page, so the row is further down. If it isn't there it scrolls
        // down to the row.
        if !row.waitForExistence(timeout: 6) {
            let window = app.windows.firstMatch
            for _ in 0..<5 where !row.waitForExistence(timeout: 1.5) {
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.7))
                    .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.35)))
            }
        }
        return row
    }

    /// A bar's button. On an iPhone it sits in the navigation bar; on a closed
    /// iPhone Duo the system moves the bar's items into the side rail with
    /// the tabs (or, with the rail hidden for a pushed chat, shows them on
    /// their own), outside any navigation bar.
    private func barButton(_ label: String, in app: XCUIApplication) -> XCUIElement {
        let inNavigationBar = app.navigationBars.buttons[label].firstMatch
        return inNavigationBar.exists ? inNavigationBar : app.buttons[label].firstMatch
    }

    /// Whether a tab's bar items sit in a closed iPhone Duo's side rail. At a
    /// tab's root other than Home, the menu button belongs to the navigation
    /// bar on any other device; in the rail it is outside every navigation
    /// bar. Home's own header menu (`aiden.home.menu`) is not a bar item.
    private func showsSideRail(in app: XCUIApplication) -> Bool {
        let menu = app.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Open menu", "aiden.home.menu"
        )).firstMatch
        return menu.waitForExistence(timeout: 5) && !app.navigationBars.buttons["Open menu"].exists
    }

    private func openDrawer(in app: XCUIApplication) {
        XCTAssertTrue(AidenStateMatrix.openDrawer(in: app), "The drawer did not open")
    }

    /// Settings from the drawer's bottom bar. A tap that lands while the
    /// drawer is still sliding in can miss, so it taps again.
    private func openSettings(in app: XCUIApplication) {
        openDrawer(in: app)
        let entry = app.buttons["Settings"].firstMatch
        entry.tap()
        if !app.navigationBars["App settings"].waitForExistence(timeout: 3), entry.exists, entry.isHittable {
            entry.tap()
        }
    }

    /// Picking a row from a list laid over the detail (an iPad in portrait)
    /// slides the list away and lifts its dimming. Until it's gone the detail
    /// is still dimmed, so an audit reads it as low contrast, and a tap on it
    /// only puts the list away. Tiled columns keep the list, so there it waits
    /// out the timeout and goes on.
    private func waitForTheListToMoveAside(from listElement: XCUIElement, in app: XCUIApplication) {
        guard AidenStateMatrix.window(of: app).frame.width > AidenStateMatrix.compactWidth else { return }
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == false"), object: listElement)
        _ = XCTWaiter().wait(for: [gone], timeout: 5)
        // The dimming fades out after the list has left.
        Thread.sleep(forTimeInterval: 0.5)
    }

    /// The tab view's own sidebar (identifier `ToggleSidebar`), which sits over
    /// the page in a narrow window and takes the next touch. A list tab's
    /// split has its own column toggle with no identifier; that list isn't
    /// put away here, since with nothing chosen the list is what shows.
    private func hideOverlaySidebar(in app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        if toggle.exists, toggle.label == "Hide Sidebar" {
            toggle.tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// The open drawer's search field, at any width.
    private func searchField(in app: XCUIApplication) -> XCUIElement {
        let field = AidenStateMatrix.drawerSearchField(in: app)
        _ = field.waitForExistence(timeout: 10)
        return field
    }

    private func machinesRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers")).firstMatch
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
        let named = app.buttons["BackButton"].firstMatch
        let back = named.waitForExistence(timeout: 2) ? named : app.navigationBars.buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
    }
}
