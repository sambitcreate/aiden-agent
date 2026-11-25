#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// The shell's information architecture: the Chats tab, the drawer's pins and
/// recents, and the move from the v2 bar (Search) to v3 (Chats).
@MainActor
final class AidenShellIATests: XCTestCase {
    private let studio = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func id(_ objectId: String, on instanceId: String = "studio", device: String = "demo-device") -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: device, objectId: objectId)
    }

    // MARK: Navigation store v2 -> v3

    /// A v2 snapshot written by the Search build: Search was its own tab.
    private func v2Snapshot(tab: String) throws -> Data {
        let route = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AidenAppRoute.bot(id("b1"))))
        let chat = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AidenAppRoute.chat(id("c1"))))
        return try JSONSerialization.data(withJSONObject: [
            "tab": tab,
            "inboxPath": [chat],
            "botsPath": [route],
            "workspacesPath": [],
            "savedPaths": [:],
        ])
    }

    func testAV2SnapshotOnSearchOpensOnChatsWithItsPathsKept() throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        defaults.set(try v2Snapshot(tab: "search"), forKey: AidenAppNavigationStore.previousSnapshotKey)
        let store = AidenAppNavigationStore(defaults: defaults)

        let loaded = store.load()

        XCTAssertEqual(loaded.tab, .chats)
        XCTAssertEqual(loaded.chatsPath, [])
        XCTAssertEqual(loaded.inboxPath, [.chat(id("c1"))])
        XCTAssertEqual(loaded.botsPath, [.bot(id("b1"))])
        XCTAssertNotNil(defaults.object(forKey: AidenAppNavigationStore.previousSnapshotKey), "A read removed v2")
        XCTAssertNil(defaults.object(forKey: AidenAppNavigationStore.snapshotKey), "A read wrote v3")
    }

    func testAV2SnapshotOnAnotherTabKeepsThatTab() throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        defaults.set(try v2Snapshot(tab: "bots"), forKey: AidenAppNavigationStore.previousSnapshotKey)

        XCTAssertEqual(AidenAppNavigationStore(defaults: defaults).load().tab, .bots)
    }

    func testTheFirstV3WriteRemovesV2AndV3WinsAfterwards() throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        defaults.set(try v2Snapshot(tab: "search"), forKey: AidenAppNavigationStore.previousSnapshotKey)
        let store = AidenAppNavigationStore(defaults: defaults)
        let navigation = AidenAppNavigation(restoring: store.load(), installations: [studio])
        navigation.open(.chat(id("c2")))

        store.save(navigation.snapshot)

        XCTAssertNil(defaults.object(forKey: AidenAppNavigationStore.previousSnapshotKey))
        let reloaded = store.load()
        XCTAssertEqual(reloaded.tab, .chats)
        XCTAssertEqual(reloaded.chatsPath, [.chat(id("c2"))])
        XCTAssertEqual(reloaded.inboxPath, [.chat(id("c1"))])
    }

    // MARK: Opening

    /// A Home Screen or widget action that starts a voice chat lands on Chats.
    func testAHomeActionChatLandsOnChats() {
        let navigation = AidenAppNavigation()
        navigation.tab = .inbox

        navigation.open(.chat(id("c1")), startsVoice: true)

        XCTAssertEqual(navigation.tab, .chats)
        XCTAssertEqual(navigation.chatsPath, [.chat(id("c1"))])
        XCTAssertEqual(navigation.inboxPath, [])
        XCTAssertEqual(navigation.chatStartingVoice, id("c1"))
    }

    /// Settings from the drawer goes on top of the tab that's showing, so Back
    /// returns there rather than jumping tabs.
    func testSettingsOpensOverTheTabThatIsShowing() {
        let navigation = AidenAppNavigation()
        navigation.open(.bot(id("b1")))

        navigation.open(.settings)

        XCTAssertEqual(navigation.tab, .bots)
        XCTAssertEqual(navigation.botsPath, [.bot(id("b1")), .settings])
        XCTAssertEqual(navigation.chatsPath, [])
        XCTAssertEqual(navigation.inboxPath, [])
    }

    /// Beside the list, a chat picked from the Chats list replaces the one in
    /// the detail instead of stacking, and leaves any other tab holding it.
    func testAChatPickedBesideTheChatsListBecomesItsSelection() {
        let navigation = AidenAppNavigation()
        navigation.besideList = true
        navigation.openInboxRow(.chat(id("c1")))
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1"))])

        navigation.pick(.chat(id("c1")), fromListOf: .chats)
        navigation.pick(.chat(id("c2")), fromListOf: .chats)

        XCTAssertEqual(navigation.tab, .chats)
        XCTAssertEqual(navigation.chatsPath, [.chat(id("c2"))])
        XCTAssertEqual(navigation.inboxPath, [])
    }

    /// A new chat opens on Chats from every tab but Workspaces, where it
    /// stays so Back returns to the workspace, and it puts the drawer away.
    func testANewChatOpensOnChatsExceptFromWorkspaces() {
        for (from, lands) in [(AidenAppTab.inbox, AidenAppTab.chats), (.bots, .chats), (.chats, .chats), (.workspaces, .workspaces)] {
            let navigation = AidenAppNavigation()
            navigation.tab = from
            navigation.drawerIsOpen = true

            navigation.openNewChat(id("new"))

            XCTAssertEqual(navigation.tab, lands, "From \(from)")
            XCTAssertEqual(navigation.path(of: lands), [.chat(id("new"))], "From \(from)")
            XCTAssertFalse(navigation.drawerIsOpen, "From \(from) the drawer stayed open")
        }
    }

    /// Paths changing under the drawer (a machine forgotten elsewhere, the
    /// selected machine changing) don't put it away.
    func testBackgroundPathChangesLeaveTheDrawerOpen() {
        let navigation = AidenAppNavigation()
        navigation.open(.settings)
        navigation.open(.usage)
        navigation.drawerIsOpen = true

        navigation.leaveSelectedMachineRoutes()
        navigation.dropRoutes(outside: [])
        navigation.setPath([.settings], of: navigation.tab)

        XCTAssertTrue(navigation.drawerIsOpen, "A background path change closed the drawer")
    }

    /// A drawer page already open on another tab moves to the tab that's
    /// showing, rather than taking the person to that tab.
    func testADrawerPageOpenOnAnotherTabMovesToTheShowingOne() {
        let navigation = AidenAppNavigation()
        navigation.open(.bot(id("b1")))
        navigation.open(.settings)
        navigation.tab = .chats

        navigation.open(.settings)

        XCTAssertEqual(navigation.tab, .chats)
        XCTAssertEqual(navigation.chatsPath, [.settings])
        XCTAssertEqual(navigation.botsPath, [.bot(id("b1"))])
    }

    /// Show all chats keeps the chat selected beside the list, and on a stack
    /// goes to the list.
    func testShowAllChatsKeepsTheSelectionBesideTheList() {
        let split = AidenAppNavigation()
        split.besideList = true
        split.pick(.chat(id("c1")), fromListOf: .chats)
        split.tab = .bots

        split.showAllChats()

        XCTAssertEqual(split.tab, .chats)
        XCTAssertEqual(split.chatsPath, [.chat(id("c1"))])

        let stack = AidenAppNavigation()
        stack.open(.chat(id("c1")))
        stack.tab = .bots
        stack.showAllChats()
        XCTAssertEqual(stack.tab, .chats)
        XCTAssertEqual(stack.chatsPath, [])
    }

    /// Chats, the Inbox and the open drawer each show a list of chats, which
    /// the inbox store keeps fresh; Bots and Workspaces alone don't, and on a
    /// stack neither does a chat pushed over the list.
    func testAChatListIsOnScreenOnChatsTheInboxOrInTheDrawer() {
        let expected: [AidenAppTab: Bool] = [.chats: true, .inbox: true, .bots: false, .workspaces: false]
        let navigation = AidenAppNavigation()
        for (tab, showsList) in expected {
            navigation.tab = tab
            navigation.drawerIsOpen = false
            XCTAssertEqual(navigation.showsChatList, showsList, "\(tab)")
            navigation.drawerIsOpen = true
            XCTAssertTrue(navigation.showsChatList, "\(tab) with the drawer open")
        }

        // iPhone: a chat pushed over Chats covers the list.
        let stack = AidenAppNavigation()
        stack.open(.chat(id("c1")))
        XCTAssertEqual(stack.tab, .chats)
        XCTAssertFalse(stack.showsChatList, "A chat over the Chats list kept the quick pace")
        stack.drawerIsOpen = true
        XCTAssertTrue(stack.showsChatList)

        // Beside the list, the chat sits next to it.
        let split = AidenAppNavigation()
        split.besideList = true
        split.pick(.chat(id("c1")), fromListOf: .chats)
        XCTAssertTrue(split.showsChatList)
    }

    /// Each device's posture: an iPhone keeps the stack (and the dock) both
    /// upright and sideways, so a Plus or Pro Max doesn't swap layouts as it
    /// turns; an iPad and an open iPhone Duo set the list beside its detail.
    func testOnlyARegularWidthThatIsNotAPhoneOnItsSideSetsTheListBesideItsDetail() {
        XCTAssertFalse(AidenTabChrome.besideList(horizontal: .compact, vertical: .regular),
                       "An upright iPhone or the closed Duo")
        XCTAssertFalse(AidenTabChrome.besideList(horizontal: .regular, vertical: .compact),
                       "A Plus or Pro Max on its side swapped to the split")
        XCTAssertFalse(AidenTabChrome.besideList(horizontal: .compact, vertical: .compact),
                       "A smaller iPhone on its side")
        XCTAssertTrue(AidenTabChrome.besideList(horizontal: .regular, vertical: .regular),
                      "An iPad or the open Duo")
    }

    /// The dock steps aside only for a keyboard docked along the bottom; a
    /// hardware keyboard's shortcut bar, a floating keyboard or one that has
    /// slid off the screen leave the tabs where they are.
    func testOnlyAKeyboardAlongTheBottomEdgeTakesTheDocksPlace() {
        let screen = CGRect(x: 0, y: 0, width: 402, height: 874)

        XCTAssertTrue(AidenTabChrome.keyboardTakesBottomEdge(
            keyboard: CGRect(x: 0, y: 874 - 336, width: 402, height: 336), screen: screen))
        XCTAssertFalse(AidenTabChrome.keyboardTakesBottomEdge(
            keyboard: CGRect(x: 0, y: 874 - 55, width: 402, height: 55), screen: screen),
            "A hardware keyboard's shortcut bar hid the dock")
        XCTAssertFalse(AidenTabChrome.keyboardTakesBottomEdge(
            keyboard: CGRect(x: 50, y: 300, width: 300, height: 250), screen: screen),
            "A floating keyboard hid the dock")
        XCTAssertFalse(AidenTabChrome.keyboardTakesBottomEdge(
            keyboard: CGRect(x: 0, y: 874, width: 402, height: 336), screen: screen),
            "A keyboard below the screen hid the dock")
    }

    /// Like the system tab bar: another tab keeps where each tab was, and the
    /// tab already open goes back to its root.
    func testTheDockKeepsEachTabsPlaceAndAReselectReturnsToTheRoot() {
        let navigation = AidenAppNavigation()
        navigation.open(.chat(id("c1")))
        XCTAssertEqual(navigation.tab, .chats)

        navigation.selectFromDock(.inbox)
        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.chatsPath, [.chat(id("c1"))], "Leaving Chats dropped its open chat")

        navigation.selectFromDock(.chats)
        XCTAssertEqual(navigation.chatsPath, [.chat(id("c1"))], "Coming back to Chats lost its open chat")
        XCTAssertTrue(navigation.showsConversation)

        navigation.selectFromDock(.chats)
        XCTAssertEqual(navigation.tab, .chats)
        XCTAssertEqual(navigation.chatsPath, [], "Choosing the open tab again didn't return to its root")
        XCTAssertFalse(navigation.showsConversation)
    }

    /// The Inbox's dot says nothing to VoiceOver, so the tab tells how many
    /// chats wait on the person; no other tab, and no count of none, adds a value.
    func testTheInboxTabTellsVoiceOverHowManyChatsNeedThePerson() {
        XCTAssertNil(AidenAppTab.inbox.accessibilityCount(needsYou: 0))
        XCTAssertEqual(AidenAppTab.inbox.accessibilityCount(needsYou: 1), "1 chat needs you")
        XCTAssertEqual(AidenAppTab.inbox.accessibilityCount(needsYou: 4), "4 chats need you")
        for tab in AidenAppTab.allCases where tab != .inbox {
            XCTAssertNil(tab.accessibilityCount(needsYou: 4), "\(tab) read the Inbox's count")
        }

        // In the dock the count rides in the tab's name, since a tab's value
        // is whether it's chosen.
        let dock = AidenDock(selection: .chats, needsYouCount: 3, onSelect: { _ in })
        XCTAssertEqual(dock.accessibilityName(of: .inbox), "Inbox, 3 chats need you")
        XCTAssertEqual(dock.accessibilityName(of: .bots), "Bots")
        XCTAssertEqual(AidenDock(selection: .inbox, needsYouCount: 0, onSelect: { _ in }).accessibilityName(of: .inbox), "Inbox")
    }

    /// A notification's chat opens beside Chats' list. With a page pushed over
    /// it, the Inbox still counts it as open, so its replies aren't news.
    func testAChatSelectedBesideTheChatsListCountsAsOpenUnderAPage() {
        let navigation = AidenAppNavigation()
        navigation.besideList = true
        navigation.open(.chat(id("c1")))
        navigation.push(.machines, over: .chat(id("c1")))
        XCTAssertEqual(navigation.tab, .chats)
        XCTAssertEqual(navigation.chatsPath.last, .machines)

        XCTAssertEqual(navigation.inboxOpenChat, id("c1"))

        navigation.tab = .bots
        XCTAssertNil(navigation.inboxOpenChat)
    }

    // MARK: Chats list

    private func chat(_ chatID: String, _ title: String, minutesAgo: Double, workspace: String = "default") -> AidenChatSummary {
        let updated = now.addingTimeInterval(-minutesAgo * 60)
        return AidenChatSummary(
            id: chatID, workspaceId: workspace, title: title, titlePending: false,
            createdAt: updated.addingTimeInterval(-60), updatedAt: updated,
            revision: "rev-\(chatID)", activity: .idle
        )
    }

    private func snapshot(
        _ instanceId: String,
        device: String = "demo-device",
        chats: [AidenChatSummary] = [],
        bots: [AidenBotSummary] = [],
        online: Bool = true,
        blocked: Bool = false
    ) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: instanceId, deviceId: device, chats: chats,
            workspaceNames: ["default": "Project-\(instanceId)"], isOnline: online, isBlocked: blocked,
            fetchedAt: now, bots: bots
        )
    }

    func testChatsAreNewestFirstAcrossMachinesWithTheirOwnWorkspaceNames() {
        let entries = AidenChatsList.entries(
            snapshots: [
                snapshot("studio", chats: [chat("a", "Old", minutesAgo: 30), chat("b", "Newest", minutesAgo: 1)]),
                snapshot("laptop", chats: [chat("a", "Middle", minutesAgo: 10)], online: false),
            ],
            hiddenMachines: []
        )

        XCTAssertEqual(entries.map(\.title), ["Newest", "Middle", "Old"])
        XCTAssertEqual(entries.map(\.workspaceName), ["Project-studio", "Project-laptop", "Project-studio"])
        XCTAssertEqual(entries.map(\.isOnline), [true, false, true])
        XCTAssertEqual(entries[1].route, .chat(id("a", on: "laptop")), "The same chat id on two machines is two chats")
    }

    func testBlockedAndHiddenMachinesListNoChats() {
        let entries = AidenChatsList.entries(
            snapshots: [
                snapshot("studio", chats: [chat("a", "Kept", minutesAgo: 1)]),
                snapshot("blocked", chats: [chat("b", "Blocked", minutesAgo: 1)], blocked: true),
                snapshot("hidden", chats: [chat("c", "Hidden", minutesAgo: 1)]),
            ],
            hiddenMachines: ["hidden"]
        )

        XCTAssertEqual(entries.map(\.title), ["Kept"])
    }

    func testARepeatedChatIsListedOnceAsItsNewerCopyAndTheOrderIsStable() {
        let snapshots = [
            snapshot("studio", chats: [chat("a", "Stale", minutesAgo: 20), chat("a", "Fresh", minutesAgo: 2)]),
            snapshot("studio", chats: [chat("z", "Second snapshot", minutesAgo: 0), chat("a", "Older again", minutesAgo: 30)]),
            snapshot("laptop", chats: [chat("t", "Tie one", minutesAgo: 5)]),
            snapshot("mini", chats: [chat("t", "Tie two", minutesAgo: 5)]),
        ]

        let forward = AidenChatsList.entries(snapshots: snapshots, hiddenMachines: [])
        let backward = AidenChatsList.entries(snapshots: snapshots.reversed(), hiddenMachines: [])

        XCTAssertEqual(forward.filter { $0.id.objectId == "a" }.map(\.title), ["Fresh"])
        XCTAssertEqual(forward.map(\.title), ["Second snapshot", "Fresh", "Tie one", "Tie two"])
        XCTAssertEqual(forward, backward)
    }

    func testTheLimitKeepsTheNewest() {
        let chats = (0..<20).map { chat("c\($0)", "Chat \($0)", minutesAgo: Double($0)) }
        let entries = AidenChatsList.entries(snapshots: [snapshot("studio", chats: chats)], hiddenMachines: [], limit: 3)

        XCTAssertEqual(entries.map(\.title), ["Chat 0", "Chat 1", "Chat 2"])
        XCTAssertEqual(AidenChatsList.entries(snapshots: [snapshot("studio", chats: chats)], hiddenMachines: [], limit: -1), [])
    }

    // MARK: Pins

    func testPinsToggleInOrderAndSurviveARelaunch() {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let store = AidenDrawerPinsStore(defaults: defaults)
        let bot = AidenDrawerPin(kind: .bot, id: id("b1"))
        let workspace = AidenDrawerPin(kind: .workspace, id: id("w1"))

        store.toggle(bot)
        store.toggle(workspace)
        XCTAssertEqual(AidenDrawerPinsStore(defaults: defaults).pins, [bot, workspace])

        store.toggle(bot)
        XCTAssertFalse(store.isPinned(bot))
        XCTAssertEqual(AidenDrawerPinsStore(defaults: defaults).pins, [workspace])

        store.toggle(workspace)
        XCTAssertNil(defaults.object(forKey: AidenDrawerPinsStore.key), "No pins leaves nothing saved")
    }

    func testABotAndAWorkspaceWithTheSameIdAreTwoPins() {
        let store = AidenDrawerPinsStore(defaults: AidenDemoHosts.isolatedDefaults())
        store.toggle(AidenDrawerPin(kind: .bot, id: id("same")))
        store.toggle(AidenDrawerPin(kind: .workspace, id: id("same")))

        XCTAssertEqual(store.pins.map(\.route), [.bot(id("same")), .workspace(id("same"))])
    }

    func testSavedDuplicatePinsLoadOnce() throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let pin = AidenDrawerPin(kind: .bot, id: id("b1"))
        defaults.set(try JSONEncoder().encode([pin, pin]), forKey: AidenDrawerPinsStore.key)

        XCTAssertEqual(AidenDrawerPinsStore(defaults: defaults).pins, [pin])
    }

    func testUnpairingAMachinePurgesOnlyItsPins() {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let store = AidenDrawerPinsStore(defaults: defaults)
        let kept = AidenDrawerPin(kind: .bot, id: id("b1", on: "laptop"))
        store.toggle(AidenDrawerPin(kind: .bot, id: id("b1")))
        store.toggle(kept)
        store.toggle(AidenDrawerPin(kind: .workspace, id: id("w1")))

        store.purge(instanceID: "studio")

        XCTAssertEqual(store.pins, [kept])
        XCTAssertEqual(AidenDrawerPinsStore(defaults: defaults).pins, [kept])
    }

    private func bot(_ botID: String, name: String, extra: [String: Any] = [:]) throws -> AidenBotSummary {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var object: [String: Any] = [
            "id": botID, "name": name, "purpose": "",
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
            "health": "ready",
            "createdAt": formatter.string(from: now), "updatedAt": formatter.string(from: now),
            "revision": "bot_revision_\(botID)",
        ]
        object.merge(extra) { _, new in new }
        return try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testPinnedItemsAreNamedFromTheirOwnMachineAndAMissingOneIsHiddenNotLost() throws {
        let scout = AidenDrawerPin(kind: .bot, id: id("scout"))
        let project = AidenDrawerPin(kind: .workspace, id: id("default", on: "laptop"))
        let gone = AidenDrawerPin(kind: .bot, id: id("deleted"))
        let elsewhere = AidenDrawerPin(kind: .bot, id: id("scout", on: "unlisted"))
        let pins = [gone, project, scout, elsewhere]
        let snapshots = [
            snapshot("studio", bots: [try bot("scout", name: "Scout")]),
            snapshot("laptop", online: false),
        ]

        let items = AidenDrawerPinned.items(pins: pins, snapshots: snapshots, hiddenMachines: [])

        XCTAssertEqual(items.map(\.pin), [project, scout])
        XCTAssertEqual(items.map(\.name), ["Project-laptop", "Scout"])
        XCTAssertEqual(items.map(\.isOnline), [false, true])
        XCTAssertTrue(AidenDrawerPinned.items(pins: pins, snapshots: snapshots, hiddenMachines: ["studio", "laptop"]).isEmpty)
    }

    /// A pinned Bot's dot follows the Inbox: open cards, an interrupted run
    /// and a lost model each need the person; a quiet Bot doesn't.
    func testAPinnedBotNeedsYouWhenTheInboxSaysSo() throws {
        let names = ["quiet", "cards", "interrupted", "model"]
        let bots = [
            try bot("quiet", name: "quiet", extra: ["sessionState": "idle"]),
            try bot("cards", name: "cards", extra: ["issueCount": 2]),
            try bot("interrupted", name: "interrupted", extra: ["sessionState": "interrupted"]),
            try bot("model", name: "model", extra: ["sessionState": "needs_model"]),
        ]
        let items = AidenDrawerPinned.items(
            pins: names.map { AidenDrawerPin(kind: .bot, id: id($0)) },
            snapshots: [snapshot("studio", bots: bots)],
            hiddenMachines: []
        )

        XCTAssertEqual(items.map(\.name), names)
        XCTAssertEqual(items.map(\.needsYou), [false, true, true, true])
    }

    func testAPinOnAnotherPairingOfTheSameMachineIsNotShown() throws {
        let pin = AidenDrawerPin(kind: .bot, id: id("scout", device: "old-phone"))
        let items = AidenDrawerPinned.items(
            pins: [pin],
            snapshots: [snapshot("studio", bots: [try bot("scout", name: "Scout")])],
            hiddenMachines: []
        )

        XCTAssertEqual(items, [])
    }
}
#endif
