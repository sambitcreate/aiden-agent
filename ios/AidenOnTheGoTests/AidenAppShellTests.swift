#if DEBUG
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenAppShellTests: XCTestCase {
    private let studio = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
    private let laptop = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")

    private func id(
        _ objectId: String,
        on instanceId: String = "studio",
        device: String = "demo-device"
    ) -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: device, objectId: objectId)
    }

    private func temporaryCache() -> AidenChatCache {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenAppShellTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return AidenChatCache(root: root)
    }

    // MARK: Flag

    /// The Bot rollout flag reads this way.
    func testABuildFlagFailsClosed() {
        let closed: [Any?] = [
            nil, "", "NO", "no", "0", "false", "maybe", "$(AIDEN_BOT_FIRST_ENABLED)",
            NSNumber(value: false), Date(), ["YES"],
        ]
        for value in closed {
            XCTAssertFalse(AppConfig.isFlagEnabled(value), "\(String(describing: value))")
        }
        let open: [Any?] = ["YES", "yes", "1", "true", "TRUE", NSNumber(value: true)]
        for value in open {
            XCTAssertTrue(AppConfig.isFlagEnabled(value), "\(String(describing: value))")
        }
    }

    // MARK: Opening routes

    func testOpeningAChatRouteSelectsItsTabAndPushes() {
        let navigation = AidenAppNavigation()
        navigation.tab = .search

        navigation.open(.chat(id("c1")))

        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1"))])
        XCTAssertEqual(navigation.botsPath, [])
        XCTAssertEqual(navigation.workspacesPath, [])
    }

    func testEveryRouteLandsOnItsOwnTabsPath() {
        let navigation = AidenAppNavigation()

        navigation.open(.bot(id("b1")))
        XCTAssertEqual(navigation.tab, .bots)
        navigation.open(.workspace(id("w1")))
        XCTAssertEqual(navigation.tab, .workspaces)
        for route: AidenAppRoute in [.machines, .machine(instanceId: "studio"), .settings, .scheduled, .usage] {
            navigation.tab = .search
            navigation.open(route)
            XCTAssertEqual(navigation.tab, .inbox, "\(route)")
        }

        XCTAssertEqual(navigation.botsPath, [.bot(id("b1"))])
        XCTAssertEqual(navigation.workspacesPath, [.workspace(id("w1"))])
        XCTAssertEqual(
            navigation.inboxPath,
            [.machines, .machine(instanceId: "studio"), .settings, .scheduled, .usage]
        )
    }

    func testAChatOnTwoMachinesIsTwoRoutes() {
        let navigation = AidenAppNavigation()

        navigation.open(.chat(id("c1", on: "studio")))
        navigation.open(.chat(id("c1", on: "laptop")))

        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1", on: "studio")), .chat(id("c1", on: "laptop"))])
    }

    /// Two screens on one chat would mean two live models for it.
    func testOpeningARouteAlreadyOnThePathGoesBackToIt() {
        let navigation = AidenAppNavigation()
        navigation.open(.chat(id("c1")))
        navigation.open(.chat(id("c2")))
        navigation.open(.chat(id("c3")))

        navigation.open(.chat(id("c3")))
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1")), .chat(id("c2")), .chat(id("c3"))])

        navigation.open(.chat(id("c1")))
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1"))])
    }

    func testALinkOpensOnItsOwnMachine() {
        func route(_ destination: AidenNavigationRequest.Destination, instanceId: String?) -> AidenAppRoute? {
            AidenAppRoute(
                request: AidenNavigationRequest(
                    destination: destination,
                    instanceId: instanceId,
                    workspaceId: nil,
                    startsVoice: false
                ),
                installations: [studio, laptop],
                defaultInstanceId: "studio"
            )
        }

        XCTAssertEqual(route(.chat("c1"), instanceId: "laptop"), .chat(id("c1", on: "laptop")))
        XCTAssertEqual(route(.chat("c1"), instanceId: nil), .chat(id("c1", on: "studio")))
        XCTAssertEqual(route(.botChat("b1"), instanceId: "laptop"), .bot(id("b1", on: "laptop")))
        XCTAssertNil(route(.chat("c1"), instanceId: "gone"))
        XCTAssertNil(route(.newChat, instanceId: "studio"))
    }

    func testAChatOpenedOnATabStaysOnThatTab() {
        let navigation = AidenAppNavigation()
        navigation.tab = .workspaces

        navigation.open(.chat(id("c1")), on: .workspaces)

        XCTAssertEqual(navigation.tab, .workspaces)
        XCTAssertEqual(navigation.workspacesPath, [.chat(id("c1"))])
        XCTAssertEqual(navigation.inboxPath, [])
    }

    func testABotChatLeavesItsChatRouteForTheBotsTab() {
        let navigation = AidenAppNavigation()
        navigation.open(.settings)
        navigation.open(.chat(id("c1")))

        navigation.replace(.chat(id("c1")), with: .bot(id("b1")))

        XCTAssertEqual(navigation.tab, .bots)
        XCTAssertEqual(navigation.inboxPath, [.settings])
        XCTAssertEqual(navigation.botsPath, [.bot(id("b1"))])
    }

    /// Two screens of one chat would each hold a model and a draft of their own.
    func testAChatOpenOnAnotherTabIsGoneBackTo() {
        let navigation = AidenAppNavigation()
        let chat = AidenAppRoute.chat(id("chat_1"))
        navigation.open(.workspace(id("workspace_app")))
        navigation.open(chat, on: .workspaces)
        navigation.open(.settings)

        navigation.open(chat)

        XCTAssertEqual(navigation.tab, .workspaces)
        XCTAssertEqual(navigation.workspacesPath, [.workspace(id("workspace_app")), chat])
        XCTAssertEqual(navigation.inboxPath, [.settings], "A second screen of the chat opened on the Inbox")
    }

    func testAChatOpenOnItsOwnTabIsNotOpenedAgainFromAnother() {
        let navigation = AidenAppNavigation()
        let chat = AidenAppRoute.chat(id("chat_1"))
        navigation.open(chat)
        navigation.tab = .workspaces

        navigation.open(chat, on: .workspaces)

        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [chat])
        XCTAssertEqual(navigation.workspacesPath, [])
    }

    func testAMachineChangeClosesThePagesThatReadTheOldMachine() {
        let navigation = AidenAppNavigation()
        navigation.open(.settings)
        navigation.open(.usage)
        let chat = AidenAppRoute.chat(id("chat_1"))
        navigation.open(chat, on: .workspaces)

        navigation.leaveSelectedMachineRoutes()

        XCTAssertEqual(navigation.inboxPath, [.settings], "Usage stayed open on the wrong machine")
        XCTAssertEqual(navigation.workspacesPath, [chat], "A chat belongs to its own machine")

        navigation.open(.scheduled)
        navigation.leaveSelectedMachineRoutes()
        XCTAssertEqual(navigation.inboxPath, [.settings])
    }

    func testAVoiceLinkStartsTheMicOnceAndOnlyOnItsChat() {
        let navigation = AidenAppNavigation()
        let voice = id("chat_voice")

        navigation.open(.chat(voice), startsVoice: true)
        XCTAssertEqual(navigation.chatStartingVoice, voice)

        navigation.finishStartingVoice(id("chat_other"))
        XCTAssertEqual(navigation.chatStartingVoice, voice, "Another chat closing ended the voice start")

        navigation.finishStartingVoice(voice)
        XCTAssertNil(navigation.chatStartingVoice)

        navigation.open(.chat(voice), startsVoice: true)
        navigation.open(.chat(id("chat_other")))
        XCTAssertNil(navigation.chatStartingVoice, "A voice start outlived the link that asked for it")
    }

    func testLeavingARouteDropsItAndWhatSitsOnIt() {
        let navigation = AidenAppNavigation()
        navigation.open(.workspace(id("w1")))
        navigation.open(.chat(id("c1")), on: .workspaces)
        navigation.open(.scheduled)

        navigation.leave(.workspace(id("w1")))
        navigation.leave(.usage)

        XCTAssertEqual(navigation.workspacesPath, [])
        XCTAssertEqual(navigation.inboxPath, [.scheduled])
    }

    // MARK: List beside detail

    func testTheFirstRouteIsTheSelectionAndTheRestIsTheDetail() {
        let split = AidenSplitNavigationPath([.chat(id("c1")), .settings, .usage])

        XCTAssertEqual(split.selection, .chat(id("c1")))
        XCTAssertEqual(split.detailPath, [.settings, .usage])

        let empty = AidenSplitNavigationPath([])
        XCTAssertNil(empty.selection)
        XCTAssertEqual(empty.detailPath, [])
    }

    func testChoosingAnotherRowStartsTheDetailOverOnIt() {
        var split = AidenSplitNavigationPath([.chat(id("c1")), .settings])

        split.select(.chat(id("c2")))
        XCTAssertEqual(split.path, [.chat(id("c2"))])
    }

    /// Opening the display hands a stack's path to the list: the conversation
    /// on screen becomes the highlighted row, with only what's above it pushed.
    func testOpeningTheDisplaySelectsTheConversationOnScreen() {
        let navigation = AidenAppNavigation()
        navigation.openInboxRow(.chat(id("c1")))
        navigation.openInboxRow(.chat(id("c2")))
        navigation.open(.settings)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1")), .chat(id("c2")), .settings])

        navigation.inboxBesideList = true

        XCTAssertEqual(AidenSplitNavigationPath(navigation.inboxPath).selection, .chat(id("c2")))
        XCTAssertEqual(AidenSplitNavigationPath(navigation.inboxPath).detailPath, [.settings])
        XCTAssertEqual(navigation.inboxOpenChat, id("c2"))
    }

    /// A launch on the open display restores a chat opened from Settings as
    /// the selection, rather than Settings with nothing highlighted.
    func testARestoredChatUnderAPageBecomesTheSelection() {
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        let compact = AidenAppNavigation()
        compact.open(.settings)
        compact.openInboxRow(.bot(id("b1")))
        store.save(compact.snapshot)

        let restored = AidenAppNavigation(restoring: store.load(), installations: [studio, laptop])
        restored.inboxBesideList = true

        XCTAssertEqual(restored.inboxPath, [.bot(id("b1"))])
    }

    /// Pages alone have no row to highlight, so the list leaves them be.
    func testAPathWithNoConversationIsKeptWhenTheListTakesOver() {
        let navigation = AidenAppNavigation()
        navigation.open(.machines)
        navigation.open(.machine(instanceId: "laptop"))

        navigation.inboxBesideList = true

        XCTAssertEqual(navigation.inboxPath, [.machines, .machine(instanceId: "laptop")])
    }

    func testBackInTheDetailKeepsTheSelection() {
        var split = AidenSplitNavigationPath([.chat(id("c1")), .settings, .usage])

        split.setDetailPath([.settings])
        XCTAssertEqual(split.path, [.chat(id("c1")), .settings])
        split.setDetailPath([])
        XCTAssertEqual(split.path, [.chat(id("c1"))])
        split.setDetailPath([.machines])
        XCTAssertEqual(split.path, [.chat(id("c1")), .machines])
    }

    /// Collapsed, Back from a chat shows the list and empties the path; a
    /// deeper Back is the detail stack's own and leaves the list hidden.
    func testCollapsedBackToTheListEmptiesThePath() {
        let path: [AidenAppRoute] = [.chat(id("c1")), .settings]

        XCTAssertFalse(AidenSplitNavigationPath.compactShowsList(path))
        let back = AidenSplitNavigationPath.path(path, afterShowingList: true, besideList: false)
        XCTAssertEqual(back, [])
        XCTAssertTrue(AidenSplitNavigationPath.compactShowsList(back))

        XCTAssertEqual(AidenSplitNavigationPath.path(path, afterShowingList: false, besideList: false), path)
    }

    /// Beside the list the split reports its columns as it lays them out,
    /// as when the display opens; that's no Back, so the chat stays.
    func testColumnWritesBesideTheListKeepThePath() {
        let path: [AidenAppRoute] = [.chat(id("c1"))]

        XCTAssertEqual(AidenSplitNavigationPath.path(path, afterShowingList: true, besideList: true), path)
        XCTAssertEqual(AidenSplitNavigationPath.path(path, afterShowingList: false, besideList: true), path)
    }

    /// Collapsed, the chat leaving by Back stays drawn as it slides out, and
    /// a newly chosen one replaces it at once. Beside the list nothing
    /// selected is the empty state, never a stale chat.
    func testTheDetailRootKeepsTheOutgoingChatOnlyWhileCollapsed() {
        let old = AidenAppRoute.chat(id("c1"))
        let new = AidenAppRoute.chat(id("c2"))

        XCTAssertEqual(AidenSplitNavigationPath.detailRoot(selection: nil, lastSelection: old, besideList: false), old)
        XCTAssertEqual(AidenSplitNavigationPath.detailRoot(selection: new, lastSelection: old, besideList: false), new)
        XCTAssertNil(AidenSplitNavigationPath.detailRoot(selection: nil, lastSelection: old, besideList: true))
        XCTAssertEqual(AidenSplitNavigationPath.detailRoot(selection: new, lastSelection: old, besideList: true), new)
    }

    /// No row chosen means the detail shows its empty state and has no stack.
    func testWithNothingSelectedTheDetailPushesNothing() {
        var split = AidenSplitNavigationPath([])

        split.setDetailPath([.settings])

        XCTAssertEqual(split.path, [])
    }

    private func besideList() -> AidenAppNavigation {
        let navigation = AidenAppNavigation()
        navigation.inboxBesideList = true
        return navigation
    }

    /// A row tapped beside the list replaces what the detail showed instead of
    /// stacking a second chat, from any tab, and drops a pending voice start.
    /// On a stack the same taps push.
    func testARowChosenBesideTheListReplacesTheSelection() {
        let navigation = besideList()
        navigation.openInboxRow(.chat(id("c1")))
        navigation.open(.settings)
        navigation.open(.chat(id("c1")), startsVoice: true)
        navigation.tab = .bots

        navigation.openInboxRow(.chat(id("c2")))

        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c2"))])
        XCTAssertEqual(navigation.openChat, id("c2"))
        XCTAssertNil(navigation.chatStartingVoice)

        navigation.openInboxRow(.bot(id("b1")))
        XCTAssertEqual(navigation.inboxPath, [.bot(id("b1"))])
        XCTAssertTrue(navigation.showsConversation)

        let stack = AidenAppNavigation()
        stack.openInboxRow(.chat(id("c1")))
        stack.openInboxRow(.chat(id("c2")))
        XCTAssertEqual(stack.inboxPath, [.chat(id("c1")), .chat(id("c2"))])
    }

    /// A new chat from Compose, a Search result, a link or a Shortcut opens on
    /// the Inbox without going through the list. Beside the list it still
    /// becomes the selection, so the highlight follows it and it has no Back to
    /// the chat before. A page from the menu still goes on top.
    func testAChatOpenedFromOutsideTheListBecomesTheSelection() {
        let navigation = besideList()
        navigation.openInboxRow(.chat(id("c1")))
        navigation.open(.settings)

        navigation.open(.chat(id("c2")), on: .inbox)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c2"))], "Compose")

        navigation.open(.chat(id("c3")), startsVoice: true)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c3"))], "A voice link")
        XCTAssertEqual(navigation.chatStartingVoice, id("c3"))

        navigation.open(.usage)
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c3")), .usage])

        let stack = AidenAppNavigation()
        stack.openInboxRow(.chat(id("c1")))
        stack.open(.settings)
        stack.open(.chat(id("c2")), on: .inbox)
        stack.open(.chat(id("c3")), startsVoice: true)
        XCTAssertEqual(stack.inboxPath, [.chat(id("c1")), .settings, .chat(id("c2")), .chat(id("c3"))])
    }

    /// Back, replace and Delete keep their stack rules, and the split reads the
    /// result: going back to the chosen chat pops what's over it, and deleting
    /// the chosen chat empties the detail.
    func testTheStackRulesStillHoldBesideTheList() {
        let navigation = besideList()
        navigation.openInboxRow(.chat(id("c1")))

        navigation.open(.settings)
        XCTAssertEqual(AidenSplitNavigationPath(navigation.inboxPath).selection, .chat(id("c1")))
        XCTAssertEqual(AidenSplitNavigationPath(navigation.inboxPath).detailPath, [.settings])

        navigation.open(.chat(id("c1")))
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c1"))], "Going back to the chosen chat pops the detail")

        navigation.replace(.chat(id("c1")), with: .chat(id("c3")))
        XCTAssertEqual(navigation.inboxPath, [.chat(id("c3"))])

        navigation.leave(.chat(id("c3")))
        XCTAssertNil(AidenSplitNavigationPath(navigation.inboxPath).selection)
    }

    /// The chosen chat stays the Inbox's open chat under a page pushed over it,
    /// so it keeps its place in the list while its row is highlighted. On a
    /// stack the list isn't on screen then, and nothing is open.
    func testTheChosenChatStaysOpenForTheListUnderAPage() {
        let navigation = besideList()
        navigation.openInboxRow(.chat(id("c1")))
        navigation.open(.settings)

        XCTAssertNil(navigation.openChat)
        XCTAssertEqual(navigation.inboxOpenChat, id("c1"))

        navigation.tab = .bots
        XCTAssertNil(navigation.inboxOpenChat, "Another tab is showing")

        let stack = AidenAppNavigation()
        stack.openInboxRow(.chat(id("c1")))
        stack.open(.settings)
        XCTAssertNil(stack.inboxOpenChat)
    }

    /// Frames measured on an iPhone Duo's inner display.
    func testOnlyADetailStartingAtTheSplitsEdgeIsAnOverlaidList() {
        let portraitSplit = CGRect(x: 0, y: 82, width: 669, height: 786)
        XCTAssertTrue(AidenSplitNavigationPath.listIsOverlaid(
            detailFrame: CGRect(x: 0, y: 82, width: 669, height: 786), splitFrame: portraitSplit
        ))
        XCTAssertTrue(
            AidenSplitNavigationPath.listIsOverlaid(
                detailFrame: CGRect(x: 0, y: 82, width: 661, height: 786), splitFrame: portraitSplit
            ),
            "A detail a few points short of the split is still under the list"
        )
        XCTAssertFalse(
            AidenSplitNavigationPath.listIsOverlaid(
                detailFrame: CGRect(x: 320, y: 0, width: 631, height: 669),
                splitFrame: CGRect(x: 0, y: 0, width: 951, height: 669)
            ),
            "Tiled: the detail starts after the list"
        )
        XCTAssertFalse(
            AidenSplitNavigationPath.listIsOverlaid(detailFrame: CGRect(x: 0, y: 82, width: 20, height: 786), splitFrame: portraitSplit),
            "Mid-animation"
        )
        XCTAssertFalse(AidenSplitNavigationPath.listIsOverlaid(detailFrame: .zero, splitFrame: .zero), "Not measured yet")
    }

    /// The width only changes how the path is drawn, so a restored path, or one
    /// trimmed for a forgotten machine, keeps its selection.
    func testARestoredInboxPathKeepsItsSelection() {
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        let navigation = besideList()
        navigation.openInboxRow(.chat(id("c1")))
        navigation.open(.machine(instanceId: "laptop"))
        store.save(navigation.snapshot)

        let restored = AidenAppNavigation(restoring: store.load(), installations: [studio, laptop])
        XCTAssertEqual(AidenSplitNavigationPath(restored.inboxPath).selection, .chat(id("c1")))
        XCTAssertEqual(AidenSplitNavigationPath(restored.inboxPath).detailPath, [.machine(instanceId: "laptop")])

        restored.dropRoutes(outside: [studio])
        XCTAssertEqual(AidenSplitNavigationPath(restored.inboxPath).selection, .chat(id("c1")))
        XCTAssertEqual(AidenSplitNavigationPath(restored.inboxPath).detailPath, [])
    }

    // MARK: Restoration

    func testNavigationRoundTripsThroughTheStore() {
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        let navigation = AidenAppNavigation()
        navigation.open(.settings)
        navigation.open(.chat(id("c1:with:colons")))
        navigation.open(.bot(id("b1")))
        navigation.open(.workspace(id("w1")))
        navigation.tab = .search

        store.save(navigation.snapshot)
        let restored = AidenAppNavigation(restoring: store.load(), installations: [studio])

        XCTAssertEqual(restored.snapshot, navigation.snapshot)
        XCTAssertEqual(restored.tab, .search)
        XCTAssertEqual(restored.inboxPath, [.settings, .chat(id("c1:with:colons"))])
    }

    func testARestoredRouteToARemovedMachineFallsBackToTheScreenBeforeIt() {
        let snapshot = AidenAppNavigationSnapshot(
            tab: .workspaces,
            inboxPath: [.settings, .chat(id("c1", on: "gone"))],
            botsPath: [.bot(id("b1", on: "studio"))],
            workspacesPath: [.workspace(id("w1", on: "gone"))]
        )

        let restored = AidenAppNavigation(restoring: snapshot, installations: [studio])

        XCTAssertEqual(restored.tab, .workspaces)
        XCTAssertEqual(restored.inboxPath, [.settings])
        XCTAssertEqual(restored.botsPath, [.bot(id("b1", on: "studio"))])
        XCTAssertEqual(restored.workspacesPath, [])
    }

    func testARestoredMachinePageForARemovedMachineFallsBack() {
        let snapshot = AidenAppNavigationSnapshot(
            inboxPath: [.machines, .machine(instanceId: "gone")]
        )

        XCTAssertEqual(AidenAppNavigation(restoring: snapshot, installations: [studio]).inboxPath, [.machines])
    }

    /// Forgetting a machine from its own page lands back on Machines, and a chat
    /// deep under a workspace leaves the routes before it.
    func testForgettingAMachineFromItsPageLeavesMachinesShowing() {
        let navigation = AidenAppNavigation()
        navigation.open(.machines)
        navigation.open(.machine(instanceId: "laptop"))
        navigation.workspacesPath = [.workspace(id("w1", on: "studio")), .chat(id("c1", on: "laptop"))]

        navigation.dropRoutes(outside: [studio])

        XCTAssertEqual(navigation.inboxPath, [.machines])
        XCTAssertEqual(navigation.workspacesPath, [.workspace(id("w1", on: "studio"))])
    }

    /// Forgetting a machine and pairing it again gives a new device. Routes from
    /// the old pairing are not this one's to reopen.
    func testARouteFromAnOlderPairingFallsBack() {
        let snapshot = AidenAppNavigationSnapshot(inboxPath: [.chat(id("c1", device: "older-device"))])

        XCTAssertEqual(AidenAppNavigation(restoring: snapshot, installations: [studio]).inboxPath, [])
    }

    func testAMachineRemovedWhileAChatIsOpenFallsBackToTheRoot() {
        let navigation = AidenAppNavigation()
        navigation.open(.chat(id("c1", on: "laptop")))
        navigation.open(.bot(id("b1", on: "studio")))

        navigation.dropRoutes(outside: [studio])

        XCTAssertEqual(navigation.inboxPath, [])
        XCTAssertEqual(navigation.botsPath, [.bot(id("b1", on: "studio"))])
    }

    func testCorruptSavedNavigationStartsAtTheInbox() {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let store = AidenAppNavigationStore(defaults: defaults)

        defaults.set(Data("not json".utf8), forKey: AidenAppNavigationStore.snapshotKey)
        XCTAssertEqual(store.load(), AidenAppNavigationSnapshot())

        defaults.set("reset", forKey: AidenAppNavigationStore.snapshotKey)
        XCTAssertEqual(store.load(), AidenAppNavigationSnapshot())
    }

    /// A later build can add a tab or a route. That costs one path, not the rest.
    func testAnUnknownRouteDropsOnlyItsOwnPath() throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let store = AidenAppNavigationStore(defaults: defaults)
        store.save(AidenAppNavigationSnapshot(tab: .bots, botsPath: [.bot(id("b1"))]))
        let saved = try XCTUnwrap(defaults.data(forKey: AidenAppNavigationStore.snapshotKey))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        object["inboxPath"] = [["fromALaterBuild": [:]]]
        object["tab"] = "fromALaterBuild"
        defaults.set(try JSONSerialization.data(withJSONObject: object), forKey: AidenAppNavigationStore.snapshotKey)

        let loaded = store.load()

        XCTAssertEqual(loaded.tab, .inbox)
        XCTAssertEqual(loaded.inboxPath, [])
        XCTAssertEqual(loaded.botsPath, [.bot(id("b1"))])
    }

    // MARK: Pushed chats

    func testAChatRouteLoadsFromItsOwnMachineWithoutSwitching() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        let model = AidenChatRouteModel(id: id("chat_laptop_1", on: "laptop"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .ready(let chat, let owner) = model.state else {
            return XCTFail("Not ready: \(model.state)")
        }
        XCTAssertEqual(chat.id, "chat_laptop_1")
        XCTAssertEqual(owner.instanceId, "laptop")
        XCTAssertEqual(owner.scope, .owner)
        XCTAssertTrue(coordinator.isLive(owner))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("GET /chats/chat_laptop_1"))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains { $0.contains("chat_laptop_1") })
    }

    func testAChatRouteOpensFromTheSavedTranscriptWithoutAskingTheMachine() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let owner = try coordinator.ownerContext(for: "laptop")
        let saved = try await coordinator.remoteClient(for: owner).chat(id: "chat_laptop_1")
        let cache = temporaryCache()
        _ = try await cache.saveChat(saved, instanceId: "laptop", writeToken: cache.reserveChatWrite())
        let asked = responder.requests(instanceId: "laptop").count
        let model = AidenChatRouteModel(id: id("chat_laptop_1", on: "laptop"), cache: cache)

        await model.load(coordinator: coordinator)

        guard case .ready(let chat, _) = model.state else {
            return XCTFail("Not ready: \(model.state)")
        }
        XCTAssertEqual(chat.id, "chat_laptop_1")
        XCTAssertEqual(responder.requests(instanceId: "laptop").count, asked)
    }

    func testAChatRouteToARemovedMachineExplainsItself() async {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        await coordinator.start()
        let model = AidenChatRouteModel(id: id("c1", on: "gone"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
    }

    func testAChatRouteFromAnOlderPairingNeverReachesTheMachine() async {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let model = AidenChatRouteModel(
            id: id("chat_studio_1", on: "studio", device: "older-device"),
            cache: temporaryCache()
        )

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /chats/chat_studio_1"))
    }

    func testAChatTheMachineNoLongerHasExplainsItself() async {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        await coordinator.start()
        let model = AidenChatRouteModel(id: id("chat_deleted"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
    }

    func testARevokedMachineLeavesNoEndlessSpinner() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        responder.reply(
            instanceId: "laptop",
            path: "/chats/chat_laptop_1",
            status: 401,
            json: try JSONSerialization.data(withJSONObject: ["error": [
                "code": "credential_revoked",
                "message": "This device was removed.",
                "requestId": "request_demo_revoked",
                "retryable": false,
            ]])
        )
        let model = AidenChatRouteModel(id: id("chat_laptop_1", on: "laptop"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
    }

    /// A Bot's legacy chat route runs its chat on the Bot's own machine. Once
    /// that machine is revoked there is no owner, and the route says the machine
    /// is gone: it never falls back to the default machine's context.
    func testABotChatRouteHasNoOwnerOnceItsMachineIsRevoked() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))
        let id = AidenHostObjectID(instanceId: "laptop", deviceId: laptop.installation.deviceId, objectId: "bot_demo")
        XCTAssertNotEqual(coordinator.defaultInstanceId, "laptop")

        XCTAssertEqual(AidenBotRouteModel.chatOwner(for: id, coordinator: coordinator)?.instanceId, "laptop")

        laptop.markRevoked()
        XCTAssertNil(
            AidenBotRouteModel.chatOwner(for: id, coordinator: coordinator),
            "A revoked machine's chat has no owner, not the default machine's"
        )
        XCTAssertEqual(AidenBotRouteModel.machineGoneMessage, "This computer is no longer paired. Pair it again to open this Bot.")
    }

    func testABotChatOnAChatRouteAsksForItsBotRoute() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", path: "/chats/chat_bot", status: 200, json: try botChatJSON())
        let model = AidenChatRouteModel(id: id("chat_bot"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .botChat(let route) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(route, id("bot_scout"))
    }

    func testABotChatOnAMachineWithoutBotsExplainsItself() async throws {
        let responder = AidenDemoResponder()
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.deviceCapabilities = installation.deviceCapabilities.filter { $0 != .botRead && $0 != .botWrite }
        installation.serverCapabilities = installation.serverCapabilities?.filter { $0 != .botRead && $0 != .botWrite }
        let coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", path: "/chats/chat_bot", status: 200, json: try botChatJSON())
        let model = AidenChatRouteModel(id: id("chat_bot"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
    }

    func testAChatRouteOpensFromItsCreateReceiptWithoutAskingTheMachine() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let owner = try coordinator.ownerContext(for: "studio")
        let receipt = try await coordinator.remoteClient(for: owner).chat(id: "chat_studio_1")
        let asked = responder.requests(instanceId: "studio").count
        let model = AidenChatRouteModel(id: id("chat_studio_1"), cache: temporaryCache(), receipt: receipt)

        await model.load(coordinator: coordinator)

        guard case .ready(let chat, _) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(chat.id, "chat_studio_1")
        XCTAssertEqual(responder.requests(instanceId: "studio").count, asked)
    }

    // MARK: Bot routes

    private func botChatJSON(chatId: String = "chat_bot", botId: String = "bot_scout") throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "id": chatId,
            "workspaceId": "workspace_app",
            "botId": botId,
            "title": "Scout",
            "messages": [[String: Any]](),
            "createdAt": "2026-11-01T10:00:00.000Z",
            "updatedAt": "2026-11-01T10:00:00.000Z",
            "revision": "chat_revision_1",
        ] as [String: Any])
    }

    private func conversationsJSON(chatId: String? = "chat_bot") throws -> Data {
        let rows: [[String: Any]] = chatId.map { [[
            "chatId": $0,
            "botId": "bot_scout",
            "title": "Scout",
            "activityState": "idle",
            "canRespondToApproval": false,
            "createdAt": "2026-11-01T10:00:00.000Z",
            "updatedAt": "2026-11-01T10:00:00.000Z",
            "revision": "chat_revision_1",
        ]] } ?? []
        return try JSONSerialization.data(withJSONObject: ["conversations": rows])
    }

    /// A paired machine from before durable Bot sessions.
    private func olderBotMachine(responder: AidenDemoResponder) async throws -> AidenRemoteCoordinator {
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.serverFeatures = installation.serverFeatures.filter { $0 != "bot-durable-session-v1" }
        let coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        await coordinator.start()
        return coordinator
    }

    private func botRouteModel(_ route: AidenHostObjectID) -> AidenBotRouteModel {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenAppShellTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return AidenBotRouteModel(id: route, chatCache: temporaryCache(), botCache: AidenBotCache(root: root))
    }

    func testABotRouteOpensTheDurableSessionOfTheSelectedMachine() async {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let model = botRouteModel(id("bot_scout"))

        await model.load(coordinator: coordinator)

        XCTAssertEqual(model.state, .session)
    }

    /// A Bot on another machine opens there, and the selection stays put.
    func testABotRouteOnAnotherMachineOpensThere() async {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let model = botRouteModel(id("bot_scout", on: "laptop"))
        let asked = responder.requests(instanceId: "studio").count

        await model.load(coordinator: coordinator)

        XCTAssertEqual(model.state, .session)
        XCTAssertEqual(responder.requests(instanceId: "studio").count, asked)
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testABotRouteFromAnOlderPairingStaysClosed() async {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        await coordinator.start()
        let route = id("bot_scout", device: "older-device")
        let model = botRouteModel(route)

        await model.load(coordinator: coordinator)

        guard case .unavailable = model.state else { return XCTFail("\(model.state)") }
    }

    /// A Bot chat through a chat route used to open read-only.
    func testABotChatOnAnOlderMachineOpensAndCanSend() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        responder.reply(instanceId: "studio", path: "/bot-conversations", status: 200, json: try conversationsJSON())
        responder.reply(instanceId: "studio", path: "/chats/chat_bot", status: 200, json: try botChatJSON())
        let model = botRouteModel(id("bot_scout"))

        await model.load(coordinator: coordinator)

        guard case .chat(let chat, let allowsMutations) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(chat.id, "chat_bot")
        XCTAssertTrue(allowsMutations)
    }

    /// A Bot whose newest chat is on this phone, and a model to open it with.
    private func savedBotChat() async throws -> AidenBotRouteModel {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenAppShellTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let botCache = AidenBotCache(root: root)
        let activation = await botCache.activate(instanceId: "studio", deviceId: "demo-device")
        let conversations = try AidenRemoteJSONDecoder.decode(AidenBotConversationPage.self, from: try conversationsJSON())
        let stored = try await botCache.store(AidenBotCacheSnapshot(conversations: conversations), activation: activation)
        XCTAssertTrue(stored)
        let chatCache = temporaryCache()
        let chat = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: try botChatJSON())
        let saved = try await chatCache.saveChat(chat, instanceId: "studio", writeToken: chatCache.reserveChatWrite())
        XCTAssertTrue(saved)
        return AidenBotRouteModel(id: id("bot_scout"), chatCache: chatCache, botCache: botCache)
    }

    func testASavedBotChatShowsAtOnceButSendingWaitsForTheLiveCheck() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        let release = responder.hold(instanceId: "studio", path: "/bots/bot_scout")
        let model = try await savedBotChat()

        let load = Task { await model.load(coordinator: coordinator) }
        let deadline = Date().addingTimeInterval(10)
        while model.state == .loading, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }

        guard case .chat(let saved, let allowsMutations) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(saved.id, "chat_bot")
        XCTAssertFalse(allowsMutations, "Saved words granted sending with the live check out")
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /chats/chat_bot"), "The saved chat was read again")

        release()
        await load.value
        guard case .chat(_, let live) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertTrue(live)
    }

    func testASavedBotChatOnAnOfflineMachineStaysReadOnly() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        await coordinator.connectActiveInstallation()
        let model = try await savedBotChat()

        await model.load(coordinator: coordinator)

        guard case .chat(let saved, let allowsMutations) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertEqual(saved.id, "chat_bot")
        XCTAssertFalse(allowsMutations)
    }

    func testARetryAfterAnUnclearFailureReusesItsKey() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        let starter = AidenBotChatStarter(cache: temporaryCache())
        responder.fail(instanceId: "studio", path: "/bots/bot_scout/chats", code: .timedOut)

        let first = await starter.start(botID: "bot_scout", coordinator: coordinator)
        XCTAssertFalse(first)
        responder.reply(instanceId: "studio", method: "POST", path: "/bots/bot_scout/chats", status: 201, json: try botChatJSON())
        let second = await starter.start(botID: "bot_scout", coordinator: coordinator)
        XCTAssertTrue(second)
        let third = await starter.start(botID: "bot_scout", coordinator: coordinator)
        XCTAssertTrue(third)

        let keys = responder.idempotencyKeys(instanceId: "studio")
        XCTAssertEqual(keys.count, 3)
        XCTAssertEqual(keys[0], keys[1], "The machine may have made the chat, so the retry must name it")
        XCTAssertNotEqual(keys[1], keys[2], "A chat that was made doesn't hold the key")
    }

    func testARetryAfterAClearRefusalGetsANewKey() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        let starter = AidenBotChatStarter(cache: temporaryCache())
        let refusal = Data("""
        {"error":{"code":"invalid_request","message":"No.","requestId":"request-400","retryable":false}}
        """.utf8)
        responder.reply(instanceId: "studio", method: "POST", path: "/bots/bot_scout/chats", status: 400, json: refusal)

        let first = await starter.start(botID: "bot_scout", coordinator: coordinator)
        XCTAssertFalse(first)
        XCTAssertNotNil(coordinator.presentedError)
        let second = await starter.start(botID: "bot_scout", coordinator: coordinator)
        XCTAssertFalse(second)

        let keys = responder.idempotencyKeys(instanceId: "studio")
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testAMachineChangeDropsTheKeptKey() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        let starter = AidenBotChatStarter(cache: temporaryCache())
        responder.fail(instanceId: "studio", path: "/bots/bot_scout/chats", code: .timedOut)

        _ = await starter.start(botID: "bot_scout", coordinator: coordinator)
        starter.forgetAttempt()
        _ = await starter.start(botID: "bot_scout", coordinator: coordinator)

        let keys = responder.idempotencyKeys(instanceId: "studio")
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testABotChatStaysReadOnlyWhenThisPhoneCannotWrite() async throws {
        let responder = AidenDemoResponder()
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.serverFeatures = installation.serverFeatures.filter { $0 != "bot-durable-session-v1" }
        installation.deviceCapabilities = installation.deviceCapabilities.filter { $0 != .botWrite }
        let coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", path: "/bot-conversations", status: 200, json: try conversationsJSON())
        responder.reply(instanceId: "studio", path: "/chats/chat_bot", status: 200, json: try botChatJSON())
        let model = botRouteModel(id("bot_scout"))

        await model.load(coordinator: coordinator)

        guard case .chat(_, let allowsMutations) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertFalse(allowsMutations)
    }

    /// A route never creates anything by itself: a Bot with no chat offers to
    /// start one and waits for the tap.
    func testABotWithNoChatYetOffersToStartOneAndCreatesNothing() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await olderBotMachine(responder: responder)
        responder.reply(instanceId: "studio", path: "/bot-conversations", status: 200, json: try conversationsJSON(chatId: nil))
        let model = botRouteModel(id("bot_scout"))

        await model.load(coordinator: coordinator)

        XCTAssertEqual(model.state, .noChat(name: "Scout", canStart: true))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains { $0.hasPrefix("POST") })
    }

    func testAnOfflineBotRouteWithNothingSavedExplainsItself() async throws {
        let responder = AidenDemoResponder()
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.serverFeatures = installation.serverFeatures.filter { $0 != "bot-durable-session-v1" }
        let coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        await coordinator.start()
        let model = botRouteModel(id("bot_scout"))

        await model.load(coordinator: coordinator)

        guard case .unavailable(let message) = model.state else { return XCTFail("\(model.state)") }
        XCTAssertFalse(message.contains("Mac"), message)
    }

    // MARK: Workspace routes

    /// Two machines can both have a workspace with one ID. The route must not show
    /// the selected machine's for the other's.
    func testAWorkspaceRouteOnlyFindsItsWorkspaceOnTheSelectedMachine() async {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()

        XCTAssertEqual(
            AidenWorkspaceRoute.workspace(for: id("workspace_app"), coordinator: coordinator)?.name,
            "Aiden Agent"
        )
        XCTAssertNil(AidenWorkspaceRoute.workspace(for: id("workspace_app", on: "laptop"), coordinator: coordinator))
        XCTAssertNil(AidenWorkspaceRoute.workspace(for: id("workspace_app", device: "older-device"), coordinator: coordinator))
    }

    func testAWorkspaceRouteDoesNotOpenAHiddenOrArchivedWorkspace() async {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        await coordinator.start()

        XCTAssertNil(AidenWorkspaceRoute.workspace(for: id("default"), coordinator: coordinator), "A hidden home has no page")

        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "studio")
        XCTAssertNil(AidenWorkspaceRoute.workspace(for: id("workspace_app"), coordinator: coordinator))
    }

    // MARK: New chat

    private func newChatJSON(id chatId: String = "chat_new", botId: String? = nil, workspaceId: String = "workspace_app") throws -> Data {
        var object: [String: Any] = [
            "id": chatId,
            "workspaceId": workspaceId,
            "title": "New chat",
            "messages": [[String: Any]](),
            "createdAt": "2026-11-01T10:00:00.000Z",
            "updatedAt": "2026-11-01T10:00:00.000Z",
            "revision": "chat_revision_1",
        ]
        if let botId { object["botId"] = botId }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func flow(
        _ coordinator: AidenRemoteCoordinator,
        created: @escaping @MainActor (AidenChat, AidenHostObjectID) -> Void = { _, _ in }
    ) -> AidenNewWorkChatFlow {
        AidenNewWorkChatFlow(coordinator: coordinator, onCreated: created)
    }

    private func workspace(_ id: String, in coordinator: AidenRemoteCoordinator) throws -> AidenWorkspace {
        try XCTUnwrap(coordinator.workspaces.first { $0.id == id })
    }

    private final class RecordingHaptics: AidenHapticEmitting {
        private(set) var played: [(AidenHapticEvent, UUID?)] = []
        func activate(scope: UUID) {}
        func deactivate(scope: UUID) {}
        func emit(_ event: AidenHapticEvent, scope: UUID?, dedupeKey: String?) { played.append((event, scope)) }
    }

    /// A new chat taps success once it opens, and a refused one taps an error,
    /// both in the flow's own scope, which the shell turns on while it shows.
    func testANewChatTapsSuccessAndARefusedOneAnError() async throws {
        let responder = AidenDemoResponder()
        let haptics = RecordingHaptics()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder, haptics: haptics)
        await coordinator.start()
        let flow = flow(coordinator)
        responder.reply(instanceId: "studio", method: "POST", path: "/chats", status: 201, json: try newChatJSON())

        await flow.create(in: try workspace("workspace_app", in: coordinator))

        XCTAssertEqual(haptics.played.map(\.0), [.success])
        XCTAssertEqual(haptics.played.last?.1, flow.hapticScope)

        responder.reply(instanceId: "studio", method: "POST", path: "/chats", status: 500, json: Data(#"{"error":{"code":"internal","message":"No","requestId":"r1","retryable":false}}"#.utf8))
        await flow.create(in: try workspace("workspace_app", in: coordinator))

        XCTAssertEqual(haptics.played.map(\.0), [.success, .error])
        XCTAssertEqual(haptics.played.last?.1, flow.hapticScope)
    }

    func testANewChatOpensOnItsOwnMachineFromTheReceipt() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", method: "POST", path: "/chats", status: 201, json: try newChatJSON())
        var opened: [AidenHostObjectID] = []
        let flow = flow(coordinator) { _, id in opened.append(id) }

        await flow.create(in: try workspace("workspace_app", in: coordinator))

        XCTAssertEqual(opened, [id("chat_new")])
        XCTAssertEqual(flow.receipt(for: id("chat_new"))?.id, "chat_new")
        XCTAssertNil(flow.receipt(for: id("chat_new", on: "laptop")))
        XCTAssertFalse(flow.isCreating)
    }

    /// A receipt is the chat as it was made. Reopened later, it would hide what
    /// has happened to the chat since.
    func testANewChatForgetsItsReceiptWhenItsScreenCloses() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", method: "POST", path: "/chats", status: 201, json: try newChatJSON())
        let flow = flow(coordinator)
        await flow.create(in: try workspace("workspace_app", in: coordinator))

        flow.forgetReceipt(id("chat_other"))
        XCTAssertNotNil(flow.receipt(for: id("chat_new")), "Another chat's screen took this chat's receipt")

        flow.forgetReceipt(id("chat_new"))
        XCTAssertNil(flow.receipt(for: id("chat_new")))
    }

    func testANewChatThatComesBackAsABotChatDoesNotOpen() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        responder.reply(instanceId: "studio", method: "POST", path: "/chats", status: 201, json: try newChatJSON(botId: "bot_scout"))
        var opened: [AidenHostObjectID] = []
        let flow = flow(coordinator) { _, id in opened.append(id) }

        await flow.create(in: try workspace("workspace_app", in: coordinator))

        XCTAssertEqual(opened, [])
        XCTAssertNil(flow.receipt(for: id("chat_new")))
        XCTAssertNotNil(coordinator.presentedError)
    }

    func testTheChoicesLeaveOutArchivedWorkspaces() async throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        await coordinator.start()
        let flow = flow(coordinator)
        XCTAssertEqual(flow.existingWorkspaces.map { $0.id }, ["workspace_app", "workspace_notes"])

        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "studio")

        XCTAssertEqual(flow.existingWorkspaces.map { $0.id }, ["workspace_notes"])
    }

    // MARK: Bots

    /// Nothing will ever answer, so a skeleton here would never end.
    func testUsageOnAMachineThatKeepsItToItselfSaysSo() async throws {
        let responder = AidenDemoResponder()
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.deviceCapabilities = installation.deviceCapabilities.filter { $0 != .serverRead }
        installation.serverCapabilities = installation.serverCapabilities?.filter { $0 != .serverRead }
        let coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        await coordinator.start()
        let model = AidenMachineUsageModel(coordinator: coordinator)

        await model.load()

        XCTAssertFalse(model.sharesUsage)
        XCTAssertNil(model.usage)
        XCTAssertFalse(model.loadFailed)
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /usage"))
    }

    func testEveryUnavailableBotsStateExplainsItselfInTabCopy() {
        for state: AidenBotsAvailability in [.mobileDisabled, .unsupported, .notGranted] {
            let explanation = state.tabExplanation
            XCTAssertNotNil(explanation, "\(state)")
            XCTAssertFalse(explanation?.localizedCaseInsensitiveContains("desktop") ?? true, "\(state)")
        }
        XCTAssertNil(AidenBotsAvailability.available(canWrite: true).tabExplanation)
        XCTAssertNil(AidenBotsAvailability.available(canWrite: false).tabExplanation)
    }
}
#endif
