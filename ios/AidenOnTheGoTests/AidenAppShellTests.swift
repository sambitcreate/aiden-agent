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

    func testTabShellFlagFailsClosed() {
        let closed: [Any?] = [
            nil, "", "NO", "no", "0", "false", "maybe", "$(AIDEN_TAB_SHELL_ENABLED)",
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

    func testTheTabShellIsOffUnlessADemoRunAsks() {
        XCTAssertFalse(AppConfig.tabShellEnabled)
    }

    func testOnlyADemoRunCanOverrideTheFlag() {
        let demo = ["app", "-AidenDemoScenario", "busy"]
        XCTAssertEqual(AidenDemoScenario.tabShellOverride(in: demo + ["-AidenDemoTabShell", "YES"]), true)
        XCTAssertEqual(AidenDemoScenario.tabShellOverride(in: demo + ["-AidenDemoTabShell", "NO"]), false)
        XCTAssertEqual(AidenDemoScenario.tabShellOverride(in: demo + ["-AidenDemoTabShell", "maybe"]), false)
        XCTAssertEqual(AidenDemoScenario.tabShellOverride(in: demo + ["-AidenDemoTabShell"]), false)
        XCTAssertNil(AidenDemoScenario.tabShellOverride(in: demo))
        XCTAssertNil(AidenDemoScenario.tabShellOverride(in: ["app", "-AidenDemoTabShell", "YES"]))
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
                activeInstanceId: "studio"
            )
        }

        XCTAssertEqual(route(.chat("c1"), instanceId: "laptop"), .chat(id("c1", on: "laptop")))
        XCTAssertEqual(route(.chat("c1"), instanceId: nil), .chat(id("c1", on: "studio")))
        XCTAssertEqual(route(.botChat("b1"), instanceId: "laptop"), .bot(id("b1", on: "laptop")))
        XCTAssertNil(route(.chat("c1"), instanceId: "gone"))
        XCTAssertNil(route(.newChat, instanceId: "studio"))
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

    func testARestoredRouteToARemovedMachineFallsBackToItsTabsRoot() {
        let snapshot = AidenAppNavigationSnapshot(
            tab: .workspaces,
            inboxPath: [.settings, .chat(id("c1", on: "gone"))],
            botsPath: [.bot(id("b1", on: "studio"))],
            workspacesPath: [.workspace(id("w1", on: "gone"))]
        )

        let restored = AidenAppNavigation(restoring: snapshot, installations: [studio])

        XCTAssertEqual(restored.tab, .workspaces)
        XCTAssertEqual(restored.inboxPath, [])
        XCTAssertEqual(restored.botsPath, [.bot(id("b1", on: "studio"))])
        XCTAssertEqual(restored.workspacesPath, [])
    }

    func testARestoredMachinePageForARemovedMachineFallsBack() {
        let snapshot = AidenAppNavigationSnapshot(
            inboxPath: [.machines, .machine(instanceId: "gone")]
        )

        XCTAssertEqual(AidenAppNavigation(restoring: snapshot, installations: [studio]).inboxPath, [])
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
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        let model = AidenChatRouteModel(id: id("chat_laptop_1", on: "laptop"), cache: temporaryCache())

        await model.load(coordinator: coordinator)

        guard case .ready(let chat, let owner) = model.state else {
            return XCTFail("Not ready: \(model.state)")
        }
        XCTAssertEqual(chat.id, "chat_laptop_1")
        XCTAssertEqual(owner.instanceId, "laptop")
        XCTAssertEqual(owner.scope, .owner)
        XCTAssertTrue(coordinator.isLive(owner))
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
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

    func testAPushedChatKeepsTheOwnerItWasGiven() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()
        let laptop = try coordinator.ownerContext(for: "laptop")

        XCTAssertEqual(AidenChatDetailView.owner(laptop, coordinator: coordinator), laptop)
        XCTAssertEqual(AidenChatDetailView.owner(nil, coordinator: coordinator).instanceId, "studio")
    }

    // MARK: Bots

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
