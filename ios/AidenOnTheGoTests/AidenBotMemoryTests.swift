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
    private var _holding = false
    private var _held: [CheckedContinuation<Void, Never>] = []

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func queueRead(_ result: Result<AidenBotMemory, Error>) { locked { _reads.append(result) } }
    func queueEdit(_ result: Result<AidenBotMemory, Error>) { locked { _editResults.append(result) } }
    var readCount: Int { locked { _readCount } }
    var edits: [(edit: AidenBotMemoryEdit, key: UUID)] { locked { _edits } }
    /// Holds each edit until `releaseEdits()`.
    func holdEdits() { locked { _holding = true } }
    var heldEdits: Int { locked { _held.count } }
    func releaseEdits() {
        let waiting = locked { () -> [CheckedContinuation<Void, Never>] in
            _holding = false
            defer { _held = [] }
            return _held
        }
        waiting.forEach { $0.resume() }
    }

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
        locked { _edits.append((request.edit, idempotencyKey)) }
        if locked({ _holding }) {
            await withCheckedContinuation { continuation in
                locked { _held.append(continuation) }
            }
        }
        let next = locked { () -> Result<AidenBotMemory, Error>? in
            _editResults.isEmpty ? nil : _editResults.removeFirst()
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

    // MARK: Instant edits (R15)

    private func waitUntil(_ condition: () -> Bool, what: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testAnEditShowsAtOnceAndTheMacsViewReplacesIt() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.holdEdits()
        transport.queueEdit(.success(try editedMemory()))
        let saving = Task { await model.save(target: .user, entryId: "0f1e2d3c4b5a6978", text: "Prefers tea.") }
        try await waitUntil({ transport.heldEdits == 1 }, what: "the edit")
        XCTAssertEqual(model.memory?.user.entries.first?.text, "Prefers tea.", "the new text shows before the Mac answers")
        transport.releaseEdits()
        let failure = await saving.value
        XCTAssertNil(failure)
        XCTAssertEqual(model.memory, try editedMemory(), "the Mac's own view replaces it")
    }

    func testADeleteGoesAtOnceAndComesBackWhenItFailsAndTheMacCantBeRead() async throws {
        let transport = FakeBotMemoryTransport()
        let before = try fixtureMemory()
        let model = await loadedModel(transport, before)
        transport.holdEdits()
        transport.queueEdit(.failure(try serverError(status: 422, code: "invalid_request")))
        let deleting = Task { await model.delete(target: .memory, entryId: "a1b2c3d4e5f60718") }
        try await waitUntil({ transport.heldEdits == 1 }, what: "the delete")
        XCTAssertEqual(model.memory?.memory.entries.count, 0, "gone at once")
        XCTAssertEqual(model.countSummary, "2 things")
        transport.releaseEdits()
        await deleting.value
        XCTAssertEqual(model.memory, before, "no view to refetch: back to what showed before")
        XCTAssertEqual(model.errorMessage, AidenBotMemoryCopy.notSaved)
    }

    func testQuickEditsAreNeverRefusedAndReachTheMacInOrder() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.holdEdits()
        transport.queueEdit(.success(try fixtureMemory()))
        transport.queueEdit(.success(try emptyMemory()))
        let first = Task { await model.delete(target: .memory, entryId: "a1b2c3d4e5f60718") }
        try await waitUntil({ transport.heldEdits == 1 }, what: "the first delete")
        let second = Task { await model.delete(target: .user, entryId: "0f1e2d3c4b5a6978") }
        try await waitUntil({ model.memory?.user.entries.count == 1 }, what: "the second delete to show")
        XCTAssertEqual(transport.edits.count, 1, "the second waits for the first")
        transport.releaseEdits()
        await first.value
        await second.value
        XCTAssertEqual(transport.edits.map(\.edit), [
            .remove(target: .memory, entryId: "a1b2c3d4e5f60718"),
            .remove(target: .user, entryId: "0f1e2d3c4b5a6978"),
        ])
        XCTAssertNil(model.errorMessage, "no edit is turned away for arriving during another")
        XCTAssertEqual(model.memory?.entryCount, 0)
    }

    func testAnEditSavedFromTheClosedSheetReportsAFailureOnThePage() async throws {
        let transport = FakeBotMemoryTransport()
        let model = await loadedModel(transport, try fixtureMemory())
        transport.queueEdit(.failure(try serverError(status: 422, code: "memory_blocked")))
        transport.queueRead(.success(try fixtureMemory()))
        model.saveInBackground(target: .user, entryId: "0f1e2d3c4b5a6978", text: "password: hunter2")
        try await waitUntil({ model.errorMessage != nil }, what: "the failure")
        XCTAssertEqual(model.errorMessage, AidenBotMemoryCopy.blocked)
        XCTAssertEqual(model.memory, try fixtureMemory(), "the Mac's view is back")
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
    var beforeAuthorization: (() -> Void)?
    private(set) var authorizationRequests = 0
    private(set) var posted: [UNNotificationRequest] = []

    func currentAuthorizationStatus() async -> UNAuthorizationStatus { status }
    func requestAlertAuthorization() async -> Bool {
        authorizationRequests += 1
        beforeAuthorization?()
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

@MainActor
private final class SuspendingPeerNotificationCenter: AidenRunAlertCenter {
    var holdNextAdd = false
    private(set) var heldAdd: CheckedContinuation<Void, Never>?
    private(set) var posted: [UNNotificationRequest] = []
    func currentAuthorizationStatus() async -> UNAuthorizationStatus { .authorized }
    func requestAlertAuthorization() async -> Bool { true }
    func add(_ request: UNNotificationRequest) async throws {
        if holdNextAdd { holdNextAdd = false; await withCheckedContinuation { heldAdd = $0 } }
        posted.append(request)
    }
    func releaseAdd() { heldAdd?.resume(); heldAdd = nil }
}

private final class FakeNotificationFeed: AidenBotRoutineNotificationTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _feeds: [AidenBotRoutineNotificationFeed] = []
    private var _cursors: [String?] = []
    var beforeReturn: (() -> Void)?

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
        beforeReturn?()
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

    private func peerFeed(now: String) throws -> AidenBotRoutineNotificationFeed {
        try AidenRemoteJSONDecoder.decode(AidenBotRoutineNotificationFeed.self, from: JSONSerialization.data(withJSONObject: ["notifications": [[
            "id": "peer_root_final_one", "kind": "peer", "botId": "bot_fixture_01", "botName": "Planner", "routineName": "Review complete",
            "finishedAt": "2026-11-03T12:00:00.000Z", "preview": "The final review includes the peer’s findings."
        ]], "now": now]))
    }
    private var allAudienceGrants: Set<AidenRemoteCapability> { [.botRead, .chatRead, .botPeers, .botMessaging, .botIssues, .botAccessRequests] }

    private func installation(held: Set<AidenRemoteCapability>, offered: Set<AidenRemoteCapability>? = nil, legacy: Bool = false) throws -> AidenInstallation {
        var object: [String: Any] = [
            "instanceId": instance, "deviceId": "phone", "name": "Host", "endpoint": "https://host.test/api/aiden/v1",
            "serverSpkiSha256": "sha256/" + String(repeating: "A", count: 43),
            "deviceCapabilities": held.map(\.rawValue), "serverCapabilities": legacy ? NSNull() : (offered ?? allAudienceGrants).map(\.rawValue), "createdAt": "2026-11-03T10:00:00.000Z",
        ]
        if legacy { object.removeValue(forKey: "serverCapabilities") }
        return try AidenRemoteJSONDecoder.decode(AidenInstallation.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func host(held: Set<AidenRemoteCapability>, offered: Set<AidenRemoteCapability>? = nil, legacy: Bool = false) -> AidenServer {
        AidenServer(protocolVersion: 1, instanceId: instance, name: "Host", appVersion: "test", capabilities: Array(held), serverCapabilities: legacy ? nil : Array(offered ?? allAudienceGrants), connectionMode: .lan, minimumClientVersion: nil, serverTime: Date())
    }
    private func audience(_ held: Set<AidenRemoteCapability>, offered: Set<AidenRemoteCapability>? = nil, hostHeld: Set<AidenRemoteCapability>? = nil) throws -> Set<AidenRemoteCapability> {
        AidenBotRoutineNotifier.audienceGrants(installation: try installation(held: held, offered: offered), server: host(held: hostHeld ?? held, offered: offered))
    }

    private func projectedFeed(kind: String, title: String = "Needs you") throws -> AidenBotRoutineNotificationFeed {
        try AidenRemoteJSONDecoder.decode(AidenBotRoutineNotificationFeed.self, from: JSONSerialization.data(withJSONObject: ["notifications": [[
            "id": "projected-final", "kind": kind, "botId": "bot_fixture_01", "botName": "Planner", "routineName": title,
            "finishedAt": "2026-11-03T12:00:00.000Z", "preview": "A bounded host preview."
        ]], "now": "2026-11-03T12:01:00.000Z"]))
    }

    func testMessageAndIssueProjectionLossBeforePostKeepsCursorAndReceipts() async throws {
        for (kind, capability) in [("message", AidenRemoteCapability.botMessaging), ("issue", .botIssues), ("issue", .botAccessRequests)] {
            for boundary in ["fetch", "permission"] {
                defaults.removePersistentDomain(forName: suiteName)
                let start = "2026-11-03T11:00:00.000Z"
                defaults.set(start, forKey: AidenBotRoutineNotifier.cursorKey(instance))
                defaults.set(["prior-receipt"], forKey: AidenBotRoutineNotifier.deliveredKey(instance))
                let center = FakeNotificationCenter(); let transport = FakeNotificationFeed()
                let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
                var installed = try installation(held: allAudienceGrants)
                let server = host(held: allAudienceGrants)
                let reduced = try installation(held: allAudienceGrants.subtracting([capability]))
                if boundary == "fetch" { transport.beforeReturn = { installed = reduced } }
                else { center.status = .notDetermined; center.beforeAuthorization = { installed = reduced } }
                transport.queue(try projectedFeed(kind: kind))
                await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
                XCTAssertTrue(center.posted.isEmpty, "\(kind) / \(capability) / \(boundary)")
                XCTAssertEqual(defaults.string(forKey: AidenBotRoutineNotifier.cursorKey(instance)), start)
                XCTAssertEqual(defaults.stringArray(forKey: AidenBotRoutineNotifier.deliveredKey(instance)), ["prior-receipt"])
            }
        }
    }

    func testMessageAndIssueGrantLossDuringSystemPostRetainsOriginalProgressUntilFreshFetch() async throws {
        for (kind, capability) in [("message", AidenRemoteCapability.botMessaging), ("issue", .botIssues), ("issue", .botAccessRequests)] {
            defaults.removePersistentDomain(forName: suiteName)
            let start = "2026-11-03T11:00:00.000Z"
            defaults.set(start, forKey: AidenBotRoutineNotifier.cursorKey(instance))
            defaults.set(["prior-receipt"], forKey: AidenBotRoutineNotifier.deliveredKey(instance))
            let center = SuspendingPeerNotificationCenter(); let transport = FakeNotificationFeed()
            let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
            var installed = try installation(held: allAudienceGrants)
            let server = host(held: allAudienceGrants)
            transport.queue(try projectedFeed(kind: kind)); center.holdNextAdd = true
            let posting = Task { await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server }) }
            while center.heldAdd == nil { await Task.yield() }
            installed = try installation(held: allAudienceGrants.subtracting([capability]))
            center.releaseAdd(); await posting.value
            XCTAssertEqual(center.posted.count, 1)
            XCTAssertEqual(defaults.string(forKey: AidenBotRoutineNotifier.cursorKey(instance)), start)
            XCTAssertEqual(defaults.stringArray(forKey: AidenBotRoutineNotifier.deliveredKey(instance)), ["prior-receipt"])
            installed = try installation(held: allAudienceGrants)
            transport.queue(try projectedFeed(kind: kind))
            await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
            XCTAssertEqual(defaults.stringArray(forKey: AidenBotRoutineNotifier.deliveredKey(instance)), ["prior-receipt", "projected-final"])
        }
    }

    func testAudienceRequiresAcceptedAndCurrentHostGrantsRatherThanOffersAlone() async throws {
        let offered = allAudienceGrants
        XCTAssertFalse(try audience(offered.subtracting([.botMessaging]), offered: offered, hostHeld: offered).contains(.botMessaging))
        XCTAssertFalse(try audience(offered, offered: offered, hostHeld: offered.subtracting([.botIssues])).contains(.botIssues))
    }

    func testProductionAudienceRejectsOfferedOnlyMessagesAndMissingOptInsButKeepsLegacyRoutineFeed() async throws {
        let center = FakeNotificationCenter(); let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        let start = "2026-11-03T11:00:00.000Z"
        defaults.set(start, forKey: AidenBotRoutineNotifier.cursorKey(instance))
        var installed = try installation(held: allAudienceGrants.subtracting([.botMessaging]))
        var server = host(held: allAudienceGrants)
        transport.queue(try projectedFeed(kind: "message"))
        await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
        XCTAssertTrue(center.posted.isEmpty)
        installed = try installation(held: allAudienceGrants)
        server = host(held: allAudienceGrants, legacy: true)
        transport.queue(try projectedFeed(kind: "message"))
        await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
        XCTAssertTrue(center.posted.isEmpty, "Missing optional support never infers a messaging opt-in")
        installed = try installation(held: allAudienceGrants, legacy: true)
        server = host(held: allAudienceGrants)
        transport.queue(try projectedFeed(kind: "message"))
        await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
        XCTAssertTrue(center.posted.isEmpty, "Missing accepted support inventory never infers a messaging opt-in")
        installed = try installation(held: [.botRead, .chatRead])
        server = host(held: [.botRead, .chatRead], legacy: true)
        transport.queue(try feed([("legacy-routine", "2026-11-03T12:00:00.000Z")], now: "2026-11-03T12:01:00.000Z"))
        await notifier.deliverFromHost(instanceId: instance, transport: transport, installation: { installed }, server: { server })
        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.bot-routine.legacy-routine"])
    }

    func testPeerFinalNotificationRequiresCurrentCapabilityDeduplicatesAndOpensInitiatorChat() async throws {
        let center = FakeNotificationCenter(); let transport = FakeNotificationFeed(); let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([], now: "2026-11-03T11:00:00.000Z"))
        for _ in 0..<3 { transport.queue(try peerFeed(now: "2026-11-03T12:01:00.000Z")) }
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { [.botRead, .chatRead, .botPeers] })
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { [.botRead, .chatRead] })
        XCTAssertTrue(center.posted.isEmpty); XCTAssertEqual(defaults.string(forKey: AidenBotRoutineNotifier.cursorKey(instance)), "2026-11-03T11:00:00.000Z", "A late grant loss cannot consume a final update")
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { [.botRead, .chatRead, .botPeers] })
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { [.botRead, .chatRead, .botPeers] })
        XCTAssertEqual(center.posted.count, 1); XCTAssertEqual(center.posted.first?.identifier, "aiden.bot-routine.peer_root_final_one")
        let content = try XCTUnwrap(center.posted.first?.content); XCTAssertEqual(content.threadIdentifier, "aiden.bot-peer.\(instance).bot_fixture_01")
        XCTAssertEqual(AidenRunAlertNotifier.deepLink(from: content.userInfo), AidenDeepLink.botChatURL(instanceId: instance, botId: "bot_fixture_01"))
    }
    func testPeerGrantLossDuringAwaitedNotificationPostDoesNotConsumeCursorOrDeliveredID() async throws {
        let center = SuspendingPeerNotificationCenter(); let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center); var allowsPeers = true
        transport.queue(try feed([], now: "2026-11-03T11:00:00.000Z"))
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { allowsPeers ? [.botRead, .chatRead, .botPeers] : [.botRead, .chatRead] })
        transport.queue(try peerFeed(now: "2026-11-03T12:01:00.000Z")); center.holdNextAdd = true
        let posting = Task { await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { allowsPeers ? [.botRead, .chatRead, .botPeers] : [.botRead, .chatRead] }) }
        while center.heldAdd == nil { await Task.yield() }
        allowsPeers = false; center.releaseAdd(); await posting.value
        XCTAssertEqual(center.posted.count, 1, "The system may already have accepted the banner; no removal API is assumed")
        XCTAssertEqual(defaults.string(forKey: AidenBotRoutineNotifier.cursorKey(instance)), "2026-11-03T11:00:00.000Z")
        XCTAssertFalse((defaults.stringArray(forKey: AidenBotRoutineNotifier.deliveredKey(instance)) ?? []).contains("peer_root_final_one"))
        allowsPeers = true; transport.queue(try peerFeed(now: "2026-11-03T12:01:00.000Z"))
        await notifier.deliver(instanceId: instance, transport: transport, currentGrants: { allowsPeers ? [.botRead, .chatRead, .botPeers] : [.botRead, .chatRead] })
        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.bot-routine.peer_root_final_one", "aiden.bot-routine.peer_root_final_one"])
        XCTAssertEqual(defaults.stringArray(forKey: AidenBotRoutineNotifier.deliveredKey(instance)), ["peer_root_final_one"])
    }
    func testPairingPurgeDuringAwaitedNotificationPostCannotRecreateOldCursorOrReceipts() async throws {
        let center = SuspendingPeerNotificationCenter(); let transport = FakeNotificationFeed()
        let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center); var current = true
        transport.queue(try feed([], now: "2026-11-03T11:00:00.000Z"))
        await notifier.deliver(instanceId: instance, transport: transport, isCurrent: { current }, currentGrants: { [.botRead, .chatRead, .botPeers] })
        transport.queue(try peerFeed(now: "2026-11-03T12:01:00.000Z")); center.holdNextAdd = true
        let posting = Task { await notifier.deliver(instanceId: instance, transport: transport, isCurrent: { current }, currentGrants: { [.botRead, .chatRead, .botPeers] }) }
        while center.heldAdd == nil { await Task.yield() }
        current = false
        defaults.removeObject(forKey: AidenBotRoutineNotifier.cursorKey(instance)); defaults.removeObject(forKey: AidenBotRoutineNotifier.deliveredKey(instance))
        center.releaseAdd(); await posting.value
        XCTAssertEqual(center.posted.count, 1)
        XCTAssertNil(defaults.object(forKey: AidenBotRoutineNotifier.cursorKey(instance)))
        XCTAssertNil(defaults.object(forKey: AidenBotRoutineNotifier.deliveredKey(instance)))
    }

    func testPeerNotificationRejectsRoutineAuthorityFieldsAndStalePairingNeverPosts() async throws {
        let parsed = try peerFeed(now: "2026-11-03T12:01:00.000Z")
        var item = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(parsed.notifications[0])) as? [String: Any]); item["routineId"] = "routine_other"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenBotRoutineNotification.self, from: JSONSerialization.data(withJSONObject: item)))
        item.removeValue(forKey: "routineId"); item["status"] = "succeeded"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenBotRoutineNotification.self, from: JSONSerialization.data(withJSONObject: item)))
        let center = FakeNotificationCenter(); let transport = FakeNotificationFeed(); let notifier = AidenBotRoutineNotifier(defaults: defaults, center: center)
        transport.queue(try feed([], now: "2026-11-03T11:00:00.000Z")); await notifier.deliver(instanceId: instance, transport: transport)
        transport.queue(parsed); await notifier.deliver(instanceId: instance, transport: transport, isCurrent: { false }, currentGrants: { [.botRead, .chatRead, .botPeers] })
        XCTAssertTrue(center.posted.isEmpty); XCTAssertEqual(defaults.string(forKey: AidenBotRoutineNotifier.cursorKey(instance)), "2026-11-03T11:00:00.000Z")
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
