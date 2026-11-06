import XCTest
@testable import AidenOnTheGo

final class AidenUnifiedInboxTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_787_100_000)

    private func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

    private func chat(
        _ id: String,
        minutesAgo: Double = 5,
        rowState: AidenChatRowState? = nil,
        activity: AidenChatSummaryActivity = .idle,
        unread: Bool = false,
        workspaceId: String = "default",
        title: String? = nil,
        inbox: AidenChatInboxSignals = AidenChatInboxSignals()
    ) -> AidenChatSummary {
        let updated = ago(minutesAgo)
        return AidenChatSummary(
            id: id,
            workspaceId: workspaceId,
            title: title ?? id,
            titlePending: false,
            createdAt: updated.addingTimeInterval(-60),
            updatedAt: updated,
            revision: "rev-\(id)",
            activity: activity,
            rowState: rowState,
            unread: unread,
            inbox: inbox
        )
    }

    private func approval(_ id: String, waitingMinutes: Double) -> AidenChatSummary {
        chat(id, minutesAgo: 1, rowState: .needsApproval, activity: .active,
             inbox: AidenChatInboxSignals(attentionSince: ago(waitingMinutes)))
    }

    private func question(_ id: String, waitingMinutes: Double) -> AidenChatSummary {
        chat(id, minutesAgo: 1, rowState: .needsInput, activity: .active,
             inbox: AidenChatInboxSignals(attentionSince: ago(waitingMinutes)))
    }

    private func reply(_ id: String, minutesAgo: Double) -> AidenChatSummary {
        chat(id, minutesAgo: minutesAgo, unread: true)
    }

    private func earlier(_ id: String, minutesAgo: Double) -> AidenChatSummary {
        chat(id, minutesAgo: minutesAgo)
    }

    private func running(_ id: String, startedMinutesAgo: Double) -> AidenChatSummary {
        chat(id, minutesAgo: 1, rowState: .working, activity: .active,
             inbox: AidenChatInboxSignals(runStartedAt: ago(startedMinutesAgo)))
    }

    private func pinned(_ id: String, pinnedMinutesAgo: Double) -> AidenChatSummary {
        chat(id, minutesAgo: 600, inbox: AidenChatInboxSignals(pinnedAt: ago(pinnedMinutesAgo)))
    }

    private func snapshot(
        _ instanceId: String,
        _ chats: [AidenChatSummary],
        names: [String: String]? = nil,
        online: Bool = true,
        blocked: Bool = false,
        deviceId: String = "phone"
    ) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: instanceId,
            deviceId: deviceId,
            chats: chats,
            workspaceNames: names ?? ["default": "Project \(instanceId)"],
            isOnline: online,
            isBlocked: blocked,
            fetchedAt: now
        )
    }

    private func make(
        _ snapshots: [AidenHostInboxSnapshot],
        filter: AidenMachineFilter = .all,
        hidden: Set<String> = [],
        open: AidenHostObjectID? = nil,
        searchText: String = "",
        showAllEarlier: Bool = false
    ) -> AidenUnifiedInbox {
        AidenUnifiedInbox.make(
            snapshots: snapshots,
            filter: filter,
            hiddenMachines: hidden,
            openChat: open,
            now: now,
            searchText: searchText,
            showAllEarlier: showAllEarlier
        )
    }

    private func labels(_ rows: [AidenUnifiedInboxRow]) -> [String] {
        rows.map { "\($0.id.instanceId):\($0.id.objectId)" }
    }

    private func hostID(_ instanceId: String, _ objectId: String, deviceId: String = "phone") -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: deviceId, objectId: objectId)
    }

    // MARK: Identity

    func testSameChatIDOnTwoMachinesStaysTwoRows() {
        let inbox = make([
            snapshot("mac-a", [reply("shared", minutesAgo: 3)]),
            snapshot("mac-b", [reply("shared", minutesAgo: 4)]),
        ])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:shared", "mac-b:shared"])
        XCTAssertEqual(Set(inbox.updates.map(\.id)).count, 2)
        XCTAssertEqual(Set(inbox.updates.map(\.id.storageKey)).count, 2)
    }

    func testCollidingWorkspaceIDsDoNotDropRows() {
        let a = snapshot("mac-a", [reply("a1", minutesAgo: 3)], names: ["default": "Alpha app"])
        let b = snapshot("mac-b", [reply("b1", minutesAgo: 4)], names: ["default": "Beta app"])
        XCTAssertEqual(labels(make([a, b]).updates), ["mac-a:a1", "mac-b:b1"])
        // Each row is matched against its own machine's names, not a merged map.
        XCTAssertEqual(labels(make([a, b], searchText: "alpha").updates), ["mac-a:a1"])
        XCTAssertEqual(labels(make([a, b], searchText: "beta").updates), ["mac-b:b1"])
    }

    func testARowWhoseWorkspaceIsUnknownOnItsOwnMachineStaysOut() {
        // The other machine knows "default", but a row is only valid against its own names.
        let a = snapshot("mac-a", [reply("a1", minutesAgo: 3)], names: [:])
        let b = snapshot("mac-b", [reply("b1", minutesAgo: 4)])
        XCTAssertEqual(labels(make([a, b]).updates), ["mac-b:b1"])
    }

    func testTheSameMachineListedTwiceCountsOnce() {
        let a = snapshot("mac-a", [approval("a1", waitingMinutes: 5), reply("a2", minutesAgo: 2)])
        let inbox = make([a, a])
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:a1"])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a2"])
        XCTAssertEqual(inbox.needsYouCount, 1)
    }

    func testTiesAreDeterministicWhateverTheSnapshotOrder() {
        // Same chat ids, same timestamps, on three machines: only the host-scoped key can order them.
        let all = ["mac-a", "mac-b", "mac-c"].map {
            snapshot($0, [approval("x", waitingMinutes: 5), reply("x2", minutesAgo: 3), earlier("x3", minutesAgo: 90)])
        }
        let forward = make(all)
        for order in [[2, 0, 1], [1, 2, 0], [2, 1, 0]] {
            let shuffled = make(order.map { all[$0] })
            XCTAssertEqual(shuffled, forward)
        }
        // Ties go by (instance, device, chat id), compared as plain strings.
        XCTAssertEqual(labels(forward.needsYou), ["mac-a:x", "mac-b:x", "mac-c:x"])
        XCTAssertEqual(labels(forward.updates), ["mac-a:x2", "mac-b:x2", "mac-c:x2"])
        XCTAssertEqual(labels(forward.earlier), ["mac-a:x3", "mac-b:x3", "mac-c:x3"])
        // Same instance, two paired devices: the device id breaks the tie next.
        let devices = make([
            snapshot("mac-a", [reply("x", minutesAgo: 3)], deviceId: "phone-2"),
            snapshot("mac-a", [reply("x", minutesAgo: 3)], deviceId: "phone-1"),
        ])
        XCTAssertEqual(devices.updates.map(\.id.deviceId), ["phone-1", "phone-2"])
    }

    // MARK: Ordering

    func testNeedsYouIsOldestFirstAcrossMachines() {
        let inbox = make([
            snapshot("mac-a", [approval("a-approval", waitingMinutes: 10), question("a-question", waitingMinutes: 50)]),
            snapshot("mac-b", [approval("b-approval", waitingMinutes: 30)]),
        ])
        // Tier first (approval before question), then the longest wait first.
        XCTAssertEqual(labels(inbox.needsYou), ["mac-b:b-approval", "mac-a:a-approval", "mac-a:a-question"])
    }

    func testUpdatesAreNewestFirstAcrossMachines() {
        let inbox = make([
            snapshot("mac-a", [reply("a-old", minutesAgo: 40), reply("a-new", minutesAgo: 2)]),
            snapshot("mac-b", [reply("b-mid", minutesAgo: 15)]),
        ])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a-new", "mac-b:b-mid", "mac-a:a-old"])
    }

    func testEarlierIsNewestFirstAcrossMachines() {
        let inbox = make([
            snapshot("mac-a", [earlier("a-old", minutesAgo: 400), earlier("a-new", minutesAgo: 60)]),
            snapshot("mac-b", [earlier("b-mid", minutesAgo: 120)]),
        ])
        XCTAssertEqual(labels(inbox.earlier), ["mac-a:a-new", "mac-b:b-mid", "mac-a:a-old"])
    }

    func testPinnedRowsLeadUpdates() {
        let inbox = make([
            snapshot("mac-a", [reply("a-reply", minutesAgo: 1), pinned("a-pin", pinnedMinutesAgo: 900)]),
            snapshot("mac-b", [pinned("b-pin", pinnedMinutesAgo: 300), reply("b-reply", minutesAgo: 2)]),
        ])
        XCTAssertEqual(labels(inbox.updates), ["mac-b:b-pin", "mac-a:a-pin", "mac-a:a-reply", "mac-b:b-reply"])
        XCTAssertEqual(inbox.updates.map(\.isPinned), [true, true, false, false])
        XCTAssertTrue(inbox.earlier.isEmpty)
    }

    func testRunningRowsLeaveTheListsAndAreOldestFirst() {
        let inbox = make([
            snapshot("mac-a", [running("a-run", startedMinutesAgo: 5), reply("a-reply", minutesAgo: 3)]),
            snapshot("mac-b", [running("b-run", startedMinutesAgo: 20)]),
        ])
        XCTAssertEqual(labels(inbox.running), ["mac-b:b-run", "mac-a:a-run"])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a-reply"])
        XCTAssertTrue(inbox.needsYou.isEmpty)
        XCTAssertTrue(inbox.earlier.isEmpty)
    }

    func testAFutureTimestampStaysInItsSection() {
        // A machine with a fast clock reports times ahead of this phone's.
        let ahead = now.addingTimeInterval(3 * 60 * 60)
        let fastReply = chat("fast-reply", minutesAgo: -180, unread: true)
        let fastEarlier = chat("fast-earlier", minutesAgo: -180)
        let fastApproval = chat("fast-approval", minutesAgo: -180, rowState: .needsApproval, activity: .active,
                                inbox: AidenChatInboxSignals(attentionSince: ahead))
        XCTAssertGreaterThan(fastReply.updatedAt, now)
        let inbox = make([
            snapshot("fast", [fastReply, fastEarlier, fastApproval]),
            snapshot("mac-b", [reply("b-reply", minutesAgo: 3), earlier("b-earlier", minutesAgo: 10)]),
        ])
        XCTAssertEqual(labels(inbox.needsYou), ["fast:fast-approval"])
        XCTAssertEqual(labels(inbox.updates), ["fast:fast-reply", "mac-b:b-reply"])
        XCTAssertEqual(labels(inbox.earlier), ["fast:fast-earlier", "mac-b:b-earlier"])
    }

    // MARK: Earlier cap

    func testEarlierCapAppliesAfterTheMerge() {
        let a = (0..<15).map { earlier("a\($0)", minutesAgo: Double(60 + $0 * 2)) }
        let b = (0..<15).map { earlier("b\($0)", minutesAgo: Double(61 + $0 * 2)) }
        let inbox = make([snapshot("mac-a", a), snapshot("mac-b", b)])
        XCTAssertEqual(inbox.earlier.count, AidenInbox.earlierLimit)
        XCTAssertEqual(inbox.earlierOverflow, 10)
        // The newest 20 of the merged 30 survive, interleaved: not 15 + 5.
        XCTAssertEqual(inbox.earlier.filter { $0.id.instanceId == "mac-a" }.count, 10)
        XCTAssertEqual(inbox.earlier.filter { $0.id.instanceId == "mac-b" }.count, 10)

        let all = make([snapshot("mac-a", a), snapshot("mac-b", b)], showAllEarlier: true)
        XCTAssertEqual(all.earlier.count, 30)
        XCTAssertEqual(all.earlierOverflow, 0)
    }

    func testTheOpenChatIsKeptPastTheCapOnItsOwnMachineOnly() {
        // "shared" is the oldest row on both machines. Only mac-b's is open.
        let a = (0..<22).map { earlier("a\($0)", minutesAgo: Double(60 + $0)) } + [earlier("shared", minutesAgo: 5000)]
        let b = [earlier("shared", minutesAgo: 5000)]
        let inbox = make([snapshot("mac-a", a), snapshot("mac-b", b)], open: hostID("mac-b", "shared"))
        XCTAssertEqual(inbox.earlier.count, AidenInbox.earlierLimit)
        XCTAssertEqual(inbox.earlier.last?.id, hostID("mac-b", "shared"))
        XCTAssertFalse(inbox.earlier.contains { $0.id == hostID("mac-a", "shared") })
        XCTAssertEqual(inbox.earlierOverflow, 24 - 20)
    }

    func testSearchIgnoresTheCap() {
        let a = (0..<30).map { earlier("a\($0)", minutesAgo: Double(60 + $0)) }
        let inbox = make([snapshot("mac-a", a)], searchText: "a")
        XCTAssertEqual(inbox.earlier.count, 30)
        XCTAssertEqual(inbox.earlierOverflow, 0)
    }

    // MARK: Machine state

    func testOfflineRowsStayAndDoNotCount() {
        let inbox = make([
            snapshot("mac-a", [approval("a1", waitingMinutes: 5)]),
            snapshot("mac-off", [approval("off1", waitingMinutes: 9), reply("off2", minutesAgo: 2)], online: false),
        ])
        XCTAssertEqual(labels(inbox.needsYou), ["mac-off:off1", "mac-a:a1"])
        XCTAssertEqual(inbox.needsYou.map(\.isOnline), [false, true])
        XCTAssertEqual(labels(inbox.updates), ["mac-off:off2"])
        XCTAssertEqual(inbox.updates.map(\.isOnline), [false])
        XCTAssertEqual(inbox.needsYouCount, 1)
    }

    func testBlockedMachineRowsDrop() {
        let inbox = make([
            snapshot("mac-a", [approval("a1", waitingMinutes: 5), reply("a2", minutesAgo: 2)]),
            snapshot("mac-blocked", [approval("x1", waitingMinutes: 50), reply("x2", minutesAgo: 1), running("x3", startedMinutesAgo: 9)],
                     blocked: true),
        ])
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:a1"])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a2"])
        XCTAssertTrue(inbox.running.isEmpty)
        XCTAssertEqual(inbox.needsYouCount, 1)
        // Blocked wins even for an explicit filter on that machine.
        XCTAssertEqual(make([snapshot("mac-blocked", [reply("x2", minutesAgo: 1)], blocked: true)],
                            filter: .machine("mac-blocked")), AidenUnifiedInbox())
    }

    func testHiddenMachinesDropFromAll() {
        let snapshots = [
            snapshot("mac-a", [approval("a1", waitingMinutes: 5), reply("a2", minutesAgo: 2)]),
            snapshot("mac-hidden", [approval("h1", waitingMinutes: 50), reply("h2", minutesAgo: 1), running("h3", startedMinutesAgo: 9)]),
        ]
        let inbox = make(snapshots, hidden: ["mac-hidden"])
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:a1"])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a2"])
        XCTAssertTrue(inbox.running.isEmpty)
        XCTAssertEqual(inbox.needsYouCount, 1)
        XCTAssertEqual(labels(make(snapshots).needsYou), ["mac-hidden:h1", "mac-a:a1"])
    }

    func testFilterNarrowsRowsButNotTheBadgeCount() {
        let snapshots = [
            snapshot("mac-a", [approval("a1", waitingMinutes: 5), reply("a2", minutesAgo: 2), running("a3", startedMinutesAgo: 4)]),
            snapshot("mac-b", [approval("b1", waitingMinutes: 8), question("b2", waitingMinutes: 3), reply("b3", minutesAgo: 1)]),
        ]
        let inbox = make(snapshots, filter: .machine("mac-a"))
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:a1"])
        XCTAssertEqual(labels(inbox.updates), ["mac-a:a2"])
        XCTAssertEqual(labels(inbox.running), ["mac-a:a3"])
        XCTAssertEqual(inbox.needsYouCount, 3)
        XCTAssertEqual(make(snapshots).needsYouCount, 3)
    }

    func testTheBadgeIgnoresSearchToo() {
        let snapshots = [
            snapshot("mac-a", [approval("a1", waitingMinutes: 5), approval("a2", waitingMinutes: 6)]),
        ]
        let inbox = make(snapshots, searchText: "a1")
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:a1"])
        XCTAssertEqual(inbox.needsYouCount, 2)
    }

    // MARK: One machine

    func testOneMachineMatchesTheOldProjection() {
        // Equal-length ids, so the old projection's id order and the host key order agree on ties.
        let chats = [
            approval("c01", waitingMinutes: 20), question("c02", waitingMinutes: 40), approval("c03", waitingMinutes: 20),
            reply("c04", minutesAgo: 9), reply("c05", minutesAgo: 9), reply("c06", minutesAgo: 30),
            pinned("c07", pinnedMinutesAgo: 700), pinned("c08", pinnedMinutesAgo: 100),
            earlier("c09", minutesAgo: 90), earlier("c10", minutesAgo: 90), earlier("c11", minutesAgo: 300),
            running("c12", startedMinutesAgo: 8), running("c13", startedMinutesAgo: 30),
            chat("c14", minutesAgo: 60 * 24 * 30),
        ]
        let names = ["default": "Project"]
        let old = AidenInboxProjection.make(chats: chats, workspaceNames: names, openChatID: "c11", now: now)
        let merged = make([snapshot("mac-a", chats, names: names)], open: hostID("mac-a", "c11"))
        XCTAssertEqual(merged.needsYou.map(\.id.objectId), old.needsYou.map(\.id))
        XCTAssertEqual(merged.updates.map(\.id.objectId), (old.pinned + old.updates).map(\.id))
        XCTAssertEqual(merged.earlier.map(\.id.objectId), old.earlier.map(\.id))
        XCTAssertEqual(merged.running.map(\.id.objectId), old.working.map(\.id))
        XCTAssertEqual(merged.earlierOverflow, old.earlierOverflow)
        XCTAssertEqual(merged.needsYouCount, old.needsYou.count)
        for row in merged.updates + merged.earlier + merged.needsYou + merged.running {
            guard case .chat(let summary, let placement) = row.content else { return XCTFail("expected a chat row") }
            let expected = AidenInbox.placement(for: summary, isOpen: summary.id == "c11", now: now)
            XCTAssertEqual(placement, expected, summary.id)
        }
    }

    func testOneMachineMatchesTheOldProjectionPastTheCap() {
        let chats = (0..<25).map { earlier(String(format: "c%02d", $0), minutesAgo: Double(60 + $0)) }
        let names = ["default": "Project"]
        let old = AidenInboxProjection.make(chats: chats, workspaceNames: names, openChatID: "c24", now: now)
        let merged = make([snapshot("mac-a", chats, names: names)], open: hostID("mac-a", "c24"))
        XCTAssertEqual(merged.earlier.map(\.id.objectId), old.earlier.map(\.id))
        XCTAssertEqual(merged.earlierOverflow, old.earlierOverflow)
    }

    func testOneMachineTiesOrderLikeTheOldProjectionWhateverTheIDLength() {
        // Equal times, ids of different lengths: "aa" sorts before "b" as a plain id,
        // but a length-prefixed key would put "b" first.
        let chats = [
            approval("b", waitingMinutes: 10), approval("aa", waitingMinutes: 10),
            reply("b2", minutesAgo: 4), reply("a22", minutesAgo: 4), reply("a3", minutesAgo: 4),
            earlier("z", minutesAgo: 90), earlier("yy", minutesAgo: 90), earlier("x10", minutesAgo: 90), earlier("x9", minutesAgo: 90),
            running("r", startedMinutesAgo: 8), running("qq", startedMinutesAgo: 8),
        ]
        let names = ["default": "Project"]
        let old = AidenInboxProjection.make(chats: chats, workspaceNames: names, openChatID: nil, now: now)
        let merged = make([snapshot("mac-a", chats, names: names)])
        XCTAssertEqual(old.needsYou.map(\.id), ["aa", "b"])
        XCTAssertEqual(merged.needsYou.map(\.id.objectId), old.needsYou.map(\.id))
        XCTAssertEqual(merged.updates.map(\.id.objectId), old.updates.map(\.id))
        XCTAssertEqual(merged.earlier.map(\.id.objectId), old.earlier.map(\.id))
        XCTAssertEqual(merged.running.map(\.id.objectId), old.working.map(\.id))
    }

    func testOfflineRunningRowsStayRunningAndAreMarkedOffline() {
        let inbox = make([
            snapshot("mac-a", [running("a-run", startedMinutesAgo: 5)]),
            snapshot("mac-off", [running("off-run", startedMinutesAgo: 15)], online: false),
        ])
        XCTAssertEqual(labels(inbox.running), ["mac-off:off-run", "mac-a:a-run"])
        XCTAssertEqual(inbox.running.map(\.isOnline), [false, true])
    }

    func testAChatIDDuplicatedWithinOneSnapshotIsOneRowAndOneCount() {
        let dup = [approval("dup", waitingMinutes: 9), approval("dup", waitingMinutes: 4), reply("other", minutesAgo: 2)]
        let snapshots = [snapshot("mac-a", dup), snapshot("mac-b", [approval("b1", waitingMinutes: 3)])]
        let inbox = make(snapshots)
        XCTAssertEqual(labels(inbox.needsYou), ["mac-a:dup", "mac-b:b1"])
        XCTAssertEqual(inbox.needsYouCount, inbox.needsYou.count)
        // The count ignores the filter, so it must dedupe on machines the filter hides too.
        let narrowed = make(snapshots, filter: .machine("mac-b"))
        XCTAssertEqual(labels(narrowed.needsYou), ["mac-b:b1"])
        XCTAssertEqual(narrowed.needsYouCount, 2)
        // A copy in Needs you wins over a copy placed lower.
        let mixed = make([snapshot("mac-a", [reply("m", minutesAgo: 1), approval("m", waitingMinutes: 5)])])
        XCTAssertEqual(labels(mixed.needsYou), ["mac-a:m"])
        XCTAssertTrue(mixed.updates.isEmpty)
        XCTAssertEqual(mixed.needsYouCount, 1)
    }

    func testNoSnapshotsIsAnEmptyInbox() {
        XCTAssertEqual(make([]), AidenUnifiedInbox())
    }
}
