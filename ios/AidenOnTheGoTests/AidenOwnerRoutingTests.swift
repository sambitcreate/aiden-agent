#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// Opening or acting on something goes to the machine that owns it, and the
/// default machine stays where it was. These run the real models over the demo
/// machines, so every request is one the contract has.
@MainActor
final class AidenOwnerRoutingTests: XCTestCase {
    private static let revokedJSON = Data("""
    {"error":{"code":"credential_revoked","message":"Pair this device again.",
    "requestId":"request-revoked","retryable":false}}
    """.utf8)
    private static let triageJSON = Data("""
    {"chatId":"c1","revision":1,"updatedAt":"2026-11-05T09:00:00.000Z","pinnedAt":null,"doneAt":"2026-11-05T09:00:00.000Z","snoozedUntil":null}
    """.utf8)

    private let responder = AidenDemoResponder()
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private var root: URL!
    private var cache: AidenChatCache!
    private var drafts: AidenChatDraftStore!
    private var coordinator: AidenRemoteCoordinator!
    private var scheduler: AidenHostConnectScheduler!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenOwnerRoutingTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        cache = AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory))
        drafts = AidenChatDraftStore(root: root.appending(path: "drafts", directoryHint: .isDirectory))
        try await connect([studio, laptop])
        transcript("from studio", on: "studio")
        transcript("from laptop", on: "laptop")
    }

    /// The first machine is the selected one.
    private func connect(_ installations: [AidenInstallation]) async throws {
        coordinator = AidenDemoHosts.coordinator(
            installations: installations,
            responder: responder,
            machinePreferences: AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
        )
        scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
        await coordinator.start()
        await scheduler.foregrounded()
        try await waitUntil("every machine to connect") {
            self.coordinator.hosts.ordered.allSatisfy { $0.connectionState == .connected }
        }
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Fixtures

    private var studio: AidenInstallation { AidenDemoHosts.installation(instanceId: "studio", name: "Studio") }
    private var laptop: AidenInstallation { AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop") }

    private func id(_ objectId: String = "c1", on instanceId: String = "laptop") -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: "demo-device", objectId: objectId)
    }

    private func json(_ object: Any) -> Data {
        // Every value here is built from literals.
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func chatObject(_ chatId: String, text: String) -> [String: Any] {
        [
            "id": chatId,
            "workspaceId": "workspace_app",
            "title": "Same chat",
            "createdAt": "2026-11-05T09:00:00.000Z",
            "updatedAt": "2026-11-05T09:00:01.000Z",
            "revision": "r1",
            "messages": [[
                "id": "m1",
                "role": "assistant",
                "text": text,
                "createdAt": "2026-11-05T09:00:00.000Z",
            ]],
        ]
    }

    private func transcript(_ text: String, on instanceId: String, chat chatId: String = "c1") {
        responder.reply(
            instanceId: instanceId,
            path: "/chats/\(chatId)",
            status: 200,
            json: json(chatObject(chatId, text: text))
        )
    }

    private func emptyChat(_ chatId: String = "c1") -> AidenChat {
        AidenChat(
            id: chatId, workspaceId: "workspace_app", title: "Same chat", providerId: nil, modelId: nil,
            messages: [], createdAt: now, updatedAt: now, revision: "r0"
        )
    }

    private func chatModel(owner instanceId: String = "laptop") throws -> AidenChatViewModel {
        AidenChatViewModel(
            coordinator: coordinator,
            chat: emptyChat(),
            owner: try coordinator.ownerContext(for: instanceId),
            cache: cache,
            draftStore: drafts,
            modelPreferenceStore: AidenModelPreferenceStore(defaults: AidenDemoHosts.isolatedDefaults()),
            visualDocumentCache: AidenVisualDocumentCache(root: root.appending(path: "visuals", directoryHint: .isDirectory)),
            networkPath: AidenNetworkAvailability()
        )
    }

    private func connection(_ instanceId: String) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    private func requests(_ instanceId: String) -> [String] {
        responder.requests(instanceId: instanceId)
    }

    private func waitUntil(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Timed out waiting for: \(what)", file: file, line: line)
    }

    /// The row a machine lists, as `/chat-summaries` sends it.
    private func row(_ chatId: String = "c1", unread: Bool = false) -> [String: Any] {
        [
            "id": chatId,
            "workspaceId": "workspace_app",
            "title": "Same chat",
            "titlePending": false,
            "createdAt": "2026-11-05T09:00:00.000Z",
            "updatedAt": "2026-11-05T09:00:01.000Z",
            "revision": "rev_" + String(format: "%043d", 1),
            "activity": "idle",
            "rowState": "idle",
            "unread": unread,
            "lastAssistantMessageId": "m1",
            "inboxBucket": "earlier",
            "inboxSortAt": "2026-11-05T09:00:01.000Z",
        ]
    }

    /// Both machines hold a chat with the same id, so only the owner tells them apart.
    private func inboxStore(unread: Bool = false) async throws -> AidenUnifiedInboxStore {
        for instanceId in ["studio", "laptop"] {
            responder.reply(
                instanceId: instanceId,
                path: "/chat-summaries",
                status: 200,
                json: json(["summaries": [row(unread: unread)]])
            )
        }
        let store = AidenUnifiedInboxStore(
            hosts: coordinator.hosts,
            preferences: AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults()),
            cache: cache,
            clock: ContinuousClock(),
            drafts: drafts,
            jitter: { 0 },
            now: { [now] in now }
        )
        store.start()
        try await waitUntil("both machines' rows") {
            ["studio", "laptop"].allSatisfy { store.homeModel(for: $0)?.chats.map(\.id) == ["c1"] }
        }
        return store
    }

    // MARK: Opening

    func testOpeningAChatDoesNotChangeTheDefaultMachine() async throws {
        let navigation = AidenAppNavigation()
        let studioRequestsBefore = requests("studio")

        navigation.open(.chat(id()))
        let route = AidenChatRouteModel(id: id(), cache: cache)
        await route.load(coordinator: coordinator)

        guard case .ready(let chat, let owner) = route.state else {
            return XCTFail("The chat didn't open: \(route.state)")
        }
        XCTAssertEqual(chat.messages.map(\.text), ["from laptop"])
        XCTAssertEqual(owner.instanceId, "laptop")
        XCTAssertEqual(navigation.inboxPath, [.chat(id())])
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertEqual(requests("studio"), studioRequestsBefore, "The selected machine was asked about another's chat")
    }

    // MARK: Row actions

    func testARowActionGoesToTheOwningMachine() async throws {
        let store = try await inboxStore()
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats/c1/triage", status: 200, json: Self.triageJSON)

        await store.setTriage(.done(true), on: id())

        XCTAssertEqual(requests("laptop").filter { $0 == "POST /chats/c1/triage" }.count, 1)
        XCTAssertFalse(requests("studio").contains("POST /chats/c1/triage"))
        XCTAssertNotNil(store.homeModel(for: "laptop")?.chats.first?.inbox.doneAt)
        XCTAssertNil(store.homeModel(for: "studio")?.chats.first?.inbox.doneAt)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        store.stop()
    }

    func testMarkReadGoesToTheOwningMachine() async throws {
        let store = try await inboxStore(unread: true)
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats/c1/read", status: 204, json: Data())

        await store.markRead(id())

        XCTAssertEqual(requests("laptop").filter { $0 == "POST /chats/c1/read" }.count, 1)
        XCTAssertFalse(requests("studio").contains("POST /chats/c1/read"))
        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.first?.unread, false)
        XCTAssertEqual(store.homeModel(for: "studio")?.chats.first?.unread, true)
        store.stop()
    }

    func testDeletingGoesToTheOwningMachine() async throws {
        let store = try await inboxStore()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/c1", status: 204, json: Data())
        let saved = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: json(chatObject("c1", text: "saved")))
        _ = try await cache.saveChat(saved, instanceId: "laptop", writeToken: cache.reserveChatWrite())

        await store.delete(id())

        XCTAssertEqual(requests("laptop").filter { $0 == "DELETE /chats/c1" }.count, 1)
        XCTAssertFalse(requests("studio").contains("DELETE /chats/c1"))
        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.isEmpty, true)
        XCTAssertEqual(store.homeModel(for: "studio")?.chats.map(\.id), ["c1"], "The other machine's chat of that name went too")
        let left = await cache.loadChat(instanceId: "laptop", chatId: "c1")
        XCTAssertNil(left)
        store.stop()
    }

    func testAFailedDeleteBringsTheRowBackAndSaysSo() async throws {
        let store = try await inboxStore()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/c1", status: 500, json: json([
            "error": ["code": "internal_error", "message": "No.", "requestId": "r", "retryable": true],
        ]))

        await store.delete(id())

        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.map(\.id), ["c1"])
        XCTAssertNotNil(store.homeModel(for: "laptop")?.inboxNotice)
        store.stop()
    }

    func testAnActionOnAnOlderPairingOfAMachineGoesNowhere() async throws {
        let store = try await inboxStore()
        let older = AidenHostObjectID(instanceId: "laptop", deviceId: "older-device", objectId: "c1")
        let before = requests("laptop").count

        await store.setTriage(.done(true), on: older)
        await store.delete(older)

        XCTAssertEqual(requests("laptop").count, before)
        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.map(\.id), ["c1"])
        store.stop()
    }

    // MARK: Saved routes

    private func routeStores(
        defaults: UserDefaults = AidenDemoHosts.isolatedDefaults()
    ) -> (store: AidenAppNavigationStore, legacy: AidenProductNavigationStore, defaults: UserDefaults) {
        let legacy = AidenProductNavigationStore(defaults: defaults)
        return (AidenAppNavigationStore(defaults: defaults, legacy: legacy), legacy, defaults)
    }

    func testV1NavigationMigratesPerMachine() throws {
        let (store, legacy, _) = routeStores()
        // The same workspace id on both machines, and a machine that's gone.
        legacy.setCompactWorkspacePath(["workspace_app"], for: "studio")
        legacy.setCompactWorkspacePath(["workspace_app"], for: "laptop")
        legacy.setCompactBotPath([AidenBotChatRoute.pathValue(botID: "bot_1")], for: "studio")
        legacy.setCompactBotPath(["chat_9"], for: "laptop")
        legacy.setCompactWorkspacePath(["workspace_old"], for: "gone")

        let loaded = store.load(installations: [studio, laptop], selected: "studio")

        XCTAssertEqual(loaded.tab, .inbox)
        XCTAssertEqual(loaded.inboxPath, [])
        XCTAssertEqual(loaded.workspacesPath, [.workspace(id("workspace_app", on: "studio"))])
        XCTAssertEqual(loaded.botsPath, [.bot(id("bot_1", on: "studio"))])
        XCTAssertEqual(
            loaded.savedPath(on: .workspaces, of: laptop),
            [.workspace(id("workspace_app", on: "laptop"))],
            "Only one machine's place fits on a tab, and the other's must not be lost"
        )
        XCTAssertEqual(loaded.savedPath(on: .bots, of: laptop), [.chat(id("chat_9", on: "laptop"))])
        XCTAssertEqual(loaded.savedPaths.count, 2, "The machine that's gone came along")
    }

    func testV1StaysUntilTheFirstV2WriteLands() throws {
        let (store, legacy, defaults) = routeStores()
        legacy.setCompactWorkspacePath(["workspace_app"], for: "studio")
        legacy.setSelectedWorkspace("workspace_app", for: "studio")

        let loaded = store.load(installations: [studio, laptop], selected: "studio")

        XCTAssertNil(defaults.object(forKey: AidenAppNavigationStore.snapshotKey), "A read wrote v2")
        XCTAssertEqual(legacy.compactWorkspacePath(for: "studio"), ["workspace_app"], "A read cost v1 its paths")

        store.save(loaded)

        XCTAssertEqual(store.load().workspacesPath, loaded.workspacesPath)
        XCTAssertEqual(legacy.compactWorkspacePath(for: "studio"), [], "The paths stayed in v1 after they moved")
        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(restored.compactWorkspacePath(for: "studio"), [])
        XCTAssertEqual(restored.selectedWorkspace(for: "studio"), "workspace_app", "v1 holds more than paths")
    }

    /// `set` that goes nowhere: the write a full disk or a locked file would lose.
    private final class RefusingDefaults: UserDefaults {
        override func set(_ value: Any?, forKey defaultName: String) {}
    }

    func testAFailedV2WriteLeavesV1Alone() throws {
        let suite = "AidenOwnerRoutingTests-\(UUID().uuidString)"
        let refusing = try XCTUnwrap(RefusingDefaults(suiteName: suite))
        let plain = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { plain.removePersistentDomain(forName: suite) }
        AidenProductNavigationStore(defaults: plain).setCompactWorkspacePath(["workspace_app"], for: "studio")
        let v1 = plain.data(forKey: "aiden.product-navigation.v1")
        let legacy = AidenProductNavigationStore(defaults: plain)
        let store = AidenAppNavigationStore(defaults: refusing, legacy: legacy)

        store.save(store.load(installations: [studio], selected: "studio"))

        XCTAssertEqual(plain.data(forKey: "aiden.product-navigation.v1"), v1)
        XCTAssertEqual(legacy.compactWorkspacePath(for: "studio"), ["workspace_app"])
    }

    func testAV2TooBigToSaveLeavesV1Alone() throws {
        let (store, legacy, defaults) = routeStores()
        legacy.setCompactWorkspacePath(["workspace_app"], for: "studio")
        let huge = String(repeating: "x", count: 1_100_000)

        store.save(AidenAppNavigationSnapshot(inboxPath: [.chat(id(huge))]))

        XCTAssertNil(defaults.object(forKey: AidenAppNavigationStore.snapshotKey))
        XCTAssertEqual(legacy.compactWorkspacePath(for: "studio"), ["workspace_app"])
    }

    func testALaterWriteLeavesTheMenuShellsPathsAlone() {
        let (store, legacy, _) = routeStores()
        store.save(AidenAppNavigationSnapshot())
        legacy.setCompactBotPath(["chat_9"], for: "studio")

        store.save(AidenAppNavigationSnapshot(tab: .bots))

        XCTAssertEqual(legacy.compactBotPath(for: "studio"), ["chat_9"], "Only the write that moved the paths may take them")
    }

    func testACorruptV2FallsBackToTheInbox() {
        let (store, legacy, defaults) = routeStores()
        legacy.setCompactWorkspacePath(["workspace_app"], for: "studio")
        defaults.set(Data("not json".utf8), forKey: AidenAppNavigationStore.snapshotKey)

        let loaded = store.load(installations: [studio, laptop], selected: "studio")

        XCTAssertEqual(loaded, AidenAppNavigationSnapshot(), "A saved v2 has replaced v1, readable or not")
        let navigation = AidenAppNavigation(restoring: loaded, installations: [studio, laptop])
        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [])
    }

    func testAMachineThatLeavesTakesItsSavedPathsWithIt() {
        let (store, legacy, _) = routeStores()
        legacy.setCompactWorkspacePath(["workspace_app"], for: "laptop")
        let snapshot = store.load(installations: [studio, laptop], selected: "studio")
        let navigation = AidenAppNavigation(restoring: snapshot, installations: [studio, laptop])
        XCTAssertEqual(navigation.snapshot.savedPaths.count, 1)

        navigation.dropRoutes(outside: [studio])

        XCTAssertEqual(navigation.snapshot.savedPaths, [:])
    }

    func testPurgingAMachineRemovesItsSavedRoutes() {
        let (store, _, _) = routeStores()
        store.save(AidenAppNavigationSnapshot(
            tab: .workspaces,
            inboxPath: [.settings, .chat(id(on: "laptop"))],
            botsPath: [.bot(id("b1", on: "studio"))],
            workspacesPath: [.workspace(id("w1", on: "laptop"))],
            savedPaths: AidenAppNavigationSnapshot.savedPaths(of: laptop, on: .bots, [.chat(id("c9", on: "laptop"))])
        ))

        store.purge(instanceID: "laptop")

        let left = store.load()
        XCTAssertEqual(left.tab, .workspaces)
        XCTAssertEqual(left.inboxPath, [])
        XCTAssertEqual(left.botsPath, [.bot(id("b1", on: "studio"))])
        XCTAssertEqual(left.workspacesPath, [])
        XCTAssertEqual(left.savedPaths, [:])
    }

    func testPurgingBeforeAnyV2WriteLeavesV1ToMigrate() {
        let (store, legacy, defaults) = routeStores()
        legacy.setCompactWorkspacePath(["workspace_app"], for: "studio")

        store.purge(instanceID: "laptop")

        XCTAssertNil(defaults.object(forKey: AidenAppNavigationStore.snapshotKey))
        XCTAssertEqual(legacy.compactWorkspacePath(for: "studio"), ["workspace_app"])
    }

    // MARK: Links

    func testADeepLinkToAnotherMachineOpensWithoutSwitchingAndKeepsConsent() async throws {
        // A Live Activity's tap is this same link.
        let link = try XCTUnwrap(AidenDeepLink.request(from: try XCTUnwrap(
            AidenDeepLink.chatURL(instanceId: "laptop", chatId: "c1")
        )))
        XCTAssertTrue(coordinator.acceptLink(link))
        let route = try XCTUnwrap(AidenAppRoute(
            request: link,
            installations: coordinator.installationStore.installations,
            activeInstanceId: coordinator.activeInstanceId
        ))
        XCTAssertEqual(route, .chat(id()))
        XCTAssertEqual(coordinator.activeInstanceId, "studio")

        // A new chat is the one link that writes, so it asks first, and it asks
        // about the machine it names.
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats", status: 201, json: json(chatObject("c_new", text: "hello")))
        let consent = AidenNewChatLinkConsent()
        let installation = try connection("laptop").installation
        let target = AidenNewChatLinkConsent.Target(
            instanceID: "laptop",
            deviceID: installation.deviceId,
            pairedAt: installation.createdAt,
            installationName: installation.name,
            workspaceID: "workspace_app",
            workspaceName: "Aiden Agent",
            origin: try coordinator.requestContext(),
            startsVoice: false,
            createdAt: Date()
        )
        XCTAssertTrue(consent.propose(target))
        XCTAssertFalse(requests("laptop").contains("POST /chats"), "Nothing was agreed to yet")

        let opened = try await consent.perform(id: target.id, isValid: { true }) { agreed in
            try await self.coordinator.createChat(agreedTo: agreed)
        }

        XCTAssertEqual(opened?.destination, .chat("c_new"))
        XCTAssertEqual(opened?.instanceId, "laptop")
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertFalse(requests("studio").contains("POST /chats"))

        let again = try await consent.perform(id: target.id, isValid: { true }) { agreed in
            try await self.coordinator.createChat(agreedTo: agreed)
        }
        XCTAssertNil(again, "Consent is good for one chat")
        XCTAssertEqual(requests("laptop").filter { $0 == "POST /chats" }.count, 1)
    }

    func testAConsentedChatStopsIfTheMachineWasPairedAgain() async throws {
        let installation = try connection("laptop").installation
        let target = AidenNewChatLinkConsent.Target(
            instanceID: "laptop",
            deviceID: "older-device",
            pairedAt: installation.createdAt,
            installationName: installation.name,
            workspaceID: "workspace_app",
            workspaceName: "Aiden Agent",
            origin: nil,
            startsVoice: false,
            createdAt: Date()
        )

        let opened = try await coordinator.createChat(agreedTo: target)

        XCTAssertNil(opened)
        XCTAssertFalse(requests("laptop").contains("POST /chats"))
    }

    func testADeepLinkToAnUnpairedMachineExplainsItself() async throws {
        let link = try XCTUnwrap(AidenDeepLink.request(from: try XCTUnwrap(
            AidenDeepLink.chatURL(instanceId: "gone", chatId: "c1")
        )))

        XCTAssertFalse(coordinator.acceptLink(link))

        XCTAssertEqual(coordinator.presentedError, "This machine is no longer paired. Pair it again to continue.")
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertEqual(requests("gone"), [])
    }

    func testADeepLinkToARevokedMachineExplainsItself() async throws {
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        let link = try XCTUnwrap(AidenDeepLink.request(from: try XCTUnwrap(
            AidenDeepLink.chatURL(instanceId: "laptop", chatId: "c1")
        )))

        XCTAssertFalse(coordinator.acceptLink(link))

        XCTAssertEqual(coordinator.presentedError, "This machine is no longer paired. Pair it again to continue.")
        coordinator.setOnScreen(false, view: view, instanceId: "laptop")
    }

    func testALinkThatNamesNoMachineOpensOnTheSelectedOne() async throws {
        let link = try XCTUnwrap(AidenDeepLink.request(from: try XCTUnwrap(AidenDeepLink.botChatURL(instanceId: nil, botId: "b1"))))

        XCTAssertTrue(coordinator.acceptLink(link))

        XCTAssertNil(coordinator.presentedError)
    }

    // MARK: A revoked machine's chat

    func testARevokedMachinesChatShowsTheNoticeThenPurgesOnLeaving() async throws {
        let route = AidenChatRouteModel(id: id(), cache: cache)
        await route.load(coordinator: coordinator)
        let model = try chatModel()
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        XCTAssertNil(model.revokedMachineNotice)

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))

        XCTAssertEqual(model.revokedMachineNotice?.machineName, "Laptop")
        XCTAssertEqual(model.chat.messages.map(\.text), ["from laptop"], "The chat must not vanish")
        await route.load(coordinator: coordinator)
        guard case .ready = route.state else { return XCTFail("The route gave up on the chat on screen: \(route.state)") }
        XCTAssertNotNil(coordinator.hosts.connection(for: "laptop"), "Purged under the person reading it")
        XCTAssertEqual(coordinator.activeInstanceId, "studio")

        model.setViewPresent(false)

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "laptop") == nil }
        XCTAssertFalse(coordinator.installationStore.installations.contains { $0.id == "laptop" })
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    // MARK: Words on a machine that revoked this phone

    /// Starts a send that's held on its way to `laptop`, on a chat that's on screen.
    private func heldSend() async throws -> (AidenChatViewModel, Task<Void, Never>, @Sendable () -> Void, Int) {
        let model = try chatModel()
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        let before = model.chat.messages.count
        model.draft = "Keep these words"
        let release = responder.hold(instanceId: "laptop", path: "/chats/c1/turns")
        let send = Task { await model.send() }
        try await waitUntil("the send to reach the machine") { self.requests("laptop").contains("POST /chats/c1/turns") }
        return (model, send, release, before)
    }

    private func assertTheWordsSurvived(_ model: AidenChatViewModel, before: Int, line: UInt = #line) {
        XCTAssertEqual(model.draft, "Keep these words", line: line)
        XCTAssertEqual(model.chat.messages.count, before, "The bubble of a send that failed stayed", line: line)
        XCTAssertNil(model.streamState, "The chat still reads as sending", line: line)
        XCTAssertNil(model.pendingSend, "A revoked machine can't take a retry", line: line)
        XCTAssertEqual(model.presentedError, AidenDockCopy.machineRevoked, line: line)
    }

    /// The send's own answer says nothing about the revocation, which another
    /// request found out about first.
    func testASendThatFailsAfterARevocationKeepsItsWords() async throws {
        let (model, send, release, before) = try await heldSend()
        responder.fail(instanceId: "laptop", path: "/chats/c1/turns", code: .networkConnectionLost)

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        release()
        await send.value

        assertTheWordsSurvived(model, before: before)
        model.setViewPresent(false)
    }

    func testASendCancelledAfterARevocationKeepsItsWords() async throws {
        let (model, send, release, before) = try await heldSend()

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        send.cancel()
        await send.value
        release()

        assertTheWordsSurvived(model, before: before)
        model.setViewPresent(false)
    }

    /// Revoked in the moment before the request leaves, when the send is saving
    /// itself to disk.
    func testASendCaughtBeforeItLeavesKeepsItsWords() async throws {
        let model = try chatModel()
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        let before = model.chat.messages.count
        model.draft = "Keep these words"
        let release = responder.hold(instanceId: "laptop", path: "/chats/c1/turns")
        responder.fail(instanceId: "laptop", path: "/chats/c1/turns", code: .networkConnectionLost)

        let send = Task { await model.send() }
        await Task.yield()
        XCTAssertTrue(model.isStarting, "The send hasn't started")
        XCTAssertFalse(requests("laptop").contains("POST /chats/c1/turns"), "The send left first")
        try connection("laptop").markRevokedWithPurgePending()
        release()
        await send.value

        assertTheWordsSurvived(model, before: before)
        model.setViewPresent(false)
    }

    func testARunInputThatFailsAfterARevocationKeepsItsWords() async throws {
        let model = try chatModel()
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        model.streamState = .running
        model.activeStreamID = "stream_1"
        model.draft = "Keep these words"
        let release = responder.hold(instanceId: "laptop", path: "/streams/stream_1/inputs")
        responder.fail(instanceId: "laptop", path: "/streams/stream_1/inputs", code: .networkConnectionLost)

        let submit = Task { await model.submitRunInput(.steer) }
        try await waitUntil("the input to reach the machine") {
            self.requests("laptop").contains("POST /streams/stream_1/inputs")
        }
        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        release()
        await submit.value

        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertNil(model.pendingSend, "A revoked machine can't take a retry")
        XCTAssertEqual(model.presentedError, AidenDockCopy.machineRevoked)
        model.setViewPresent(false)
    }

    // MARK: A chat reads its own machine

    /// `workspace_app` on both machines, under different names.
    private func nameTheLaptopsWorkspace(_ name: String) throws {
        try connection("laptop").adopt(workspaces: [AidenRemoteJSONDecoder.decode(AidenWorkspace.self, from: Data("""
        {"id":"workspace_app","name":"\(name)","permission":"ask","memoryEnabled":true,"hasFolder":true,
        "isManagedWorktree":false,"createdAt":"2026-11-05T09:00:00.000Z","updatedAt":"2026-11-05T09:00:00.000Z",
        "revision":"workspace_revision_7"}
        """.utf8))])
    }

    func testAChatFindsItsWorkspaceOnItsOwnMachine() async throws {
        try nameTheLaptopsWorkspace("The laptop copy")

        let model = try chatModel()

        XCTAssertEqual(model.ownerWorkspace?.name, "The laptop copy")
        XCTAssertNotEqual(try chatModel(owner: "studio").ownerWorkspace?.name, "The laptop copy")
    }

    func testAChatFollowsItsOwnMachinesConnection() async throws {
        let model = try chatModel()
        XCTAssertEqual(model.ownerConnectionState, .connected)
        let serverTime = model.ownerServer?.serverTime

        try connection("laptop").adopt(connectionState: .connecting)

        XCTAssertEqual(model.ownerConnectionState, .connecting, "The reload follows the selected machine")
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(model.ownerServer?.serverTime, serverTime)
    }

    func testAChatListsSimulatorsFromItsOwnMachine() async throws {
        var withSimulators = laptop
        withSimulators.serverFeatures.append(AidenServer.mobileSimulatorsFeature)
        withSimulators.serverCapabilities?.append(.simulatorsMobile)
        withSimulators.deviceCapabilities.append(.simulatorsMobile)
        try await connect([studio, withSimulators])
        responder.reply(instanceId: "laptop", path: "/simulators", status: 200, json: json([
            "sharing": true, "status": "ready", "devices": [], "chatDeviceIds": [],
        ]))
        let simulators = AidenChatSimulatorsModel()
        let model = try chatModel()
        XCTAssertNotNil(model.simulatorsClient)
        XCTAssertNil(try chatModel(owner: "studio").simulatorsClient, "The selected machine doesn't offer them")

        await simulators.refresh(client: model.simulatorsClient, chatId: "c1")

        XCTAssertEqual(requests("laptop").filter { $0 == "GET /simulators" }.count, 1)
        XCTAssertFalse(requests("studio").contains("GET /simulators"))
        XCTAssertNotNil(simulators.listing)
    }

    func testAChatsFilesComeFromItsOwnMachine() async throws {
        responder.reply(instanceId: "laptop", path: "/workspaces/workspace_app/files", status: 200, json: json([
            "snapshotId": "snapshot_1", "entries": [], "truncated": false, "maxEntries": 4000, "maxDepth": 20,
            "directoryPath": "",
        ]))
        let chat = try chatModel()
        let workspace = try XCTUnwrap(chat.ownerWorkspace)
        let files = AidenWorkspaceFilesModel(workspace: workspace, owner: chat.owner)

        await files.load(coordinator: coordinator)

        XCTAssertNotNil(files.index)
        XCTAssertTrue(requests("laptop").contains("GET /workspaces/workspace_app/files"))
        XCTAssertFalse(requests("studio").contains("GET /workspaces/workspace_app/files"))
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    func testAForkOpensOnItsParentsMachine() async throws {
        let parent = try chatModel()
        var trail = AidenChatForkTrail()

        trail.open(emptyChat("fork"), fromDepth: 0, owner: parent.owner)

        XCTAssertEqual(AidenChatDetailView.owner(trail.owner, coordinator: coordinator).instanceId, "laptop")
        XCTAssertEqual(trail.forks.map(\.id), ["fork"])
    }

    func testTheTabShellOpensForksOfAChatOnAnyMachine() throws {
        let laptopChat = try chatModel()
        let studioChat = try chatModel(owner: "studio")

        XCTAssertTrue(laptopChat.opensForks(inTabShell: true))
        XCTAssertFalse(laptopChat.opensForks(inTabShell: false), "The menu shell would file it under the selected machine")
        XCTAssertTrue(studioChat.opensForks(inTabShell: false))
    }
}
#endif
