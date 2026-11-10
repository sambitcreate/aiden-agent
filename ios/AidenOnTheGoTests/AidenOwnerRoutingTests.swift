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
    private func connect(_ installations: [AidenInstallation], tabShell: Bool = false) async throws {
        pair(installations, tabShell: tabShell)
        await launch()
        try await waitUntil("every machine to connect") {
            self.coordinator.hosts.ordered.allSatisfy { $0.connectionState == .connected }
        }
    }

    /// Registers each machine's standard answers, so anything a test wants
    /// instead goes in after this.
    private func pair(_ installations: [AidenInstallation], tabShell: Bool = false) {
        coordinator = AidenDemoHosts.coordinator(
            installations: installations,
            responder: responder,
            machinePreferences: AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults()),
            tabShell: tabShell
        )
        scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
    }

    private func launch() async {
        await coordinator.start()
        await scheduler.foregrounded()
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

    private func chatObject(_ chatId: String, text: String, workspace: String = "workspace_app") -> [String: Any] {
        [
            "id": chatId,
            "workspaceId": workspace,
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

    private func transcript(
        _ text: String,
        on instanceId: String,
        chat chatId: String = "c1",
        workspace: String = "workspace_app"
    ) {
        responder.reply(
            instanceId: instanceId,
            path: "/chats/\(chatId)",
            status: 200,
            json: json(chatObject(chatId, text: text, workspace: workspace))
        )
    }

    private func workspaceObject(_ id: String, name: String = "A workspace", noWorkspace: Bool = false) -> [String: Any] {
        [
            "id": id, "name": name, "permission": "ask", "memoryEnabled": true, "hasFolder": true,
            "isManagedWorktree": false, "noWorkspace": noWorkspace,
            "createdAt": "2026-11-05T09:00:00.000Z", "updatedAt": "2026-11-05T09:00:00.000Z",
            "revision": "workspace_revision_7",
        ]
    }

    private func listWorkspaces(_ workspaces: [[String: Any]], on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/workspaces", status: 200, json: json(["workspaces": workspaces]))
    }

    private func workspaceReads(_ instanceId: String) -> Int {
        requests(instanceId).filter { $0 == "GET /workspaces" }.count
    }

    private func refusal(of route: AidenChatRouteModel, file: StaticString = #filePath, line: UInt = #line) -> String? {
        guard case .unavailable(let message) = route.state else {
            XCTFail("The chat opened: \(route.state)", file: file, line: line)
            return nil
        }
        return message
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
    private func inboxStore(unread: Bool = false, served: Bool = true) async throws -> AidenUnifiedInboxStore {
        for instanceId in ["studio", "laptop"] where served {
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
            ["studio", "laptop"].allSatisfy { store.homeModel(for: $0)?.chats.contains { $0.id == "c1" } == true }
        }
        return store
    }

    // MARK: Workspaces

    /// Each machine has a workspace called `"default"`, with chats of its own.
    private func serveDefaultWorkspaces() {
        for (instanceId, name) in [("studio", "Studio project"), ("laptop", "Laptop project")] {
            listWorkspaces([workspaceObject("default", name: name)], on: instanceId)
            responder.reply(
                instanceId: instanceId,
                path: "/chats",
                status: 200,
                json: json(["chats": [chatObject("\(instanceId)-chat", text: "Hi from \(instanceId)", workspace: "default")]])
            )
        }
    }

    func testADefaultWorkspaceOpensOnItsOwnMachine() async throws {
        serveDefaultWorkspaces()
        try await coordinator.hosts.connection(for: "laptop")?.refreshWorkspacesForPoll()
        let model = AidenWorkspaceChatsModel(
            coordinator: coordinator,
            owner: try coordinator.ownerContext(for: "laptop"),
            workspaceId: "default",
            cache: cache
        )

        await model.load()

        XCTAssertEqual(model.chats.map(\.id), ["laptop-chat"])
        XCTAssertTrue(requests("laptop").contains("GET /chats"))
        XCTAssertFalse(requests("studio").contains("GET /chats"))
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        // The selected machine's namesake is its own.
        let selected = AidenWorkspaceChatsModel(coordinator: coordinator, owner: nil, workspaceId: "default", cache: cache)
        await selected.load()
        XCTAssertEqual(selected.chats.map(\.id), ["studio-chat"])
    }

    func testAWorkspaceOnAMachineThatLeftReadsNothing() async throws {
        serveDefaultWorkspaces()
        let owner = try coordinator.ownerContext(for: "laptop")
        let model = AidenWorkspaceChatsModel(coordinator: coordinator, owner: owner, workspaceId: "default", cache: cache)
        await coordinator.removeInstallation("laptop")

        await model.load()

        XCTAssertTrue(model.chats.isEmpty)
        XCTAssertFalse(requests("laptop").contains("GET /chats"))
        XCTAssertFalse(requests("studio").contains("GET /chats"))
    }

    // MARK: Workspace Settings

    /// Both machines list a "default" workspace; this is the laptop's, as it read it.
    private func laptopsDefault() async throws -> AidenWorkspace {
        serveDefaultWorkspaces()
        try await connection("laptop").refreshWorkspacesForPoll()
        return try XCTUnwrap(try connection("laptop").workspaces.first { $0.id == "default" })
    }

    func testWorkspaceSettingsSaveOnTheWorkspacesOwnMachine() async throws {
        let workspace = try await laptopsDefault()
        responder.reply(
            instanceId: "laptop",
            method: "PATCH",
            path: "/workspaces/default",
            status: 200,
            json: json(workspaceObject("default", name: "Renamed"))
        )

        let outcome = await coordinator.updateWorkspaceOutcome(
            workspace,
            name: "Renamed",
            on: try coordinator.ownerContext(for: "laptop")
        )

        XCTAssertEqual(outcome.value?.name, "Renamed")
        XCTAssertTrue(requests("laptop").contains("PATCH /workspaces/default"))
        XCTAssertFalse(requests("studio").contains("PATCH /workspaces/default"))
        XCTAssertEqual(try connection("laptop").workspaces.first { $0.id == "default" }?.name, "Renamed")
        XCTAssertNotEqual(coordinator.workspaces.first { $0.id == "default" }?.name, "Renamed")
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testWorkspaceSettingsRemoveFromTheWorkspacesOwnMachine() async throws {
        let workspace = try await laptopsDefault()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/workspaces/default", status: 204, json: Data())

        let outcome = await coordinator.removeWorkspaceOutcome(workspace, on: try coordinator.ownerContext(for: "laptop"))

        guard case .success = outcome else { return XCTFail("Not removed: \(outcome)") }
        XCTAssertTrue(requests("laptop").contains("DELETE /workspaces/default"))
        XCTAssertFalse(requests("studio").contains("DELETE /workspaces/default"))
    }

    /// An open Settings sheet stays with the machine it opened on: once the default
    /// moves, a save can't reach the new default's same-id "default".
    func testWorkspaceSettingsNeverSaveToANewDefaultsNamesake() async throws {
        serveDefaultWorkspaces()
        try await connection("studio").refreshWorkspacesForPoll()
        let studiosDefault = try XCTUnwrap(coordinator.workspaces.first { $0.id == "default" })
        let openedOn = try coordinator.requestContext()
        let laptopOwner = try coordinator.ownerContext(for: "laptop")
        let laptopsDefault = try await laptopsDefault()
        for instanceId in ["studio", "laptop"] {
            responder.reply(
                instanceId: instanceId,
                method: "PATCH",
                path: "/workspaces/default",
                status: 200,
                json: json(workspaceObject("default", name: "Renamed"))
            )
        }

        coordinator.setDefaultMachine("laptop")
        let stale = await coordinator.updateWorkspaceOutcome(studiosDefault, name: "Renamed", on: openedOn)
        // A sheet opened for the laptop's workspace keeps saving there.
        let owned = await coordinator.updateWorkspaceOutcome(laptopsDefault, name: "Renamed", on: laptopOwner)

        guard case .stale = stale else { return XCTFail("Saved somewhere: \(stale)") }
        XCTAssertFalse(requests("studio").contains("PATCH /workspaces/default"))
        XCTAssertEqual(requests("laptop").filter { $0 == "PATCH /workspaces/default" }.count, 1)
        XCTAssertEqual(owned.value?.name, "Renamed")
    }

    func testAWorkspaceRouteFindsItsOwnMachinesWorkspace() async throws {
        serveDefaultWorkspaces()
        try await connection("studio").refreshWorkspacesForPoll()
        try await connection("laptop").refreshWorkspacesForPoll()

        XCTAssertEqual(AidenWorkspaceRoute.workspace(for: id("default", on: "laptop"), coordinator: coordinator)?.name, "Laptop project")
        XCTAssertEqual(AidenWorkspaceRoute.workspace(for: id("default", on: "studio"), coordinator: coordinator)?.name, "Studio project")
        // An older pairing of the laptop finds nothing.
        let older = AidenHostObjectID(instanceId: "laptop", deviceId: "older-device", objectId: "default")
        XCTAssertNil(AidenWorkspaceRoute.workspace(for: older, coordinator: coordinator))
        // Archived on this device for the laptop only.
        coordinator.workspaceArchiveStore.archive(workspaceID: "default", instanceID: "laptop")
        XCTAssertNil(AidenWorkspaceRoute.workspace(for: id("default", on: "laptop"), coordinator: coordinator))
        XCTAssertNotNil(AidenWorkspaceRoute.workspace(for: id("default", on: "studio"), coordinator: coordinator))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testWorkspaceGitRunsOnTheWorkspacesOwnMachine() async throws {
        _ = try await laptopsDefault()
        let model = AidenWorkspaceGitModel()

        await model.refresh(
            on: AidenWorkspaceGitTarget(coordinator: coordinator, context: try coordinator.ownerContext(for: "laptop")),
            workspaceId: "default"
        )

        XCTAssertTrue(requests("laptop").contains("GET /workspaces/default/git/review"))
        XCTAssertFalse(requests("studio").contains { $0.contains("/git/") })
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testWorkspaceGitWaitsForItsOwnMachineToConnect() async throws {
        _ = try await laptopsDefault()
        let target = AidenWorkspaceGitTarget(coordinator: coordinator, context: try coordinator.ownerContext(for: "laptop"))
        XCTAssertTrue(target.isConnected)
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))
        XCTAssertFalse(target.isConnected)
        XCTAssertEqual(coordinator.connectionState, .connected)

        let model = AidenWorkspaceGitModel()
        await model.refresh(on: target, workspaceId: "default")

        XCTAssertNotNil(model.errorMessage)
        XCTAssertFalse(requests("laptop").contains { $0.contains("/git/") })
    }

    private var serverFailure: Data {
        json(["error": ["code": "internal_error", "message": "No.", "requestId": "r", "retryable": false]])
    }

    func testAFailedWorkspaceSaveOnAnotherMachineSaysSo() async throws {
        let workspace = try await laptopsDefault()
        responder.reply(instanceId: "laptop", method: "PATCH", path: "/workspaces/default", status: 500, json: serverFailure)

        let outcome = await coordinator.updateWorkspaceOutcome(
            workspace,
            name: "Renamed",
            on: try coordinator.ownerContext(for: "laptop")
        )

        guard case .failure = outcome else { return XCTFail("Not a failure: \(outcome)") }
        let message = try XCTUnwrap(coordinator.presentedError)
        XCTAssertTrue(message.hasPrefix("Couldn’t save this workspace on Laptop."), message)
    }

    func testAFailedWorkspaceRemoveOnAnotherMachineSaysSo() async throws {
        let workspace = try await laptopsDefault()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/workspaces/default", status: 500, json: serverFailure)

        let outcome = await coordinator.removeWorkspaceOutcome(workspace, on: try coordinator.ownerContext(for: "laptop"))

        guard case .failure = outcome else { return XCTFail("Not a failure: \(outcome)") }
        let message = try XCTUnwrap(coordinator.presentedError)
        XCTAssertTrue(message.hasPrefix("Couldn’t remove this workspace from Laptop."), message)
    }

    // MARK: Bots

    /// A Bot on the laptop opens there, with the studio still the default.
    func testABotRouteOpensOnItsOwnMachine() async throws {
        let model = AidenBotRouteModel(id: id("bot_scout", on: "laptop"))

        await model.load(coordinator: coordinator)

        XCTAssertEqual(model.state, .session)
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    /// A machine from before durable sessions finds the Bot's chat on itself.
    func testABotRouteOnAnOlderMachineAsksThatMachine() async throws {
        var older = laptop
        older.serverFeatures = older.serverFeatures.filter { $0 != "bot-durable-session-v1" }
        try await connect([studio, older])
        let model = AidenBotRouteModel(id: id("bot_scout", on: "laptop"))

        await model.load(coordinator: coordinator)

        XCTAssertNotEqual(model.state, .session)
        XCTAssertTrue(requests("laptop").contains("GET /bot-conversations"))
        XCTAssertFalse(requests("studio").contains("GET /bot-conversations"))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }


    /// A Bot chat opened on the laptop, with the studio as the default, sends
    /// Profile, Advanced, Files and Delete to the laptop.
    func testABotChatOnAnotherMachineSendsItsToolsThere() async throws {
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/bots/bot_scout", status: 204, json: Data())
        let list = try await coordinator.remoteClient(for: coordinator.ownerContext(for: "laptop")).bots()
        let summary = try XCTUnwrap(list.bots.first)
        let view = AidenBotSessionChatView(
            coordinator: coordinator,
            botID: "bot_scout",
            initialSummary: summary,
            machine: "laptop",
            staysOnItsMachine: true
        )
        let tools = view.tools

        XCTAssertEqual(tools.profile(summary, opensMemory: false, onChanged: {}, onDeleted: {}).machine, "laptop")
        XCTAssertEqual(tools.advanced(onSaved: { _ in }, onSaveFailed: { _ in }).machine, "laptop")
        let files = tools.filesTools(chatID: "chat_bot_scout")
        XCTAssertEqual(files.machine, "laptop")
        XCTAssertTrue(tools.canDelete)
        await files.load(coordinator: coordinator)
        try await tools.delete()

        XCTAssertTrue(requests("laptop").contains("GET /bots/bot_scout"))
        XCTAssertTrue(requests("laptop").contains("DELETE /bots/bot_scout"))
        XCTAssertFalse(requests("studio").contains { $0.hasSuffix("/bots/bot_scout") })
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testABotsDeleteGoesToItsOwnMachine() async throws {
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/bots/bot_scout", status: 204, json: Data())
        XCTAssertTrue(AidenBotDeletion.isAvailable(coordinator: coordinator, machine: "laptop"))

        try await AidenBotDeletion.deleteListed(botID: "bot_scout", coordinator: coordinator, machine: "laptop")

        XCTAssertTrue(requests("laptop").contains("DELETE /bots/bot_scout"))
        XCTAssertFalse(requests("studio").contains { $0.hasPrefix("DELETE /bots") || $0 == "GET /bots/bot_scout" })
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testABotsToolsReadItsOwnMachine() async throws {
        let tools = AidenBotChatToolsModel(chatID: "chat_bot_scout", botID: "bot_scout", machine: "laptop")

        await tools.load(coordinator: coordinator)

        XCTAssertTrue(requests("laptop").contains("GET /bots/bot_scout"))
        XCTAssertFalse(requests("studio").contains("GET /bots/bot_scout"))
        XCTAssertFalse(requests("studio").contains("GET /bot-capabilities"))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
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

        await store.perform(.done, on: id())

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

        await store.perform(.markRead, on: id())

        XCTAssertEqual(requests("laptop").filter { $0 == "POST /chats/c1/read" }.count, 1)
        XCTAssertFalse(requests("studio").contains("POST /chats/c1/read"))
        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.first?.unread, false)
        XCTAssertEqual(store.homeModel(for: "studio")?.chats.first?.unread, true)
        store.stop()
    }

    func testARowsDeleteGoesThroughTheRowActions() async throws {
        let store = try await inboxStore()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/c1", status: 204, json: Data())
        store.homeModel(for: "studio")?.inboxNotice = AidenInboxNotice(message: "From the last action")

        await store.perform(.delete, on: id())

        XCTAssertEqual(requests("laptop").filter { $0 == "DELETE /chats/c1" }.count, 1)
        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.isEmpty, true)
        XCTAssertNil(store.notice, "A new action leaves the last one's banner up")
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

    func testDeletingReadsTheOwnersWorkspacesAgain() async throws {
        let store = try await inboxStore()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/c1", status: 204, json: Data())
        let laptopReads = workspaceReads("laptop")
        let studioReads = workspaceReads("studio")

        await store.delete(id())

        XCTAssertEqual(workspaceReads("laptop"), laptopReads + 1, "The chat's hidden folder stays listed")
        XCTAssertEqual(workspaceReads("studio"), studioReads)
        store.stop()
    }

    func testADeleteWithTheMachineAwayBringsTheRowBack() async throws {
        let store = try await inboxStore()
        let before = try XCTUnwrap(store.homeModel(for: "laptop")?.chats)
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)

        await store.delete(id())

        XCTAssertEqual(store.homeModel(for: "laptop")?.chats, before, "The words say it's back")
        XCTAssertNotNil(store.homeModel(for: "laptop")?.inboxNotice)
        let saved = await cache.loadChatSummaries(instanceId: "laptop")
        XCTAssertEqual(saved?.summaries.map(\.id), ["c1"], "It would be gone at the next launch")
        store.stop()
    }

    func testACancelledDeleteBringsTheRowBackQuietly() async throws {
        let store = try await inboxStore()
        let release = responder.hold(instanceId: "laptop", path: "/chats/c1")

        let deleting = Task { await store.delete(id()) }
        // Not the request: the Inbox's transcript prefetch reads this path too.
        try await waitUntil("the row to go") { store.homeModel(for: "laptop")?.chats.isEmpty == true }
        deleting.cancel()
        await deleting.value
        release()

        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.map(\.id), ["c1"])
        XCTAssertNil(store.homeModel(for: "laptop")?.inboxNotice)
        store.stop()
    }

    func testARowRestoredAfterAFailedDeleteKeepsItsPlace() async throws {
        for instanceId in ["studio", "laptop"] {
            responder.reply(instanceId: instanceId, path: "/chat-summaries", status: 200, json: json([
                "summaries": [row("c0"), row(), row("c2")],
            ]))
        }
        let store = try await inboxStore(served: false)
        try await waitUntil("the rows") { store.homeModel(for: "laptop")?.chats.count == 3 }
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)

        await store.delete(id())

        XCTAssertEqual(store.homeModel(for: "laptop")?.chats.map(\.id), ["c0", "c1", "c2"])
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

        await store.perform(.done, on: older)
        await store.perform(.delete, on: older)

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
        // about the machine it names. This is the chain a link takes after
        // `onOpenURL`: what the prompt offers, the prompt, and what agreeing does.
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats", status: 201, json: json(chatObject("c_new", text: "hello")))
        let newChat = try XCTUnwrap(AidenDeepLink.request(from: try XCTUnwrap(
            AidenDeepLink.newChatURL(instanceId: "laptop", workspaceId: "workspace_app", startsVoice: true)
        )))
        XCTAssertFalse(newChat.startsVoice, "A link is never consent to record")
        let consent = AidenNewChatLinkConsent()
        let target = try XCTUnwrap(coordinator.newChatTarget(for: newChat, startsVoice: false, tabShell: true))
        XCTAssertEqual(target.instanceID, "laptop")
        XCTAssertEqual(target.installationName, "Laptop", "The prompt names the wrong machine")
        XCTAssertEqual(target.workspaceID, "workspace_app")
        XCTAssertTrue(consent.propose(target))
        let stillValid = { target.origin.map(self.coordinator.isCurrent) == true }

        let opened = try await consent.perform(id: target.id, isValid: stillValid) { agreed in
            try await self.coordinator.createChat(agreedTo: agreed)
        }

        XCTAssertEqual(opened?.destination, .chat("c_new"))
        XCTAssertEqual(opened?.instanceId, "laptop")
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertFalse(requests("studio").contains("POST /chats"))

        let again = try await consent.perform(id: target.id, isValid: stillValid) { agreed in
            try await self.coordinator.createChat(agreedTo: agreed)
        }
        XCTAssertNil(again, "Consent is good for one chat")
        XCTAssertEqual(requests("laptop").filter { $0 == "POST /chats" }.count, 1)
    }

    func testANewChatLinkWaitsForItsOwnMachineNotTheSelectedOne() throws {
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_app", startsVoice: false)
        try connection("laptop").adopt(connectionState: .connecting)

        XCTAssertNil(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))

        try connection("laptop").adopt(connectionState: .connected)
        try connection("studio").adopt(connectionState: .connecting)
        XCTAssertNotNil(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))
    }

    func testANewChatLinkIsNotOfferedInAnArchivedWorkspace() {
        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "laptop")
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_app", startsVoice: false)

        XCTAssertNil(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))

        XCTAssertNotNil(coordinator.presentedError)
    }

    func testAgreeingCreatesNothingOnAMachineThatTakesNoWrites() async throws {
        var readOnly = laptop
        readOnly.deviceCapabilities.removeAll { $0 == .chatWrite }
        readOnly.serverCapabilities?.removeAll { $0 == .chatWrite }
        try await connect([studio, readOnly])
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_app", startsVoice: false)
        let target = try XCTUnwrap(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))

        let opened = try await coordinator.createChat(agreedTo: target)

        XCTAssertNil(opened, "The selected machine's grant was read")
        XCTAssertFalse(requests("laptop").contains("POST /chats"))
        XCTAssertFalse(requests("studio").contains("POST /chats"))
    }

    func testAgreeingCreatesNothingInAWorkspaceArchivedSinceThePrompt() async throws {
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_app", startsVoice: false)
        let target = try XCTUnwrap(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))
        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "laptop")

        let opened = try await coordinator.createChat(agreedTo: target)

        XCTAssertNil(opened)
        XCTAssertFalse(requests("laptop").contains("POST /chats"))
    }

    // M2: what follows a created chat.

    private func chatsHomeTarget() throws -> AidenNewChatLinkConsent.Target {
        let home = workspaceObject("workspace_home", name: "Chats", noWorkspace: true)
        try connection("laptop").adopt(workspaces: [
            AidenRemoteJSONDecoder.decode(AidenWorkspace.self, from: json(home)),
        ])
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats", status: 201, json: json(
            chatObject("c_new", text: "hello", workspace: "workspace_hidden")
        ))
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_home", startsVoice: false)
        return try XCTUnwrap(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))
    }

    func testAChatStartedUnderChatsLearnsItsHiddenFolder() async throws {
        let target = try chatsHomeTarget()
        listWorkspaces(
            [workspaceObject("workspace_home", noWorkspace: true), workspaceObject("workspace_hidden", noWorkspace: true)],
            on: "laptop"
        )

        let opened = try await coordinator.createChat(agreedTo: target)

        XCTAssertEqual(opened?.destination, .chat("c_new"))
        XCTAssertTrue(try connection("laptop").workspaces.contains { $0.id == "workspace_hidden" })
    }

    func testAChatItsMachineDoesNotListSaysSo() async throws {
        let target = try chatsHomeTarget()
        listWorkspaces([workspaceObject("workspace_home", noWorkspace: true)], on: "laptop")

        let opened = try await coordinator.createChat(agreedTo: target)

        XCTAssertNil(opened)
        XCTAssertEqual(coordinator.presentedError, AidenNoWorkspace.startedButUnlistedMessage)
    }

    func testAChatCreatedAsTheAppLeavesTheForegroundIsNotOpened() async throws {
        let link = AidenNavigationRequest(destination: .newChat, instanceId: "laptop", workspaceId: "workspace_app", startsVoice: false)
        let target = try XCTUnwrap(coordinator.newChatTarget(for: link, startsVoice: false, tabShell: true))
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats", status: 201, json: json(chatObject("c_new", text: "hello")))
        var isForeground = true
        let release = responder.hold(instanceId: "laptop", path: "/chats")

        let creating = Task { try await coordinator.createChat(agreedTo: target, isForeground: { isForeground }) }
        try await waitUntil("the create to reach the machine") { self.requests("laptop").contains("POST /chats") }
        isForeground = false
        release()
        let opened = try await creating.value

        XCTAssertNil(opened)
    }

    // I1: a foreground intent goes by its own machine.

    private func intents(for instanceId: String?, at now: Date = Date()) -> AidenForegroundIntentRouter {
        let router = AidenForegroundIntentRouter(queuesActions: true)
        router.submit(instanceID: instanceId, workspaceID: "workspace_app", startsVoice: false, now: now)
        return router
    }

    /// Lets `instanceId` take a create, then runs the queue in front of the person.
    private func openWaiting(_ router: AidenForegroundIntentRouter, answering instanceId: String) async {
        responder.reply(instanceId: instanceId, method: "POST", path: "/chats", status: 201, json: json(chatObject("c_new", text: "New")))
        await router.openWaitingChats(coordinator: coordinator, isForeground: { true })
    }

    func testAnIntentWaitsForItsOwnMachineAfterTheSelectedOneConnects() async throws {
        let router = intents(for: "laptop")
        try connection("laptop").adopt(connectionState: .connecting)

        await openWaiting(router, answering: "laptop")

        XCTAssertFalse(requests("laptop").contains("POST /chats"))
        XCTAssertNotNil(router.pending, "An intent that can't run yet was spent")

        try connection("laptop").adopt(connectionState: .connected)
        await openWaiting(router, answering: "laptop")

        XCTAssertNil(router.pending)
        XCTAssertEqual(router.routes.map(\.route), [.chat(id("c_new"))])
        XCTAssertFalse(requests("studio").contains("POST /chats"))
    }

    func testAnIntentRunsWhileTheSelectedMachineIsOffline() async throws {
        let router = intents(for: "laptop")
        try connection("studio").adopt(connectionState: .offline(message: "Away"))

        await openWaiting(router, answering: "laptop")

        XCTAssertEqual(router.routes.map(\.route), [.chat(id("c_new"))])
    }

    func testAnIntentNamingNoMachineFollowsTheSelectedOne() async throws {
        let router = intents(for: nil)
        try connection("studio").adopt(connectionState: .connecting)

        await openWaiting(router, answering: "studio")

        XCTAssertNotNil(router.pending)

        try connection("studio").adopt(connectionState: .connected)
        await openWaiting(router, answering: "studio")

        XCTAssertEqual(router.routes.map(\.route), [.chat(id("c_new", on: "studio"))])
    }

    func testAnIntentForAMachineThatLeftDoesNotWait() async {
        let router = intents(for: "gone")

        await router.openWaitingChats(coordinator: coordinator, isForeground: { true })

        XCTAssertNil(router.pending)
        XCTAssertEqual(router.routes, [])
    }

    func testAnIntentThatWaitedTooLongGivesWayToANewOne() async throws {
        let router = intents(for: "laptop", at: Date().addingTimeInterval(-61))
        try connection("laptop").adopt(connectionState: .connecting)

        router.submit(instanceID: "studio", workspaceID: "workspace_app", startsVoice: false)
        await openWaiting(router, answering: "studio")

        XCTAssertNil(router.pending)
        XCTAssertEqual(router.routes.map(\.route), [.chat(id("c_new", on: "studio"))], "A stale intent shut out the new one")
    }

    func testAnIntentAsksItsOwnMachineToConnect() async throws {
        let router = intents(for: "laptop")
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))
        var asked: [String] = []

        await router.openWaitingChats(coordinator: coordinator, connect: { asked.append($0) }, isForeground: { true })

        XCTAssertEqual(asked, ["laptop"], "A machine that wakes without a path change would never be tried")
        XCTAssertNotNil(router.pending)
    }

    func testAnIntentAsksNothingOfAConnectedMachine() async throws {
        let router = intents(for: "laptop")
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats", status: 201, json: json(chatObject("c_new", text: "New")))
        var asked: [String] = []

        await router.openWaitingChats(coordinator: coordinator, connect: { asked.append($0) }, isForeground: { true })

        XCTAssertEqual(asked, [])
    }

    func testAnIntentThatRanOutOfTimeSaysSo() async throws {
        let router = intents(for: "laptop", at: Date().addingTimeInterval(-61))
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))

        await router.openWaitingChats(coordinator: coordinator, isForeground: { true })

        XCTAssertNil(router.pending)
        XCTAssertEqual(coordinator.presentedError, "Laptop didn’t connect in time, so the chat wasn’t started.")
    }

    func testAnIntentRunsOutOfTimeOnlyInFrontOfThePerson() async throws {
        let router = intents(for: "laptop", at: Date().addingTimeInterval(-61))
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))

        await router.openWaitingChats(coordinator: coordinator, isForeground: { false })

        XCTAssertNotNil(router.pending, "Nobody would see the message")
        XCTAssertNil(coordinator.presentedError)
    }

    func testAWaitingIntentKnowsWhenItRunsOut() throws {
        let start = Date()
        let router = intents(for: "laptop", at: start)

        XCTAssertEqual(try XCTUnwrap(router.timeUntilNextExpiry(now: start.addingTimeInterval(10))), 50, accuracy: 0.01)
        XCTAssertEqual(router.timeUntilNextExpiry(now: start.addingTimeInterval(70)), 0)
        XCTAssertNil(AidenForegroundIntentRouter(queuesActions: true).timeUntilNextExpiry())
    }

    func testTheMenuShellStillTakesOneIntentAtATime() {
        let router = AidenForegroundIntentRouter(queuesActions: false)
        router.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false, now: Date().addingTimeInterval(-61))

        router.submit(instanceID: "studio", workspaceID: nil, startsVoice: false)

        XCTAssertEqual(router.pending?.instanceID, "laptop")
    }

    // I2: what a chat's own workspace allows.

    func testAChatInAWorkspaceArchivedHereIsRefused() async throws {
        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "laptop")
        let route = AidenChatRouteModel(id: id(), cache: cache)

        await route.load(coordinator: coordinator)

        XCTAssertEqual(
            refusal(of: route),
            "That chat belongs to a workspace archived on this device. Unarchive it from Workspaces to open the chat."
        )
        let onStudio = AidenChatRouteModel(id: id(on: "studio"), cache: cache)
        await onStudio.load(coordinator: coordinator)
        guard case .ready = onStudio.state else { return XCTFail("One machine's archive reached the other") }
    }

    func testASavedChatInAnArchivedWorkspaceIsRefusedToo() async throws {
        let saved = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: json(chatObject("c1", text: "saved")))
        _ = try await cache.saveChat(saved, instanceId: "laptop", writeToken: cache.reserveChatWrite())
        coordinator.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "laptop")
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))
        let route = AidenChatRouteModel(id: id(), cache: cache)

        await route.load(coordinator: coordinator)

        XCTAssertNotNil(refusal(of: route))
    }

    func testAChatWhoseWorkspaceIsGoneIsRefusedOnceTheMachineHasBeenAsked() async throws {
        transcript("from laptop", on: "laptop", workspace: "workspace_gone")
        let reads = workspaceReads("laptop")
        let route = AidenChatRouteModel(id: id(), cache: cache)

        await route.load(coordinator: coordinator)

        XCTAssertEqual(refusal(of: route), "The chat's workspace is no longer available.")
        XCTAssertEqual(workspaceReads("laptop"), reads + 1, "The list can be behind, so it's read before refusing")
    }

    func testAChatInAFolderMadeSinceTheLastReadOpens() async throws {
        transcript("from laptop", on: "laptop", workspace: "workspace_hidden")
        listWorkspaces([workspaceObject("workspace_hidden", noWorkspace: true)], on: "laptop")
        let route = AidenChatRouteModel(id: id(), cache: cache)

        await route.load(coordinator: coordinator)

        guard case .ready = route.state else { return XCTFail("Refused a chat its machine lists: \(route.state)") }
    }

    func testASavedChatStaysReadableWithItsMachineAway() async throws {
        let saved = try AidenRemoteJSONDecoder.decode(
            AidenChat.self,
            from: json(chatObject("c1", text: "saved", workspace: "workspace_unknown"))
        )
        _ = try await cache.saveChat(saved, instanceId: "laptop", writeToken: cache.reserveChatWrite())
        try connection("laptop").adopt(connectionState: .offline(message: "Away"))
        let route = AidenChatRouteModel(id: id(), cache: cache)

        await route.load(coordinator: coordinator)

        guard case .ready = route.state else { return XCTFail("Only the machine can say a workspace is gone: \(route.state)") }
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

    // The tab shell: the selected machine is only the default for new work, so
    // it gets what any other machine gets. Flag off, `AidenChatDockTests` pins
    // the old ending.

    private func sendRefusedByStudio() async throws -> AidenChatViewModel {
        transcript("from studio", on: "studio")
        let model = try chatModel(owner: "studio")
        await model.load(observeProgress: false)
        responder.reply(instanceId: "studio", method: "POST", path: "/chats/c1/turns", status: 401, json: Self.revokedJSON)
        model.draft = "Keep these words"
        return model
    }

    /// The saved machine goes first. The purge has work left after that, and the
    /// state and the error come at the end of it.
    private func waitForPairing() async throws {
        try await waitUntil("the pairing screen") {
            self.coordinator.installationStore.installations.isEmpty
                && self.coordinator.connectionState == .needsPairing
                && self.coordinator.presentedError != nil
        }
    }

    func testARevokedSelectedMachinesChatStaysUntilLeaving() async throws {
        try await connect([studio, laptop], tabShell: true)
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)
        let before = model.chat.messages.count

        await model.send()

        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertEqual(model.chat.messages.count, before)
        XCTAssertEqual(model.presentedError, AidenDockCopy.machineRevoked)
        XCTAssertEqual(model.revokedMachineNotice?.machineName, "Studio")
        XCTAssertThrowsError(try coordinator.remoteClient(for: model.owner), "The credential goes on working")
        XCTAssertTrue(coordinator.installationStore.installations.contains { $0.id == "studio" })
        XCTAssertEqual(coordinator.activeInstanceId, "laptop", "A revoked machine can't be the default for new work")

        model.setViewPresent(false)

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "studio") == nil }
        XCTAssertFalse(coordinator.installationStore.installations.contains { $0.id == "studio" })
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
    }

    func testARevokedSelectedMachineWithNothingOnScreenPurgesAtOnce() async throws {
        try await connect([studio, laptop], tabShell: true)
        let model = try await sendRefusedByStudio()

        await model.send()

        XCTAssertNil(coordinator.hosts.connection(for: "studio"))
        XCTAssertFalse(coordinator.installationStore.installations.contains { $0.id == "studio" })
    }

    func testAnotherMachinesChatDoesNotHoldBackTheSelectedOnesPurge() async throws {
        try await connect([studio, laptop], tabShell: true)
        let model = try await sendRefusedByStudio()
        let onLaptop = try chatModel()
        onLaptop.setViewPresent(true)

        await model.send()

        XCTAssertNil(coordinator.hosts.connection(for: "studio"))
        onLaptop.setViewPresent(false)
    }

    func testAnOnlyMachineKeepsItsChatOnScreenThenGoesToPairing() async throws {
        try await connect([studio], tabShell: true)
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)

        await model.send()

        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertNotNil(model.revokedMachineNotice)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertTrue(coordinator.isHoldingRevokedChat, "The pairing screen would take the chat away")

        model.setViewPresent(false)

        try await waitForPairing()
        XCTAssertFalse(coordinator.isHoldingRevokedChat)
    }

    func testConnectingLeavesAHeldOnlyMachineAlone() async throws {
        try await connect([studio], tabShell: true)
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)
        await model.send()

        await coordinator.connectActiveInstallation()

        XCTAssertTrue(coordinator.isHoldingRevokedChat, "Back in the foreground, the purge took the chat")
        XCTAssertTrue(coordinator.installationStore.installations.contains { $0.id == "studio" })
        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertNotNil(model.revokedMachineNotice)

        model.setViewPresent(false)

        try await waitForPairing()
    }

    func testSelectingAHeldMachineWaitsForItsChatToLeave() async throws {
        try await connect([studio, laptop], tabShell: true)
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)
        await model.send()
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")

        await coordinator.switchInstallation(to: "studio")

        XCTAssertNotNil(coordinator.hosts.connection(for: "studio"), "Purged with its chat on screen")
        XCTAssertNotNil(model.revokedMachineNotice)

        model.setViewPresent(false)

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "studio") == nil }
        try await waitUntil("the next machine") { self.coordinator.activeInstanceId == "laptop" }
    }

    func testSelectingARevokedMachineWithNothingOnScreenStillPurges() async throws {
        try await connect([studio, laptop], tabShell: true)
        let laptopChat = try chatModel()
        laptopChat.setViewPresent(true)
        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        laptopChat.setViewPresent(false)

        await coordinator.switchInstallation(to: "laptop")

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "laptop") == nil }
    }

    func testTheMenuShellNeverHoldsARevokedChat() async throws {
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)

        await model.send()

        XCTAssertNil(coordinator.hosts.connection(for: "studio"), "Flag off, the selected machine leaves at once")
        XCTAssertFalse(coordinator.isHoldingRevokedChat)
        model.setViewPresent(false)
    }

    // Killed on a revoked chat: `isPurgePending` is memory only, and the pairing
    // is still saved, so a launch starts over with a machine that looks paired.

    private func killedOnARevokedLaptopChat() async throws {
        let model = try chatModel()
        model.setViewPresent(true)
        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))
        XCTAssertNotNil(model.revokedMachineNotice)
    }

    private func relaunch(laptopAnswers: () -> Void) {
        pair([studio, laptop], tabShell: true)
        laptopAnswers()
    }

    func testALaunchAfterBeingKilledOnARevokedChatFinishesThePurge() async throws {
        try await killedOnARevokedLaptopChat()

        relaunch {
            responder.reply(instanceId: "laptop", path: "/server", status: 401, json: Self.revokedJSON)
        }
        await launch()

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "laptop") == nil }
        XCTAssertFalse(coordinator.installationStore.installations.contains { $0.id == "laptop" })
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    func testAChatRestoredOverARevokedMachineShowsTheNoticeAgain() async throws {
        try await killedOnARevokedLaptopChat()
        relaunch {
            responder.reply(instanceId: "laptop", path: "/server", status: 401, json: Self.revokedJSON)
        }
        let model = try chatModel()
        model.setViewPresent(true)

        await launch()

        try await waitUntil("the machine to answer") { model.revokedMachineNotice != nil }
        XCTAssertNotNil(coordinator.hosts.connection(for: "laptop"), "Purged under the person reading it")

        model.setViewPresent(false)

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "laptop") == nil }
    }

    func testAKilledRevokedMachineThatStaysAwayWaitsForItsAnswer() async throws {
        try await killedOnARevokedLaptopChat()
        relaunch {
            responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)
        }
        await launch()
        try await waitUntil("the machine to read as away") {
            if case .offline = self.coordinator.hosts.connection(for: "laptop")?.connectionState { return true }
            return false
        }
        XCTAssertTrue(coordinator.installationStore.installations.contains { $0.id == "laptop" })

        responder.reply(instanceId: "laptop", path: "/server", status: 401, json: Self.revokedJSON)
        scheduler.connect(instanceId: "laptop")

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "laptop") == nil }
    }

    // Killed on the selected machine's chat. The selection has moved on if there
    // was anywhere to go, so a launch finds that machine selected only if it's the only one.

    private func killedOnStudiosChat(_ installations: [AidenInstallation]) async throws {
        try await connect(installations, tabShell: true)
        let model = try await sendRefusedByStudio()
        model.setViewPresent(true)
        await model.send()
        XCTAssertNotNil(model.revokedMachineNotice)
    }

    /// `installations` are what's saved at the kill, the selected machine first.
    private func relaunchRefusedByStudio(_ installations: [AidenInstallation]) {
        pair(installations, tabShell: true)
        responder.reply(instanceId: "studio", path: "/server", status: 401, json: Self.revokedJSON)
    }

    func testALaunchAfterBeingKilledOnTheSelectedMachinesChatFinishesThePurge() async throws {
        try await killedOnStudiosChat([studio, laptop])
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")

        relaunchRefusedByStudio([laptop, studio])
        await launch()

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "studio") == nil }
        XCTAssertFalse(coordinator.installationStore.installations.contains { $0.id == "studio" })
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
    }

    func testAKilledOnlyMachineWithNothingRestoredGoesToPairing() async throws {
        try await killedOnStudiosChat([studio])

        relaunchRefusedByStudio([studio])
        await launch()

        try await waitForPairing()
    }

    func testAnOnlyMachinesRestoredChatStaysThenGoesToPairing() async throws {
        try await killedOnStudiosChat([studio])
        relaunchRefusedByStudio([studio])
        let model = try chatModel(owner: "studio")
        model.setViewPresent(true)

        await launch()

        try await waitUntil("the machine to answer") { model.revokedMachineNotice != nil }
        XCTAssertTrue(coordinator.isHoldingRevokedChat, "The pairing screen would take the chat away")
        XCTAssertTrue(coordinator.installationStore.installations.contains { $0.id == "studio" })

        model.setViewPresent(false)

        try await waitForPairing()
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

    func testAChatHeldOnARevokedMachineOffersNoSimulators() async throws {
        var withSimulators = laptop
        withSimulators.serverFeatures.append(AidenServer.mobileSimulatorsFeature)
        withSimulators.serverCapabilities?.append(.simulatorsMobile)
        withSimulators.deviceCapabilities.append(.simulatorsMobile)
        try await connect([studio, withSimulators])
        let model = try chatModel()
        model.setViewPresent(true)
        XCTAssertTrue(model.offersSimulators)

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop"))

        XCTAssertNotNil(model.revokedMachineNotice)
        XCTAssertFalse(model.offersSimulators, "A device button with no client behind it")
        model.setViewPresent(false)
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
        XCTAssertTrue(model.offersSimulators)
        XCTAssertFalse(try chatModel(owner: "studio").offersSimulators, "The selected machine doesn't offer them")

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

    func testTheTabShellOpensForksOfAChatOnAnyMachine() throws {
        let laptopChat = try chatModel()
        let studioChat = try chatModel(owner: "studio")

        XCTAssertTrue(laptopChat.opensForks(inTabShell: true))
        XCTAssertFalse(laptopChat.opensForks(inTabShell: false), "The menu shell would file it under the selected machine")
        XCTAssertTrue(studioChat.opensForks(inTabShell: false))
    }
}
#endif
