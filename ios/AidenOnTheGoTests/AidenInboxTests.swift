import XCTest
@testable import AidenOnTheGo

final class AidenInboxTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_787_100_000)

    private func summary(
        _ id: String,
        minutesAgo: Double,
        activity: AidenChatSummaryActivity = .idle,
        rowState: AidenChatRowState? = nil,
        unread: Bool = false,
        failed: Bool = false,
        workspaceId: String = "alpha",
        inbox: AidenChatInboxSignals = AidenChatInboxSignals()
    ) -> AidenChatSummary {
        let updated = now.addingTimeInterval(-minutesAgo * 60)
        return AidenChatSummary(
            id: id,
            workspaceId: workspaceId,
            title: id,
            titlePending: false,
            createdAt: updated.addingTimeInterval(-60),
            updatedAt: updated,
            revision: "rev-\(id)",
            activity: activity,
            rowState: rowState,
            unread: unread,
            lastRunFailed: failed,
            inbox: inbox
        )
    }

    private func ago(minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
    private func ahead(minutes: Double) -> Date { now.addingTimeInterval(minutes * 60) }

    private func section(_ chat: AidenChatSummary, isOpen: Bool = false) -> AidenInboxSection? {
        AidenInbox.placement(for: chat, isOpen: isOpen, now: now).section
    }

    // MARK: Local placement (older hosts send no bucket)

    func testLocalPlacementFollowsTheDesktopRulesInOrder() {
        let cases: [(AidenChatSummary, AidenInboxSection?, Int)] = [
            (summary("approval", minutesAgo: 3, activity: .active, rowState: .needsApproval,
                     inbox: AidenChatInboxSignals(doneAt: ago(minutes: 1))), .needsYou, AidenInbox.Tier.approval),
            (summary("question", minutesAgo: 3, activity: .active, rowState: .needsInput,
                     inbox: AidenChatInboxSignals(snoozedUntil: ahead(minutes: 60))), .needsYou, AidenInbox.Tier.input),
            (summary("failed", minutesAgo: 5, unread: true, failed: true), .needsYou, AidenInbox.Tier.failed),
            (summary("running", minutesAgo: 1, activity: .active, rowState: .working), .working, 0),
            (summary("active-older-mac", minutesAgo: 1, activity: .active), .working, 0),
            (summary("done", minutesAgo: 20, unread: true,
                     inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 30), doneAt: ago(minutes: 10))), nil, 0),
            (summary("done-then-reply", minutesAgo: 2, unread: true,
                     inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 2), doneAt: ago(minutes: 10))), .updates, 0),
            (summary("snoozed", minutesAgo: 2, unread: true,
                     inbox: AidenChatInboxSignals(snoozedUntil: ahead(minutes: 30))), nil, 0),
            (summary("pinned", minutesAgo: 60 * 24 * 30,
                     inbox: AidenChatInboxSignals(pinnedAt: ago(minutes: 60 * 24 * 30))), .pinned, 0),
            (summary("unread", minutesAgo: 4, unread: true), .updates, 0),
            (summary("recent", minutesAgo: 60 * 24 * 6), .earlier, 0),
            (summary("stale", minutesAgo: 60 * 24 * 8), nil, 0),
        ]
        for (chat, expected, tier) in cases {
            let placement = AidenInbox.placement(for: chat, isOpen: false, now: now)
            XCTAssertEqual(placement.section, expected, chat.id)
            if expected == .needsYou { XCTAssertEqual(placement.tier, tier, chat.id) }
        }
    }

    func testTheOpenChatStaysOutOfUpdatesAndTheFailedTier() {
        let failed = summary("failed", minutesAgo: 60 * 24 * 20, unread: true, failed: true)
        let reply = summary("reply", minutesAgo: 60 * 24 * 20, unread: true)
        XCTAssertEqual(section(failed), .needsYou)
        XCTAssertEqual(section(reply), .updates)
        // Open on this phone, it is read here; it stays listed in Earlier
        // even past the recent window.
        XCTAssertEqual(section(failed, isOpen: true), .earlier)
        XCTAssertEqual(section(reply, isOpen: true), .earlier)
    }

    // MARK: Host bucket with the phone's rechecks

    func testHostBucketIsUsedWhenItAgreesWithWhatThePhoneSees() {
        let hostTime = ago(minutes: 90)
        let pinned = summary("pinned", minutesAgo: 60 * 24 * 40,
                             inbox: AidenChatInboxSignals(bucket: .pinned, sortAt: hostTime, pinnedAt: hostTime))
        let updates = summary("updates", minutesAgo: 5, unread: true,
                              inbox: AidenChatInboxSignals(bucket: .updates, sortAt: hostTime))
        let approval = summary("approval", minutesAgo: 1, activity: .active, rowState: .needsApproval,
                               inbox: AidenChatInboxSignals(bucket: .needsYou, sortAt: hostTime))
        let done = summary("done", minutesAgo: 5, unread: true,
                           inbox: AidenChatInboxSignals(bucket: .done, sortAt: hostTime))

        XCTAssertEqual(AidenInbox.placement(for: pinned, isOpen: false, now: now),
                       AidenInboxPlacement(section: .pinned, tier: 0, sortAt: hostTime))
        XCTAssertEqual(AidenInbox.placement(for: updates, isOpen: false, now: now).sortAt, hostTime)
        XCTAssertEqual(AidenInbox.placement(for: approval, isOpen: false, now: now),
                       AidenInboxPlacement(section: .needsYou, tier: AidenInbox.Tier.approval, sortAt: hostTime))
        // The host's Done stands even though the local rule would list it.
        XCTAssertNil(section(done))
    }

    func testHostBucketYieldsToTheOpenChatAndLiveRowState() {
        let hostTime = ago(minutes: 30)
        let updates = summary("updates", minutesAgo: 5, unread: true,
                              inbox: AidenChatInboxSignals(bucket: .updates, sortAt: hostTime))
        let failed = summary("failed", minutesAgo: 5, unread: true, failed: true,
                             inbox: AidenChatInboxSignals(bucket: .needsYou, sortAt: hostTime))
        XCTAssertEqual(section(updates, isOpen: true), .earlier)
        XCTAssertEqual(section(failed, isOpen: true), .earlier)

        // The run finished here after the host computed Working.
        let finished = summary("finished", minutesAgo: 2,
                               inbox: AidenChatInboxSignals(bucket: .working, sortAt: hostTime))
        XCTAssertEqual(section(finished), .earlier)
        // A prompt is waiting here while the host still said Earlier.
        let prompted = summary("prompted", minutesAgo: 2, activity: .active, rowState: .needsInput,
                               inbox: AidenChatInboxSignals(bucket: .earlier, sortAt: hostTime))
        XCTAssertEqual(AidenInbox.placement(for: prompted, isOpen: false, now: now).tier, AidenInbox.Tier.input)
        XCTAssertEqual(section(prompted), .needsYou)
    }

    func testASnoozeWakesOnThePhonesClockEvenIfTheHostStillSaysSnoozed() {
        let until = ahead(minutes: 10)
        let snoozed = summary("snoozed", minutesAgo: 30, unread: true,
                              inbox: AidenChatInboxSignals(bucket: .snoozed, sortAt: ago(minutes: 30), snoozedUntil: until))
        XCTAssertNil(AidenInbox.placement(for: snoozed, isOpen: false, now: now).section)
        let later = until.addingTimeInterval(1)
        XCTAssertEqual(AidenInbox.placement(for: snoozed, isOpen: false, now: later).section, .updates)
        // Without a host bucket the local rule wakes it at the same instant.
        var local = snoozed
        local.inbox.invalidateHostPlacement()
        XCTAssertNil(AidenInbox.placement(for: local, isOpen: false, now: now).section)
        XCTAssertEqual(AidenInbox.placement(for: local, isOpen: false, now: later).section, .updates)
    }

    func testEarlierAgesOutOnThePhonesClock() {
        let chat = summary("earlier", minutesAgo: 60 * 24 * 7 - 1,
                           inbox: AidenChatInboxSignals(bucket: .earlier, sortAt: ago(minutes: 60 * 24 * 7 - 1)))
        XCTAssertEqual(AidenInbox.placement(for: chat, isOpen: false, now: now).section, .earlier)
        let twoMinutesLater = now.addingTimeInterval(120)
        XCTAssertNil(AidenInbox.placement(for: chat, isOpen: false, now: twoMinutesLater).section)
        XCTAssertEqual(AidenInbox.placement(for: chat, isOpen: true, now: twoMinutesLater).section, .earlier)
    }

    // MARK: Projection

    func testProjectionOrdersEachSectionAsTheDesktopDoesAndCapsEarlier() {
        var chats = [
            summary("question-new", minutesAgo: 1, activity: .active, rowState: .needsInput,
                    inbox: AidenChatInboxSignals(attentionSince: ago(minutes: 1))),
            summary("approval", minutesAgo: 2, activity: .active, rowState: .needsApproval,
                    inbox: AidenChatInboxSignals(attentionSince: ago(minutes: 2))),
            summary("question-old", minutesAgo: 9, activity: .active, rowState: .needsInput,
                    inbox: AidenChatInboxSignals(attentionSince: ago(minutes: 9))),
            summary("failed", minutesAgo: 30, unread: true, failed: true),
            summary("run-late", minutesAgo: 1, activity: .active, rowState: .working,
                    inbox: AidenChatInboxSignals(runStartedAt: ago(minutes: 1))),
            summary("run-early", minutesAgo: 1, activity: .active, rowState: .working,
                    inbox: AidenChatInboxSignals(runStartedAt: ago(minutes: 8))),
            summary("reply-old", minutesAgo: 50, unread: true),
            summary("reply-new", minutesAgo: 5, unread: true),
            summary("other-workspace", minutesAgo: 1, unread: true, workspaceId: "archived"),
        ]
        for index in 0..<23 {
            chats.append(summary("earlier-\(String(format: "%02d", index))", minutesAgo: Double(100 + index)))
        }

        let projection = AidenInboxProjection.make(
            chats: chats,
            workspaceNames: ["alpha": "Alpha"],
            openChatID: nil,
            now: now
        )

        XCTAssertEqual(projection.needsYou.map(\.id), ["approval", "question-old", "question-new", "failed"])
        XCTAssertEqual(projection.working.map(\.id), ["run-early", "run-late"])
        XCTAssertEqual(projection.updates.map(\.id), ["reply-new", "reply-old"])
        XCTAssertEqual(projection.earlier.count, AidenInbox.earlierLimit)
        XCTAssertEqual(projection.earlier.first?.id, "earlier-00")
        XCTAssertEqual(projection.earlierOverflow, 3)
        XCTAssertFalse(projection.rows(in: .updates).contains { $0.id == "other-workspace" })

        let all = AidenInboxProjection.make(
            chats: chats, workspaceNames: ["alpha": "Alpha"], openChatID: nil, now: now, showAllEarlier: true
        )
        XCTAssertEqual(all.earlier.count, 23)
        XCTAssertEqual(all.earlierOverflow, 0)
    }

    func testSearchFindsDoneSnoozedAndOldChatsWhereTheyWouldSitUntriaged() {
        let chats = [
            summary("deploy done", minutesAgo: 10,
                    inbox: AidenChatInboxSignals(bucket: .done, sortAt: ago(minutes: 10), doneAt: ago(minutes: 5))),
            summary("deploy snoozed", minutesAgo: 10, unread: true,
                    inbox: AidenChatInboxSignals(snoozedUntil: ahead(minutes: 60))),
            summary("deploy ancient", minutesAgo: 60 * 24 * 90),
            summary("unrelated", minutesAgo: 1, unread: true),
        ]
        let projection = AidenInboxProjection.make(
            chats: chats, workspaceNames: ["alpha": "Alpha"], openChatID: nil, now: now, searchText: "deploy"
        )
        XCTAssertEqual(projection.updates.map(\.id), ["deploy snoozed"])
        XCTAssertEqual(projection.earlier.map(\.id), ["deploy done", "deploy ancient"])
        // The workspace name matches too.
        let byWorkspace = AidenInboxProjection.make(
            chats: chats, workspaceNames: ["alpha": "Alpha"], openChatID: nil, now: now, searchText: "alp"
        )
        XCTAssertEqual(byWorkspace.updates.count + byWorkspace.earlier.count, 4)
    }

    // MARK: Triage

    func testOptimisticDoneHidesTheRowAndItsUndoBringsItBack() throws {
        let reply = summary("reply", minutesAgo: 5, unread: true,
                            inbox: AidenChatInboxSignals(bucket: .updates, sortAt: ago(minutes: 5), lastAssistantAt: ago(minutes: 5)))
        let done = AidenInbox.applyingOptimisticTriage(.done(true), to: reply, now: now)
        XCTAssertNil(section(done))
        XCTAssertTrue(done.unread, "Done alone leaves the read marker.")
        let undone = AidenInbox.applyingOptimisticTriage(try XCTUnwrap(AidenChatTriageChange.done(true).undo), to: done, now: now)
        XCTAssertEqual(section(undone), .updates)

        let failed = summary("failed", minutesAgo: 5, unread: true, failed: true)
        let failedDone = AidenInbox.applyingOptimisticTriage(.done(true), to: failed, now: now, alsoMarkRead: true)
        XCTAssertFalse(failedDone.unread)
        XCTAssertNil(section(failedDone))
    }

    func testOptimisticSnoozeHidesUntilItsTimeAndOnlyIdleRowsOfferTriage() {
        let reply = summary("reply", minutesAgo: 5, unread: true)
        let until = ahead(minutes: 60)
        let snoozed = AidenInbox.applyingOptimisticTriage(.snooze(until: until), to: reply, now: now)
        XCTAssertEqual(snoozed.inbox.snoozedUntil, until)
        XCTAssertNil(section(snoozed))
        XCTAssertEqual(AidenInbox.placement(for: snoozed, isOpen: false, now: until.addingTimeInterval(1)).section, .updates)
        // A time already past is no snooze, as on the host.
        let past = AidenInbox.applyingOptimisticTriage(.snooze(until: ago(minutes: 1)), to: reply, now: now)
        XCTAssertNil(past.inbox.snoozedUntil)

        XCTAssertTrue(AidenInbox.offersDoneAndSnooze(reply))
        XCTAssertFalse(AidenInbox.offersDoneAndSnooze(summary("run", minutesAgo: 1, activity: .active, rowState: .working)))
        XCTAssertFalse(AidenInbox.offersDoneAndSnooze(summary("ask", minutesAgo: 1, activity: .active, rowState: .needsApproval)))
    }

    func testSnoozePresetsMatchTheDesktopOnThePhonesCalendar() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        func date(_ text: String) throws -> Date {
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = calendar.timeZone
            formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withDashSeparatorInDate]
            return try XCTUnwrap(formatter.date(from: text))
        }

        // Saturday 10:00: an hour, this evening, tomorrow (Sunday) and the
        // coming Monday, two days away.
        let saturday = try date("2026-10-31T10:00:00")
        let options = AidenSnoozeOption.options(now: saturday, calendar: calendar)
        XCTAssertEqual(options.map(\.preset), [.hour, .evening, .tomorrow, .nextWeek])
        XCTAssertEqual(options[0].until, saturday.addingTimeInterval(3_600))
        XCTAssertEqual(options[1].until, try date("2026-10-31T18:00:00"))
        XCTAssertEqual(options[2].until, try date("2026-11-01T09:00:00"))
        XCTAssertEqual(options[3].until, try date("2026-11-02T09:00:00"))

        // Sunday: Monday is a day away, so Next week is the Monday after.
        let sunday = try date("2026-11-01T08:00:00")
        let sundayOptions = AidenSnoozeOption.options(now: sunday, calendar: calendar)
        XCTAssertEqual(sundayOptions.last?.until, try date("2026-11-09T09:00:00"))

        // Wednesday 17:30: the evening is under an hour away, so it is left out.
        let wednesday = try date("2026-11-04T17:30:00")
        let late = AidenSnoozeOption.options(now: wednesday, calendar: calendar)
        XCTAssertEqual(late.map(\.preset), [.hour, .tomorrow, .nextWeek])
        XCTAssertEqual(late[2].until, try date("2026-11-09T09:00:00"))
    }

    // MARK: Row text

    func testRowStatusSaysWhatTheDesktopSays() {
        let approval = summary("approval", minutesAgo: 1, activity: .active, rowState: .needsApproval,
                               inbox: AidenChatInboxSignals(attentionSince: ago(minutes: 125)))
        let run = summary("run", minutesAgo: 1, activity: .active, rowState: .working,
                          inbox: AidenChatInboxSignals(runStartedAt: ago(minutes: 4)))
        let projection = AidenInboxProjection.make(
            chats: [approval, run], workspaceNames: ["alpha": "Alpha"], openChatID: nil, now: now
        )
        let needs = AidenInboxRowStatus.make(projection.needsYou[0], section: .needsYou, now: now)
        XCTAssertEqual(needs.label, "Approval")
        XCTAssertEqual(needs.tone, .warning)
        XCTAssertEqual(needs.wait, "2h")
        XCTAssertEqual(AidenInboxRowStatus.make(projection.working[0], section: .working, now: now).label, "Working 4m")

        let view = AidenInboxRowView(
            row: projection.needsYou[0], section: .needsYou, workspaceName: "Alpha",
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        )
        XCTAssertEqual(view.accessibilityName(needs), "approval, Alpha, Approval, 2h")
        XCTAssertEqual(AidenInboxDuration.text(since: now.addingTimeInterval(-30), now: now), "<1m")
        XCTAssertEqual(AidenInboxDuration.text(since: ago(minutes: 60 * 49), now: now), "2d")
    }
}
