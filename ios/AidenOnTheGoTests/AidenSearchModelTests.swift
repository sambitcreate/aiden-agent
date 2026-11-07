#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// A clock that moves only when a test moves it, so the debounce is tested
/// without waiting.
final class AidenManualClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (left: Instant, right: Instant) -> Bool { left.offset < right.offset }
    }

    private struct Sleeper {
        let deadline: Instant
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current = Instant(offset: .zero)
    private var sleepers: [UUID: Sleeper] = [:]

    var now: Instant {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    var minimumResolution: Duration { .zero }

    /// How many `sleep` calls are waiting for time to pass.
    var sleeperCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return sleepers.count
    }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                } else if deadline <= current {
                    lock.unlock()
                    continuation.resume()
                } else {
                    sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
                    lock.unlock()
                }
            }
        } onCancel: {
            lock.lock()
            let sleeper = sleepers.removeValue(forKey: id)
            lock.unlock()
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        lock.lock()
        current = current.advanced(by: duration)
        let due = sleepers.filter { $0.value.deadline <= current }
        due.keys.forEach { sleepers[$0] = nil }
        lock.unlock()
        due.values.forEach { $0.continuation.resume() }
    }
}

@MainActor
final class AidenSearchModelTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_787_100_000)
    private let clock = AidenManualClock()
    private let desk = AidenBotDesk()
    private let onScreenView = NSObject()
    private var machineList: [AidenSearchMachine] = []
    private var snapshots: [AidenHostInboxSnapshot] = []
    private var preferences = AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())

    /// The real machine source and a model over it.
    private func realModel(_ coordinator: AidenRemoteCoordinator) -> AidenSearchModel {
        let preferences = preferences
        return AidenSearchModel(
            chatInput: { AidenSearchChatInput(snapshots: []) },
            machines: { AidenSearchMachine.machines(in: coordinator, preferences: preferences) },
            clock: clock
        )
    }

    // MARK: Fixtures

    private func chat(_ id: String, _ title: String, minutesAgo: Double = 5) -> AidenChatSummary {
        let updated = now.addingTimeInterval(-minutesAgo * 60)
        return AidenChatSummary(
            id: id, workspaceId: "default", title: title, titlePending: false,
            createdAt: updated.addingTimeInterval(-60), updatedAt: updated,
            revision: "rev-\(id)", activity: .idle
        )
    }

    private func snapshot(_ instanceId: String, _ chats: [AidenChatSummary], online: Bool = true) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: instanceId, deviceId: "phone", chats: chats,
            workspaceNames: ["default": "Project"], isOnline: online, isBlocked: false, fetchedAt: now
        )
    }

    private func machine(
        _ id: String,
        _ name: String,
        canReadBots: Bool = true,
        isConnected: Bool = true,
        isBlocked: Bool = false
    ) -> AidenSearchMachine {
        let desk = desk
        return AidenSearchMachine(
            instanceId: id, deviceId: "phone", name: name,
            canReadBots: canReadBots, isConnected: isConnected, isBlocked: isBlocked,
            searchBots: { query in try await desk.search(machine: id, query: query) }
        )
    }

    private func conversation(_ chatId: String, bot botId: String = "bot_scout", title: String, minutesAgo: Double = 10) -> AidenBotConversationItem {
        let stamp = ISO8601DateFormatter.fractional.string(from: now.addingTimeInterval(-minutesAgo * 60))
        let object: [String: Any] = [
            "chatId": chatId, "botId": botId, "title": title, "preview": "About \(title)",
            "activityState": "idle", "canRespondToApproval": false,
            "createdAt": stamp, "updatedAt": stamp, "revision": "rev-\(chatId)",
        ]
        // Built from literals above.
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! AidenRemoteJSONDecoder.decode(AidenBotConversationItem.self, from: data)
    }

    private func makeModel() -> AidenSearchModel {
        AidenSearchModel(
            chatInput: { [unowned self] in AidenSearchChatInput(snapshots: snapshots) },
            machines: { [unowned self] in machineList },
            now: { [now] in now },
            clock: clock
        )
    }

    /// Lets queued main-actor work run until `condition` holds.
    private func settle(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        until condition: () -> Bool
    ) async {
        for _ in 0..<2_000 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Never settled: \(what)", file: file, line: line)
    }

    /// Starts a run and waits until it is sleeping through the debounce.
    private func startRun(_ model: AidenSearchModel, sleeping count: Int = 1) async -> Task<Void, Never> {
        let task = Task { await model.run() }
        await settle("debounce sleep") { clock.sleeperCount == count }
        return task
    }

    /// A background revocation of a machine that isn't selected. A view is showing
    /// its data, so the connection stays in the registry, revoked, as the app holds it.
    private func revoke(_ instanceId: String, in coordinator: AidenRemoteCoordinator) async {
        coordinator.setOnScreen(true, view: onScreenView, instanceId: instanceId)
        if let connection = coordinator.hosts.connection(for: instanceId) {
            await coordinator.hostConnectionWasRevokedInBackground(connection)
        }
    }

    private func pastDebounce() {
        clock.advance(by: .milliseconds(300))
    }

    // MARK: Chats

    func testChatSearchIsLocalAndMakesNoRequest() async {
        snapshots = [snapshot("studio", [chat("c1", "Fix the flaky upload test"), chat("c2", "Plan the roadmap")])]
        machineList = [machine("studio", "Studio Mac")]
        let model = makeModel()

        model.query = "flaky"

        XCTAssertEqual(model.chats.map(\.id.objectId), ["c1"])
        XCTAssertEqual(model.chats.first?.id.instanceId, "studio")
        let run = await startRun(model)
        // The chats are there before the debounce, and nothing has asked a machine.
        XCTAssertEqual(model.chats.map(\.id.objectId), ["c1"])
        XCTAssertTrue(desk.asks.isEmpty)
        run.cancel()
        await run.value
        XCTAssertTrue(desk.asks.isEmpty)
    }

    func testChatSearchCoversEveryMachinesLoadedChats() {
        snapshots = [
            snapshot("studio", [chat("c1", "Upload test", minutesAgo: 5)]),
            snapshot("laptop", [chat("c1", "Upload test again", minutesAgo: 1)], online: false),
        ]
        let model = makeModel()

        model.query = "upload"

        // The same chat id on two machines is two rows, newest first.
        XCTAssertEqual(model.chats.map(\.id.instanceId), ["laptop", "studio"])
        XCTAssertEqual(Set(model.chats.map(\.id)).count, 2)
    }

    // MARK: Bots

    func testBotSearchAsksEachCapableMachineOnce() async {
        machineList = [
            machine("studio", "Studio Mac"),
            machine("laptop", "Laptop"),
            machine("mini", "Home Mini", canReadBots: false),
            machine("build", "Build Box", isConnected: false),
        ]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        desk.reply("laptop", "scout", [conversation("chat_1", title: "Scout notes", minutesAgo: 20)])
        let model = makeModel()

        model.query = " scout "
        let run = await startRun(model)
        XCTAssertTrue(desk.asks.isEmpty, "A machine was asked before the debounce ended")
        pastDebounce()
        await run.value

        XCTAssertEqual(desk.asks.sorted(), ["laptop: scout", "studio: scout"])
        // The same conversation id on two machines stays two hits.
        XCTAssertEqual(model.bots.map(\.id.instanceId), ["studio", "laptop"])
        XCTAssertEqual(model.bots.map(\.machineName), ["Studio Mac", "Laptop"])
        XCTAssertEqual(model.bots.map(\.title), ["Scout digest", "Scout notes"])
        XCTAssertEqual(model.bots.first?.botID, AidenHostObjectID(instanceId: "studio", deviceId: "phone", objectId: "bot_scout"))
        // A machine that can't read Bots isn't missing anything. One that isn't connected is.
        XCTAssertEqual(model.unsearchedMachines, ["Build Box"])
        XCTAssertFalse(model.isSearchingBots)
    }

    func testTheDebounceWaitsForTheLastKeystroke() async {
        machineList = [machine("studio", "Studio Mac")]
        let model = makeModel()

        model.query = "sc"
        let first = await startRun(model)
        clock.advance(by: .milliseconds(299))
        XCTAssertTrue(desk.asks.isEmpty)
        model.query = "scout"
        first.cancel()
        let second = await startRun(model)
        clock.advance(by: .milliseconds(299))
        XCTAssertTrue(desk.asks.isEmpty)
        clock.advance(by: .milliseconds(1))
        await second.value
        await first.value

        XCTAssertEqual(desk.asks, ["studio: scout"])
    }

    func testAnOlderQuerysLateReplyIsDropped() async {
        machineList = [machine("studio", "Studio Mac")]
        desk.hold("studio", "old", ignoringCancellation: true)
        desk.reply("studio", "new", [conversation("chat_new", title: "New answer")])
        let model = makeModel()

        model.query = "old"
        let older = await startRun(model)
        pastDebounce()
        await settle("old query asked") { desk.asks == ["studio: old"] }

        model.query = "new"
        let newer = await startRun(model)
        pastDebounce()
        await newer.value
        XCTAssertEqual(model.bots.map(\.title), ["New answer"])

        // The old query's machine answers last.
        desk.release("studio", "old", [conversation("chat_old", title: "Old answer")])
        await older.value

        XCTAssertEqual(model.bots.map(\.title), ["New answer"])
        XCTAssertFalse(model.isSearchingBots)
        XCTAssertTrue(model.unsearchedMachines.isEmpty)
    }

    func testANewQueryCancelsTheOldRequest() async {
        machineList = [machine("studio", "Studio Mac")]
        desk.hold("studio", "old", ignoringCancellation: false)
        let model = makeModel()

        model.query = "old"
        let older = await startRun(model)
        pastDebounce()
        await settle("old query asked") { desk.asks == ["studio: old"] }

        model.query = "new"
        let newer = await startRun(model)
        await settle("old request cancelled") { desk.cancelled == ["studio: old"] }
        newer.cancel()
        await newer.value
        await older.value

        // Cancelling isn't a failure to report.
        XCTAssertTrue(model.unsearchedMachines.isEmpty)
    }

    func testOneMachineFailingLeavesTheOthersResults() async {
        machineList = [
            machine("studio", "Studio Mac"),
            machine("laptop", "Laptop"),
            machine("mini", "Home Mini"),
        ]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        desk.fail("laptop", "scout")
        desk.reply("mini", "scout", [conversation("chat_2", title: "Scout on the mini", minutesAgo: 30)])
        let model = makeModel()

        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(model.bots.map(\.title), ["Scout digest", "Scout on the mini"])
        XCTAssertEqual(model.unsearchedMachines, ["Laptop"])
        XCTAssertFalse(model.isSearchingBots)
        // Each machine was still asked once.
        XCTAssertEqual(desk.asks.count, 3)
    }

    func testResultsFromOneMachineShowWhileAnotherIsStillAnswering() async {
        machineList = [machine("studio", "Studio Mac"), machine("laptop", "Laptop")]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        desk.hold("laptop", "scout", ignoringCancellation: false)
        let model = makeModel()

        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await settle("studio's hit shows") { model.bots.map(\.title) == ["Scout digest"] }

        XCTAssertTrue(model.isSearchingBots)
        desk.release("laptop", "scout", [conversation("chat_2", title: "Laptop notes", minutesAgo: 60)])
        await run.value
        XCTAssertEqual(model.bots.map(\.title), ["Scout digest", "Laptop notes"])
        XCTAssertFalse(model.isSearchingBots)
    }

    func testABotSearchOnlyAsksAboutTheFirstTwoHundredCharacters() async {
        machineList = [machine("studio", "Studio Mac")]
        let model = makeModel()

        model.query = String(repeating: "é", count: 260)
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(desk.asks, ["studio: " + String(repeating: "é", count: 200)])
        XCTAssertTrue(model.unsearchedMachines.isEmpty)
    }

    // MARK: Empty query

    func testAnEmptyQueryClearsResults() async {
        snapshots = [snapshot("studio", [chat("c1", "Scout plan")])]
        machineList = [machine("studio", "Studio Mac"), machine("build", "Build Box", isConnected: false)]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        let model = makeModel()
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value
        XCTAssertEqual(model.chats.count, 1)
        XCTAssertEqual(model.bots.count, 1)
        XCTAssertEqual(model.unsearchedMachines, ["Build Box"])

        model.query = "   "
        await model.run()

        XCTAssertTrue(model.chats.isEmpty)
        XCTAssertTrue(model.bots.isEmpty)
        XCTAssertTrue(model.unsearchedMachines.isEmpty)
        XCTAssertFalse(model.isSearchingBots)
        XCTAssertEqual(desk.asks, ["studio: scout"], "Clearing asked a machine")
    }

    func testClearingTheQueryDropsAReplyStillOnItsWay() async {
        machineList = [machine("studio", "Studio Mac")]
        desk.hold("studio", "scout", ignoringCancellation: true)
        let model = makeModel()
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await settle("asked") { desk.asks.count == 1 }

        model.query = ""
        await model.run()
        desk.release("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        await run.value

        XCTAssertTrue(model.bots.isEmpty)
        XCTAssertFalse(model.isSearchingBots)
    }

    // MARK: Opening

    func testAResultOpensOnItsOwnMachine() async throws {
        snapshots = [snapshot("laptop", [chat("c1", "Upload test")])]
        machineList = [machine("laptop", "Laptop")]
        desk.reply("laptop", "upload", [conversation("chat_9", bot: "bot_scout", title: "Upload digest")])
        let model = makeModel()
        model.query = "upload"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        let laptop = { (objectId: String) in AidenHostObjectID(instanceId: "laptop", deviceId: "phone", objectId: objectId) }
        XCTAssertEqual(model.chats.first?.route, .chat(laptop("c1")))
        XCTAssertEqual(model.bots.first?.route, .bot(laptop("bot_scout")))

        let navigation = AidenAppNavigation()
        navigation.tab = .search
        navigation.open(try XCTUnwrap(model.chats.first).route)
        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [.chat(laptop("c1"))])
        navigation.tab = .search
        navigation.open(try XCTUnwrap(model.bots.first).route)
        XCTAssertEqual(navigation.tab, .bots)
        XCTAssertEqual(navigation.botsPath, [.bot(laptop("bot_scout"))])
    }

    // MARK: Real machines

    /// Real clients over the demo machines, so each request is one the contract has.
    private func demoMachines(
        capable: Set<String> = ["studio", "laptop", "mini"],
        offline: Set<String> = []
    ) async throws -> (AidenRemoteCoordinator, AidenDemoResponder) {
        preferences = AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
        let responder = AidenDemoResponder()
        let installations = ["studio", "laptop", "mini"].map { id -> AidenInstallation in
            var installation = AidenDemoHosts.installation(instanceId: id, name: id.capitalized)
            if !capable.contains(id) {
                installation.deviceCapabilities.removeAll { $0 == .botRead || $0 == .botWrite }
            }
            return installation
        }
        let coordinator = AidenDemoHosts.coordinator(installations: installations, responder: responder)
        for id in ["studio", "laptop", "mini"] {
            responder.reply(instanceId: id, path: "/bot-conversations", status: 200, json: Data(
                #"{"conversations":[{"chatId":"chat_\#(id)","botId":"bot_scout","title":"Scout on \#(id)","activityState":"idle","canRespondToApproval":false,"createdAt":"2026-11-05T09:00:00.000Z","updatedAt":"2026-11-05T09:00:00.000Z","revision":"r1"}]}"#.utf8
            ))
        }
        for id in offline { responder.fail(instanceId: id, path: "*", code: .notConnectedToInternet) }
        await coordinator.start()
        // Only the selected machine connects on start. The rest connect as the app's scheduler does.
        for connection in coordinator.hosts.ordered where connection.instanceId != "studio" {
            await connection.connect()
        }
        return (coordinator, responder)
    }

    func testTheRealSourceReadsEachMachinesOwnCapabilityAndConnection() async throws {
        let (coordinator, _) = try await demoMachines(capable: ["studio", "mini"], offline: ["mini"])

        let machines = AidenSearchMachine.machines(in: coordinator, preferences: preferences)

        XCTAssertEqual(machines.map(\.instanceId), ["studio", "laptop", "mini"])
        XCTAssertEqual(machines.map(\.name), ["Studio", "Laptop", "Mini"])
        // Studio is the selected machine, yet each of the others is judged on its own.
        XCTAssertEqual(machines.map(\.canReadBots), [true, false, true])
        XCTAssertEqual(machines.map(\.isConnected), [true, true, false])
    }

    func testSearchingRealMachinesAsksOnlyConnectedCapableOnesAndLeavesTheSelectionAlone() async throws {
        let (coordinator, responder) = try await demoMachines(capable: ["studio", "mini"], offline: ["mini"])
        let before = (laptop: responder.requests(instanceId: "laptop").count, mini: responder.requests(instanceId: "mini").count)
        let model = realModel(coordinator)

        // A slash and a space must travel as a query, never as part of the path.
        model.query = "a/b ../c"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        let asked = { (id: String) in
            responder.requests(instanceId: id).filter { $0.contains("bot-conversations") }
        }
        XCTAssertEqual(asked("studio"), ["GET /bot-conversations"])
        XCTAssertEqual(asked("laptop"), [], "A machine without Bot access was asked")
        XCTAssertEqual(asked("mini"), [], "A machine that isn't connected was asked")
        XCTAssertEqual(responder.requests(instanceId: "laptop").count, before.laptop, "Searching reached a machine it had no reason to")
        XCTAssertEqual(responder.requests(instanceId: "mini").count, before.mini, "Searching retried a machine that isn't connected")
        XCTAssertEqual(model.bots.map(\.title), ["Scout on studio"])
        XCTAssertEqual(model.unsearchedMachines, ["Mini"])
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    func testARealMachineThatErrorsIsNamedAndTheRestStay() async throws {
        let (coordinator, responder) = try await demoMachines()
        responder.reply(instanceId: "laptop", path: "/bot-conversations", status: 500, json: Data("{}".utf8))
        let model = realModel(coordinator)

        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on mini"])
        XCTAssertEqual(model.unsearchedMachines, ["Laptop"])
        XCTAssertNil(coordinator.presentedError)
        XCTAssertEqual(coordinator.connectionState, .connected)
    }

    // MARK: Hidden and revoked machines

    func testHitsFromAMachineThatLeavesTheListAreDropped() async {
        machineList = [machine("studio", "Studio Mac"), machine("laptop", "Laptop")]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        desk.reply("laptop", "scout", [conversation("chat_2", title: "Scout notes", minutesAgo: 20)])
        let model = makeModel()
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value
        XCTAssertEqual(model.bots.map(\.title), ["Scout digest", "Scout notes"])

        // Hidden or forgotten: the machine is no longer one the person searches.
        machineList = [machine("studio", "Studio Mac")]

        XCTAssertEqual(model.bots.map(\.title), ["Scout digest"])
    }

    func testHitsFromAMachineRevokedAfterTheyLandedAreDropped() async {
        machineList = [machine("studio", "Studio Mac"), machine("laptop", "Laptop")]
        desk.reply("studio", "scout", [conversation("chat_1", title: "Scout digest")])
        desk.reply("laptop", "scout", [conversation("chat_2", title: "Scout notes", minutesAgo: 20)])
        let model = makeModel()
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        machineList = [machine("studio", "Studio Mac"), machine("laptop", "Laptop", isConnected: false, isBlocked: true)]

        XCTAssertEqual(model.bots.map(\.title), ["Scout digest"])
        XCTAssertTrue(model.unsearchedMachines.isEmpty, "A revoked machine was named")
    }

    func testARevokedMachineIsNotNamedAsOneThatCouldNotBeSearched() async {
        machineList = [
            machine("studio", "Studio Mac"),
            machine("laptop", "Laptop", isConnected: false, isBlocked: true),
            machine("build", "Build Box", isConnected: false),
        ]
        let model = makeModel()

        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(model.unsearchedMachines, ["Build Box"])
        XCTAssertEqual(desk.asks, ["studio: scout"])
    }

    func testTheQueryIsTrimmedForTheTaskThatRunsIt() {
        let model = makeModel()
        model.query = "  scout \n"
        XCTAssertEqual(model.trimmedQuery, "scout")
    }

    func testChatDetailsAreReadOnceForEveryRow() {
        snapshots = [
            snapshot("studio", [chat("c1", "Upload test")]),
            snapshot("laptop", [chat("c1", "Upload again")], online: false),
        ]
        machineList = [machine("studio", "Studio Mac"), machine("laptop", "Laptop")]
        let model = makeModel()
        model.query = "upload"

        let details = model.chatDetails()

        XCTAssertEqual(model.chats.map { details.machineName(for: $0) }, ["Laptop", "Studio Mac"])
        XCTAssertEqual(model.chats.map { details.workspaceName(for: $0) }, ["Project", "Project"])
    }

    func testTheRealSourceLeavesOutAHiddenMachine() async throws {
        let (coordinator, responder) = try await demoMachines(offline: ["mini"])
        preferences.update("laptop") { $0.isHidden = true }
        preferences.update("mini") { $0.isHidden = true }
        let model = realModel(coordinator)

        XCTAssertEqual(AidenSearchMachine.machines(in: coordinator, preferences: preferences).map(\.instanceId), ["studio"])
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(model.bots.map(\.title), ["Scout on studio"])
        XCTAssertTrue(model.unsearchedMachines.isEmpty, "A hidden machine was named")
        XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0.contains("bot-conversations") }, [])
    }

    func testARealMachineHiddenAfterItsHitsLandedLosesThem() async throws {
        let (coordinator, _) = try await demoMachines()
        let model = realModel(coordinator)
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value
        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on laptop", "Scout on mini"])

        preferences.update("laptop") { $0.isHidden = true }

        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on mini"])
    }

    func testARealMachineRevokedAfterItsHitsLandedLosesThem() async throws {
        let (coordinator, _) = try await demoMachines()
        let model = realModel(coordinator)
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value
        XCTAssertEqual(model.bots.count, 3)

        await revoke("laptop", in: coordinator)

        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on mini"])
        XCTAssertFalse(model.unsearchedMachines.contains("Laptop"))
    }

    func testARealMachineRevokedWhileItsRequestIsOutIsDropped() async throws {
        let (coordinator, responder) = try await demoMachines()
        let release = responder.hold(instanceId: "laptop", path: "/bot-conversations")
        let model = realModel(coordinator)
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await settle("laptop asked") {
            responder.requests(instanceId: "laptop").contains("GET /bot-conversations")
        }

        await revoke("laptop", in: coordinator)
        release()
        await run.value

        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on mini"])
        XCTAssertFalse(model.unsearchedMachines.contains("Laptop"), "A revoked machine was named")
        XCTAssertFalse(model.isSearchingBots)
    }

    func testABotSearchAsksForUpToFiftyConversations() async throws {
        let (coordinator, responder) = try await demoMachines()
        let seen = AidenQueryItemsBox()
        responder.reply(instanceId: "studio", path: "/bot-conversations", status: 200) { url in
            seen.record(url)
            return Data(#"{"conversations":[]}"#.utf8)
        }
        let model = realModel(coordinator)

        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value

        XCTAssertEqual(seen.value("limit"), "50")
        XCTAssertEqual(seen.value("query"), "scout")
    }

    func testASelectedMachineThatNeedsPairingLosesItsHitsAndIsNotNamed() async throws {
        let (coordinator, _) = try await demoMachines()
        let model = realModel(coordinator)
        model.query = "scout"
        let run = await startRun(model)
        pastDebounce()
        await run.value
        XCTAssertEqual(Set(model.bots.map(\.title)), ["Scout on studio", "Scout on laptop", "Scout on mini"])
        XCTAssertEqual(coordinator.activeInstanceId, "studio")

        // A selected machine with no credential to use ends here, without being revoked.
        let studio = try XCTUnwrap(coordinator.hosts.connection(for: "studio"))
        studio.adopt(connectionState: .needsPairing)

        XCTAssertFalse(studio.isRevoked)
        XCTAssertFalse(model.bots.contains { $0.id.instanceId == "studio" })
        XCTAssertFalse(model.unsearchedMachines.contains("Studio"))
    }

    // MARK: From the Inbox store

    func testTheChatInputIsBuiltFromTheInboxStoreAndKeepsItsHiddenMachines() async throws {
        let (coordinator, _) = try await demoMachines()
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenSearchModelTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        for id in ["studio", "laptop"] {
            let decoded = try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: Data(
                #"{"summaries":[{"id":"c_\#(id)","workspaceId":"workspace_app","title":"Upload test on \#(id)","titlePending":false,"createdAt":"2026-11-05T09:00:00.000Z","updatedAt":"2026-11-05T09:00:00.000Z","revision":"rev_\#(String(format: "%043d", 1))","activity":"idle","rowState":"idle","unread":false,"inboxBucket":"earlier","inboxSortAt":"2026-11-05T09:00:00.000Z"}]}"#.utf8
            ))
            _ = try await cache.saveChatSummaries(
                AidenChatCache.SummarySnapshot(summaries: decoded.summaries, nextCursor: nil),
                instanceId: id,
                writeToken: cache.reserveSummaryWrite(instanceId: id)
            )
            _ = await cache.saveWorkspaces(
                [try AidenRemoteJSONDecoder.decode(AidenWorkspace.self, from: Data(
                    #"{"id":"workspace_app","name":"Saved name","permission":"ask","memoryEnabled":true,"hasFolder":true,"isManagedWorktree":false,"createdAt":"2026-11-05T09:00:00.000Z","updatedAt":"2026-11-05T09:00:00.000Z","revision":"workspace_revision_7"}"#.utf8
                ))],
                instanceId: id,
                writeToken: cache.reserveChatWrite()
            )
        }
        let store = AidenUnifiedInboxStore(hosts: coordinator.hosts, preferences: preferences, cache: cache, clock: clock)
        await settle("saved chats reach the store") {
            store.snapshots["studio"]?.chats.isEmpty == false && store.snapshots["laptop"]?.chats.isEmpty == false
        }
        let model = AidenSearchModel(
            chatInput: { AidenSearchChatInput(store: store) },
            machines: { AidenSearchMachine.machines(in: coordinator, preferences: self.preferences) },
            clock: clock
        )
        model.query = "upload"
        XCTAssertEqual(Set(model.chats.map(\.id.instanceId)), ["studio", "laptop"])

        preferences.update("laptop") { $0.isHidden = true }
        await settle("the store sees the hidden machine") { store.hiddenMachines == ["laptop"] }

        XCTAssertEqual(AidenSearchChatInput(store: store).hiddenMachines, ["laptop"])
        XCTAssertEqual(model.chats.map(\.id.instanceId), ["studio"])
    }
}

private extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// The query items of the last request a reply closure saw.
private final class AidenQueryItemsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: String] = [:]

    func record(_ url: URL) {
        let found = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        lock.lock()
        items = Dictionary(found.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        lock.unlock()
    }

    func value(_ name: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return items[name]
    }
}

/// Stands in for the machines' Bot search: records who was asked, and answers,
/// fails or holds each (machine, query).
@MainActor
final class AidenBotDesk {
    private struct Key: Hashable {
        let machine: String
        let query: String
    }

    private enum Plan {
        case reply([AidenBotConversationItem])
        case fail
        case hold(ignoringCancellation: Bool)
    }

    struct Failure: Error {}

    private(set) var asks: [String] = []
    private(set) var cancelled: [String] = []
    private var plans: [Key: Plan] = [:]
    private var waiting: [Key: CheckedContinuation<[AidenBotConversationItem], Error>] = [:]

    func reply(_ machine: String, _ query: String, _ items: [AidenBotConversationItem]) {
        plans[Key(machine: machine, query: query)] = .reply(items)
    }

    func fail(_ machine: String, _ query: String) {
        plans[Key(machine: machine, query: query)] = .fail
    }

    func hold(_ machine: String, _ query: String, ignoringCancellation: Bool) {
        plans[Key(machine: machine, query: query)] = .hold(ignoringCancellation: ignoringCancellation)
    }

    func release(_ machine: String, _ query: String, _ items: [AidenBotConversationItem]) {
        waiting.removeValue(forKey: Key(machine: machine, query: query))?.resume(returning: items)
    }

    func search(machine: String, query: String) async throws -> [AidenBotConversationItem] {
        let key = Key(machine: machine, query: query)
        asks.append("\(machine): \(query)")
        switch plans[key] {
        case nil:
            return []
        case .reply(let items):
            return items
        case .fail:
            throw Failure()
        case .hold(let ignoringCancellation):
            if ignoringCancellation {
                return try await withCheckedThrowingContinuation { waiting[key] = $0 }
            }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[AidenBotConversationItem], Error>) in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        waiting[key] = continuation
                    }
                }
            } onCancel: {
                Task { @MainActor in
                    self.cancelled.append("\(machine): \(query)")
                    self.waiting.removeValue(forKey: key)?.resume(throwing: CancellationError())
                }
            }
        }
    }
}
#endif
