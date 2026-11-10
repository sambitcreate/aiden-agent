#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// A clock that moves only when a test moves it.
private final class AidenInboxTestClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration = .zero
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (left: Instant, right: Instant) -> Bool { left.offset < right.offset }
    }

    private struct Sleeper {
        let id: UUID
        let deadline: Instant
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current = Instant()
    private var sleepers: [Sleeper] = []

    var now: Instant { lock.withLock { current } }
    var minimumResolution: Duration { .zero }
    var sleeperCount: Int { lock.withLock { sleepers.count } }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                enum Start { case wait, resume, cancel }
                let start: Start = lock.withLock {
                    if Task.isCancelled { return .cancel }
                    if deadline <= current { return .resume }
                    sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return .wait
                }
                switch start {
                case .wait: break
                case .resume: continuation.resume()
                case .cancel: continuation.resume(throwing: CancellationError())
                }
            }
        } onCancel: {
            let cancelled: Sleeper? = lock.withLock {
                guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return sleepers.remove(at: index)
            }
            cancelled?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        let due: [Sleeper] = lock.withLock {
            current = current.advanced(by: duration)
            let due = sleepers.filter { $0.deadline <= current }
            sleepers.removeAll { $0.deadline <= current }
            return due
        }
        due.forEach { $0.continuation.resume() }
    }
}

/// Holds the next cache write at its start until the test lets it go on. Writes
/// after that one pass, so a test can land a newer write ahead of it.
private actor AidenInboxSaveGate {
    private(set) var arrivals = 0
    private var isClosed = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func close() { isClosed = true }

    func open() {
        isClosed = false
        waiting.forEach { $0.resume() }
        waiting = []
    }

    func pass() async {
        guard isClosed else { return }
        isClosed = false
        arrivals += 1
        await withCheckedContinuation { waiting.append($0) }
    }
}

/// The store over the demo machines, so every request is one the contract has,
/// and over a clock the tests move, so nothing here waits for a poll to come due.
@MainActor
final class AidenUnifiedInboxStoreTests: XCTestCase {
    private let responder = AidenDemoResponder()
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private let revokedJSON = Data("""
    {"error":{"code":"credential_revoked","message":"Pair this device again.",
    "requestId":"request-revoked","retryable":false}}
    """.utf8)
    private let serverErrorJSON = Data("""
    {"error":{"code":"internal_error","message":"The Mac stumbled.",
    "requestId":"request-500","retryable":true}}
    """.utf8)
    private var root: URL!
    private var cache: AidenChatCache!
    private var clock: AidenInboxTestClock!
    private var preferences: AidenMachinePreferencesStore!
    private var scheduler: AidenHostConnectScheduler!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenUnifiedInboxStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        cache = AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory))
        clock = AidenInboxTestClock()
        preferences = AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Fixtures

    private func coordinator(_ ids: String...) -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(
            installations: ids.map { AidenDemoHosts.installation(instanceId: $0, name: $0) },
            responder: responder
        )
    }

    /// Connects every machine the way the app does, through the scheduler.
    private func connectAll(_ coordinator: AidenRemoteCoordinator) async {
        scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
        await coordinator.start()
        await scheduler.foregrounded()
    }

    private func makeStore(
        _ coordinator: AidenRemoteCoordinator,
        jitter: @escaping @MainActor () -> Double = { 0 },
        onNow: @escaping @MainActor () -> Void = {}
    ) -> AidenUnifiedInboxStore {
        let fixedNow = now
        let store = AidenUnifiedInboxStore(
            hosts: coordinator.hosts,
            preferences: preferences,
            cache: cache,
            clock: clock,
            jitter: jitter,
            now: {
                onNow()
                return fixedNow
            }
        )
        store.connectScheduler = scheduler
        return store
    }

    private func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// `age` is minutes before `now`, so a page's rows stay in canonical order
    /// when their ages rise.
    private func row(
        _ id: String,
        age: Int,
        needsYou: Bool = false,
        inboxFields: Bool = true,
        workspace: String = "workspace_app"
    ) -> [String: Any] {
        let updated = timestamp(now.addingTimeInterval(-Double(age) * 60))
        var row: [String: Any] = [
            "id": id,
            "workspaceId": workspace,
            "title": id,
            "titlePending": false,
            "createdAt": updated,
            "updatedAt": updated,
            "revision": "rev_" + String(format: "%043d", age + 1),
            "activity": "idle",
            "rowState": "idle",
            "unread": false,
        ]
        if needsYou {
            row.merge(["activity": "active", "rowState": "needs_approval", "attentionSince": updated, "runStartedAt": updated]) { $1 }
        }
        if inboxFields {
            row.merge(["inboxBucket": needsYou ? "needs_you" : "earlier", "inboxSortAt": updated]) { $1 }
        }
        return row
    }

    private func running(_ id: String, age: Int) -> [String: Any] {
        var running = row(id, age: age)
        let started = timestamp(now.addingTimeInterval(-Double(age) * 60))
        running.merge([
            "activity": "active", "rowState": "working", "runStartedAt": started,
            "inboxBucket": "working", "inboxSortAt": started,
        ]) { $1 }
        return running
    }

    private func page(_ rows: [[String: Any]], next: String? = nil) -> Data {
        var object: [String: Any] = ["summaries": rows]
        if let next { object["nextCursor"] = next }
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func cursor(_ name: String) -> String {
        "cur_\(name).\(String(repeating: "a", count: 43))"
    }

    private func serve(_ rows: [[String: Any]], on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/chat-summaries", status: 200, json: page(rows))
    }

    private func save(_ rows: [[String: Any]], on instanceId: String) async throws {
        let decoded = try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: page(rows))
        _ = try await cache.saveChatSummaries(
            AidenChatCache.SummarySnapshot(summaries: decoded.summaries, nextCursor: nil),
            instanceId: instanceId,
            writeToken: cache.reserveSummaryWrite(instanceId: instanceId)
        )
    }

    /// The Inbox shows a row only under a workspace it can name.
    private func saveWorkspace(on instanceId: String) async throws {
        _ = await cache.saveWorkspaces(
            [try AidenRemoteJSONDecoder.decode(AidenWorkspace.self, from: Data("""
            {"id":"workspace_app","name":"Saved name","permission":"ask","memoryEnabled":true,"hasFolder":true,
            "isManagedWorktree":false,"createdAt":"2026-11-05T09:00:00.000Z","updatedAt":"2026-11-05T09:00:00.000Z",
            "revision":"workspace_revision_7"}
            """.utf8))],
            instanceId: instanceId,
            writeToken: cache.reserveChatWrite()
        )
    }

    private func connection(_ instanceId: String, in coordinator: AidenRemoteCoordinator) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    private func polls(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /chat-summaries" }.count
    }

    private func untilSaving(_ gate: AidenInboxSaveGate) async {
        let deadline = Date().addingTimeInterval(60)
        while await gate.arrivals == 0, Date() < deadline {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    private func workspaceReads(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /workspaces" }.count
    }

    /// The Mac's list once a workspace has been made on it.
    private func serveWorkspaces(_ ids: String..., on instanceId: String) {
        let workspaces = ids.map { id -> [String: Any] in
            [
                "id": id, "name": id, "permission": "ask", "memoryEnabled": true, "hasFolder": true,
                "isManagedWorktree": false, "createdAt": "2026-11-05T09:00:00.000Z",
                "updatedAt": "2026-11-05T09:00:00.000Z", "revision": "workspace_revision_7",
            ]
        }
        responder.reply(
            instanceId: instanceId,
            path: "/workspaces",
            status: 200,
            json: try! JSONSerialization.data(withJSONObject: ["workspaces": workspaces])
        )
    }

    private func probes(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /server" }.count
    }

    /// Row ids on one machine, in every list the Inbox shows.
    private func rowIDs(_ inbox: AidenUnifiedInbox, on instanceId: String) -> Set<String> {
        Set((inbox.needsYou + inbox.updates + inbox.earlier + inbox.running)
            .filter { $0.id.instanceId == instanceId }
            .map(\.id.objectId))
    }

    private func isOffline(_ connection: AidenHostConnection) -> Bool {
        if case .offline = connection.connectionState { return true }
        return false
    }

    /// For work on the main actor or a demo request to land. It watches a
    /// condition; nothing here waits for a set time to pass.
    private func waitUntil(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(60)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("Timed out waiting for \(what)", file: file, line: line)
                return
            }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    /// Every poller is asleep on the clock, so none has a request still to send.
    private func untilAsleep(_ count: Int, file: StaticString = #filePath, line: UInt = #line) async {
        await waitUntil("\(count) pollers asleep", file: file, line: line) { clock.sleeperCount == count }
    }

    /// Moves the clock and lets whatever came due run, so a check that nothing
    /// went out can fail. A poller that came due has left the clock by the time
    /// `advance` returns, and is back once its poll is done. A connect it asked
    /// for starts a turn or two of the main actor later.
    private func advance(
        by duration: Duration,
        asleep: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        clock.advance(by: duration)
        await Task.yield()
        await untilAsleep(asleep, file: file, line: line)
        for _ in 0..<10 { await Task.yield() }
    }

    /// Starts the store and returns once its first polls are in.
    private func startAndSettle(
        _ store: AidenUnifiedInboxStore,
        machines: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        store.start()
        await untilAsleep(machines, file: file, line: line)
    }

    // MARK: Delays

    func testDelayMatchesTheTable() {
        let expected: [(AidenInboxPollRole, failures: Int, plain: Double, jittered: Double)] = [
            (.focused, 0, 15, 18), (.background, 0, 30, 36), (.inboxHidden, 0, 60, 72),
            (.focused, 1, 30, 36), (.background, 1, 30, 36), (.inboxHidden, 1, 30, 36),
            (.focused, 2, 60, 72), (.background, 2, 60, 72), (.inboxHidden, 2, 60, 72),
            (.focused, 3, 120, 144), (.background, 3, 120, 144), (.inboxHidden, 3, 120, 144),
            (.focused, 4, 300, 360), (.background, 4, 300, 360), (.inboxHidden, 4, 300, 360),
            (.focused, 9, 300, 360), (.background, 9, 300, 360), (.inboxHidden, 9, 300, 360),
        ]
        for row in expected {
            XCTAssertEqual(
                AidenInboxPollPolicy.delay(role: row.0, failures: row.failures, jitter: 0),
                .seconds(row.plain),
                "\(row.0) after \(row.failures) failures"
            )
            XCTAssertEqual(
                AidenInboxPollPolicy.delay(role: row.0, failures: row.failures, jitter: 0.2),
                .seconds(row.jittered),
                "\(row.0) after \(row.failures) failures, with jitter"
            )
        }
    }

    func testJitterOutsideItsRangeIsHeldToIt() {
        XCTAssertEqual(AidenInboxPollPolicy.delay(role: .focused, failures: 0, jitter: 5), .seconds(18))
        XCTAssertEqual(AidenInboxPollPolicy.delay(role: .focused, failures: 0, jitter: -1), .seconds(15))
    }

    func testAMachineWithOneChatOpenPollsFasterThanTheRest() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        store.setFocusedMachine("laptop")
        await startAndSettle(store, machines: 2)

        await advance(by: .seconds(14), asleep: 2)
        XCTAssertEqual(polls("laptop"), 1)
        clock.advance(by: .seconds(1))
        await waitUntil("the focused machine's poll") { polls("laptop") == 2 }
        await untilAsleep(2)
        XCTAssertEqual(polls("studio"), 1, "Only the focused machine is on 15 seconds")

        clock.advance(by: .seconds(15))
        await waitUntil("the other machine's poll") { polls("studio") == 2 }
        store.stop()
    }

    func testTheOnlyMachineCountsAsFocused() async {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)

        clock.advance(by: .seconds(15))

        await waitUntil("the second poll") { polls("studio") == 2 }
        store.stop()
    }

    func testTheInboxOutOfViewSlowsEveryMachine() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(false)
        store.setFocusedMachine("laptop")
        await startAndSettle(store, machines: 2)

        await advance(by: .seconds(59), asleep: 2)
        XCTAssertEqual(polls("studio"), 1)
        XCTAssertEqual(polls("laptop"), 1)
        clock.advance(by: .seconds(1))

        await waitUntil("both polls") { polls("studio") == 2 && polls("laptop") == 2 }
        store.stop()
    }

    func testComingBackToTheInboxPollsWhatIsDueAndNothingElse() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        await advance(by: .seconds(40), asleep: 2)
        XCTAssertEqual(polls("studio"), 1)

        store.setInboxVisible(true)

        await waitUntil("the polls that came due") { polls("studio") == 2 && polls("laptop") == 2 }
        await untilAsleep(2)
        clock.advance(by: .seconds(5))
        store.setInboxVisible(false)
        store.setInboxVisible(true)
        await untilAsleep(2)
        XCTAssertEqual(polls("studio"), 2, "Flipping tabs must not poll")
        clock.advance(by: .seconds(25))
        await waitUntil("the poll that was already scheduled") { polls("studio") == 3 }
        store.stop()
    }

    func testEachMachineKeepsItsOwnJitter() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        var draws = [0.0, 0.2].makeIterator()
        let store = makeStore(coordinator, jitter: { draws.next() ?? 0.1 })
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)

        clock.advance(by: .seconds(30))
        await waitUntil("the machine with no jitter") { polls("studio") + polls("laptop") == 3 }
        await untilAsleep(2)
        XCTAssertEqual(polls("studio") + polls("laptop"), 3, "Both machines fired together")

        clock.advance(by: .seconds(6))
        await waitUntil("the machine with jitter") { polls("studio") == 2 && polls("laptop") == 2 }
        store.stop()
    }

    // MARK: Polling only in the foreground

    func testNothingPollsBeforeStart() async {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)

        await store.refreshAll()
        clock.advance(by: .seconds(3600))

        XCTAssertEqual(clock.sleeperCount, 0)
        XCTAssertEqual(polls("studio"), 0)
    }

    func testPollingStopsWhenBackgrounded() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)
        XCTAssertEqual(polls("studio"), 1)
        XCTAssertEqual(polls("laptop"), 1)

        store.stop()
        await untilAsleep(0)
        clock.advance(by: .seconds(3600))
        await store.refreshAll()

        XCTAssertEqual(polls("studio"), 1)
        XCTAssertEqual(polls("laptop"), 1)
        XCTAssertEqual(clock.sleeperCount, 0)
    }

    func testStartingAgainPollsAtOnce() async {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        store.stop()
        await untilAsleep(0)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), 2)
        store.stop()
    }

    func testAMachineThatLeavesStopsBeingPolled() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)
        XCTAssertFalse(rowIDs(store.inbox, on: "laptop").isEmpty)

        await coordinator.removeInstallation("laptop")

        await waitUntil("the machine's rows to go") { store.snapshots["laptop"] == nil }
        await untilAsleep(1)
        XCTAssertTrue(rowIDs(store.inbox, on: "laptop").isEmpty)
        clock.advance(by: .seconds(3600))
        await untilAsleep(1)
        XCTAssertEqual(polls("laptop"), 1)
        store.stop()
    }

    func testAMachinePairedWhileRunningStartsBeingPolled() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        let later = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "later", name: "later")],
            responder: responder
        )
        let installation = try XCTUnwrap(later.installationStore.installations.first)

        coordinator.hosts.sync(with: coordinator.installationStore.installations + [installation])

        await untilAsleep(2)
        XCTAssertNotNil(store.snapshots["later"])
        store.stop()
    }

    func testTheStoreEndsItsPollingWhenItGoes() async {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        var store: AidenUnifiedInboxStore? = makeStore(coordinator)
        await startAndSettle(store!, machines: 2)
        weak let gone = store

        store = nil

        await untilAsleep(0)
        XCTAssertNil(gone)
        await advance(by: .seconds(3600), asleep: 0)
        XCTAssertEqual(polls("studio"), 1)
    }

    // MARK: Cold start

    func testColdStartWalksPagesUntilOneHasNoNeedsYou() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1, needsYou: true), row("b", age: 2)], next: cursor("two")
        ))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 200, json: page(
            [row("c", age: 3)], next: cursor("three")
        ))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("three"))", status: 200, json: page(
            [row("d", age: 4, needsYou: true)]
        ))
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), 2, "Page two had nothing that needs the person")
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["a", "b", "c"])
        store.stop()
    }

    func testColdStartStopsAtFirstPageWithNoNeedsYou() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1)], next: cursor("two")
        ))
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), 1)
        store.stop()
    }

    private func serveThreeFullPages(on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1, needsYou: true)], next: cursor("two")
        ))
        responder.reply(instanceId: instanceId, path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 200, json: page(
            [row("b", age: 2, needsYou: true)], next: cursor("three")
        ))
        responder.reply(instanceId: instanceId, path: "/chat-summaries", query: "limit=100&cursor=\(cursor("three"))", status: 200, json: page(
            [row("c", age: 3, needsYou: true)], next: cursor("four")
        ))
        responder.reply(instanceId: instanceId, path: "/chat-summaries", query: "limit=100&cursor=\(cursor("four"))", status: 200, json: page(
            [row("d", age: 4, needsYou: true)]
        ))
    }

    func testColdStartStopsAtThreePages() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), AidenInboxPollPolicy.coldStartPageLimit)
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["a", "b", "c"])
        store.stop()
    }

    func testALaterPollReadsOnePageAndKeepsTheRowsTheWalkFound() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("new", age: 0), row("a", age: 1, needsYou: true)], next: cursor("two")
        ))

        clock.advance(by: .seconds(15))
        await waitUntil("the steady poll") { polls("studio") == 4 }
        await waitUntil("its row") { rowIDs(store.inbox, on: "studio").contains("new") }
        await untilAsleep(1)

        XCTAssertEqual(polls("studio"), 4, "Only a cold start walks pages")
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["new", "a", "b", "c"])
        XCTAssertEqual(store.inbox.needsYouCount, 3, "A deep row that needs the person left the badge")
        store.stop()
    }

    func testARowGoneFromTheFirstPageDoesNotStayAsWalked() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        // "b" was deleted on the Mac: this page runs past where it would be.
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1, needsYou: true), row("c", age: 3, needsYou: true)], next: cursor("four")
        ))

        clock.advance(by: .seconds(15))
        await waitUntil("the row to go") { rowIDs(store.inbox, on: "studio") == ["a", "c"] }
        store.stop()
    }

    func testAColdWalkOverFullPagesKeepsEveryRow() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        func fullPage(from start: Int, next: String?) -> Data {
            page((start..<start + AidenChatSummaryPage.defaultLimit).map { row("row\($0)", age: $0, needsYou: true) }, next: next)
        }
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: fullPage(from: 1000, next: cursor("two")))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 200, json: fullPage(from: 1100, next: cursor("three")))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("three"))", status: 200, json: fullPage(from: 1200, next: cursor("four")))
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(store.snapshots["studio"]?.chats.count, 3 * AidenChatSummaryPage.defaultLimit)
        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
        store.stop()
    }

    func testAFailedColdWalkKeepsTheRowsPastThePageItRead() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        store.stop()
        await untilAsleep(0)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("new", age: 0, needsYou: true), row("a", age: 1, needsYou: true)], next: cursor("two")
        ))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 500, json: serverErrorJSON)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["new", "a", "b", "c"])
        XCTAssertEqual(store.inbox.needsYouCount, 4)
        let saved = await cache.loadChatSummaries(instanceId: "studio")
        XCTAssertEqual(saved?.summaries.map(\.id), ["new", "a", "b", "c"])
        store.stop()
    }

    func testAPageReadBeforeAColdWalkFailedIsKept() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("three"))", status: 500, json: serverErrorJSON)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["a", "b"])
        store.stop()
    }

    func testACacheRefusalOnAWalkedPageLeavesTheMachineConnected() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        cache = AidenChatCache(root: root.appending(path: "full", directoryHint: .isDirectory), maxSummaryCacheFileBytes: 6_000)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1, needsYou: true)], next: cursor("two")
        ))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 200, json: page(
            (2..<60).map { row("row\($0)", age: $0) }
        ))
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), 2, "The walk reached the page the cache refuses")
        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
        store.stop()
    }

    func testAWalkTheCacheTurnedAwayIsWalkedAgain() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serveThreeFullPages(on: "studio")
        let gate = AidenInboxSaveGate()
        cache = AidenChatCache(
            root: root.appending(path: "gated", directoryHint: .isDirectory),
            beforeMetadataWrite: { await gate.pass() }
        )
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await gate.close()
        store.start()
        await untilSaving(gate)

        // A newer write lands first, so the walk's save is turned away.
        try await save([row("newer", age: 0)], on: "studio")
        await gate.open()
        await untilAsleep(1)
        XCTAssertEqual(polls("studio"), 3)

        clock.advance(by: .seconds(15))
        await waitUntil("the next poll") { polls("studio") > 3 }
        await untilAsleep(1)
        XCTAssertEqual(polls("studio"), 6, "That walk never landed, so this poll walks")
        store.stop()
    }

    func testAWalkThatFailsIsTriedAgain() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100", status: 200, json: page(
            [row("a", age: 1, needsYou: true)], next: cursor("two")
        ))
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 500, json: serverErrorJSON)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["a"])
        responder.reply(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor("two"))", status: 200, json: page(
            [row("b", age: 2)]
        ))

        clock.advance(by: .seconds(30))

        await waitUntil("the walk") { rowIDs(store.inbox, on: "studio") == ["a", "b"] }
        store.stop()
    }

    // MARK: Offline and old machines

    func testAnOfflineMachineShowsItsCachedRows() async throws {
        let coordinator = AidenDemoHosts.coordinator(.offlineMix, responder: responder)
        try await save([row("saved", age: 1, needsYou: true), row("older", age: 2)], on: "laptop")
        try await saveWorkspace(on: "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 4)

        await waitUntil("the saved rows") { rowIDs(store.inbox, on: "laptop") == ["saved", "older"] }
        let snapshot = try XCTUnwrap(store.snapshots["laptop"])
        XCTAssertFalse(snapshot.isOnline)
        XCTAssertFalse(snapshot.isBlocked)
        XCTAssertNil(snapshot.fetchedAt)
        await waitUntil("the saved workspace name") { store.snapshots["laptop"]?.workspaceNames["workspace_app"] == "Saved name" }
        let needsYou = store.inbox.needsYou.filter { $0.id.instanceId == "laptop" }
        XCTAssertEqual(needsYou.map(\.isOnline), [false], "Offline rows are dimmed")
        let onlineNeedsYou = store.inbox.needsYou.filter(\.isOnline).count
        XCTAssertEqual(store.inbox.needsYouCount, onlineNeedsYou, "Offline rows count toward no badge")
        XCTAssertEqual(polls("laptop"), 0, "An offline machine goes through a connect, not a poll")
        store.stop()
    }

    func testAMachineNotYetConnectedShowsItsCachedRowsBeforeAnyPoll() async throws {
        let coordinator = coordinator("studio")
        try await save([row("saved", age: 1)], on: "studio")
        try await saveWorkspace(on: "studio")

        let store = makeStore(coordinator)

        await waitUntil("the saved rows") { rowIDs(store.inbox, on: "studio") == ["saved"] }
        XCTAssertEqual(store.snapshots["studio"]?.isOnline, false)
        XCTAssertEqual(polls("studio"), 0)
    }

    /// The poll can start before the saved rows have been read back.
    func testAMachineThatFailsItsFirstPollStillShowsItsCachedRows() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        try await save([row("saved", age: 1)], on: "studio")
        responder.fail(instanceId: "studio", path: "/chat-summaries", code: .notConnectedToInternet)

        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["saved"])
        XCTAssertEqual(store.snapshots["studio"]?.isOnline, false)
        store.stop()
    }

    /// A row this phone can't save is this phone's problem, not news of the machine.
    func testAPageTheCacheRefusesLeavesTheMachineConnected() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        cache = AidenChatCache(root: root.appending(path: "full", directoryHint: .isDirectory), maxSummaryCacheFileBytes: 64)
        serve([row("answered", age: 1)], on: "studio")
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(polls("studio"), 1)
        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
        store.stop()
    }

    // MARK: What the connection has to know

    func testAChatInANewWorkspaceIsFoundAndCountedByAPull() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("known", age: 2)], on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        let readsBefore = workspaceReads("studio")
        serveWorkspaces("workspace_app", "workspace_new", on: "studio")
        serve([row("fresh", age: 1, needsYou: true, workspace: "workspace_new"), row("known", age: 2)], on: "studio")

        await store.refreshAll()

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["fresh", "known"])
        XCTAssertEqual(store.inbox.needsYouCount, 1)
        XCTAssertEqual(workspaceReads("studio"), readsBefore + 1)
        XCTAssertEqual(store.snapshots["studio"]?.workspaceNames["workspace_new"], "workspace_new")
        store.stop()
    }

    func testAWorkspaceStillUnknownIsNotReadForAgainUntilAnotherTurnsUp() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("lost", age: 1, workspace: "workspace_gone"), row("known", age: 2)], on: "studio")
        let store = makeStore(coordinator)
        let readsBefore = workspaceReads("studio")

        await startAndSettle(store, machines: 1)
        await store.refreshAll()
        await store.refreshAll()

        XCTAssertEqual(workspaceReads("studio"), readsBefore + 1)
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["known"])

        serve([row("other", age: 0, workspace: "workspace_other"), row("known", age: 2)], on: "studio")
        await store.refreshAll()
        XCTAssertEqual(workspaceReads("studio"), readsBefore + 2)
        store.stop()
    }

    func testAServerErrorOnTheWorkspaceListIsNotAFailedPoll() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("lost", age: 1, workspace: "workspace_gone"), row("known", age: 2)], on: "studio")
        responder.reply(instanceId: "studio", path: "/workspaces", status: 500, json: serverErrorJSON)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        let readsBefore = workspaceReads("studio")

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(workspaceReads("studio"), readsBefore + 1)
        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
        let pollsBefore = polls("studio")
        clock.advance(by: .seconds(15))
        await waitUntil("the next poll, on time") { polls("studio") == pollsBefore + 1 }
        await untilAsleep(1)
        XCTAssertEqual(workspaceReads("studio"), readsBefore + 2, "A 5xx may pass, so the next poll asks again")
        store.stop()
    }

    func testAWorkspaceListThatKeepsFailingIsReadThreeTimes() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("lost", age: 1, workspace: "workspace_gone"), row("known", age: 2)], on: "studio")
        responder.reply(instanceId: "studio", path: "/workspaces", status: 503, json: serverErrorJSON)
        let store = makeStore(coordinator)
        let readsBefore = workspaceReads("studio")

        await startAndSettle(store, machines: 1)
        for _ in 0..<4 { await store.refreshAll() }

        XCTAssertEqual(workspaceReads("studio"), readsBefore + 3)
        store.stop()
    }

    func testAWorkspaceListThatRecoversBringsItsChatIn() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("fresh", age: 1, needsYou: true, workspace: "workspace_new")], on: "studio")
        responder.reply(instanceId: "studio", path: "/workspaces", status: 500, json: serverErrorJSON)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        XCTAssertEqual(store.inbox.needsYouCount, 0)

        serveWorkspaces("workspace_app", "workspace_new", on: "studio")
        await store.refreshAll()

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["fresh"])
        XCTAssertEqual(store.inbox.needsYouCount, 1)
        store.stop()
    }

    func testARefusalOfTheWorkspaceListIsNotAnsweredAgain() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("lost", age: 1, workspace: "workspace_gone")], on: "studio")
        responder.reply(instanceId: "studio", path: "/workspaces", status: 403, json: serverErrorJSON)
        let store = makeStore(coordinator)
        let readsBefore = workspaceReads("studio")

        await startAndSettle(store, machines: 1)
        await store.refreshAll()

        XCTAssertEqual(workspaceReads("studio"), readsBefore + 1)
        store.stop()
    }

    func testAnOldCredentialsRefusalOfTheWorkspaceListSaysNothingOfANewPairing() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let laptop = try connection("laptop", in: coordinator)
        let readsBefore = workspaceReads("laptop")
        let release = responder.hold(instanceId: "laptop", path: "/workspaces")
        responder.reply(instanceId: "laptop", path: "/workspaces", status: 401, json: revokedJSON)
        let read = Task { try await laptop.refreshWorkspacesForPoll() }
        await waitUntil("the read") { workspaceReads("laptop") == readsBefore + 1 }

        laptop.advanceHostGeneration()
        release()

        do {
            try await read.value
            XCTFail("A 401 can't read as an answer")
        } catch {
            XCTAssertTrue(aidenIsCancellation(error), "Only the old pairing was refused: \(error)")
        }
    }

    func testAWorkspaceReadThatFindsNoMachineIsAFailedPoll() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("lost", age: 1, workspace: "workspace_gone")], on: "studio")
        responder.fail(instanceId: "studio", path: "/workspaces", code: .notConnectedToInternet)
        let store = makeStore(coordinator)
        let studio = try connection("studio", in: coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertTrue(isOffline(studio))
        store.stop()
    }

    func testAWorkspaceReadStoppedOnItsWayWritesNothing() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("known", age: 2)], on: "studio")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        let readsBefore = workspaceReads("studio")
        let release = responder.hold(instanceId: "studio", path: "/workspaces")
        serveWorkspaces("workspace_app", "workspace_new", on: "studio")
        serve([row("fresh", age: 1, workspace: "workspace_new"), row("known", age: 2)], on: "studio")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the read") { workspaceReads("studio") == readsBefore + 1 }

        store.stop()
        release()
        await refresh.value

        let studio = try connection("studio", in: coordinator)
        XCTAssertFalse(studio.workspaces.contains { $0.id == "workspace_new" })
    }

    func testAMachineThatLosesChatReadLosesItsRows() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        XCTAssertFalse(rowIDs(store.inbox, on: "laptop").isEmpty)
        let laptop = try connection("laptop", in: coordinator)
        let pollsBefore = polls("laptop")
        var narrowed = AidenDemoHosts.installation(instanceId: "laptop", name: "laptop")
        narrowed.deviceCapabilities.removeAll { $0 == .chatRead }
        _ = AidenDemoHosts.coordinator(installations: [narrowed], responder: responder)

        await laptop.connect(over: .probe)

        await waitUntil("the rows to go") { rowIDs(store.inbox, on: "laptop").isEmpty }
        await untilAsleep(2)
        XCTAssertEqual(store.snapshots["laptop"]?.chats, [])
        XCTAssertEqual(store.inbox.needsYou.filter { $0.id.instanceId == "laptop" }.count, 0)
        XCTAssertEqual(polls("laptop"), pollsBefore, "Nothing reads what it may no longer read")
        store.stop()
    }

    func testAnOldHostThatRefusesInboxFieldsStillListsChats() async throws {
        let coordinator = AidenDemoHosts.coordinator(.oldHost, responder: responder)
        await connectAll(coordinator)
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertFalse(rowIDs(store.inbox, on: "studio").isEmpty)
        XCTAssertEqual(polls("studio"), 0, "An old host doesn't advertise chat summaries")
        XCTAssertTrue(responder.requests(instanceId: "studio").contains("GET /chats"))
        XCTAssertEqual(store.snapshots["studio"]?.isOnline, true)
        store.stop()
    }

    func testAHostThatSendsSummariesWithoutInboxFieldsStillListsChats() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("plain", age: 90, inboxFields: false)], on: "studio")
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["plain"])
        store.stop()
    }

    // MARK: Reaching machines

    func testPullToRefreshHitsEachOnlineMachineOnce() async throws {
        let coordinator = AidenDemoHosts.coordinator(.offlineMix, responder: responder)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 4)
        let offlineProbes = probes("laptop")
        XCTAssertEqual(polls("studio"), 1)
        XCTAssertEqual(polls("mini"), 1)
        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")

        let refresh = Task { await store.refreshAll() }

        // "At once": one machine holding its answer doesn't delay the next.
        await waitUntil("both polls") { polls("mini") == 2 && polls("studio") == 2 }
        release()
        await refresh.value
        XCTAssertEqual(polls("studio"), 2)
        XCTAssertEqual(polls("mini"), 2)
        XCTAssertEqual(polls("laptop"), 0)
        XCTAssertEqual(polls("build"), 0)
        XCTAssertEqual(probes("laptop"), offlineProbes)
        store.stop()
    }

    func testPullToRefreshJoinsAPollAlreadyOut() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")
        clock.advance(by: .seconds(15))
        await waitUntil("the poll") { polls("studio") == 2 }

        let refresh = Task { await store.refreshAll() }
        await Task.yield()
        release()
        await refresh.value

        XCTAssertEqual(polls("studio"), 2)
        store.stop()
    }

    func testAPullPutsOffTheNextPoll() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        clock.advance(by: .seconds(10))

        await store.refreshAll()
        XCTAssertEqual(polls("studio"), 2)
        clock.advance(by: .seconds(5))
        await untilAsleep(1)

        XCTAssertEqual(polls("studio"), 2, "The poll that was due came a moment after the pull")
        clock.advance(by: .seconds(10))
        await waitUntil("the next poll") { polls("studio") == 3 }
        store.stop()
    }

    /// Wi-Fi to cellular: a LAN machine has gone, and nothing but the poll finds out.
    func testAFailedPollOnAConnectedMachineMarksItOfflineAndBacksOff() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)
        let laptop = try connection("laptop", in: coordinator)
        XCTAssertEqual(laptop.connectionState, .connected)
        let probesBefore = probes("laptop")
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)

        clock.advance(by: .seconds(30))
        await waitUntil("the machine to go offline") { self.isOffline(laptop) }
        await untilAsleep(2)
        XCTAssertEqual(store.snapshots["laptop"]?.isOnline, false)
        XCTAssertEqual(store.inbox.needsYou.filter { $0.id.instanceId == "laptop" && $0.isOnline }.count, 0)
        XCTAssertNil(coordinator.presentedError, "A poll has no app-wide error to show")

        // Failure 1 waits 30 seconds, and the next attempt is a connect.
        let connectsBefore = laptop.connectionGeneration
        await advance(by: .seconds(29), asleep: 2)
        XCTAssertEqual(laptop.connectionGeneration, connectsBefore, "Failure 1 waits the whole 30 seconds")
        XCTAssertEqual(probes("laptop"), probesBefore)
        clock.advance(by: .seconds(1))
        await waitUntil("a connect through the scheduler") { self.probes("laptop") == probesBefore + 1 }
        await waitUntil("the connect to fail") { !laptop.isConnectInFlight }
        await untilAsleep(2)

        // Failure 2 waits 60 seconds.
        await advance(by: .seconds(59), asleep: 2)
        XCTAssertEqual(laptop.connectionGeneration, connectsBefore + 1, "Failure 2 waits the whole 60 seconds")
        XCTAssertEqual(probes("laptop"), probesBefore + 1)
        clock.advance(by: .seconds(1))
        await waitUntil("the next connect") { self.probes("laptop") == probesBefore + 2 }
        await waitUntil("the connect to fail") { !laptop.isConnectInFlight }
        await untilAsleep(2)
        XCTAssertEqual(polls("laptop"), 2, "Nothing polls a machine known to be offline")
        store.stop()
    }

    func testAMachineBackOnlineIsPolledAtOnceAndLosesItsBackoff() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)
        let laptop = try connection("laptop", in: coordinator)
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)
        clock.advance(by: .seconds(30))
        await waitUntil("the machine to go offline") { self.isOffline(laptop) }
        await untilAsleep(2)
        _ = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "laptop", name: "laptop")],
            responder: responder
        )
        let pollsBefore = polls("laptop")

        clock.advance(by: .seconds(30))

        await waitUntil("the poll after the connect") { polls("laptop") == pollsBefore + 1 }
        await waitUntil("the row to brighten") { store.snapshots["laptop"]?.isOnline == true }
        await untilAsleep(2)
        await advance(by: .seconds(29), asleep: 2)
        XCTAssertEqual(polls("laptop"), pollsBefore + 1)
        clock.advance(by: .seconds(1))
        await waitUntil("the usual 30 seconds") { polls("laptop") == pollsBefore + 2 }
        store.stop()
    }

    func testAServerErrorBacksOffButLeavesTheMachineConnected() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        let studio = try connection("studio", in: coordinator)
        responder.reply(instanceId: "studio", path: "/chat-summaries", status: 500, json: serverErrorJSON)

        clock.advance(by: .seconds(15))
        await waitUntil("the failed poll") { polls("studio") == 2 }
        await untilAsleep(1)

        XCTAssertEqual(studio.connectionState, .connected)
        await advance(by: .seconds(29), asleep: 1)
        XCTAssertEqual(polls("studio"), 2, "Backoff is 30 seconds after one failure")
        clock.advance(by: .seconds(1))
        await waitUntil("the retry") { polls("studio") == 3 }
        store.stop()
    }

    func testAMachineBeingCheckedAgainKeepsItsRowsLit() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        let laptop = try connection("laptop", in: coordinator)
        let release = responder.hold(instanceId: "laptop", path: "/server")

        let check = Task { await laptop.connect(over: .probe) }
        await waitUntil("the check to start") { laptop.connectionState == .connecting }
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(store.snapshots["laptop"]?.isOnline, true)
        release()
        await check.value
        store.stop()
    }

    func testAConnectFinishingPollsWithoutWaitingForTheTimer() async throws {
        let coordinator = coordinator("studio", "laptop")
        await coordinator.start()
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        XCTAssertEqual(polls("laptop"), 0, "Not connected yet")

        await connectAll(coordinator)

        await waitUntil("the poll") { polls("laptop") == 1 }
        store.stop()
    }

    // MARK: Revocation and late answers

    /// `loose` sits under the hidden No workspace record on `laptop`, and `kept`
    /// in a workspace of its own.
    private func noWorkspaceMachine() async throws -> (AidenRemoteCoordinator, AidenUnifiedInboxStore, AidenHostObjectID) {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("loose", age: 1, workspace: "default"), row("kept", age: 2)], on: "laptop")
        responder.reply(instanceId: "laptop", path: "/chats/loose", status: 200, json: Data("""
        {"id":"loose","workspaceId":"default","title":"loose","messages":[],"createdAt":"2026-11-01T10:00:00.000Z",
        "updatedAt":"2026-11-01T10:00:00.000Z","revision":"chat_revision_current"}
        """.utf8))
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/loose", status: 204, json: Data())
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        let installation = try connection("laptop", in: coordinator).installation
        return (coordinator, store, AidenHostObjectID(instanceId: "laptop", deviceId: installation.deviceId, objectId: "loose"))
    }

    func testADeletedChatLeavesAtOnceOverItsOwnMachine() async throws {
        let (coordinator, store, loose) = try await noWorkspaceMachine()
        let selected = coordinator.activeInstanceId
        let release = responder.hold(instanceId: "laptop", path: "/chats/loose")
        let studioRequests = responder.requests(instanceId: "studio").count

        let deletion = Task { await store.delete(loose) }
        await waitUntil("the row to leave") { rowIDs(store.inbox, on: "laptop") == ["kept"] }
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("DELETE /chats/loose"))
        release()

        let result = await deletion.value
        XCTAssertEqual(result, .deleted)
        let requests = responder.requests(instanceId: "laptop")
        let read = try XCTUnwrap(requests.firstIndex(of: "GET /chats/loose"), "The row's revision can lag a rename")
        let removal = try XCTUnwrap(requests.firstIndex(of: "DELETE /chats/loose"))
        XCTAssertLessThan(read, removal)
        XCTAssertEqual(requests.last, "GET /workspaces", "The chat's hidden folder stayed listed")
        XCTAssertEqual(coordinator.activeInstanceId, selected, "Deleting moved the selection")
        XCTAssertFalse(responder.requests(instanceId: "studio").dropFirst(studioRequests).contains { $0.contains("loose") })
        store.stop()
    }

    func testAFailedDeleteBringsTheRowBackAndSaysSo() async throws {
        let (_, store, loose) = try await noWorkspaceMachine()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/loose", status: 500, json: serverErrorJSON)

        let result = await store.delete(loose)

        XCTAssertEqual(result, .failed)
        await waitUntil("the row to return") { rowIDs(store.inbox, on: "laptop") == ["loose", "kept"] }
        await waitUntil("the notice") { store.notice?.instanceId == "laptop" }
        store.stop()
    }

    func testADeleteAnsweredWithARevocationEndsThePairing() async throws {
        let (_, store, loose) = try await noWorkspaceMachine()
        responder.reply(instanceId: "laptop", method: "DELETE", path: "/chats/loose", status: 401, json: revokedJSON)

        let result = await store.delete(loose)

        XCTAssertEqual(result, .abandoned)
        await waitUntil("the rows to drop") { rowIDs(store.inbox, on: "laptop").isEmpty }
        XCTAssertTrue(try XCTUnwrap(store.snapshots["laptop"]).isBlocked)
        XCTAssertNil(store.notice)
        store.stop()
    }

    /// A running chat is what the Inbox has to say, so it isn't caught up.
    func testAnInboxWithOnlyRunningChatsIsNotCaughtUp() async throws {
        let coordinator = coordinator("studio")
        serve([running("run", age: 3)], on: "studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 1)

        XCTAssertEqual(store.inbox.running.map(\.id.objectId), ["run"])
        XCTAssertTrue(store.hasRunningChats)
        XCTAssertEqual(store.listState, .rows)
        store.stop()
    }

    func testARunThatEndsTakesTheAccessoryWithIt() async throws {
        let coordinator = coordinator("studio")
        serve([running("run", age: 3)], on: "studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        XCTAssertTrue(store.hasRunningChats)

        // Past the recent window, so the finished chat isn't listed in Earlier.
        serve([row("run", age: 100_000)], on: "studio")
        await store.refreshAll()

        XCTAssertFalse(store.hasRunningChats)
        XCTAssertEqual(store.listState, .caughtUp)
        store.stop()
    }

    /// It can't be confirmed running, so it's a row in Updates, and the Inbox can't
    /// say "All caught up" over it.
    func testAnOfflineRunningChatIsARowAndNeverCaughtUp() async throws {
        let coordinator = coordinator("studio")
        try await saveWorkspace(on: "studio")
        try await save([running("run", age: 3)], on: "studio")
        responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.start()
        await waitUntil("the machine to be offline") { store.snapshots["studio"]?.isOnline == false }
        await waitUntil("the saved row") { !store.inbox.updates.isEmpty || !store.inbox.running.isEmpty }

        XCTAssertEqual(store.inbox.updates.map(\.id.objectId), ["run"])
        XCTAssertEqual(store.inbox.running, [])
        XCTAssertFalse(store.hasRunningChats)
        XCTAssertEqual(store.inbox.needsYouCount, 0)
        XCTAssertEqual(store.listState, .rows)
        store.stop()
    }

    func testARevokedMachinesRowsDropAtOnce() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        XCTAssertFalse(rowIDs(store.inbox, on: "laptop").isEmpty)
        let countBefore = store.inbox.needsYouCount
        let studioCount = store.inbox.needsYou.filter { $0.id.instanceId == "studio" }.count
        XCTAssertGreaterThan(countBefore, studioCount)
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop", in: coordinator))

        // No clock movement: this is not the next poll.
        await waitUntil("the rows to drop") { rowIDs(store.inbox, on: "laptop").isEmpty }
        XCTAssertEqual(store.inbox.needsYouCount, studioCount)
        let snapshot = try XCTUnwrap(store.snapshots["laptop"], "The machine waits for its purge")
        XCTAssertTrue(snapshot.isBlocked)
        XCTAssertEqual(snapshot.chats, [])
        XCTAssertEqual(snapshot.workspaceNames, [:])
        await untilAsleep(1)

        coordinator.setOnScreen(false, view: view, instanceId: "laptop")
        await waitUntil("the purge") { store.snapshots["laptop"] == nil }
        store.stop()
    }

    func testA401OnAPollDropsTheMachineWithoutAnAppWideError() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        responder.reply(instanceId: "laptop", path: "/chat-summaries", status: 401, json: revokedJSON)

        await store.refreshAll()

        await waitUntil("the rows to drop") { rowIDs(store.inbox, on: "laptop").isEmpty }
        await untilAsleep(1)
        XCTAssertNil(coordinator.presentedError)
        XCTAssertNotNil(coordinator.hosts.connection(for: "studio"))
        store.stop()
    }

    func testA401OnThePollOfTheSelectedMachineTakesTheSelectedPath() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        responder.reply(instanceId: "studio", path: "/chat-summaries", status: 401, json: revokedJSON)

        await store.refreshAll()

        await waitUntil("the machine to go") { store.snapshots["studio"] == nil }
        await waitUntil("the app-wide notice") { coordinator.presentedError?.contains("revoked") == true }
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
        store.stop()
    }

    func testAReplyFromBeforeARevocationDoesNotBringRowsBack() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("before", age: 1)], on: "laptop")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        let release = responder.hold(instanceId: "laptop", path: "/chat-summaries")
        serve([row("late", age: 0)], on: "laptop")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("laptop") == 2 }

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop", in: coordinator))
        release()
        await refresh.value

        XCTAssertEqual(store.snapshots["laptop"]?.chats, [])
        XCTAssertTrue(rowIDs(store.inbox, on: "laptop").isEmpty)
        let saved = await cache.loadChatSummaries(instanceId: "laptop")
        XCTAssertEqual(saved?.summaries.map(\.id), ["before"], "A late answer reached the cache")
        coordinator.setOnScreen(false, view: view, instanceId: "laptop")
        store.stop()
    }

    func testAReplyFromBeforeARepairIsDropped() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("before", age: 1)], on: "laptop")
        let laptop = try connection("laptop", in: coordinator)
        let model = AidenHomeModel(chatCache: cache)
        _ = await model.pollChats(host: laptop, walkingPages: false, now: now)
        let release = responder.hold(instanceId: "laptop", path: "/chat-summaries")
        serve([row("late", age: 0)], on: "laptop")
        let poll = Task { await model.pollChats(host: laptop, walkingPages: false, now: now) }
        await waitUntil("the poll") { polls("laptop") == 2 }

        laptop.advanceHostGeneration()
        release()
        let result = await poll.value

        guard case .abandoned = result else { return XCTFail("\(result)") }
        XCTAssertEqual(model.chats.map(\.id), ["before"])
        let saved = await cache.loadChatSummaries(instanceId: "laptop")
        XCTAssertEqual(saved?.summaries.map(\.id), ["before"])
    }

    func testARepairStartsTheMachineOverWithAColdWalk() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)
        let laptop = try connection("laptop", in: coordinator)
        serveThreeFullPages(on: "laptop")

        laptop.advanceHostGeneration()

        await waitUntil("the walk") { polls("laptop") == 1 + AidenInboxPollPolicy.coldStartPageLimit }
        await waitUntil("its rows") { rowIDs(store.inbox, on: "laptop") == ["a", "b", "c"] }
        store.stop()
    }

    func testACancelledPollWritesNoSnapshot() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("before", age: 1)], on: "studio")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")
        serve([row("late", age: 0)], on: "studio")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("studio") == 2 }

        store.stop()
        release()
        await refresh.value

        XCTAssertEqual(store.snapshots["studio"]?.chats.map(\.id), ["before"])
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["before"])
        let saved = await cache.loadChatSummaries(instanceId: "studio")
        XCTAssertEqual(saved?.summaries.map(\.id), ["before"])
    }

    /// A save under way can't be cancelled, so the answer is stopped after it.
    func testAPollStoppedWhileItsPageSavesWritesNoSnapshot() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("before", age: 1)], on: "studio")
        let gate = AidenInboxSaveGate()
        cache = AidenChatCache(
            root: root.appending(path: "gated", directoryHint: .isDirectory),
            beforeMetadataWrite: { await gate.pass() }
        )
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        await gate.close()
        serve([row("late", age: 0)], on: "studio")
        let refresh = Task { await store.refreshAll() }
        await untilSaving(gate)

        store.stop()
        await gate.open()
        await refresh.value

        XCTAssertEqual(store.snapshots["studio"]?.chats.map(\.id), ["before"])
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["before"])
    }

    func testAPollThatFailsAfterANewerConnectLeavesTheMachineConnected() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("rows", age: 1)], on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        let studio = try connection("studio", in: coordinator)
        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("studio") == 2 }

        await studio.connect(over: .probe)
        responder.fail(instanceId: "studio", path: "/chat-summaries", code: .notConnectedToInternet)
        release()
        await refresh.value
        await untilAsleep(1)

        XCTAssertEqual(studio.connectionState, .connected)
        serve([row("rows", age: 1)], on: "studio")
        let pollsBefore = polls("studio")
        clock.advance(by: .seconds(15))
        await waitUntil("the next poll, with no backoff") { polls("studio") == pollsBefore + 1 }
        store.stop()
    }

    func testAPollThatFailsDuringAConnectLeavesItToTheConnect() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        let studio = try connection("studio", in: coordinator)
        let releasePoll = responder.hold(instanceId: "studio", path: "/chat-summaries")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("studio") == 2 }
        let releaseConnect = responder.hold(instanceId: "studio", path: "/server")
        let check = Task { await studio.connect(over: .probe) }
        await waitUntil("the connect") { studio.connectionState == .connecting }

        responder.fail(instanceId: "studio", path: "/chat-summaries", code: .notConnectedToInternet)
        releasePoll()
        await refresh.value

        XCTAssertEqual(studio.connectionState, .connecting)
        releaseConnect()
        await check.value
        XCTAssertEqual(studio.connectionState, .connected)
        store.stop()
    }

    func testARevocationCountsEvenAfterANewerConnect() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("before", age: 1)], on: "laptop")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        let laptop = try connection("laptop", in: coordinator)
        let release = responder.hold(instanceId: "laptop", path: "/chat-summaries")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("laptop") == 2 }

        await laptop.connect(over: .probe)
        responder.reply(instanceId: "laptop", path: "/chat-summaries", status: 401, json: revokedJSON)
        release()
        await refresh.value

        XCTAssertTrue(laptop.isRevoked)
        await waitUntil("the rows to drop") { rowIDs(store.inbox, on: "laptop").isEmpty }
        store.stop()
    }

    func testAFailureAfterStopLeavesTheMachineAlone() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")
        responder.fail(instanceId: "studio", path: "/chat-summaries", code: .notConnectedToInternet)
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("studio") == 2 }

        store.stop()
        release()
        await refresh.value

        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
    }

    // MARK: Filter, hidden machines and preferences

    func testHidingTheFilteredMachineResetsTheFilterToAll() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        store.filter = .machine("laptop")
        XCTAssertTrue(rowIDs(store.inbox, on: "studio").isEmpty)

        preferences.update("laptop") { $0.isHidden = true }

        await waitUntil("the filter to reset") { store.filter == .all }
        XCTAssertFalse(rowIDs(store.inbox, on: "studio").isEmpty)
        XCTAssertTrue(rowIDs(store.inbox, on: "laptop").isEmpty)
        store.stop()
    }

    func testRevokingTheFilteredMachineResetsTheFilterToAll() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        store.filter = .machine("laptop")
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")

        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop", in: coordinator))

        await waitUntil("the filter to reset") { store.filter == .all }
        XCTAssertFalse(rowIDs(store.inbox, on: "studio").isEmpty)
        coordinator.setOnScreen(false, view: view, instanceId: "laptop")
        store.stop()
    }

    func testForgettingTheFilteredMachineResetsTheFilterToAll() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        store.filter = .machine("laptop")

        await coordinator.removeInstallation("laptop")

        await waitUntil("the filter to reset") { store.filter == .all }
        store.stop()
    }

    func testAFilterOnAMachineThatIsNotShownResetsAtOnce() async throws {
        let coordinator = coordinator("studio")
        let store = makeStore(coordinator)

        store.filter = .machine("nowhere")

        XCTAssertEqual(store.filter, .all)
    }

    func testAHiddenMachineIsNotPolledUntilItIsShownAgain() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        preferences.update("laptop") { $0.isHidden = true }
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        clock.advance(by: .seconds(3600))
        await untilAsleep(1)
        XCTAssertEqual(polls("laptop"), 0)

        preferences.update("laptop") { $0.isHidden = false }

        await waitUntil("the machine's first poll") { polls("laptop") == 1 }
        await waitUntil("its rows") { !rowIDs(store.inbox, on: "laptop").isEmpty }
        store.stop()
    }

    func testHidingAMachineLeavesTheOtherAsTheOnlyMachine() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 2)

        preferences.update("laptop") { $0.isHidden = true }
        await untilAsleep(1)
        clock.advance(by: .seconds(15))

        await waitUntil("the 15 second poll") { polls("studio") == 2 }
        store.stop()
    }

    func testMachinesGetTheirColoursWhenTheyLoadNotFromAView() async throws {
        let coordinator = coordinator("studio", "laptop")

        _ = makeStore(coordinator)

        // Pairing order, whatever is asked for first afterwards.
        XCTAssertEqual(preferences.preferences(for: "laptop").color, .teal)
        XCTAssertEqual(preferences.preferences(for: "studio").color, .blue)
    }

    // MARK: Reading the Inbox

    func testReadingTheInboxDoesNotRebuildIt() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        var rebuilds = 0
        let store = makeStore(coordinator, onNow: { rebuilds += 1 })
        await startAndSettle(store, machines: 1)
        let before = rebuilds

        for _ in 0..<100 { _ = store.inbox }

        XCTAssertEqual(rebuilds, before)
        store.stop()
    }

    func testThePollerSendsTheFreshRowsToTheInbox() async throws {
        let coordinator = coordinator("studio")
        await connectAll(coordinator)
        serve([row("first", age: 1)], on: "studio")
        let store = makeStore(coordinator)
        store.setInboxVisible(true)
        await startAndSettle(store, machines: 1)
        XCTAssertEqual(rowIDs(store.inbox, on: "studio"), ["first"])
        XCTAssertEqual(store.snapshots["studio"]?.fetchedAt, now)
        serve([row("second", age: 0)], on: "studio")

        clock.advance(by: .seconds(15))

        await waitUntil("the new row") { rowIDs(store.inbox, on: "studio") == ["second"] }
        store.stop()
    }

    func testChangingTheFilterRebuildsTheInbox() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)

        store.filter = .machine("studio")

        XCTAssertTrue(rowIDs(store.inbox, on: "laptop").isEmpty)
        store.filter = .all
        XCTAssertFalse(rowIDs(store.inbox, on: "laptop").isEmpty)
        store.stop()
    }

    // MARK: One Home model per machine

    func testASwipeOnAMachineThatIsNotSelectedGoesToThatMachine() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("row", age: 90)], on: "laptop")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats/row/triage", status: 200, json: Data("""
        {"chatId":"row","revision":1,"updatedAt":"2026-11-05T09:00:00.000Z","pinnedAt":null,"doneAt":"2026-11-05T09:00:00.000Z","snoozedUntil":null}
        """.utf8))
        let model = try XCTUnwrap(store.homeModel(for: "laptop"))

        let landed = await model.setTriage(.done(true), chatID: "row", host: try connection("laptop", in: coordinator), now: now)

        XCTAssertTrue(landed)
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("POST /chats/row/triage"))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("POST /chats/row/triage"))
        await waitUntil("the row to leave") { rowIDs(store.inbox, on: "laptop").isEmpty }
        store.stop()
    }

    func testAPollDoesNotUndoASwipeMadeWhileItWasOut() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("row", age: 90)], on: "laptop")
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        responder.reply(instanceId: "laptop", method: "POST", path: "/chats/row/triage", status: 200, json: Data("""
        {"chatId":"row","revision":1,"updatedAt":"2026-11-05T09:00:00.000Z","pinnedAt":null,"doneAt":"2026-11-05T09:00:00.000Z","snoozedUntil":null}
        """.utf8))
        let releasePage = responder.hold(instanceId: "laptop", path: "/chat-summaries")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the poll") { polls("laptop") == 2 }
        let model = try XCTUnwrap(store.homeModel(for: "laptop"))

        let landed = await model.setTriage(.done(true), chatID: "row", host: try connection("laptop", in: coordinator), now: now)
        XCTAssertTrue(landed)
        await waitUntil("the row to leave") { rowIDs(store.inbox, on: "laptop").isEmpty }
        releasePage()
        await refresh.value

        XCTAssertTrue(rowIDs(store.inbox, on: "laptop").isEmpty, "The page, older than the swipe, brought the row back")
        store.stop()
    }

    /// The selection arriving moves a machine's generation, not its lease.
    func testTheSelectionMovingDoesNotResetAMachinesModel() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)
        let rows = rowIDs(store.inbox, on: "laptop")
        let model = try XCTUnwrap(store.homeModel(for: "laptop"))
        model.inboxNotice = AidenInboxNotice(message: "Still here")

        await coordinator.switchInstallation(to: "laptop")
        await store.refreshAll()

        XCTAssertEqual(rowIDs(store.inbox, on: "laptop"), rows)
        XCTAssertTrue(store.homeModel(for: "laptop") === model)
        XCTAssertEqual(model.inboxNotice?.message, "Still here", "The model took the move for another machine")
        store.stop()
    }

    func testAHomeModelLoadsFromTheHostItWasGiven() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        serve([row("mine", age: 1)], on: "laptop")
        let model = AidenHomeModel(chatCache: cache)

        await model.load(host: try connection("laptop", in: coordinator))

        XCTAssertEqual(model.chats.map(\.id), ["mine"])
        XCTAssertEqual(polls("studio"), 0)
    }

    // MARK: Bots

    /// `GET /bots` with one Bot holding an open "Needs you" card.
    private func serveBotWithCards(_ botID: String, on instanceId: String) {
        let stamp = timestamp(now.addingTimeInterval(-600))
        let bot: [String: Any] = [
            "id": botID, "name": botID, "purpose": "",
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
            "health": "ready", "sessionState": "idle", "issueCount": 1,
            "createdAt": stamp, "updatedAt": stamp, "revision": "bot_revision_1",
        ]
        responder.reply(
            instanceId: instanceId,
            path: "/bots",
            status: 200,
            json: try! JSONSerialization.data(withJSONObject: ["bots": [bot], "maxBots": 256])
        )
    }

    private func botReads(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /bots" }.count
    }

    func testMachinesWithoutBotReadAreNotAskedForBots() async throws {
        var withoutBots = AidenDemoHosts.installation(instanceId: "laptop", name: "laptop")
        withoutBots.deviceCapabilities.removeAll { $0 == .botRead || $0 == .botWrite }
        let coordinator = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "studio", name: "studio"), withoutBots],
            responder: responder
        )
        serveBotWithCards("bot_cards", on: "studio")
        serveBotWithCards("bot_cards", on: "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)

        await startAndSettle(store, machines: 2)

        XCTAssertEqual(botReads("studio"), 1)
        XCTAssertEqual(botReads("laptop"), 0)
        XCTAssertEqual(store.snapshots["studio"]?.bots.map(\.id), ["bot_cards"])
        XCTAssertEqual(store.snapshots["laptop"]?.bots, [])
        let chatsNeedingYou = store.inbox.needsYou.filter { !$0.isBot }.count
        XCTAssertEqual(store.inbox.needsYou.filter(\.isBot).map { "\($0.id.instanceId):\($0.id.objectId)" }, ["studio:bot_cards"])
        XCTAssertEqual(store.needsYouCount, chatsNeedingYou + 1)
        // Each poll asks again, so a Bot that's dealt with leaves.
        responder.reply(instanceId: "studio", path: "/bots", status: 200, json: Data(#"{"bots":[],"maxBots":256}"#.utf8))
        await store.refreshAll()
        XCTAssertEqual(botReads("studio"), 2)
        XCTAssertEqual(botReads("laptop"), 0)
        XCTAssertFalse(store.inbox.needsYou.contains(where: \.isBot))
        XCTAssertEqual(store.needsYouCount, chatsNeedingYou)
        store.stop()
    }

    func testABotReadThatFailsKeepsTheBotsLastSeenAndTheChats() async throws {
        let coordinator = coordinator("studio")
        serveBotWithCards("bot_cards", on: "studio")
        serve([row("chat", age: 3, needsYou: true)], on: "studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        XCTAssertEqual(store.needsYouCount, 2)

        responder.reply(instanceId: "studio", path: "/bots", status: 500, json: serverErrorJSON)
        await store.refreshAll()

        XCTAssertEqual(store.snapshots["studio"]?.bots.map(\.id), ["bot_cards"])
        XCTAssertEqual(store.needsYouCount, 2)
        XCTAssertFalse(store.refreshFailed)
        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .connected)
        store.stop()
    }

    /// A slow chat list doesn't hold up the Bots: both are read at once.
    func testBotsAreReadAlongsideTheChatsNotAfterThem() async throws {
        let coordinator = coordinator("studio")
        serveBotWithCards("bot_cards", on: "studio")
        serve([row("chat", age: 3, needsYou: true)], on: "studio")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 1)
        XCTAssertEqual(botReads("studio"), 1)

        let release = responder.hold(instanceId: "studio", path: "/chat-summaries")
        let refresh = Task { await store.refreshAll() }
        await waitUntil("the Bots read while the chats are still out") { self.botReads("studio") == 2 }
        release()
        await refresh.value

        XCTAssertEqual(store.snapshots["studio"]?.bots.map(\.id), ["bot_cards"])
        XCTAssertEqual(store.needsYouCount, 2)
        store.stop()
    }

    // MARK: The Bots and Workspaces tabs

    func testTheBotsTabListsEachMachinesBotsUnderTheFilter() async throws {
        let coordinator = coordinator("studio", "laptop")
        serveBotWithCards("bot_cards", on: "studio")
        serveBotWithCards("bot_cards", on: "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)

        let all = store.botSections()
        XCTAssertEqual(Set(all.map(\.instanceId)), ["studio", "laptop"])
        XCTAssertEqual(all.flatMap(\.rows).count, 2)
        store.filter = .machine("laptop")
        let one = store.botSections()
        XCTAssertEqual(one.map(\.instanceId), ["laptop"])
        XCTAssertEqual(one.first?.rows.map(\.id), [AidenHostObjectID(instanceId: "laptop", deviceId: "demo-device", objectId: "bot_cards")])
        store.stop()
    }

    func testTheWorkspacesTabListsEachMachinesWorkspacesUnderTheFilter() async throws {
        let coordinator = coordinator("studio", "laptop")
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await startAndSettle(store, machines: 2)

        let all = store.workspaceSections { _, _ in false }
        XCTAssertEqual(Set(all.map(\.instanceId)), ["studio", "laptop"])
        let studios = try XCTUnwrap(all.first { $0.instanceId == "studio" }).rows
        let first = try XCTUnwrap(studios.first)
        XCTAssertEqual(first.id.instanceId, "studio")
        XCTAssertEqual(studios.map(\.workspace.id), AidenNoWorkspace.choices(coordinator.hosts.connection(for: "studio")?.workspaces ?? [])
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.map(\.id))
        // Archived here for the laptop only.
        let archived = store.workspaceSections { $0 == "laptop" && $1 == first.workspace.id }
        XCTAssertEqual(archived.first { $0.instanceId == "studio" }?.rows, studios)
        XCTAssertEqual(archived.first { $0.instanceId == "laptop" }?.rows.contains { $0.workspace.id == first.workspace.id }, false)
        store.filter = .machine("laptop")
        XCTAssertEqual(store.workspaceSections { _, _ in false }.map(\.instanceId), ["laptop"])
        store.stop()
    }
}
#endif
