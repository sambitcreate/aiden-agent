import UserNotifications
import XCTest
@testable import AidenOnTheGo

/// A scripted Mac for Profile → Memory. Reads and edits are recorded so a
/// test can assert what reached the Mac.
private final class FakeBotMemoryTransport: AidenBotMemoryTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _reads: [Result<AidenBotMemory, Error>] = []
    private var _editResults: [Result<AidenBotMemory, Error>] = []
    private var _readCount = 0
    private var _edits: [(edit: AidenBotMemoryEdit, key: UUID)] = []

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func queueRead(_ result: Result<AidenBotMemory, Error>) { locked { _reads.append(result) } }
    func queueEdit(_ result: Result<AidenBotMemory, Error>) { locked { _editResults.append(result) } }
    var readCount: Int { locked { _readCount } }
    var edits: [(edit: AidenBotMemoryEdit, key: UUID)] { locked { _edits } }

    func botMemory(botId: String) async throws -> AidenBotMemory {
        let next = locked { () -> Result<AidenBotMemory, Error>? in
            _readCount += 1
            return _reads.isEmpty ? nil : _reads.removeFirst()
        }
        guard let next else { throw URLError(.notConnectedToInternet) }
        return try next.get()
    }

    func editBotMemory(
        botId: String,
        request: AidenBotMemoryEditRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMemory {
        let next = locked { () -> Result<AidenBotMemory, Error>? in
            _edits.append((request.edit, idempotencyKey))
            return _editResults.isEmpty ? nil : _editResults.removeFirst()
        }
        guard let next else { throw URLError(.notConnectedToInternet) }
        return try next.get()
    }
}

@MainActor
final class AidenBotMemoryTests: XCTestCase {
    private let botID = "bot_fixture_01"

    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The fixture's `GET /memory` view.
    private func fixtureMemory() throws -> AidenBotMemory {
        try decode(AidenBotMemory.self, try XCTUnwrap(try fixture()["botMemory"]))
    }

    /// The view the fixture's replace edit returns.
    private func editedMemory() throws -> AidenBotMemory {
        let edit = try XCTUnwrap(try fixture()["botMemoryEdit"] as? [String: Any])
        let response = try XCTUnwrap(edit["response"] as? [String: Any])
        return try decode(AidenBotMemory.self, try XCTUnwrap(response["view"]))
    }

    private func emptyMemory(readable: Bool = true) throws -> AidenBotMemory {
        var object = try XCTUnwrap(try fixture()["botMemory"] as? [String: Any])
        object["readable"] = readable
        object["revision"] = "0000000000000000"
        for key in ["user", "memory"] {
            var group = try XCTUnwrap(object[key] as? [String: Any])
            group["entries"] = [[String: Any]]()
            group["usedChars"] = 0
            object[key] = group
        }
        return try decode(AidenBotMemory.self, object)
    }

    private func serverError(status: Int, code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"No","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    private func loadedModel(_ transport: FakeBotMemoryTransport, _ memory: AidenBotMemory) async -> AidenBotMemoryModel {
        transport.queueRead(.success(memory))
        let model = AidenBotMemoryModel(botID: botID, botName: "Scout", transport: transport)
        await model.load()
        return model
    }

    // MARK: Load

    func testLoadShowsBothGroupsAndTheQuietCount() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())

        XCTAssertEqual(model.memory?.user.entries.count, 2)
        XCTAssertEqual(model.memory?.memory.entries.count, 1)
        XCTAssertEqual(model.countSummary, "3 things")
        XCTAssertNil(model.loadError)
    }

    func testAFailedFirstLoadShowsTheLoadErrorAndNoCount() async {
        let transport = FakeBotMemoryTransport()
        let model = AidenBotMemoryModel(botID: botID, botName: "Scout", transport: transport)
        await model.load()

        XCTAssertNil(model.memory)
        XCTAssertNil(model.countSummary)
        XCTAssertEqual(model.loadError, AidenBotMemoryCopy.couldNotLoad)
    }

    // MARK: Edit

    func testEditSendsTrimmedReplaceAndShowsTheReturnedView() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.success(try editedMemory()))

        let failure = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "  Prefers short, friendly answers.\n")

        XCTAssertNil(failure)
        XCTAssertEqual(
            transport.edits.map(\.edit),
            [.replace(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers short, friendly answers.")]
        )
        XCTAssertEqual(model.memory?.user.entries.first?.id, "5e5e5e5e5e5e5e5e", "the new content-addressed id")
        XCTAssertEqual(transport.readCount, 1, "a successful edit needs no refetch")
    }

    func testEditRejectsEmptyAndOverlongTextWithoutCallingTheMac() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())

        let empty = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "   ")
        let long = await model.save(
            target: .user,
            entryId: "0f1e2d3c4b5a6978",
            text: String(repeating: "a", count: AidenBotMemoryWire.maxEntryLength + 1)
        )

        XCTAssertNotNil(empty)
        XCTAssertNotNil(long)
        XCTAssertTrue(transport.edits.isEmpty)
    }

    func testAStaleEntryShowsChangedCopyAndRefetchesTheView() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.failure(try serverError(status: 404, code: "memory_entry_not_found")))
        transport.queueRead(.success(try editedMemory()))

        let failure = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers tea.")

        XCTAssertEqual(failure, "This memory changed since you opened it. Close this and try again.")
        XCTAssertEqual(transport.readCount, 2, "the error carries no view, so it is read again")
        XCTAssertEqual(model.memory?.revision, "7a7a7a7a7a7a7a7a")
    }

    func testOverBudgetAndBlockedEditsUseThePersonFacingCopy() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.failure(try serverError(status: 422, code: "memory_over_budget")))
        transport.queueRead(.success(try fixtureMemory()))
        transport.queueEdit(.failure(try serverError(status: 422, code: "memory_over_budget")))
        transport.queueRead(.success(try fixtureMemory()))
        transport.queueEdit(.failure(try serverError(status: 422, code: "memory_blocked")))
        transport.queueRead(.success(try fixtureMemory()))

        let aboutYou = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "A longer note")
        let notes = await model.save(target: .memory, entryId: "a1b2c3d4e5f60718", text: "A longer note")
        let blocked = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "password: hunter2")

        XCTAssertEqual(aboutYou, "That would make “About you” too long. Shorten it, or delete something else first.")
        XCTAssertEqual(notes, "That would make “Scout’s notes” too long. Shorten it, or delete something else first.")
        XCTAssertEqual(blocked, "This can’t be saved because it looks like a password or an instruction to the Bot.")
        XCTAssertEqual(transport.readCount, 4)
    }

    func testALostResponseRetriesUnderTheSameKeyButARefusalDoesNot() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.failure(URLError(.networkConnectionLost)))
        transport.queueRead(.success(try fixtureMemory()))
        transport.queueEdit(.failure(try serverError(status: 422, code: "memory_blocked")))
        transport.queueRead(.success(try fixtureMemory()))
        transport.queueEdit(.success(try editedMemory()))

        _ = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers tea.")
        _ = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers tea.")
        _ = await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers tea.")

        let keys = transport.edits.map(\.key)
        XCTAssertEqual(keys.count, 3)
        XCTAssertEqual(keys[0], keys[1], "an edit that may have reached the Mac replays its key")
        XCTAssertNotEqual(keys[1], keys[2], "a definite refusal starts a new request")
    }

    // MARK: Delete

    func testDeleteIsImmediateAndAFailureRefetches() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.success(try emptyMemory()))

        await model.delete(target: .memory, entryId: "a1b2c3d4e5f60718")

        XCTAssertEqual(transport.edits.map(\.edit), [.remove(target: .memory, entryId: "a1b2c3d4e5f60718")])
        XCTAssertEqual(model.countSummary, "Nothing yet")
        XCTAssertNil(model.errorMessage)

        transport.queueEdit(.failure(try serverError(status: 404, code: "memory_entry_not_found")))
        transport.queueRead(.success(try fixtureMemory()))
        await model.delete(target: .user, entryId: "1122334455667788")

        XCTAssertEqual(model.errorMessage, AidenBotMemoryCopy.entryChanged)
        XCTAssertEqual(model.countSummary, "3 things", "the refetched view replaces the stale one")
    }

    // MARK: Erase and unreadable memory

    func testEraseClearsBothGroups() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.success(try emptyMemory()))

        let erased = await model.erase()

        XCTAssertTrue(erased)
        XCTAssertEqual(transport.edits.map(\.edit), [.clear])
        XCTAssertEqual(model.memory?.entryCount, 0)
    }

    func testAFailedEraseSaysSoAndKeepsWhatTheMacHas() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.failure(try serverError(status: 422, code: "invalid_request")))
        transport.queueRead(.success(try fixtureMemory()))

        let erased = await model.erase()

        XCTAssertFalse(erased)
        XCTAssertEqual(model.errorMessage, AidenBotMemoryCopy.notErased)
        XCTAssertEqual(model.memory?.entryCount, 3)
    }

    func testUnreadableMemoryCanStillBeErased() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try emptyMemory(readable: false))
        XCTAssertEqual(model.countSummary, "Couldn’t be read")
        transport.queueEdit(.success(try emptyMemory()))

        let erased = await model.erase()

        XCTAssertTrue(erased)
        XCTAssertEqual(model.memory?.readable, true)
        XCTAssertEqual(model.countSummary, "Nothing yet")
    }

    func testUsageLineReadsLikeTheDesktop() {
        XCTAssertEqual(
            AidenBotMemoryCopy.usage(used: 563, limit: 1_375, locale: Locale(identifier: "en_US")),
            "563 of 1,375 characters"
        )
    }
}

// MARK: - Bot routine notifications

private final class FakeNotificationCenter: AidenRunAlertCenter {
    var status: UNAuthorizationStatus = .authorized
    var failNextAdd = false
    var grantsAuthorization = true
    private(set) var authorizationRequests = 0
    private(set) var posted: [UNNotificationRequest] = []

    func currentAuthorizationStatus() async -> UNAuthorizationStatus { status }
    func requestAlertAuthorization() async -> Bool {
        authorizationRequests += 1
        status = grantsAuthorization ? .authorized : .denied
        return grantsAuthorization
    }

    func add(_ request: UNNotificationRequest) async throws {
        if failNextAdd {
            failNextAdd = false
            throw URLError(.cannotCreateFile)
        }
        posted.append(request)
    }
}

private final class FakeNotificationFeed: AidenBotRoutineNotificationTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _feeds: [AidenBotRoutineNotificationFeed] = []
    private var _cursors: [String?] = []

    func queue(_ feed: AidenBotRoutineNotificationFeed) {
        lock.lock(); defer { lock.unlock() }
        _feeds.append(feed)
    }

    var cursors: [String?] {
        lock.lock(); defer { lock.unlock() }
        return _cursors
    }

    func botRoutineNotifications(since: String?) async throws -> AidenBotRoutineNotificationFeed {
        lock.lock(); defer { lock.unlock() }
        _cursors.append(since)
        guard !_feeds.isEmpty else { throw URLError(.notConnectedToInternet) }
        return _feeds.removeFirst()
    }
}

@MainActor
final class AidenBotRoutineNotifierTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private let instance = "instance_fixture_01"

    override func setUp() {
        super.setUp()
        suiteName = "AidenBotRoutineNotifierTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func feed(_ items: [(id: String, finishedAt: String)], now: String) throws -> AidenBotRoutineNotificationFeed {
        let notifications: [[String: Any]] = items.map { item in
            [
                "id": item.id, "botId": "bot_fixture_01", "botName": "Scout",
                "routineId": "task_fixture_routine_01", "routineName": "Morning brief",
                "status": "succeeded", "finishedAt": item.finishedAt,
                "preview": "Your first meeting is at 9:30 with Priya.",
            ]
        }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotRoutineNotificationFeed.self,
            from: JSONSerialization.data(withJSONObject: ["notifications": notifications, "now": now])
        )
    }

    func testFirstPollBaselinesThenPostsEachNewRunOnceAndOpensTheBotChat() async throws {
        let center = FakeNotificationCenter()
        let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([("run_old", "2026-08-19T14:00:00.000Z")], now: "2026-08-19T15:00:00.000Z"))
        transport.queue(try feed([("run_new", "2026-08-19T15:30:00.000Z")], now: "2026-08-19T16:00:00.000Z"))
        // A replay of the same run (for example a clock tie) must not post twice.
        transport.queue(try feed([("run_new", "2026-08-19T15:30:00.000Z")], now: "2026-08-19T16:05:00.000Z"))

        await notifier.deliver(instanceId: instance, transport: transport)
        XCTAssertTrue(center.posted.isEmpty, "pairing never floods the lock screen with history")
        await notifier.deliver(instanceId: instance, transport: transport)
        await notifier.deliver(instanceId: instance, transport: transport)

        XCTAssertEqual(transport.cursors, [nil, "2026-08-19T15:00:00.000Z", "2026-08-19T16:00:00.000Z"])
        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.bot-routine.run_new"])
        let content = try XCTUnwrap(center.posted.first?.content)
        XCTAssertEqual(content.title, "Scout")
        XCTAssertEqual(content.body, "Morning brief: Your first meeting is at 9:30 with Priya.")
        let link = try XCTUnwrap(AidenRunAlertNotifier.deepLink(from: content.userInfo))
        XCTAssertEqual(link, AidenDeepLink.botChatURL(instanceId: instance, botId: "bot_fixture_01"))
        XCTAssertNotNil(AidenDeepLink.request(from: link), "the tap opens the Bot's chat through the app's link router")
    }

    func testAFailedPostKeepsTheRunInTheNextWindow() async throws {
        let center = FakeNotificationCenter()
        let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([], now: "2026-08-19T15:00:00.000Z"))
        transport.queue(try feed([
            ("run_a", "2026-08-19T15:10:00.000Z"), ("run_b", "2026-08-19T15:20:00.000Z"),
        ], now: "2026-08-19T16:00:00.000Z"))
        transport.queue(try feed([("run_b", "2026-08-19T15:20:00.000Z")], now: "2026-08-19T16:10:00.000Z"))

        await notifier.deliver(instanceId: instance, transport: transport)
        center.failNextAdd = true
        await notifier.deliver(instanceId: instance, transport: transport)
        XCTAssertTrue(center.posted.isEmpty)
        await notifier.deliver(instanceId: instance, transport: transport)

        XCTAssertEqual(transport.cursors.last, "2026-08-19T15:00:00.000Z", "the cursor did not move past the failed run")
        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.bot-routine.run_b"])
    }

    func testCursorsAreKeptPerPairedMac() async throws {
        let center = FakeNotificationCenter()
        let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([], now: "2026-08-19T15:00:00.000Z"))
        transport.queue(try feed([], now: "2026-08-19T15:00:00.000Z"))

        await notifier.deliver(instanceId: instance, transport: transport)
        await notifier.deliver(instanceId: "instance_other", transport: transport)

        XCTAssertEqual(transport.cursors, [nil, nil], "another Mac starts from its own baseline")
    }

    func testPermissionIsAskedOnlyWhenThereIsARunToShow() async throws {
        let center = FakeNotificationCenter()
        center.status = .notDetermined
        let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([], now: "2026-08-19T15:00:00.000Z"))
        transport.queue(try feed([], now: "2026-08-19T15:10:00.000Z"))
        transport.queue(try feed([("run_a", "2026-08-19T15:20:00.000Z")], now: "2026-08-19T15:30:00.000Z"))

        await notifier.deliver(instanceId: instance, transport: transport)
        await notifier.deliver(instanceId: instance, transport: transport)
        XCTAssertEqual(center.authorizationRequests, 0, "a quiet refresh never prompts")
        await notifier.deliver(instanceId: instance, transport: transport)

        XCTAssertEqual(center.authorizationRequests, 1)
        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.bot-routine.run_a"])
    }

    func testNothingIsFetchedWithoutNotificationPermission() async throws {
        let center = FakeNotificationCenter()
        center.status = .denied
        let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)

        await notifier.deliver(instanceId: instance, transport: transport)

        XCTAssertTrue(transport.cursors.isEmpty)
    }
}
