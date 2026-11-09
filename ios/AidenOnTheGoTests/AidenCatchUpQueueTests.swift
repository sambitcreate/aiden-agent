#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// Rows come from `AidenUnifiedInbox`, as they do in the app, so what's tested
/// is the order and the online state the Inbox really gives the queue.
private enum Fixture {
    static let now = Date(timeIntervalSince1970: 1_787_100_000)

    static func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

    static func question(_ id: String, waitingMinutes: Double) -> AidenChatSummary {
        summary(id, rowState: .needsInput, inbox: AidenChatInboxSignals(attentionSince: ago(waitingMinutes)))
    }

    static func running(_ id: String, startedMinutesAgo: Double, pinned: Bool = false) -> AidenChatSummary {
        summary(id, rowState: .working, inbox: AidenChatInboxSignals(
            runStartedAt: ago(startedMinutesAgo),
            pinnedAt: pinned ? ago(60) : nil
        ))
    }

    private static func summary(
        _ id: String,
        rowState: AidenChatRowState,
        inbox: AidenChatInboxSignals
    ) -> AidenChatSummary {
        AidenChatSummary(
            id: id,
            workspaceId: "default",
            title: "Title \(id)",
            titlePending: false,
            createdAt: ago(120),
            updatedAt: ago(1),
            revision: "rev-\(id)",
            activity: .active,
            rowState: rowState,
            unread: false,
            inbox: inbox
        )
    }

    static func snapshot(
        _ instanceId: String,
        _ chats: [AidenChatSummary],
        online: Bool = true,
        blocked: Bool = false,
        deviceId: String = "phone"
    ) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: instanceId,
            deviceId: deviceId,
            chats: chats,
            workspaceNames: ["default": "Project \(instanceId)"],
            isOnline: online,
            isBlocked: blocked,
            fetchedAt: now
        )
    }

    static func inbox(_ snapshots: AidenHostInboxSnapshot...) -> AidenUnifiedInbox {
        AidenUnifiedInbox.make(
            snapshots: snapshots,
            filter: .all,
            hiddenMachines: [],
            openChat: nil,
            now: now
        )
    }

    static func queue(_ snapshots: AidenHostInboxSnapshot...) -> AidenCatchUpQueue {
        AidenCatchUpQueue(rows: AidenUnifiedInbox.make(
            snapshots: snapshots,
            filter: .all,
            hiddenMachines: [],
            openChat: nil,
            now: now
        ).needsYou)
    }

    static func id(_ objectId: String, on instanceId: String) -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: "phone", objectId: objectId)
    }
}

@MainActor
final class AidenCatchUpQueueTests: XCTestCase {
    private typealias F = Fixture

    private let oldest = F.id("oldest", on: "studio")
    private let middle = F.id("middle", on: "laptop")
    private let newest = F.id("newest", on: "studio")

    /// `oldest` and `newest` on the studio, `middle` on the laptop.
    private func queue(
        studio: [String] = ["oldest", "newest"],
        laptop: [String] = ["middle"],
        laptopOnline: Bool = true,
        laptopBlocked: Bool = false
    ) -> AidenCatchUpQueue {
        let waits = ["oldest": 30.0, "middle": 20.0, "newest": 10.0, "late": 25.0]
        func chats(_ ids: [String]) -> [AidenChatSummary] {
            ids.map { F.question($0, waitingMinutes: waits[$0] ?? 5) }
        }
        return F.queue(
            F.snapshot("studio", chats(studio)),
            F.snapshot("laptop", chats(laptop), online: laptopOnline, blocked: laptopBlocked)
        )
    }

    // MARK: The queue

    func testCatchUpStartsAtTheOldest() {
        XCTAssertEqual(queue().first, oldest)
    }

    func testNextCrossesMachines() {
        let queue = queue()

        XCTAssertEqual(queue.next(after: oldest), middle)
        XCTAssertEqual(queue.next(after: middle), newest)
    }

    func testNextSkipsARowThatWasAnsweredElsewhere() {
        let afterAnswer = queue(laptop: [])

        XCTAssertEqual(afterAnswer.next(after: oldest), newest)
    }

    func testOfflineRowsAreNotQueued() {
        let queue = queue(laptopOnline: false)

        XCTAssertEqual(queue.count, 2)
        XCTAssertEqual(queue.next(after: oldest), newest)
    }

    func testTheLastRowHasNoNext() {
        XCTAssertNil(queue().next(after: newest))
    }

    func testAnEmptyInboxHasNoFirstRow() {
        XCTAssertNil(queue(studio: [], laptop: []).first)
    }

    /// Opening a chat can answer it: an unseen failure stops needing the person
    /// once it's seen. The queue still has to say where to go.
    func testNextAfterARowThatLeftTheQueueIsTheOldestLeft() {
        let afterAnswer = queue(studio: ["newest"])

        XCTAssertEqual(afterAnswer.next(after: oldest), middle)
    }

    // MARK: A run

    func testARunWalksEveryRowAndEnds() {
        let queue = queue()
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue), middle)
        XCTAssertEqual(run.advance(in: queue), newest)
        XCTAssertEqual(run.current, newest)
        XCTAssertNil(run.advance(in: queue))
    }

    /// Next doesn't answer anything, so a skipped chat is still in the queue
    /// when the chat after it is answered. The run mustn't go back to it.
    func testARunNeverGoesBackToAChatItShowed() {
        var run = AidenCatchUpRun(startingAt: oldest)
        XCTAssertEqual(run.advance(in: queue()), middle)

        let middleAnswered = queue(laptop: [])

        XCTAssertEqual(run.advance(in: middleAnswered), newest)
    }

    func testARunSkipsARowAnsweredElsewhereBetweenSteps() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue(laptop: [])), newest)
    }

    func testARunMovesOnWhenTheChatOnScreenWasAnswered() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue(studio: ["newest"])), middle)
    }

    /// The queue is read fresh, so a chat that starts waiting during the run
    /// takes its place in the order.
    func testARowThatArrivesDuringARunIsReached() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue(studio: ["oldest", "late", "newest"])), F.id("late", on: "studio"))
    }

    func testARunEndsWhenEveryOtherRowWasAnswered() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertNil(run.advance(in: queue(studio: ["oldest"], laptop: [])))
        XCTAssertEqual(run.current, oldest, "An ended run still names the chat it stopped on")
    }

    func testAMachineGoingOfflineDropsItsRowsFromTheRun() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue(laptopOnline: false)), newest)
    }

    func testARevokedMachinesRowsLeaveTheRun() {
        var run = AidenCatchUpRun(startingAt: oldest)

        XCTAssertEqual(run.advance(in: queue(laptopBlocked: true)), newest)
    }

    func testARunThatOnlyHadAMachineThatDroppedEnds() {
        var run = AidenCatchUpRun(startingAt: middle)

        XCTAssertNil(run.advance(in: queue(studio: [], laptopOnline: false)))
    }

    // MARK: Navigation

    private func openedRun() -> AidenAppNavigation {
        let navigation = AidenAppNavigation()
        navigation.tab = .bots
        XCTAssertEqual(navigation.startCatchUp(in: queue()), oldest)
        return navigation
    }

    func testStartingCatchUpPushesTheOldestChatOnTheInbox() {
        let navigation = openedRun()

        XCTAssertEqual(navigation.tab, .inbox)
        XCTAssertEqual(navigation.inboxPath, [.chat(oldest)])
        XCTAssertEqual(navigation.catchUp?.current, oldest)
    }

    func testNextReplacesTheChatSoBackReturnsToTheInbox() {
        let navigation = openedRun()

        XCTAssertEqual(navigation.advanceCatchUp(in: queue()), middle)

        XCTAssertEqual(navigation.inboxPath, [.chat(middle)])
        XCTAssertEqual(navigation.openChat, middle)
        XCTAssertEqual(navigation.catchUp?.current, middle)
    }

    func testAnEmptiedQueueEndsOnTheFinishedScreen() {
        let navigation = openedRun()

        XCTAssertNil(navigation.advanceCatchUp(in: queue(studio: [], laptop: [])))

        XCTAssertEqual(navigation.inboxPath, [.catchUpFinished(AidenCatchUpEnding(walked: true, unreached: 0))])
        XCTAssertNil(navigation.catchUp)
        XCTAssertNil(navigation.openChat)
    }

    func testStartingWithNothingQueuedSaysItIsFinished() {
        let navigation = AidenAppNavigation()

        XCTAssertNil(navigation.startCatchUp(in: queue(studio: [], laptop: [])))

        XCTAssertEqual(navigation.inboxPath, [.catchUpFinished(AidenCatchUpEnding(walked: false, unreached: 0))])
        XCTAssertNil(navigation.catchUp)
    }

    func testAMachineThatDropsLeavesItsUnseenChatsInTheEnding() {
        let navigation = openedRun()
        let dropped = F.queue(
            F.snapshot("studio", [F.question("oldest", waitingMinutes: 30)]),
            F.snapshot("laptop", [F.question("middle", waitingMinutes: 20), F.question("newest", waitingMinutes: 10)], online: false)
        )

        XCTAssertNil(navigation.advanceCatchUp(in: dropped))

        XCTAssertEqual(navigation.inboxPath, [.catchUpFinished(AidenCatchUpEnding(walked: true, unreached: 2))])
    }

    func testAChatShownBeforeItsMachineDroppedIsNotLeftOver() {
        let navigation = openedRun()
        XCTAssertEqual(navigation.advanceCatchUp(in: queue()), middle)
        let dropped = F.queue(
            F.snapshot("studio", [F.question("oldest", waitingMinutes: 30)]),
            F.snapshot("laptop", [F.question("middle", waitingMinutes: 20)], online: false)
        )

        XCTAssertNil(navigation.advanceCatchUp(in: dropped))

        XCTAssertEqual(navigation.inboxPath, [.catchUpFinished(AidenCatchUpEnding(walked: true, unreached: 0))])
    }

    func testStartingWithOnlyOfflineChatsSaysWhereTheyAre() {
        let navigation = AidenAppNavigation()
        let offline = F.queue(F.snapshot("laptop", [F.question("gone", waitingMinutes: 5)], online: false))

        XCTAssertNil(navigation.startCatchUp(in: offline))

        XCTAssertEqual(navigation.inboxPath, [.catchUpFinished(AidenCatchUpEnding(walked: false, unreached: 1))])
    }

    func testEachEndingSaysOnlyWhatIsTrue() {
        func copy(walked: Bool, unreached: Int) -> [String] {
            let ending = AidenCatchUpEnding(walked: walked, unreached: unreached)
            return [ending.title, ending.message]
        }

        XCTAssertEqual(copy(walked: true, unreached: 0), ["Catch Up finished", "You’ve been through every chat in Catch Up."])
        XCTAssertEqual(
            copy(walked: true, unreached: 1),
            ["Catch Up finished", "You’ve been through every chat you can reach. 1 more is on an offline machine."]
        )
        XCTAssertEqual(
            copy(walked: true, unreached: 3),
            ["Catch Up finished", "You’ve been through every chat you can reach. 3 more are on offline machines."]
        )
        XCTAssertEqual(copy(walked: false, unreached: 0), ["Nothing to catch up on", "There’s nothing in Catch Up right now."])
        XCTAssertEqual(
            copy(walked: false, unreached: 1),
            ["Nothing to catch up on yet", "1 chat needs you on an offline machine."]
        )
        XCTAssertEqual(
            copy(walked: false, unreached: 2),
            ["Nothing to catch up on yet", "2 chats need you on offline machines."]
        )
    }

    func testGoingBackEndsTheRun() {
        let navigation = openedRun()

        navigation.inboxPath = []

        XCTAssertNil(navigation.catchUp)
    }

    /// Next shows only during a run, so a chat opened any other way has none,
    /// even the one the run stopped on.
    func testReopeningTheChatAfterARunDoesNotResumeIt() {
        let navigation = openedRun()
        navigation.inboxPath = []

        navigation.open(.chat(oldest))

        XCTAssertNil(navigation.catchUp)
    }

    func testOpeningAnotherChatEndsTheRun() {
        let navigation = openedRun()

        navigation.open(.chat(F.id("from-a-link", on: "laptop")))

        XCTAssertNil(navigation.catchUp)
    }

    func testVisitingAnotherTabKeepsTheRun() {
        let navigation = openedRun()

        navigation.tab = .workspaces
        navigation.tab = .inbox

        XCTAssertEqual(navigation.catchUp?.current, oldest)
    }

    func testAMachineRemovedDuringARunEndsItAtTheInbox() {
        let navigation = openedRun()

        navigation.dropRoutes(outside: [])

        XCTAssertEqual(navigation.inboxPath, [])
        XCTAssertNil(navigation.catchUp)
    }

    func testAFinishedScreenIsNotRestoredOnTheNextLaunch() {
        let navigation = AidenAppNavigation()
        _ = navigation.startCatchUp(in: queue(studio: [], laptop: []))
        XCTAssertFalse(navigation.inboxPath.isEmpty, "There's no finished screen to leave out")

        let restored = AidenAppNavigation(restoring: navigation.snapshot, installations: [])

        XCTAssertEqual(restored.inboxPath, [])
    }

    /// The chat comes back, and it comes back as a plain chat, with no Next.
    func testTheRunIsNotRestoredOnTheNextLaunch() {
        let installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        let chat = AidenHostObjectID(instanceId: "studio", deviceId: installation.deviceId, objectId: "oldest")
        let navigation = AidenAppNavigation()
        _ = navigation.startCatchUp(in: F.queue(
            F.snapshot("studio", [F.question("oldest", waitingMinutes: 30)], deviceId: installation.deviceId)
        ))
        XCTAssertEqual(navigation.catchUp?.current, chat, "There's no run to leave behind")
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        store.save(navigation.snapshot)

        let restored = AidenAppNavigation(restoring: store.load(), installations: [installation])

        XCTAssertEqual(restored.inboxPath, [.chat(chat)])
        XCTAssertNil(restored.catchUp)
    }
}

final class AidenRunningAccessoryTests: XCTestCase {
    private typealias F = Fixture

    private func rows(online: Bool = true) -> [AidenUnifiedInboxRow] {
        F.inbox(
            F.snapshot("studio", [F.running("newer", startedMinutesAgo: 2)], online: online),
            F.snapshot("laptop", [F.running("older", startedMinutesAgo: 9)], online: online)
        ).running
    }

    func testItNamesTheOldestRunAndCountsTheOthers() {
        let summary = AidenRunningSummary(rows: rows())

        XCTAssertEqual(summary.title, "Title older")
        XCTAssertEqual(summary.othersCount, 1)
    }

    func testOneRunningChatOpensThatChat() {
        let only = AidenRunningSummary(rows: Array(rows().prefix(1)))

        XCTAssertEqual(only.tap, .open(F.id("older", on: "laptop")))
        XCTAssertEqual(only.othersCount, 0)
    }

    func testSeveralRunningChatsShowThemAll() {
        XCTAssertEqual(AidenRunningSummary(rows: rows()).tap, .showAll)
    }

    func testOfflineRunningChatsAreLeftOut() {
        let summary = AidenRunningSummary(rows: F.inbox(
            F.snapshot("studio", [F.running("here", startedMinutesAgo: 2)]),
            F.snapshot("laptop", [F.running("gone", startedMinutesAgo: 9)], online: false)
        ).running)

        XCTAssertEqual(summary.title, "Title here")
        XCTAssertEqual(summary.othersCount, 0)
        XCTAssertEqual(summary.tap, .open(F.id("here", on: "studio")))
    }

    func testAnOfflineRunningChatIsListedInUpdatesAndCountsForNothing() {
        let inbox = F.inbox(
            F.snapshot("studio", [F.running("here", startedMinutesAgo: 2)]),
            F.snapshot("laptop", [F.running("gone", startedMinutesAgo: 9)], online: false)
        )

        XCTAssertEqual(inbox.updates.map(\.id), [F.id("gone", on: "laptop")])
        XCTAssertEqual(inbox.updates.map(\.isOnline), [false])
        XCTAssertEqual(inbox.running.map(\.id), [F.id("here", on: "studio")])
        XCTAssertEqual(inbox.needsYou, [])
        XCTAssertEqual(inbox.needsYouCount, 0)
        XCTAssertEqual(AidenCatchUpQueue(rows: inbox.needsYou).count, 0)
    }

    func testAPinnedOfflineRunningChatStaysWithThePins() {
        let inbox = F.inbox(F.snapshot("laptop", [
            F.running("loose", startedMinutesAgo: 1),
            F.running("pinned", startedMinutesAgo: 9, pinned: true),
        ], online: false))

        XCTAssertEqual(inbox.updates.map(\.id), [F.id("pinned", on: "laptop"), F.id("loose", on: "laptop")])
        XCTAssertEqual(inbox.updates.map(\.isPinned), [true, false])
    }

    func testAnOfflineRunningChatSaysLastSeenRunningWithNoSpinner() throws {
        let inbox = F.inbox(F.snapshot("laptop", [F.running("gone", startedMinutesAgo: 9)], online: false))
        guard case .chat(let summary, let placement) = try XCTUnwrap(inbox.updates.first).content else {
            return XCTFail("Not a chat row")
        }
        let row = AidenInboxProjection.Row(summary: summary, placement: placement)

        for section in [AidenInboxSection.updates, .pinned] {
            let status = AidenInboxRowStatus.make(row, section: section, now: F.now)

            XCTAssertEqual(status.label, "Last seen running")
            XCTAssertEqual(status.tone, .plain, "Any other tone could draw a live spinner")
            XCTAssertNil(status.wait)
        }
    }

    func testAnOnlineRunningChatStillSaysItIsWorking() throws {
        let inbox = F.inbox(F.snapshot("studio", [F.running("here", startedMinutesAgo: 9)]))
        guard case .chat(let summary, let placement) = try XCTUnwrap(inbox.running.first).content else {
            return XCTFail("Not a chat row")
        }
        let row = AidenInboxProjection.Row(summary: summary, placement: placement)

        XCTAssertEqual(AidenInboxRowStatus.make(row, section: .working, now: F.now).tone, .working)
    }

    func testTheListIsOnlyEmptyWhenTheAccessoryHoldsEveryChat() {
        let running = F.snapshot("studio", [F.running("here", startedMinutesAgo: 2)])
        let runningOnly = F.inbox(running)
        let withAQuestion = F.inbox(
            running,
            F.snapshot("laptop", [F.question("asks", waitingMinutes: 5)])
        )
        let withAnOfflineRun = F.inbox(
            running,
            F.snapshot("laptop", [F.running("gone", startedMinutesAgo: 9)], online: false)
        )

        XCTAssertTrue(AidenRunningHome.accessory.leavesListEmpty(runningOnly))
        XCTAssertFalse(AidenRunningHome.inboxRow.leavesListEmpty(runningOnly), "The row is in the list")
        XCTAssertFalse(AidenRunningHome.accessory.leavesListEmpty(withAQuestion))
        XCTAssertFalse(AidenRunningHome.accessory.leavesListEmpty(withAnOfflineRun))
        XCTAssertFalse(AidenRunningHome.accessory.leavesListEmpty(F.inbox()), "Nothing is running")
    }

    func testNothingOnlineMeansNothingToShow() {
        let summary = AidenRunningSummary(rows: rows(online: false))

        XCTAssertNil(summary.title)
        XCTAssertNil(summary.tap)
    }

    func testTheAccessoryIsRunningsHomeOnACompactWidth() {
        XCTAssertEqual(
            AidenRunningHome.resolve(accessoryCanTurnOff: true, horizontalSizeClass: .compact),
            .accessory
        )
    }

    /// iOS 26.0 can't turn an accessory off, so the modifier stays off there.
    func testAnAccessoryThatCannotTurnOffIsNotUsed() {
        XCTAssertEqual(
            AidenRunningHome.resolve(accessoryCanTurnOff: false, horizontalSizeClass: .compact),
            .inboxRow
        )
    }

    /// A sidebar has no bottom accessory.
    func testARegularWidthKeepsRunningChatsInTheInbox() {
        XCTAssertEqual(
            AidenRunningHome.resolve(accessoryCanTurnOff: true, horizontalSizeClass: .regular),
            .inboxRow
        )
    }
}
#endif
