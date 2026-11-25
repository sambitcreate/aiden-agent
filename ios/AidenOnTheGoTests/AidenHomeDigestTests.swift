import XCTest
@testable import AidenOnTheGo

/// Home's greeting, its Bot sprites and its "From your Bots" card, and the
/// routine feed they read.
@MainActor
final class AidenHomeDigestTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    private func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func bot(_ id: String, state: String? = "idle", issues: Int? = nil, minutesAgo: Double = 30) -> AidenBotSummary {
        var object: [String: Any] = [
            "id": id,
            "name": id.capitalized,
            "purpose": "",
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
            "health": "ready",
            "createdAt": iso(ago(minutesAgo + 60)),
            "updatedAt": iso(ago(minutesAgo)),
            "revision": "bot_revision_\(id)",
        ]
        if let state { object["sessionState"] = state }
        if let issues { object["issueCount"] = issues }
        return try! JSONDecoder().decode(AidenBotSummary.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func item(
        _ id: String,
        bot: String,
        kind: String = "routine",
        status: String = "succeeded",
        name: String = "Morning brief",
        preview: String = "All quiet.",
        minutesAgo: Double
    ) -> AidenBotRoutineNotification {
        try! JSONDecoder().decode(
            AidenBotRoutineNotification.self,
            from: JSONSerialization.data(withJSONObject: wire(
                id, bot: bot, kind: kind, status: status, name: name, preview: preview, minutesAgo: minutesAgo
            ))
        )
    }

    private func wire(
        _ id: String,
        bot: String,
        kind: String = "routine",
        status: String = "succeeded",
        name: String = "Morning brief",
        preview: String = "All quiet.",
        minutesAgo: Double
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "kind": kind, "botId": bot, "botName": bot.capitalized,
            "routineName": name, "finishedAt": iso(ago(minutesAgo)), "preview": preview,
        ]
        if kind == "routine" {
            object["routineId"] = "routine_\(id)"
            object["status"] = status
        }
        return object
    }

    private func entries(_ bots: AidenBotSummary..., on instanceId: String = "studio") -> [AidenHomeDigest.BotEntry] {
        bots.map { AidenHomeDigest.BotEntry(instanceId: instanceId, bot: $0) }
    }

    private func feed(_ items: AidenBotRoutineNotification..., on instanceId: String = "studio") -> [AidenHomeDigest.FeedEntry] {
        items.map { AidenHomeDigest.FeedEntry(instanceId: instanceId, notification: $0) }
    }

    // MARK: The digest

    func testTheCardShowsAtMostThreeBotsAndOffersTheRest() {
        let bots = entries(bot("ada"), bot("bea"), bot("cal"), bot("dot"), bot("eve"))
        let items = feed(
            item("r1", bot: "ada", minutesAgo: 1), item("r2", bot: "bea", minutesAgo: 2),
            item("r3", bot: "cal", minutesAgo: 3), item("r4", bot: "dot", minutesAgo: 4),
            item("r5", bot: "eve", minutesAgo: 5)
        )

        let digest = AidenHomeDigest.make(bots: bots, feed: items)

        XCTAssertEqual(digest.rows.map(\.bot.id), ["ada", "bea", "cal"], "Newest news first, three rows")
        XCTAssertEqual(digest.total, 5)
        XCTAssertTrue(digest.hasMore)
    }

    func testThreeOrFewerBotsNeedNoSeeAll() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("ada"), bot("bea")),
            feed: feed(item("r1", bot: "ada", minutesAgo: 1), item("r2", bot: "bea", minutesAgo: 2))
        )
        XCTAssertEqual(digest.rows.count, 2)
        XCTAssertFalse(digest.hasMore)
    }

    func testNeedsYouOutranksWorkingWhichOutranksNewerNews() {
        let digest = AidenHomeDigest.make(
            bots: entries(
                bot("fresh"),
                bot("busy", state: "running", minutesAgo: 50),
                bot("stuck", issues: 2, minutesAgo: 90)
            ),
            feed: feed(item("r1", bot: "fresh", minutesAgo: 1))
        )

        XCTAssertEqual(digest.rows.map(\.bot.id), ["stuck", "busy", "fresh"])
        XCTAssertEqual(digest.rows.map(\.status), [.needsYou, .working, .update])
        XCTAssertEqual(digest.rows[0].title, "2 things need you")
    }

    func testABotThatNeedsYouAndJustRanShowsOnceAsNeedingYou() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("scout", issues: 1)),
            feed: feed(
                item("r1", bot: "scout", minutesAgo: 1),
                item("i1", bot: "scout", kind: "issue", name: "Approve the deploy", preview: "", minutesAgo: 10)
            )
        )

        XCTAssertEqual(digest.rows.count, 1)
        XCTAssertEqual(digest.rows[0].status, .needsYou)
        XCTAssertEqual(digest.rows[0].title, "Approve the deploy")
    }

    func testAFailedRunSaysSoAndAQuietBotHasNoRow() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("ada"), bot("quiet")),
            feed: feed(
                item("r0", bot: "ada", minutesAgo: 30),
                item("r1", bot: "ada", status: "failed", name: "Nightly sync", preview: "The run failed.", minutesAgo: 2)
            )
        )

        XCTAssertEqual(digest.rows.map(\.bot.id), ["ada"])
        XCTAssertEqual(digest.rows[0].status, .failed)
        XCTAssertEqual(digest.rows[0].title, "Nightly sync")
        XCTAssertEqual(digest.rows[0].preview, "The run failed.")
    }

    func testNewsFromABotTheRosterDoesntListIsDropped() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("ada")),
            feed: feed(item("r1", bot: "gone", minutesAgo: 1)) + feed(item("r2", bot: "ada", minutesAgo: 1), on: "laptop")
        )
        XCTAssertTrue(digest.rows.isEmpty, "Neither a deleted Bot nor another machine's same-named Bot shows")
    }

    func testTheSameBotOnTwoMachinesIsTwoRows() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("ada")) + entries(bot("ada"), on: "laptop"),
            feed: feed(item("r1", bot: "ada", minutesAgo: 1)) + feed(item("r2", bot: "ada", minutesAgo: 2), on: "laptop")
        )
        XCTAssertEqual(digest.rows.map(\.instanceId), ["studio", "laptop"])
        XCTAssertEqual(Set(digest.rows.map(\.id)).count, 2)
    }

    // MARK: Sprites

    func testSpritesPutBotsThatNeedYouFirstThenWorkThenRecent() {
        let sprites = AidenHomeBotRoster.sprites(entries(
            bot("old", minutesAgo: 300),
            bot("recent", minutesAgo: 1),
            bot("busy", state: "running", minutesAgo: 200),
            bot("stuck", state: "interrupted", minutesAgo: 400)
        ))
        XCTAssertEqual(sprites.map(\.bot.id), ["stuck", "busy", "recent"])
    }

    // MARK: Greeting and name

    func testTheGreetingFollowsTheTimeOfDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        func at(_ hour: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: hour, minute: 30))!
        }
        XCTAssertEqual(AidenGreeting.make(date: at(8), name: nil, calendar: calendar), "Good morning")
        XCTAssertEqual(AidenGreeting.make(date: at(13), name: nil, calendar: calendar), "Good afternoon")
        XCTAssertEqual(AidenGreeting.make(date: at(19), name: nil, calendar: calendar), "Good evening")
        XCTAssertEqual(AidenGreeting.make(date: at(2), name: nil, calendar: calendar), "Hello")
        XCTAssertEqual(AidenGreeting.make(date: at(8), name: "  Sam \n", calendar: calendar), "Good morning, Sam")
        XCTAssertEqual(AidenGreeting.make(date: at(8), name: "   ", calendar: calendar), "Good morning",
                       "A blank name leaves no dangling comma")
    }

    func testAHostNameWinsOverTheLocalOneAndNeitherMeansNoName() {
        XCTAssertEqual(AidenHomeName.resolve(host: "Ada", local: "Sam"), "Ada")
        XCTAssertEqual(AidenHomeName.resolve(host: nil, local: "Sam"), "Sam")
        XCTAssertEqual(AidenHomeName.resolve(host: " ", local: "Sam"), "Sam")
        XCTAssertNil(AidenHomeName.resolve(host: nil, local: nil))
        XCTAssertNil(AidenHomeName.resolve(host: nil, local: "\n  "))
        XCTAssertEqual(AidenHomeName.clean(String(repeating: "x", count: 90))?.count, AidenHomeName.maximumLength)
    }

    // MARK: The feed reader

    private func page(_ items: [String: Any]...) -> AidenBotRoutineNotificationFeed {
        let object: [String: Any] = ["notifications": items, "now": iso(now)]
        return try! JSONDecoder().decode(
            AidenBotRoutineNotificationFeed.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }

    private let allGrants: Set<AidenRemoteCapability> = [.botRead, .chatRead, .botPeers, .botMessaging, .botIssues]

    func testTheReaderMergesPagesNewestFirstAndKeepsAWindow() {
        let reader = AidenBotRoutineFeedReader()
        reader.record([item("a", bot: "ada", minutesAgo: 10), item("b", bot: "ada", minutesAgo: 5)], instanceId: "studio")
        reader.record([item("b", bot: "ada", minutesAgo: 5), item("c", bot: "ada", minutesAgo: 1)], instanceId: "studio")
        XCTAssertEqual(reader.notifications(for: "studio").map(\.id), ["c", "b", "a"])
        XCTAssertTrue(reader.notifications(for: "laptop").isEmpty)

        reader.record((0..<30).map { item("n\($0)", bot: "ada", minutesAgo: Double($0) + 100) }, instanceId: "studio")
        XCTAssertEqual(reader.notifications(for: "studio").count, AidenBotRoutineFeedReader.windowSize)
        XCTAssertEqual(reader.notifications(for: "studio").first?.id, "c")
    }

    func testTheReaderLeavesOutWhatThePairingCannotSee() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(
            wire("r", bot: "ada", minutesAgo: 1),
            wire("m", bot: "ada", kind: "message", minutesAgo: 2),
            wire("i", bot: "ada", kind: "issue", minutesAgo: 3)
        ), held: false)

        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: [.botRead, .chatRead]) { true }

        XCTAssertEqual(reader.notifications(for: "studio").map(\.id), ["r"])
    }

    func testAFreshWindowAnswersWithoutAskingAgain() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: false)
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true }
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true }
        let calls = await transport.calls
        XCTAssertEqual(calls, 1)
    }

    func testAResponseThatLandsAfterTheMachineStoppedBeingCurrentIsDropped() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: true)
        let machine = CurrentMachine()

        let fetch = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { machine.isCurrent } }
        await transport.waitForCall()
        machine.isCurrent = false
        await transport.release()
        await fetch.value

        XCTAssertTrue(reader.notifications(for: "studio").isEmpty)
    }

    func testAResponseThatLandsAfterTheMachineIsForgottenIsDropped() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: true)

        let fetch = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        await transport.waitForCall()
        reader.forget(instanceId: "studio")
        await transport.release()
        await fetch.value

        XCTAssertTrue(reader.notifications(for: "studio").isEmpty)
    }

    func testThePairingNeedsBotAndChatReadToAskAtAll() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: false)
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: [.botRead]) { true }
        let calls = await transport.calls
        XCTAssertEqual(calls, 0)
    }
}

@MainActor
private final class CurrentMachine {
    var isCurrent = true
}

/// A routine feed that can hold its answer until the test lets it go.
private actor HeldFeed: AidenBotRoutineNotificationTransport {
    private let feed: AidenBotRoutineNotificationFeed
    private var held: Bool
    private var waiter: CheckedContinuation<Void, Never>?
    private var callWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var calls = 0

    init(_ feed: AidenBotRoutineNotificationFeed, held: Bool) {
        self.feed = feed
        self.held = held
    }

    func botRoutineNotifications(since: String?) async throws -> AidenBotRoutineNotificationFeed {
        calls += 1
        callWaiters.forEach { $0.resume() }
        callWaiters = []
        if held { await withCheckedContinuation { waiter = $0 } }
        return feed
    }

    func waitForCall() async {
        guard calls == 0 else { return }
        await withCheckedContinuation { callWaiters.append($0) }
    }

    func release() {
        held = false
        waiter?.resume()
        waiter = nil
    }
}
