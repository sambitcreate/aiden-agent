#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// A chat belongs to the machine that owns it. These run the real models over
/// the demo machines, so every request is one the contract has.
@MainActor
final class AidenOwnerScopeTests: XCTestCase {
    private let responder = AidenDemoResponder()
    private var root: URL!
    private var coordinator: AidenRemoteCoordinator!
    private var cache: AidenChatCache!
    private var drafts: AidenChatDraftStore!
    private var preferences: AidenModelPreferenceStore!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenOwnerScopeTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        cache = AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory))
        drafts = AidenChatDraftStore(root: root.appending(path: "drafts", directoryHint: .isDirectory))
        preferences = AidenModelPreferenceStore(defaults: AidenDemoHosts.isolatedDefaults())
        coordinator = AidenDemoHosts.coordinator(
            installations: [machine("studio", "Studio"), machine("laptop", "Laptop")],
            responder: responder
        )
        transcript("from studio", on: "studio")
        transcript("from laptop", on: "laptop")
        await coordinator.start()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    /// A machine that serves windowed transcripts, the route a chat reads today.
    private func machine(_ id: String, _ name: String, extraFeatures: [String] = []) -> AidenInstallation {
        var installation = AidenDemoHosts.installation(instanceId: id, name: name)
        installation.serverFeatures += [
            AidenServer.chatMessagesWindowFeature,
            AidenServer.chatMessagesWindowMetadataFeature,
        ] + extraFeatures
        return installation
    }

    private func messageJSON(_ text: String, id: String = "m1", role: String = "assistant") -> [String: Any] {
        ["id": id, "role": role, "text": text, "createdAt": "2026-11-05T09:00:00.000Z"]
    }

    private func json(_ object: Any) -> Data {
        // Every value here is built above from literals.
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// Answers both transcript routes: `/chats/{id}/messages` for a connected
    /// machine, and `/chats/{id}` for one whose `/server` hasn't answered yet.
    private func transcript(_ text: String..., on instanceId: String, chat chatId: String = "c1", revision: String = "r1") {
        let messages = text.enumerated().map { messageJSON($1, id: "m\($0 + 1)") }
        let shared: [String: Any] = [
            "workspaceId": "workspace_app",
            "title": "Same chat",
            "createdAt": "2026-11-05T09:00:00.000Z",
            "updatedAt": "2026-11-05T09:00:01.000Z",
            "revision": revision,
            "messages": messages,
        ]
        responder.reply(instanceId: instanceId, path: "/chats/\(chatId)", status: 200, json: json(
            shared.merging(["id": chatId]) { $1 }
        ))
        responder.reply(instanceId: instanceId, path: "/chats/\(chatId)/messages", status: 200, json: json(
            shared.merging(["chatId": chatId, "hasOlder": false]) { $1 }
        ))
    }

    private func emptyChat(_ chatId: String) -> AidenChat {
        let date = Date(timeIntervalSince1970: 1_793_000_000)
        return AidenChat(
            id: chatId, workspaceId: "workspace_app", title: "Same chat", providerId: nil, modelId: nil,
            messages: [], createdAt: date, updatedAt: date, revision: "r0"
        )
    }

    private func model(
        owner instanceId: String,
        chat chatId: String = "c1",
        networkPath: AidenNetworkAvailability? = nil,
        reportsEveryMachine: Bool = false,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) throws -> AidenChatViewModel {
        AidenChatViewModel(
            coordinator: coordinator,
            chat: emptyChat(chatId),
            owner: try coordinator.ownerContext(for: instanceId),
            cache: cache,
            draftStore: drafts,
            modelPreferenceStore: preferences,
            visualDocumentCache: AidenVisualDocumentCache(root: root.appending(path: "visuals", directoryHint: .isDirectory)),
            networkPath: networkPath ?? AidenNetworkAvailability(),
            reportsEveryMachine: reportsEveryMachine,
            onChatUpdated: onChatUpdated,
            onChatActivityChanged: onChatActivityChanged
        )
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
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for: \(what)", file: file, line: line)
    }

    private func waitForRequest(_ request: String, on instanceId: String) async throws {
        try await waitUntil("\(request) on \(instanceId)") {
            responder.requests(instanceId: instanceId).contains(request)
        }
    }

    /// Reading a draft back takes over its session, so a test waits on the files.
    private func savedDraftCount() -> Int {
        let files = FileManager.default.enumerator(at: root.appending(path: "drafts"), includingPropertiesForKeys: nil)
        return (files?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "json" }.count
    }

    private func cachedTexts(_ instanceId: String, chat chatId: String = "c1") async -> [String]? {
        await cache.loadChat(instanceId: instanceId, chatId: chatId)?.messages.map(\.text)
    }

    private func acceptTurn(on instanceId: String, stream streamId: String, frames: [String]) {
        responder.reply(instanceId: instanceId, method: "POST", path: "/chats/c1/turns", status: 202, json: json([
            "turnId": "turn_1",
            "streamId": streamId,
            "status": "queued",
            "message": messageJSON("Question", id: "accepted", role: "user"),
        ]))
        responder.reply(instanceId: instanceId, path: "/streams/\(streamId)", status: 200, json: json([
            "streamId": streamId,
            "chatId": "c1",
            "turnId": "turn_1",
            "state": "done",
            "lastSequence": frames.count,
            "updatedAt": "2026-11-05T09:00:02.000Z",
        ]))
        responder.reply(
            instanceId: instanceId,
            path: "/streams/\(streamId)/events",
            status: 200,
            json: Data(frames.joined().utf8)
        )
    }

    private func frame(
        _ sequence: Int,
        _ type: String,
        stream streamId: String,
        payload: String,
        terminal: Bool = false
    ) -> String {
        "id: \(sequence)\nevent: \(type)\ndata: {\"protocolVersion\":1,\"streamId\":\"\(streamId)\",\"sequence\":\(sequence),\"timestamp\":\"2026-11-05T09:00:02.000Z\",\"type\":\"\(type)\",\"terminal\":\(terminal),\"payload\":\(payload)}\n\n"
    }

    // MARK: Replies stay with their machine

    func testALateReplyNeverReachesAnotherMachinesChat() async throws {
        let release = responder.hold(instanceId: "studio", path: "/chats/c1/messages")
        let a = try model(owner: "studio")
        let b = try model(owner: "laptop")
        let loading = Task { await a.load(observeProgress: false) }
        try await waitForRequest("GET /chats/c1/messages", on: "studio")

        await b.load(observeProgress: false)
        await coordinator.switchInstallation(to: "laptop")
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
        release()
        await loading.value

        XCTAssertEqual(a.chat.messages.map(\.text), ["from studio"])
        XCTAssertEqual(b.chat.messages.map(\.text), ["from laptop"])
        let cachedOnStudio = await cachedTexts("studio")
        let cachedOnLaptop = await cachedTexts("laptop")
        XCTAssertEqual(cachedOnStudio, ["from studio"])
        XCTAssertEqual(cachedOnLaptop, ["from laptop"])
    }

    func testSameChatIDOnTwoMachinesKeepsSeparateModelsAndCaches() async throws {
        let a = try model(owner: "studio")
        let b = try model(owner: "laptop")
        await a.load(observeProgress: false)
        await b.load(observeProgress: false)

        let cachedOnStudio = await cachedTexts("studio")
        let cachedOnLaptop = await cachedTexts("laptop")
        XCTAssertEqual(cachedOnStudio, ["from studio"])
        XCTAssertEqual(cachedOnLaptop, ["from laptop"])

        // Reopened with both machines offline, each shows only its own rows.
        responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)
        let reopenedStudio = try model(owner: "studio")
        let reopenedLaptop = try model(owner: "laptop")
        await reopenedStudio.load(observeProgress: false)
        await reopenedLaptop.load(observeProgress: false)
        XCTAssertEqual(reopenedStudio.chat.messages.map(\.text), ["from studio"])
        XCTAssertEqual(reopenedLaptop.chat.messages.map(\.text), ["from laptop"])

        // Removing one machine's chat leaves the other's rows alone.
        await cache.purge(instanceId: "studio")
        let purgedStudio = await cachedTexts("studio")
        let keptLaptop = await cachedTexts("laptop")
        XCTAssertNil(purgedStudio)
        XCTAssertEqual(keptLaptop, ["from laptop"])
    }

    func testAChatKeepsStreamingAfterTheSelectionMoves() async throws {
        acceptTurn(on: "studio", stream: "stream_1", frames: [
            frame(1, "text_delta", stream: "stream_1", payload: #"{"text":"streamed on studio"}"#),
            frame(2, "done", stream: "stream_1", payload: #"{"messageId":"m2"}"#, terminal: true),
        ])
        let release = responder.hold(instanceId: "studio", path: "/streams/stream_1/events")
        let a = try model(owner: "studio")
        await a.load(observeProgress: false)
        a.draft = "Question"
        XCTAssertTrue(a.canSend)
        await a.send()
        try await waitForRequest("GET /streams/stream_1/events", on: "studio")

        await coordinator.switchInstallation(to: "laptop")
        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        release()

        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }
        XCTAssertNil(a.presentedError)
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains { $0.contains("stream_1") })
        let cachedOnStudio = await cachedTexts("studio")
        let cachedOnLaptop = await cachedTexts("laptop")
        XCTAssertEqual(cachedOnStudio, ["from studio", "streamed on studio"])
        XCTAssertNil(cachedOnLaptop)
    }

    func testAMessageSentAfterTheSelectionMovesGoesToItsOwner() async throws {
        acceptTurn(on: "studio", stream: "stream_1", frames: [
            frame(1, "done", stream: "stream_1", payload: #"{"messageId":"m1"}"#, terminal: true),
        ])
        let a = try model(owner: "studio")
        await a.load(observeProgress: false)
        await coordinator.switchInstallation(to: "laptop")

        a.draft = "Question"
        XCTAssertTrue(a.canSend)
        await a.send()

        try await waitForRequest("POST /chats/c1/turns", on: "studio")
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("POST /chats/c1/turns"))
    }

    func testAChatComesBackWorkingAfterTheSelectionLeavesAndReturns() async throws {
        let a = try model(owner: "studio")
        await coordinator.switchInstallation(to: "laptop")
        await coordinator.switchInstallation(to: "studio")

        XCTAssertFalse(coordinator.isCurrent(a.owner))
        await a.load(observeProgress: false)

        XCTAssertEqual(a.chat.messages.map(\.text), ["from studio"])
        XCTAssertTrue(a.isConnected)
    }

    // MARK: What a chat reads about its machine

    func testAChatReadsItsOwnMachineNotTheSelectedOne() async throws {
        coordinator = AidenDemoHosts.coordinator(
            installations: [
                machine("studio", "Studio"),
                { () -> AidenInstallation in
                    var laptop = machine("laptop", "Laptop")
                    laptop.serverFeatures.removeAll { $0 == AidenServer.chatTasksFeature }
                    return laptop
                }(),
            ],
            responder: responder
        )
        await coordinator.start()
        let a = try model(owner: "studio")
        let b = try model(owner: "laptop")
        XCTAssertTrue(a.canReadTaskProgress)
        XCTAssertFalse(b.canReadTaskProgress, "The laptop's /server hasn't answered, and studio's answer isn't the laptop's.")

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertTrue(a.canReadTaskProgress, "The selected laptop lacks the feature, but this chat is on studio.")
        XCTAssertFalse(b.canReadTaskProgress)
    }

    func testAChatOnAMachineThatHasNotConnectedWaitsLikeAnyUnconnectedChat() async throws {
        let b = try model(owner: "laptop")
        b.draft = "Waiting"

        XCTAssertFalse(b.isConnected)
        XCTAssertFalse(b.canSend)
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("GET /server"))

        await b.load(observeProgress: false)
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("GET /server"), "A chat never connects its machine.")
        XCTAssertEqual(b.chat.messages.map(\.text), ["from laptop"])
    }

    // MARK: Drafts

    func testADraftWrittenOnOneMachineStaysOnThatMachine() async throws {
        let a = try model(owner: "studio")
        let b = try model(owner: "laptop")
        await a.load(observeProgress: false)
        await b.load(observeProgress: false)
        await coordinator.switchInstallation(to: "laptop")

        // Typed while the other machine is selected, so only ownership can file it.
        a.draft = "for studio"
        try await waitUntil("the studio draft to reach disk") { savedDraftCount() == 1 }

        let reopenedLaptop = try model(owner: "laptop")
        await reopenedLaptop.load(observeProgress: false)
        XCTAssertEqual(reopenedLaptop.draft, "")

        reopenedLaptop.draft = "for laptop"
        try await waitUntil("the laptop draft to reach disk") { savedDraftCount() == 2 }

        let reopenedStudio = try model(owner: "studio")
        await reopenedStudio.load(observeProgress: false)
        XCTAssertEqual(reopenedStudio.draft, "for studio")
        let againLaptop = try model(owner: "laptop")
        await againLaptop.load(observeProgress: false)
        XCTAssertEqual(againLaptop.draft, "for laptop")
    }

    // MARK: A forgotten machine

    func testAModelWhoseMachineIsForgottenStopsWriting() async throws {
        await coordinator.switchInstallation(to: "laptop")
        let release = responder.hold(instanceId: "studio", path: "/chats/c1/messages")
        let a = try model(owner: "studio")
        let loading = Task { await a.load(observeProgress: false) }
        try await waitForRequest("GET /chats/c1/messages", on: "studio")

        await coordinator.removeInstallation("studio")
        XCTAssertFalse(coordinator.isLive(a.owner))
        release()
        await loading.value

        XCTAssertEqual(a.chat.messages, [])
        let cached = await cachedTexts("studio")
        XCTAssertNil(cached)
        a.draft = "nowhere to go"
        XCTAssertFalse(a.canSend)
        try await Task.sleep(for: .milliseconds(200)) // past the draft debounce
        await a.waitForDraftPersistence()
        XCTAssertEqual(savedDraftCount(), 0)
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
    }

    func testADraftIsStillSavedAfterItsMachineIsRepaired() async throws {
        let a = try model(owner: "studio")
        await a.load(observeProgress: false)

        coordinator.hosts.connection(for: "studio")?.advanceHostGeneration()
        XCTAssertFalse(coordinator.isLive(a.owner))
        XCTAssertTrue(coordinator.isRetained(a.owner))

        a.draft = "still mine"
        try await Task.sleep(for: .milliseconds(200)) // past the draft debounce
        await a.waitForDraftPersistence()
        XCTAssertEqual(savedDraftCount(), 1)
    }

    // MARK: A chat left running stays out of the selected machine

    /// Starts a turn on studio and leaves its event stream parked, with two
    /// frames ready to deliver once `release` is called.
    private func sendHeldTurn(on a: AidenChatViewModel) async throws -> @Sendable () -> Void {
        acceptTurn(on: "studio", stream: "stream_1", frames: [
            frame(1, "text_delta", stream: "stream_1", payload: #"{"text":"streamed on studio"}"#),
            frame(2, "done", stream: "stream_1", payload: #"{"messageId":"m2"}"#, terminal: true),
        ])
        let release = responder.hold(instanceId: "studio", path: "/streams/stream_1/events")
        await a.load(observeProgress: false)
        a.draft = "Question"
        await a.send()
        try await waitForRequest("GET /streams/stream_1/events", on: "studio")
        return release
    }

    func testAChatLeftRunningPublishesNothingWhileAnotherMachineIsSelected() async throws {
        var updates: [AidenChat] = []
        var activity: [AidenChatSummaryActivity] = []
        let a = try model(
            owner: "studio",
            onChatUpdated: { updates.append($0) },
            onChatActivityChanged: { activity.append($1) }
        )
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        updates = []
        activity = []

        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        release()
        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }

        XCTAssertEqual(updates.map(\.id), [])
        XCTAssertEqual(activity, [])
    }

    func testAChatPublishesAgainOnceItsMachineIsSelectedAgain() async throws {
        var updates: [AidenChat] = []
        var activity: [AidenChatSummaryActivity] = []
        let a = try model(
            owner: "studio",
            onChatUpdated: { updates.append($0) },
            onChatActivityChanged: { activity.append($1) }
        )
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        await coordinator.switchInstallation(to: "studio")
        updates = []
        activity = []

        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        release()
        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }

        XCTAssertEqual(updates.last?.messages.last?.text, "streamed on studio")
        XCTAssertEqual(activity, [.idle])
    }

    /// The tab shell's rows come from every machine, so its chats report to
    /// their own machine's rows whichever machine is selected.
    func testATabShellChatPublishesWhileAnotherMachineIsSelected() async throws {
        var updates: [AidenChat] = []
        var activity: [AidenChatSummaryActivity] = []
        let a = try model(
            owner: "studio",
            reportsEveryMachine: true,
            onChatUpdated: { updates.append($0) },
            onChatActivityChanged: { activity.append($1) }
        )
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        updates = []
        activity = []

        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        release()
        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }

        XCTAssertEqual(updates.last?.messages.last?.text, "streamed on studio")
        XCTAssertEqual(activity, [.idle])
    }

    // MARK: A left-behind chat stops when its machine does

    /// Waits for the stream loop and any reconciliation to finish.
    private func waitForStreamWorkToEnd(_ a: AidenChatViewModel) async throws {
        var ended = false
        Task { @MainActor in
            await a.waitForStreamWork()
            ended = true
        }
        try await waitUntil("the stream work to end") { ended }
    }

    /// Longer than the first retry delays, which are at most two seconds.
    private func assertNoNewRequests(on instanceId: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let before = responder.requests(instanceId: instanceId).count
        try await Task.sleep(for: .milliseconds(2_500))
        XCTAssertEqual(responder.requests(instanceId: instanceId).count, before, file: file, line: line)
    }

    private func statusProbes() -> Int {
        responder.requests(instanceId: "studio").filter { $0 == "GET /streams/stream_1" }.count
    }

    func testALeftBehindStreamEndsWhenItsMachineStopsAnswering() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)

        responder.fail(instanceId: "studio", path: "*", code: .cannotConnectToHost)
        release()

        try await waitForStreamWorkToEnd(a)
        XCTAssertEqual(statusProbes(), 1)
        try await assertNoNewRequests(on: "studio")
        XCTAssertTrue(coordinator.isLive(a.owner))
        let cachedStream = await cache.loadActiveStream(instanceId: "studio", chatId: "c1")
        XCTAssertEqual(cachedStream?.streamId, "stream_1")
    }

    func testALeftBehindStreamEndsRatherThanWaitingForTheNetwork() async throws {
        let network = AidenNetworkAvailability()
        let a = try model(owner: "studio", networkPath: network)
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)

        network.setAvailable(false)
        responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        release()

        try await waitForStreamWorkToEnd(a)
        XCTAssertEqual(statusProbes(), 0)
        XCTAssertFalse(a.isWaitingForNetwork)
    }

    func testALeftBehindStreamEndsOnARevokedCredential() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)

        let revoked = json(["error": [
            "code": "credential_revoked",
            "message": "Pair this device again.",
            "requestId": "request-revoked",
            "retryable": false,
        ]])
        responder.reply(instanceId: "studio", path: "/streams/stream_1/events", status: 401, json: revoked)
        responder.reply(instanceId: "studio", path: "/streams/stream_1", status: 401, json: revoked)
        release()

        try await waitForStreamWorkToEnd(a)
        try await assertNoNewRequests(on: "studio")
    }

    func testAChatOnARevokedMachineStaysUntilItsViewGoes() async throws {
        await coordinator.switchInstallation(to: "laptop")
        let a = try model(owner: "studio")
        a.setViewPresent(true)
        let context = a.owner
        let revoked = json(["error": [
            "code": "credential_revoked",
            "message": "Pair this device again.",
            "requestId": "request-revoked",
            "retryable": false,
        ]])
        responder.reply(instanceId: "studio", path: "/chats/c1/messages", status: 401, json: revoked)
        responder.reply(instanceId: "studio", path: "/chats/c1", status: 401, json: revoked)

        await a.load()

        let studio = try XCTUnwrap(coordinator.hosts.connection(for: "studio"))
        XCTAssertTrue(studio.isRevoked)
        XCTAssertTrue(studio.isPurgePending)
        XCTAssertFalse(coordinator.isLive(context))
        XCTAssertTrue(coordinator.isRetained(context), "The record stays while the chat is on screen")
        XCTAssertNil(coordinator.presentedError)

        a.setViewPresent(false)

        try await waitUntil("the purge") { self.coordinator.hosts.connection(for: "studio") == nil }
        XCTAssertFalse(coordinator.isRetained(context))
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
    }

    func testALeftBehindReconciliationEndsWhenItsMachineStopsAnswering() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)

        responder.fail(instanceId: "studio", path: "/chats/c1/messages", code: .cannotConnectToHost)
        responder.fail(instanceId: "studio", path: "/chats/c1", code: .cannotConnectToHost)
        release()

        try await waitForStreamWorkToEnd(a)
        XCTAssertEqual(a.activeStreamID, "stream_1")
        try await assertNoNewRequests(on: "studio")
    }

    func testAStreamStillOnScreenKeepsRetryingOnAnotherMachine() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")

        responder.fail(instanceId: "studio", path: "*", code: .cannotConnectToHost)
        release()
        try await waitUntil("a retry after the first failed attempt") { self.statusProbes() >= 2 }

        // Leaving the screen ends it at the next failed attempt.
        a.setViewPresent(false)
        try await waitForStreamWorkToEnd(a)
    }

    func testALeftBehindStreamKeepsGoingWhileItsMachineAnswers() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)

        // The event stream drops, but the machine still answers for its status.
        responder.fail(instanceId: "studio", path: "/streams/stream_1/events", code: .networkConnectionLost)
        responder.reply(instanceId: "studio", path: "/streams/stream_1", status: 200, json: json([
            "streamId": "stream_1",
            "chatId": "c1",
            "turnId": "turn_1",
            "state": "running",
            "lastSequence": 0,
            "updatedAt": "2026-11-05T09:00:02.000Z",
        ]))
        release()
        try await waitUntil("the status probe") { self.statusProbes() >= 1 }

        acceptTurn(on: "studio", stream: "stream_1", frames: [
            frame(1, "text_delta", stream: "stream_1", payload: #"{"text":"streamed on studio"}"#),
            frame(2, "done", stream: "stream_1", payload: #"{"messageId":"m2"}"#, terminal: true),
        ])
        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")

        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }
    }

    func testComingBackRestartsAStreamThatStopped() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)
        responder.fail(instanceId: "studio", path: "*", code: .cannotConnectToHost)
        release()
        try await waitForStreamWorkToEnd(a)

        acceptTurn(on: "studio", stream: "stream_1", frames: [
            frame(1, "text_delta", stream: "stream_1", payload: #"{"text":"streamed on studio"}"#),
            frame(2, "done", stream: "stream_1", payload: #"{"messageId":"m2"}"#, terminal: true),
        ])
        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        a.setViewPresent(true)

        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }
    }

    func testComingBackRestartsAReconciliationThatStopped() async throws {
        let a = try model(owner: "studio")
        let release = try await sendHeldTurn(on: a)
        await coordinator.switchInstallation(to: "laptop")
        a.setViewPresent(false)
        responder.fail(instanceId: "studio", path: "/chats/c1/messages", code: .cannotConnectToHost)
        responder.fail(instanceId: "studio", path: "/chats/c1", code: .cannotConnectToHost)
        release()
        try await waitForStreamWorkToEnd(a)

        transcript("from studio", "streamed on studio", on: "studio", revision: "r2")
        a.setViewPresent(true)

        try await waitUntil("the reply to settle") {
            a.activeStreamID == nil && a.chat.messages.last?.text == "streamed on studio"
        }
    }

    // MARK: Bot chats

    private let botId = "bot_scout"

    private func botSession(_ text: String, on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/bots/\(botId)/session", status: 200, json: json([
            "botId": botId,
            "epoch": "epoch_\(instanceId)",
            "seq": 1,
            "state": "idle",
            "interrupted": false,
            "entries": [[
                "type": "message", "id": "entry_1", "role": "assistant",
                "text": text, "createdAt": "2026-11-05T09:00:00.000Z",
            ]],
            "hasOlder": false,
            "question": NSNull(),
            "approval": NSNull(),
        ]))
    }

    private func botKey(_ owner: AidenRemoteRequestContext) -> AidenBotSessionKey {
        AidenBotSessionKey(instanceId: owner.instanceId, deviceId: owner.deviceId, botID: botId)
    }

    private func botModel(
        owner instanceId: String,
        cache: AidenBotSessionCache
    ) throws -> AidenBotSessionModel {
        let owner = try coordinator.ownerContext(for: instanceId)
        let coordinator = coordinator!
        return AidenBotSessionModel(
            botID: botId,
            transport: try coordinator.remoteClient(for: owner),
            owner: owner,
            isOwnerLive: { coordinator.isLive(owner) },
            cacheKey: botKey(owner),
            cache: cache,
            outboxStore: nil
        )
    }

    private func texts(_ entries: [AidenBotSessionEntry]?) -> [String]? {
        entries?.compactMap { entry in
            if case let .message(message) = entry { return message.text }
            return nil
        }
    }

    func testABotChatKeepsItsMachineWhenTheSelectionMoves() async throws {
        botSession("from studio", on: "studio")
        botSession("from laptop", on: "laptop")
        let botCache = AidenBotSessionCache()
        let release = responder.hold(instanceId: "studio", path: "/bots/\(botId)/session")
        let a = try botModel(owner: "studio", cache: botCache)
        let b = try botModel(owner: "laptop", cache: botCache)
        let loading = Task { await a.load() }
        try await waitForRequest("GET /bots/\(botId)/session", on: "studio")

        await b.load()
        await coordinator.switchInstallation(to: "laptop")
        release()
        await loading.value

        XCTAssertEqual(texts(a.entries), ["from studio"])
        XCTAssertEqual(texts(b.entries), ["from laptop"])
        XCTAssertEqual(a.owner.instanceId, "studio")
        XCTAssertEqual(texts(botCache.transcript(for: botKey(a.owner))), ["from studio"])
        XCTAssertEqual(texts(botCache.transcript(for: botKey(b.owner))), ["from laptop"])
    }

    func testABotModelWhoseMachineIsForgottenStopsWriting() async throws {
        botSession("from studio", on: "studio")
        await coordinator.switchInstallation(to: "laptop")
        let botCache = AidenBotSessionCache()
        let release = responder.hold(instanceId: "studio", path: "/bots/\(botId)/session")
        let a = try botModel(owner: "studio", cache: botCache)
        let key = botKey(a.owner)
        let loading = Task { await a.load() }
        try await waitForRequest("GET /bots/\(botId)/session", on: "studio")
        let waiting = await a.send("Waiting for the first snapshot")
        XCTAssertTrue(waiting)

        await coordinator.removeInstallation("studio")
        release()
        await loading.value

        XCTAssertEqual(a.entries, [])
        XCTAssertNil(botCache.transcript(for: key))
        XCTAssertFalse(a.canSend)
        XCTAssertFalse(responder.requests(instanceId: "studio").contains { $0.hasPrefix("POST") })

        // A frame that was already on its way changes nothing either.
        let outcome = await a.apply(AidenBotSessionEvent(botId: botId, epoch: "epoch_studio", seq: 2, kind: .partial("late")))
        XCTAssertEqual(outcome, .closed)
        XCTAssertNil(a.partial)
    }
}
#endif
