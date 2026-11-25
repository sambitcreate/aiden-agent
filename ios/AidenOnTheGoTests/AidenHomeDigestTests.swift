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

    func testAResolvedIssueNoLongerHoldsItsBotAtNeedsYou() {
        // The Mac counts no open issue (it omits the count at zero); the feed still remembers the card.
        let digest = AidenHomeDigest.make(
            bots: entries(bot("scout"), bot("ada")),
            feed: feed(
                item("i1", bot: "scout", kind: "issue", name: "Approve the deploy", preview: "", minutesAgo: 5),
                item("r1", bot: "ada", minutesAgo: 1)
            )
        )

        XCTAssertFalse(digest.rows.contains { $0.status == .needsYou })
        XCTAssertFalse(digest.rows.contains { $0.title == "Approve the deploy" })
        XCTAssertEqual(digest.rows.map(\.bot.id), ["ada"], "A Bot with only a resolved issue has nothing to say")
    }

    func testAnIssueTitleFromTheFeedIsntReusedForAnotherReasonToNeedYou() {
        // Stopped mid-run, with an old resolved issue still in the feed.
        let digest = AidenHomeDigest.make(
            bots: entries(bot("scout", state: "interrupted")),
            feed: feed(item("i1", bot: "scout", kind: "issue", name: "Approve the deploy", preview: "Old", minutesAgo: 5))
        )

        XCTAssertEqual(digest.rows.map(\.status), [.needsYou])
        XCTAssertNotEqual(digest.rows.first?.title, "Approve the deploy")
        XCTAssertEqual(digest.rows.first?.preview, "")
    }

    func testAFailedRunOutranksWorkAndNewerNewsButNotWhatNeedsYou() {
        let digest = AidenHomeDigest.make(
            bots: entries(
                bot("fresh"),
                bot("busy", state: "running", minutesAgo: 1),
                bot("broken"),
                bot("stuck", issues: 1, minutesAgo: 300)
            ),
            feed: feed(
                item("r1", bot: "fresh", minutesAgo: 1),
                item("r2", bot: "broken", status: "failed", minutesAgo: 240)
            ),
            limit: 4
        )

        XCTAssertEqual(digest.rows.map(\.bot.id), ["stuck", "broken", "busy", "fresh"])
        XCTAssertEqual(digest.rows.map(\.status), [.needsYou, .failed, .working, .update])
    }

    func testOldNewsMakesNoRowButWhatNeedsYouOrWorksStillShows() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("old"), bot("stuck", issues: 1, minutesAgo: 3000), bot("busy", state: "running"), bot("new")),
            feed: feed(
                item("o", bot: "old", minutesAgo: 2 * 24 * 60),
                item("b", bot: "busy", name: "Weekly sweep", minutesAgo: 2 * 24 * 60),
                item("n", bot: "new", minutesAgo: 30)
            ),
            since: ago(24 * 60)
        )

        XCTAssertEqual(digest.rows.map(\.bot.id), ["stuck", "busy", "new"])
        XCTAssertEqual(digest.rows.first { $0.bot.id == "busy" }?.title, "Working", "A stale run doesn't name today's work")
    }

    func testHomeSaysTheBotsWorkedOnlyWhenARunFinishedAfterTheLastVisit() {
        let digest = AidenHomeDigest.make(
            bots: entries(bot("ada"), bot("bea"), bot("stuck", issues: 1, minutesAgo: 1)),
            feed: feed(item("a", bot: "ada", minutesAgo: 90), item("b", bot: "bea", status: "failed", minutesAgo: 40))
        )

        XCTAssertTrue(digest.hasNewSince(ago(60)), "The failed run 40 minutes ago is new since an hour ago")
        XCTAssertFalse(digest.hasNewSince(ago(30)), "A Bot needing you isn't news of work done")
        XCTAssertFalse(digest.hasNewSince(nil), "A first visit has nothing to compare with")
        XCTAssertFalse(AidenHomeDigest.empty.hasNewSince(ago(60)))
    }

    func testHomeHoldsSkeletonSpritesUntilAMachineThatCanShowBotsAnswers() {
        typealias Machine = AidenHomeBotsState.Machine
        let answered = Machine(readsBots: true, isOnline: true, isOffline: false, answered: true)
        let reading = Machine(readsBots: true, isOnline: true, isOffline: false, answered: false)
        let connecting = Machine(readsBots: true, isOnline: false, isOffline: false, answered: false)
        let asleep = Machine(readsBots: true, isOnline: false, isOffline: true, answered: true)
        let noGrant = Machine(readsBots: false, isOnline: true, isOffline: false, answered: true)
        var hidden = answered
        hidden.isHidden = true

        XCTAssertEqual(AidenHomeBotsState.make(hasBots: true, machines: [reading]), .bots)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: [answered, reading]), .loading)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: [connecting, asleep]), .loading)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: [answered, asleep]), .noBots)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: [asleep]), .offline)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: [noGrant, hidden]), .none)
        XCTAssertEqual(AidenHomeBotsState.make(hasBots: false, machines: []), .none)

        XCTAssertTrue(AidenHomeBotsState.isAllOffline([asleep, noGrant]))
        XCTAssertFalse(AidenHomeBotsState.isAllOffline([asleep, answered]))
    }

    func testTheCardSaysNothingNewOnlyAfterEveryShownMachineWasRead() {
        typealias Machine = AidenHomeFeedState.Machine
        let read: Set<String> = ["studio"]
        let studio = Machine(id: "studio", isConnected: true, isOffline: false)
        let mini = Machine(id: "mini", isConnected: true, isOffline: false)
        let asleep = Machine(id: "mini", isConnected: false, isOffline: true)
        let joining = Machine(id: "mini", isConnected: false, isOffline: false)
        func state(
            _ outcomes: [String: AidenBotRoutineFeedReader.Outcome] = [:],
            rows: Bool = false,
            machines: [Machine]
        ) -> AidenHomeFeedState {
            AidenHomeFeedState.make(hasRows: rows, machines: machines, outcomes: outcomes) { read.contains($0) }
        }

        XCTAssertEqual(state(machines: [studio]), .quiet)
        XCTAssertEqual(state(machines: [studio, mini]), .loading, "One read machine doesn't speak for one still being read")
        XCTAssertEqual(state(["mini": .read], machines: [studio, mini]), .loading, "A read that left no window isn't a read")
        XCTAssertEqual(state(machines: [studio, joining]), .loading, "A machine still connecting may yet answer")
        XCTAssertEqual(state(["mini": .failed], machines: [studio, mini]), .partial)
        XCTAssertEqual(state(["mini": .skipped], machines: [studio, mini]), .partial, "A skipped read isn't a read")
        XCTAssertEqual(state(machines: [studio, asleep]), .partial)
        XCTAssertEqual(state(["mini": .failed], machines: [mini]), .failed)
        XCTAssertEqual(state(["mini": .skipped], machines: [mini]), .failed)
        XCTAssertEqual(state(machines: [asleep]), .offline, "An offline machine never leaves the card on skeletons")
        XCTAssertEqual(state(machines: [studio, mini]), .loading)
        XCTAssertEqual(state(rows: true, machines: [mini]), .rows)
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
        reader.record([item("a", bot: "ada", minutesAgo: 10), item("b", bot: "ada", minutesAgo: 5)], instanceId: "studio", grants: allGrants)
        reader.record([item("b", bot: "ada", minutesAgo: 5), item("c", bot: "ada", minutesAgo: 1)], instanceId: "studio", grants: allGrants)
        XCTAssertEqual(reader.notifications(for: "studio").map(\.id), ["c", "b", "a"])
        XCTAssertTrue(reader.notifications(for: "laptop").isEmpty)

        reader.record((0..<30).map { item("n\($0)", bot: "ada", minutesAgo: Double($0) + 100) }, instanceId: "studio", grants: allGrants)
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
        _ = await fetch.value

        XCTAssertTrue(reader.notifications(for: "studio").isEmpty)
    }

    func testAResponseThatLandsAfterTheMachineIsForgottenIsDropped() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: true)

        let fetch = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        await transport.waitForCall()
        reader.forget(instanceId: "studio")
        await transport.release()
        _ = await fetch.value

        XCTAssertTrue(reader.notifications(for: "studio").isEmpty)
    }

    func testANarrowedPairingStopsShowingWhatItCanNoLongerSee() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(
            wire("r", bot: "ada", minutesAgo: 1),
            wire("i", bot: "ada", kind: "issue", minutesAgo: 2)
        ), held: false)
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true }
        XCTAssertEqual(reader.notifications(for: "studio", grants: allGrants).map(\.id), ["r", "i"])

        // Issues are no longer granted: the old issue row goes at once, and
        // the next read starts the window over.
        let narrowed = allGrants.subtracting([.botIssues])
        XCTAssertEqual(reader.notifications(for: "studio", grants: narrowed).map(\.id), ["r"])
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: narrowed, force: true) { true }
        XCTAssertEqual(reader.notifications(for: "studio").map(\.id), ["r"])

        // Bots can't be read at all: everything goes.
        let outcome = await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: [.chatRead]) { true }
        XCTAssertEqual(outcome, .skipped)
        XCTAssertTrue(reader.notifications(for: "studio").isEmpty)
    }

    func testTheNextReadAsksOnlyForWhatsNewerAndPullToRefreshAsksAgain() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: false)
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true }
        await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants, force: true) { true }

        let sinces = await transport.sinces
        XCTAssertEqual(sinces, [nil, iso(now)], "The first read takes the window; the next starts at the machine's own clock")
    }

    func testTwoReadersOfOneMachineShareOneFetch() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: true)

        let first = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        await transport.waitForCall()
        let second = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        await transport.release()
        let outcomes = [await first.value, await second.value]

        XCTAssertEqual(outcomes, [.read, .read])
        let calls = await transport.calls
        XCTAssertEqual(calls, 1)
    }

    func testTheNotifiersNewsPageIsNotHomesFullRead() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: false)
        // The notifier fetches only what's new since its last check, and
        // records that without a cursor.
        XCTAssertTrue(reader.beginFetch("studio"))
        let home = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        for _ in 0..<10 { await Task.yield() }
        reader.record([item("n", bot: "ada", minutesAgo: 1)], instanceId: "studio", grants: allGrants)
        XCTAssertFalse(reader.hasFullRead("studio"))
        reader.endFetch("studio")
        let outcome = await home.value

        XCTAssertEqual(outcome, .read)
        let sinces = await transport.sinces
        XCTAssertEqual(sinces, [nil], "Home still reads the whole window itself")
        XCTAssertTrue(reader.hasFullRead("studio"))
    }

    func testAReaderWaitingOnAnotherFetchStopsWhenItsTaskIsCancelled() async {
        let reader = AidenBotRoutineFeedReader()
        let transport = HeldFeed(page(wire("r", bot: "ada", minutesAgo: 1)), held: false)
        XCTAssertTrue(reader.beginFetch("studio"))
        let waiting = Task { await reader.refreshIfStale(instanceId: "studio", transport: transport, grants: allGrants) { true } }
        for _ in 0..<10 { await Task.yield() }

        waiting.cancel()
        let outcome = await waiting.value

        XCTAssertEqual(outcome, .skipped)
        XCTAssertTrue(reader.isFetching("studio"), "The other fetch goes on")
        let calls = await transport.calls
        XCTAssertEqual(calls, 0)
        reader.endFetch("studio")
    }

    func testAnOpenHomeReadsAgainEveryMinute() async {
        let clock = SteppedSleep(steps: 3)
        let model = AidenHomeFeedModel(reader: AidenBotRoutineFeedReader(), sleep: { try await clock.sleep($0) })
        var reads = 0

        await model.repeatEveryInterval { reads += 1 }

        XCTAssertEqual(reads, 4, "Once now, then once after each interval")
        let slept = await clock.slept
        XCTAssertEqual(slept, [.seconds(60), .seconds(60), .seconds(60), .seconds(60)])
    }

    func testAMachineThatDoesntAnswerIsAFailureNotAnEmptyFeed() async {
        let reader = AidenBotRoutineFeedReader()
        let outcome = await reader.refreshIfStale(instanceId: "studio", transport: FailingFeed(), grants: allGrants) { true }
        XCTAssertEqual(outcome, .failed)
        XCTAssertNil(reader.windows["studio"])
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
    private(set) var sinces: [String?] = []

    init(_ feed: AidenBotRoutineNotificationFeed, held: Bool) {
        self.feed = feed
        self.held = held
    }

    func botRoutineNotifications(since: String?) async throws -> AidenBotRoutineNotificationFeed {
        calls += 1
        sinces.append(since)
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

/// A sleep that lets `steps` intervals pass, then stops the loop the way
/// cancelling Home's task does.
private actor SteppedSleep {
    private let steps: Int
    private(set) var slept: [Duration] = []

    init(steps: Int) { self.steps = steps }

    func sleep(_ duration: Duration) throws {
        slept.append(duration)
        if slept.count > steps { throw CancellationError() }
    }
}

private struct FailingFeed: AidenBotRoutineNotificationTransport {
    func botRoutineNotifications(since: String?) async throws -> AidenBotRoutineNotificationFeed {
        throw URLError(.notConnectedToInternet)
    }
}
