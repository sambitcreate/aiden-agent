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

        let open = AidenInboxProjection.make(
            chats: chats, workspaceNames: ["alpha": "Alpha"], openChatID: "earlier-22", now: now
        )
        XCTAssertEqual(open.earlier.count, AidenInbox.earlierLimit)
        XCTAssertEqual(open.earlier.last?.id, "earlier-22")
        XCTAssertFalse(open.earlier.contains { $0.id == "earlier-19" })
        XCTAssertEqual(open.earlierOverflow, 3)

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
        let undo = try XCTUnwrap(AidenInbox.undo(of: .done(true), before: reply, now: now))
        XCTAssertEqual(undo, .done(false))
        let undone = AidenInbox.applyingOptimisticTriage(undo, to: done, now: now)
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

    }

    private func offer(
        _ chat: AidenChatSummary,
        isOpen: Bool = false,
        readState: Bool = true,
        triage: Bool = true
    ) -> AidenInboxRowOffer {
        AidenInbox.rowOffer(for: chat, isOpen: isOpen, now: now, supportsReadState: readState, supportsTriage: triage)
    }

    func testRowOffersFollowTheDesktopsTriageRules() {
        let reply = summary("reply", minutesAgo: 5, unread: true)
        XCTAssertEqual(offer(reply), AidenInboxRowOffer(markRead: true, done: true, snooze: true, alsoMarkRead: false))
        // Rows that wait on the person or run offer Mark read only.
        for state in [AidenChatRowState.working, .needsApproval, .needsInput] {
            let row = summary("live", minutesAgo: 1, activity: .active, rowState: state, unread: true)
            XCTAssertEqual(offer(row), AidenInboxRowOffer(markRead: true, done: false, snooze: false, alsoMarkRead: false), "\(state)")
        }
        // Without chat-triage-v1 (or chat:write) there is no Done or Snooze;
        // without read markers there is no Mark read.
        XCTAssertEqual(offer(reply, triage: false), AidenInboxRowOffer(markRead: true, done: false, snooze: false, alsoMarkRead: false))
        XCTAssertEqual(offer(reply, readState: false), AidenInboxRowOffer(markRead: false, done: true, snooze: true, alsoMarkRead: false))

        // Unseen failed output: Done and Snooze also read it, so a Mac
        // without read markers is offered neither; the open chat is seen.
        let failed = summary("failed", minutesAgo: 5, unread: true, failed: true)
        XCTAssertEqual(offer(failed), AidenInboxRowOffer(markRead: true, done: true, snooze: true, alsoMarkRead: true))
        XCTAssertEqual(offer(failed, readState: false), AidenInboxRowOffer(markRead: false, done: false, snooze: false, alsoMarkRead: false))
        XCTAssertEqual(offer(failed, isOpen: true, readState: false).done, true)

        // Done follows the hold: a done row with newer output offers Done again.
        let held = summary("held", minutesAgo: 5, inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 30), doneAt: ago(minutes: 10)))
        XCTAssertFalse(offer(held).done)
        XCTAssertTrue(offer(held).undone)
        XCTAssertTrue(offer(held).snooze)
        let newer = summary("newer", minutesAgo: 5, inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 5), doneAt: ago(minutes: 10)))
        XCTAssertTrue(offer(newer).done)
        // Snooze follows this phone's clock.
        let snoozed = summary("snoozed", minutesAgo: 5, inbox: AidenChatInboxSignals(snoozedUntil: ahead(minutes: 10)))
        XCTAssertFalse(offer(snoozed).snooze)
        XCTAssertTrue(offer(snoozed).wake)
        let woke = summary("woke", minutesAgo: 5, inbox: AidenChatInboxSignals(snoozedUntil: ago(minutes: 1)))
        XCTAssertTrue(offer(woke).snooze)
    }

    func testSearchedHeldRowsOfferPersistentInverseActionsAndSendTheInverse() throws {
        let held = summary("held", minutesAgo: 5, inbox: AidenChatInboxSignals(
            lastAssistantAt: ago(minutes: 30), doneAt: ago(minutes: 10), snoozedUntil: ahead(minutes: 60)))
        XCTAssertNil(section(held))
        let projection = AidenInboxProjection.make(chats: [held], workspaceNames: ["alpha": "Workspace"], openChatID: nil, now: now, searchText: "held")
        XCTAssertEqual(projection.rows(in: .earlier).map(\.id), [held.id])
        var writes: [AidenChatTriageChange] = []
        var presentedSnooze = false
        let actions = AidenInboxRowActions(offer: offer(held), markRead: {}, triage: { writes.append($0) }, snooze: { presentedSnooze = true })
        // Swipe and VoiceOver use these same labels and bound callbacks.
        XCTAssertEqual(actions.doneLabel, "Mark not done")
        XCTAssertEqual(actions.snoozeLabel, "Unsnooze")
        try XCTUnwrap(actions.done)()
        try XCTUnwrap(actions.snooze)()
        XCTAssertEqual(writes, [.done(false), .wake])
        XCTAssertFalse(presentedSnooze)
        var awake = held
        for write in writes { awake = AidenInbox.applyingOptimisticTriage(write, to: awake, now: now) }
        XCTAssertEqual(section(awake), .earlier)
        XCTAssertNil(awake.inbox.doneAt)
        XCTAssertNil(awake.inbox.snoozedUntil)
    }

    func testUndoPutsBackWhatTheRowHeldBefore() {
        let plain = summary("plain", minutesAgo: 5)
        XCTAssertEqual(AidenInbox.undo(of: .done(true), before: plain, now: now), .done(false))
        XCTAssertEqual(AidenInbox.undo(of: .snooze(until: ahead(minutes: 60)), before: plain, now: now), .wake)
        // A row already snoozed goes back to its earlier snooze, not awake.
        let snoozed = summary("snoozed", minutesAgo: 5, inbox: AidenChatInboxSignals(snoozedUntil: ahead(minutes: 10)))
        XCTAssertEqual(
            AidenInbox.undo(of: .snooze(until: ahead(minutes: 600)), before: snoozed, now: now),
            .snooze(until: ahead(minutes: 10))
        )
        // Undoing a wake of a done row marks it done again.
        let held = summary("held", minutesAgo: 5, inbox: AidenChatInboxSignals(doneAt: ago(minutes: 1)))
        let undo = AidenInbox.undo(of: .done(false), before: held, now: now)
        XCTAssertEqual(undo, AidenChatTriageChange(done: true, restoreDoneAt: ago(minutes: 1)))
        // A reply between the original Done and Undo must still wake the row.
        let awake = AidenInbox.applyingOptimisticTriage(.done(false), to: held, now: now)
        let restored = AidenInbox.applyingOptimisticTriage(undo!, to: awake, now: now)
        XCTAssertEqual(restored.inbox.doneAt, held.inbox.doneAt)
        var replied = restored
        replied.inbox.lastAssistantAt = now.addingTimeInterval(-30)
        XCTAssertEqual(section(replied), .earlier)
        XCTAssertEqual(AidenInbox.undo(of: AidenChatTriageChange(pinned: true), before: plain, now: now), AidenChatTriageChange(pinned: false))
        XCTAssertNil(AidenInbox.undo(of: AidenChatTriageChange(), before: plain, now: now))
    }

    func testRollbackRestoresOnlyTheFieldsTheWriteStillHolds() {
        let before = summary("failed", minutesAgo: 5, unread: true, failed: true,
                             inbox: AidenChatInboxSignals(bucket: .needsYou, sortAt: ago(minutes: 5),
                                                          lastAssistantAt: ago(minutes: 5), pinnedAt: ago(minutes: 60)))
        let optimistic = AidenInbox.applyingOptimisticTriage(.done(true), to: before, now: now, alsoMarkRead: true)

        // Nothing else moved: the row is exactly as it was, host bucket too.
        XCTAssertEqual(AidenInbox.rollingBack(optimistic, optimistic: optimistic, before: before), before)

        // Newer output arrived meanwhile: its time and run state stay, and the
        // old host bucket isn't put back over them.
        var moved = optimistic
        moved.inbox.lastAssistantAt = ago(minutes: 1)
        moved.inbox.attentionSince = ago(minutes: 1)
        moved.inbox.runStartedAt = ago(minutes: 2)
        let restored = AidenInbox.rollingBack(moved, optimistic: optimistic, before: before)
        XCTAssertNil(restored.inbox.doneAt)
        XCTAssertTrue(restored.unread)
        XCTAssertEqual(restored.inbox.lastAssistantAt, ago(minutes: 1))
        XCTAssertEqual(restored.inbox.attentionSince, ago(minutes: 1))
        XCTAssertEqual(restored.inbox.runStartedAt, ago(minutes: 2))
        XCTAssertNil(restored.inbox.bucket)
        XCTAssertEqual(restored.inbox.pinnedAt, ago(minutes: 60))

        // A later write (or reload) that changed a field keeps its value.
        var later = optimistic
        later.inbox.doneAt = ago(minutes: 0.5)
        later.unread = true
        XCTAssertEqual(AidenInbox.rollingBack(later, optimistic: optimistic, before: before).inbox.doneAt, ago(minutes: 0.5))
    }

    func testOpeningAChatWithANewerReplyEndsItsDoneHold() throws {
        let held = summary("held", minutesAgo: 30, inbox: AidenChatInboxSignals(
            bucket: .done, sortAt: ago(minutes: 30), lastAssistantAt: ago(minutes: 30), doneAt: ago(minutes: 20)
        ))
        XCTAssertNil(section(held))
        let chat = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: Data("""
        {"id":"held","workspaceId":"alpha","botId":"bot","title":"held","providerId":"p","modelId":"m","createdAt":"2026-08-18T19:00:00Z","updatedAt":"2026-08-18T19:00:00Z",
        "revision":"rev-2","messages":[
          {"id":"m1","role":"assistant","text":"old","createdAt":"\(Self.iso(ago(minutes: 30)))"},
          {"id":"m2","role":"assistant","text":"new","createdAt":"\(Self.iso(ago(minutes: 2)))"},
          {"id":"m3","role":"user","text":"later","createdAt":"\(Self.iso(ago(minutes: 1)))"}]}
        """.utf8))
        var opened = held
        opened.inbox = held.inbox.admitting(chat)
        XCTAssertEqual(opened.inbox.lastAssistantAt, ago(minutes: 2))
        XCTAssertNil(opened.inbox.bucket, "The host's Done bucket no longer describes the row.")
        XCTAssertEqual(section(opened), .earlier)
        // Nothing newer: the row's signals are left alone.
        XCTAssertEqual(opened.inbox.admitting(chat), opened.inbox)
    }

    func testOpeningAChatEndsDoneOnlyForRepliesTheHostCounts() throws {
        let held = summary("held", minutesAgo: 30, inbox: AidenChatInboxSignals(
            bucket: .done, sortAt: ago(minutes: 30), lastAssistantAt: ago(minutes: 30), doneAt: ago(minutes: 20)
        ))
        func chat(_ messages: String) throws -> AidenChat {
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: Data("""
            {"id":"held","workspaceId":"alpha","botId":"bot","title":"held","providerId":"p","modelId":"m","createdAt":"2026-08-18T19:00:00Z","updatedAt":"2026-08-18T19:00:00Z",
            "revision":"rev-2","messages":[{"id":"m1","role":"assistant","text":"old","createdAt":"\(Self.iso(ago(minutes: 30)))"},\(messages)]}
            """.utf8))
        }
        // A blank reply and a cancelled empty turn are not output the host counts.
        let quiet = try chat("""
        {"id":"m2","role":"assistant","text":"  ","createdAt":"\(Self.iso(ago(minutes: 5)))"},
        {"id":"m3","role":"assistant","text":"","outcome":{"status":"cancelled"},"createdAt":"\(Self.iso(ago(minutes: 4)))"}
        """)
        XCTAssertEqual(held.inbox.admitting(quiet), held.inbox)

        // A failed turn counts even with no text, as the host's failure does.
        let failed = try chat("""
        {"id":"m4","role":"assistant","text":"","outcome":{"status":"failed"},"createdAt":"\(Self.iso(ago(minutes: 3)))"}
        """)
        XCTAssertEqual(held.inbox.admitting(failed).lastAssistantAt, ago(minutes: 3))
        XCTAssertNil(held.inbox.admitting(failed).bucket)
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
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

        // The banner names the day as the desktop's toast does.
        func confirmation(_ option: AidenSnoozeOption, now: Date) -> String {
            AidenChatTriageChange.snooze(until: option.until).confirmation(now: now, calendar: calendar)
        }
        XCTAssertTrue(confirmation(options[1], now: saturday).hasPrefix("Snoozed until today at "))
        XCTAssertTrue(confirmation(options[2], now: saturday).hasPrefix("Snoozed until tomorrow at "))
        XCTAssertTrue(confirmation(options[3], now: saturday).hasPrefix("Snoozed until Monday at "))
        // Late in the evening "tomorrow" is still the next calendar day.
        let lateEvening = try date("2026-10-31T23:30:00")
        XCTAssertTrue(confirmation(options[2], now: lateEvening).hasPrefix("Snoozed until tomorrow at "))
    }

    func testTheBannerStaysUnderVoiceOverAndOtherwiseGoesAsOnAndroid() {
        let undo = AidenInboxNotice(message: "Marked done", undo: .done(false), chatID: "c")
        let refusal = AidenInboxNotice(message: "Couldn’t update that chat. It’s back where it was.")
        XCTAssertEqual(undo.autoDismissDelay(voiceOverRunning: false), .seconds(5), "Undo lasts its window.")
        XCTAssertEqual(refusal.autoDismissDelay(voiceOverRunning: false), .seconds(10))
        XCTAssertNil(undo.autoDismissDelay(voiceOverRunning: true))
        XCTAssertNil(refusal.autoDismissDelay(voiceOverRunning: true))
    }

    func testABannerShownAgainGetsOnlyWhatIsLeftOfItsWindow() {
        let posted = Date(timeIntervalSince1970: 1_800_000_000)
        let undo = AidenInboxNotice(message: "Marked done", undo: .done(false), chatID: "c", revision: 4, postedAt: posted)
        XCTAssertEqual(undo.remainingDelay(voiceOverRunning: false, now: posted), .seconds(5))
        // Back on the list 3.2 seconds later: 1.8 seconds of Undo are left.
        XCTAssertEqual(undo.remainingDelay(voiceOverRunning: false, now: posted.addingTimeInterval(3.2)), .milliseconds(1800))
        XCTAssertEqual(undo.remainingDelay(voiceOverRunning: false, now: posted.addingTimeInterval(9)), .zero, "Past its window it goes at once.")
        XCTAssertNil(undo.remainingDelay(voiceOverRunning: true, now: posted.addingTimeInterval(9)), "VoiceOver keeps it until dismissed.")
    }

    // MARK: Row text

    func testRowStatusSaysWhatTheDesktopSays() throws {
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

        // Pinned waits from the chat's last change, not from when it was pinned;
        // Updates from the newest reply. Done is said before a snooze.
        let pinned = summary("pinned", minutesAgo: 3, inbox: AidenChatInboxSignals(pinnedAt: ago(minutes: 60 * 26)))
        let reply = summary("reply", minutesAgo: 3, unread: true, inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 7)))
        let both = summary("both", minutesAgo: 3, inbox: AidenChatInboxSignals(doneAt: ago(minutes: 1), snoozedUntil: ahead(minutes: 60)))
        let lists = AidenInboxProjection.make(
            chats: [pinned, reply, both], workspaceNames: ["alpha": "Alpha"], openChatID: nil, now: now, searchText: "Alpha"
        )
        XCTAssertEqual(AidenInboxRowStatus.make(try XCTUnwrap(lists.pinned.first), section: .pinned, now: now).wait, "3m")
        XCTAssertEqual(AidenInboxRowStatus.make(try XCTUnwrap(lists.updates.first), section: .updates, now: now).wait, "7m")
        let bothRow = try XCTUnwrap(lists.earlier.first { $0.id == "both" })
        XCTAssertEqual(AidenInboxRowStatus.make(bothRow, section: .earlier, now: now).label, "Done")

        let view = AidenInboxRowView(
            row: projection.needsYou[0], section: .needsYou, workspaceName: "Alpha",
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        )
        XCTAssertEqual(view.accessibilityName(needs), "approval, Alpha, Approval, 2h")
        XCTAssertEqual(AidenInboxDuration.text(since: now.addingTimeInterval(-30), now: now), "<1m")
        XCTAssertEqual(AidenInboxDuration.text(since: ago(minutes: 60 * 49), now: now), "2d")
    }
}

#if DEBUG
/// The Inbox tab's store over demo machines, so every request is one the contract
/// has. Nothing here waits for a poll to come due: each test reads once at `start()`.
@MainActor
private final class AidenInboxTabFixture {
    static let doneAt = "2026-11-05T09:00:00.000Z"

    let responder = AidenDemoResponder()
    let now = Date(timeIntervalSince1970: 1_793_000_000)
    let preferences = AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
    let cache: AidenChatCache
    let coordinator: AidenRemoteCoordinator
    private let root: URL
    private var scheduler: AidenHostConnectScheduler?

    /// A `readOnly` machine's pairing wasn't granted chat writes.
    init(machines ids: [String], readOnly: Set<String> = []) {
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenInboxTabFixture-\(UUID().uuidString)", directoryHint: .isDirectory)
        cache = AidenChatCache(root: root)
        coordinator = AidenDemoHosts.coordinator(
            installations: ids.map { id in
                var installation = AidenDemoHosts.installation(instanceId: id, name: id)
                if readOnly.contains(id) { installation.deviceCapabilities.removeAll { $0 == .chatWrite } }
                return installation
            },
            responder: responder
        )
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    func connectAll() async {
        let scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
        self.scheduler = scheduler
        await coordinator.start()
        await scheduler.foregrounded()
    }

    func makeStore() -> AidenUnifiedInboxStore {
        let fixedNow = now
        let store = AidenUnifiedInboxStore(
            hosts: coordinator.hosts,
            preferences: preferences,
            cache: cache,
            clock: ContinuousClock(),
            jitter: { 0 },
            now: { fixedNow }
        )
        store.connectScheduler = scheduler
        return store
    }

    func connection(_ instanceId: String) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    func id(_ chatID: String, on instanceId: String) throws -> AidenHostObjectID {
        let installation = try connection(instanceId).installation
        return AidenHostObjectID(instanceId: instanceId, deviceId: installation.deviceId, objectId: chatID)
    }

    /// `age` is minutes before `now`, so rows stay in canonical order as ages rise.
    func row(_ id: String, age: Int, state: String = "idle", unread: Bool = false) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let updated = formatter.string(from: now.addingTimeInterval(-Double(age) * 60))
        var row: [String: Any] = [
            "id": id, "workspaceId": "workspace_app", "title": id, "titlePending": false,
            "createdAt": updated, "updatedAt": updated, "revision": "rev_" + String(format: "%043d", age + 1),
            "activity": "idle", "rowState": state, "unread": unread,
        ]
        if state != "idle" {
            row.merge(["activity": "active", "attentionSince": updated, "runStartedAt": updated]) { $1 }
        }
        return row
    }

    /// An unseen failed run: it needs the person, and Done on it also reads it.
    func failedRow(_ id: String, age: Int) -> [String: Any] {
        let row = row(id, age: age, unread: true)
        return row.merging([
            "lastRunFailed": true,
            "lastAssistantAt": row["updatedAt"]!,
            "lastAssistantMessageId": "msg_1",
        ]) { $1 }
    }

    func serve(_ rows: [[String: Any]], next: String? = nil, on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/chat-summaries", status: 200, json: page(rows, next: next))
    }

    func page(_ rows: [[String: Any]], next: String? = nil) -> Data {
        var object: [String: Any] = ["summaries": rows]
        if let next { object["nextCursor"] = next }
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    func serveTriage(of chatID: String, on instanceId: String, revision: Int, doneAt: String?) {
        let done = doneAt.map { "\"\($0)\"" } ?? "null"
        responder.reply(instanceId: instanceId, method: "POST", path: "/chats/\(chatID)/triage", status: 200, json: Data("""
        {"chatId":"\(chatID)","revision":\(revision),"updatedAt":"\(Self.doneAt)","pinnedAt":null,"doneAt":\(done),"snoozedUntil":null}
        """.utf8))
    }

    func serveRead(of chatID: String, on instanceId: String) {
        responder.reply(instanceId: instanceId, method: "POST", path: "/chats/\(chatID)/read", status: 204, json: Data())
    }

    func serveTranscript(of row: [String: Any], on instanceId: String) {
        let chat = row.filter { ["id", "workspaceId", "title", "createdAt", "updatedAt", "revision"].contains($0.key) }
            .merging(["messages": [["id": "m1", "role": "assistant", "text": "Saved", "createdAt": row["updatedAt"]!]]]) { $1 }
        responder.reply(
            instanceId: instanceId,
            path: "/chats/\(row["id"]!)",
            status: 200,
            json: try! JSONSerialization.data(withJSONObject: chat, options: [.sortedKeys])
        )
    }

    func requests(_ request: String, on instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == request }.count
    }

    /// For work on the main actor or a demo request to land.
    func waitUntil(
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
}

private extension AidenUnifiedInbox {
    /// Every list the Inbox shows, by chat id.
    var listedIDs: [String] { (needsYou + updates + earlier).map(\.id.objectId) }
}

// MARK: The Inbox tab

extension AidenInboxTests {
    @MainActor
    func testHomeModelLoadsFromTheHostItWasGiven() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("on-laptop", age: 1)], on: "laptop")
        let selectedBefore = fixture.requests("GET /chat-summaries", on: "studio")
        let model = AidenHomeModel(chatCache: fixture.cache)

        await model.load(host: try fixture.connection("laptop"))

        XCTAssertEqual(model.chats.map(\.id), ["on-laptop"])
        XCTAssertEqual(fixture.coordinator.defaultInstanceId, "studio", "Reading a machine moved the selection")
        XCTAssertEqual(fixture.requests("GET /chat-summaries", on: "studio"), selectedBefore)
    }

    @MainActor
    func testPromptRowsOfferNeitherDoneNorSnooze() throws {
        let prompts = [
            summary("approval", minutesAgo: 3, activity: .active, rowState: .needsApproval, unread: true),
            summary("question", minutesAgo: 4, activity: .active, rowState: .needsInput),
        ]
        let reply = summary("reply", minutesAgo: 5, unread: true, inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 5)))
        let inbox = AidenUnifiedInbox.make(
            snapshots: [AidenHostInboxSnapshot(
                instanceId: "studio", deviceId: "phone", chats: prompts + [reply],
                workspaceNames: ["alpha": "Alpha"], isOnline: true, isBlocked: false, fetchedAt: now,
                supportsReadState: true, supportsTriage: true
            )],
            filter: .all, hiddenMachines: [], openChat: nil, now: now
        )

        XCTAssertEqual(inbox.needsYou.map(\.id.objectId), ["approval", "question"])
        for row in inbox.needsYou {
            let actions = AidenInboxRowActions(offer: row.offer, perform: { _ in }, chooseSnooze: {})
            XCTAssertNil(actions.done, row.id.objectId)
            XCTAssertNil(actions.snooze, row.id.objectId)
        }
        XCTAssertNotNil(AidenInboxRowActions(offer: inbox.needsYou[0].offer, perform: { _ in }, chooseSnooze: {}).markRead)

        let replyRow = try XCTUnwrap(inbox.updates.first)
        let actions = AidenInboxRowActions(offer: replyRow.offer, perform: { _ in }, chooseSnooze: {})
        XCTAssertNotNil(actions.done, "An idle row lost Done")
        XCTAssertNotNil(actions.snooze, "An idle row lost Snooze")
    }

    /// A row gives what its own machine can take: another machine's features
    /// say nothing about it.
    @MainActor
    func testARowOffersOnlyWhatItsOwnMachineCanTake() throws {
        let chat = summary("reply", minutesAgo: 5, unread: true, inbox: AidenChatInboxSignals(lastAssistantAt: ago(minutes: 5)))
        func snapshot(_ instanceId: String, canWrite: Bool) -> AidenHostInboxSnapshot {
            AidenHostInboxSnapshot(
                instanceId: instanceId, deviceId: "phone", chats: [chat], workspaceNames: ["alpha": "Alpha"],
                isOnline: true, isBlocked: false, fetchedAt: now, supportsReadState: canWrite, supportsTriage: canWrite
            )
        }

        let rows = AidenUnifiedInbox.make(
            snapshots: [snapshot("new", canWrite: true), snapshot("old", canWrite: false)],
            filter: .all, hiddenMachines: [], openChat: nil, now: now
        ).updates

        let offers = Dictionary(uniqueKeysWithValues: rows.map { ($0.id.instanceId, $0.offer) })
        XCTAssertEqual(offers["new"]?.done, true)
        XCTAssertEqual(offers["old"], AidenInboxRowOffer(markRead: false, done: false, snooze: false, alsoMarkRead: false))
    }

    /// Each action reaches the row's own write, and the swipes and the menu are
    /// built from the same list.
    @MainActor
    func testRowActionsMirrorTheOffer() throws {
        var performed: [AidenInboxRowAction] = []
        var choseSnooze = false
        func actions(_ offer: AidenInboxRowOffer) -> AidenInboxRowActions {
            AidenInboxRowActions(offer: offer, perform: { performed.append($0) }, chooseSnooze: { choseSnooze = true })
        }

        let idle = actions(AidenInboxRowOffer(markRead: true, done: true, snooze: true, alsoMarkRead: false))
        try XCTUnwrap(idle.markRead)()
        try XCTUnwrap(idle.done)()
        try XCTUnwrap(idle.snooze)()
        XCTAssertEqual(performed, [.markRead, .done])
        XCTAssertTrue(choseSnooze, "Snooze asks until when before it writes")

        performed = []
        let held = actions(AidenInboxRowOffer(markRead: false, done: false, snooze: false, undone: true, wake: true, alsoMarkRead: false))
        XCTAssertNil(held.markRead)
        try XCTUnwrap(held.done)()
        try XCTUnwrap(held.snooze)()
        XCTAssertEqual(performed, [.undone, .wake])
    }

    @MainActor
    func testUndoNoticeRestoresARow() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("row", age: 90)], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.inbox.listedIDs.contains("row") }
        fixture.serveTriage(of: "row", on: "laptop", revision: 1, doneAt: AidenInboxTabFixture.doneAt)

        await store.perform(.done, on: try fixture.id("row", on: "laptop"))

        await fixture.waitUntil("the row to leave") { !store.inbox.listedIDs.contains("row") }
        await fixture.waitUntil("the notice") { store.notice != nil }
        let notice = try XCTUnwrap(store.notice)
        XCTAssertEqual(notice.instanceId, "laptop")
        XCTAssertNotNil(notice.notice.undo, "Done offered no Undo")
        fixture.serveTriage(of: "row", on: "laptop", revision: 2, doneAt: nil)

        await store.undo(notice)

        await fixture.waitUntil("the row to come back") { store.inbox.listedIDs.contains("row") }
        await fixture.waitUntil("the notice to go") { store.notice == nil }
        XCTAssertEqual(fixture.requests("POST /chats/row/triage", on: "laptop"), 2)
        XCTAssertEqual(fixture.requests("POST /chats/row/triage", on: "studio"), 0)
    }

    /// A swipe lands on the model the rows are drawn from, at once, whichever
    /// machine is selected, so no second copy can say otherwise.
    @MainActor
    func testASwipeMovesTheRowBeforeTheMachineAnswers() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("selected", age: 90, unread: true)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.inbox.listedIDs.contains("selected") }
        fixture.serveTriage(of: "selected", on: "studio", revision: 1, doneAt: AidenInboxTabFixture.doneAt)
        let release = fixture.responder.hold(instanceId: "studio", path: "/chats/selected/triage")

        let swipe = Task { await store.perform(.done, on: try! fixture.id("selected", on: "studio")) }

        await fixture.waitUntil("the row to leave") { !store.inbox.listedIDs.contains("selected") }
        XCTAssertEqual(store.homeModel(for: "studio")?.chats.first?.inbox.doneAt, fixture.now, "The edit is not on the store's model")
        release()
        await swipe.value
    }

    @MainActor
    func testOnlyOneNoticeShowsAcrossMachines() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("first", age: 90)], on: "studio")
        fixture.serve([fixture.row("second", age: 91)], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.listedIDs.count == 2 }
        fixture.serveTriage(of: "first", on: "studio", revision: 1, doneAt: AidenInboxTabFixture.doneAt)
        fixture.serveTriage(of: "second", on: "laptop", revision: 1, doneAt: AidenInboxTabFixture.doneAt)

        await store.perform(.done, on: try fixture.id("first", on: "studio"))
        await store.perform(.done, on: try fixture.id("second", on: "laptop"))

        await fixture.waitUntil("the second notice") { store.notice?.instanceId == "laptop" }
        store.dismissNotice()
        await fixture.waitUntil("the notice to go") { store.notice == nil }
        XCTAssertNil(store.homeModel(for: "studio")?.inboxNotice, "An older notice was waiting underneath")
    }

    /// Spec, Shell: the badge is the online needs-you count, and nothing else.
    @MainActor
    func testTheBadgeMatchesNeedsYouCount() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop", "mini"])
        await fixture.connectAll()
        fixture.serve([
            fixture.row("approval", age: 1, state: "needs_approval"),
            fixture.row("reply", age: 2, unread: true),
        ], on: "studio")
        fixture.serve([fixture.row("question", age: 3, state: "needs_input")], on: "laptop")
        fixture.serve([fixture.row("quiet", age: 4)], on: "mini")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("every machine's rows") { store.inbox.listedIDs.count == 4 }

        XCTAssertEqual(store.needsYouCount, 2)
        XCTAssertEqual(store.needsYouCount, store.inbox.needsYou.count)

        store.filter = .machine("mini")
        XCTAssertEqual(store.needsYouCount, 2, "The filter narrowed the badge")
    }

    /// Plan, Task 21: the count is "online, not hidden, ignores filter", and the
    /// spec's "Hide from Inbox" takes the machine's rows out.
    @MainActor
    func testHidingAMachineRemovesItsRowsAndDropsItFromTheBadge() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("mine", age: 1, state: "needs_approval")], on: "studio")
        fixture.serve([
            fixture.row("theirs", age: 2, state: "needs_approval"),
            fixture.row("theirs-too", age: 3),
        ], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.listedIDs.count == 3 }
        XCTAssertEqual(store.needsYouCount, 2)

        fixture.preferences.update("laptop") { $0.isHidden = true }

        await fixture.waitUntil("the hidden rows to go") { store.inbox.listedIDs == ["mine"] }
        XCTAssertEqual(store.needsYouCount, 1)

        fixture.preferences.update("laptop") { $0.isHidden = false }

        await fixture.waitUntil("the rows to come back") { store.inbox.listedIDs.count == 3 }
        XCTAssertEqual(store.needsYouCount, 2)
    }

    @MainActor
    func testEveryMachineHiddenSaysSoInsteadOfLoading() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.row("mine", age: 1)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.listState == .rows }

        fixture.preferences.update("studio") { $0.isHidden = true }

        await fixture.waitUntil("the hidden state") { store.listState == .allHidden }
    }

    // MARK: What an Inbox with no rows says

    /// The spinner this replaces never ended: a machine that can't be reached
    /// leaves the model `.unresolved`.
    @MainActor
    func testOfflineWithNothingSavedShowsAnOfflineStateNotASpinner() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        fixture.responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        fixture.responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)
        await fixture.connectAll()
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("the offline state") { store.listState == .offline(machines: 2) }
        XCTAssertEqual(store.homeModel(for: "studio")?.chatListLoadState, .unresolved)
    }

    @MainActor
    func testSavedRowsStayWhenTheMachineIsOffline() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.row("saved", age: 1, unread: true)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        await fixture.waitUntil("the row") { store.inbox.listedIDs == ["saved"] }
        store.stop()

        fixture.responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        await fixture.coordinator.connectActiveInstallation()
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("the machine to go offline") { !(store.snapshots["studio"]?.isOnline ?? true) }
        XCTAssertEqual(store.listState, .rows)
    }

    func testAnInboxWithNoRowsSaysWhy() {
        func state(
            hasRows: Bool = false,
            _ machines: [AidenInboxMachineRead],
            hidden: Bool = false
        ) -> AidenInboxListState {
            AidenInboxListState.make(hasRows: hasRows, machines: machines, hasHiddenMachines: hidden)
        }
        let content = AidenInboxMachineRead(presentation: .content)
        let empty = AidenInboxMachineRead(presentation: .empty)
        let reading = AidenInboxMachineRead(presentation: .skeleton)
        let offline = AidenInboxMachineRead(presentation: .failed)
        let refused = AidenInboxMachineRead(presentation: .failed, failure: "Refused")

        XCTAssertEqual(state(hasRows: true, [offline]), .rows)
        XCTAssertEqual(state([content, offline]), .caughtUp, "Chats that are all done are caught up, not missing")
        XCTAssertEqual(state([reading, offline]), .loading, "A machine still reading may yet bring rows")
        XCTAssertEqual(state([empty, offline]), .noChats)
        XCTAssertEqual(state([offline, offline]), .offline(machines: 2))
        XCTAssertEqual(state([offline, refused]), .failed("Refused"))
        XCTAssertEqual(state([], hidden: true), .allHidden)
        XCTAssertEqual(state([]), .noChats)
    }

    @MainActor
    func testAConnectedMachineWithNoChatsSettlesOnNoChats() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([], on: "studio")
        let store = fixture.makeStore()
        XCTAssertNotEqual(store.listState, .noChats, "Empty before the machine has answered")
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("the empty state") { store.listState == .noChats }
    }

    @MainActor
    func testAReadThatFailsOverSavedRowsSaysSoAndKeepsThem() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let page = try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: fixture.page([fixture.row("saved", age: 1, unread: true)])
        )
        _ = try await fixture.cache.saveChatSummaries(
            AidenChatCache.SummarySnapshot(summaries: page.summaries, nextCursor: nil),
            instanceId: "studio",
            writeToken: fixture.cache.reserveSummaryWrite(instanceId: "studio")
        )
        fixture.responder.reply(instanceId: "studio", path: "/chat-summaries", status: 500, json: Data("""
        {"error":{"code":"internal_error","message":"The Mac stumbled.","requestId":"r","retryable":true}}
        """.utf8))
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("the failed refresh") { store.refreshFailed }
        XCTAssertEqual(store.inbox.listedIDs, ["saved"])
        XCTAssertEqual(store.listState, .rows)
    }

    // MARK: What the list is given

    @MainActor
    func testTheOpenChatReachesTheList() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("same", age: 2, unread: true)], on: "studio")
        fixture.serve([fixture.row("same", age: 3, unread: true)], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.updates.count == 2 }

        store.openChat = try fixture.id("same", on: "laptop")

        XCTAssertEqual(store.inbox.updates.map(\.id.instanceId), ["studio"], "An open chat isn't news")
        XCTAssertEqual(store.inbox.earlier.map(\.id.instanceId), ["laptop"])

        store.openChat = nil
        XCTAssertEqual(store.inbox.updates.count, 2)
    }

    @MainActor
    func testSearchNarrowsTheRowsAndLeavesTheBadge() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([
            fixture.row("needle", age: 1, unread: true),
            fixture.row("approval", age: 2, state: "needs_approval"),
        ], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.listedIDs.count == 2 }

        store.searchText = "needle"

        XCTAssertEqual(store.inbox.listedIDs, ["needle"])
        XCTAssertEqual(store.needsYouCount, 1)
    }

    @MainActor
    func testShowMoreListsEveryEarlierRow() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let total = AidenInbox.earlierLimit + 3
        fixture.serve((0..<total).map { fixture.row("row-\($0)", age: $0 + 1) }, on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.earlierOverflow == 3 }
        XCTAssertEqual(store.inbox.earlier.count, AidenInbox.earlierLimit)

        store.showsAllEarlier = true

        XCTAssertEqual(store.inbox.earlier.count, total)
        XCTAssertEqual(store.inbox.earlierOverflow, 0)
    }

    /// A snooze ends and Earlier ages out with nothing else changing.
    @MainActor
    func testRowsFollowThePhonesClock() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.row("ageing", age: 1)], on: "studio")
        var clock = fixture.now
        let store = AidenUnifiedInboxStore(
            hosts: fixture.coordinator.hosts,
            preferences: fixture.preferences,
            cache: fixture.cache,
            clock: ContinuousClock(),
            jitter: { 0 },
            now: { clock }
        )
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.inbox.listedIDs == ["ageing"] }

        clock = clock.addingTimeInterval(AidenInbox.recentWindow + 3600)
        store.refreshClock()

        XCTAssertEqual(store.inbox.listedIDs, [])
    }

    @MainActor
    func testLoadMoreAsksEachMachineWithAPageLeftOnce() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"])
        await fixture.connectAll()
        let cursor = "cur_next.\(String(repeating: "a", count: 43))"
        fixture.serve([fixture.row("first", age: 1)], next: cursor, on: "studio")
        fixture.serve([fixture.row("only", age: 2)], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("a page left") { store.moreChats == .available }
        fixture.responder.reply(
            instanceId: "studio",
            path: "/chat-summaries",
            query: "limit=100&cursor=\(cursor)",
            status: 200,
            json: fixture.page([fixture.row("second", age: 5)])
        )

        await store.loadMoreChats()

        await fixture.waitUntil("the next page") { store.inbox.listedIDs.contains("second") }
        await fixture.waitUntil("nothing left") { store.moreChats == .none }
        XCTAssertEqual(fixture.requests("GET /chat-summaries", on: "laptop"), 1, "A machine with no page left was asked")
    }

    /// `tab` decides visibility: the spec's fastest poll is for "the machine with
    /// an open chat" while the Inbox is visible, and a chat is pushed on that tab.
    @MainActor
    func testOnlyAChatOnTheTabOnScreenIsOpen() {
        let id = AidenHostObjectID(instanceId: "studio", deviceId: "phone", objectId: "chat")
        let navigation = AidenAppNavigation()
        XCTAssertNil(navigation.openChat)

        navigation.open(.chat(id))
        XCTAssertEqual(navigation.openChat, id)

        navigation.open(.settings)
        XCTAssertNil(navigation.openChat, "Settings is over the chat")

        navigation.inboxPath = [.chat(id)]
        navigation.tab = .bots
        XCTAssertNil(navigation.openChat, "A chat on a tab nobody is looking at")
    }

    // MARK: Polls landing under a write

    /// A poll asked for after the swipe can still read the machine before the
    /// write lands, so its page says the row was never moved.
    @MainActor
    func testAPollLandingDuringASwipeLeavesTheRowMoved() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.failedRow("failed", age: 90), fixture.row("quiet", age: 120)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the failed row") { store.inbox.needsYou.map(\.id.objectId) == ["failed"] }
        XCTAssertEqual(store.needsYouCount, 1)
        fixture.serveTriage(of: "failed", on: "studio", revision: 1, doneAt: AidenInboxTabFixture.doneAt)
        fixture.serveRead(of: "failed", on: "studio")
        let release = fixture.responder.hold(instanceId: "studio", path: "/chats/failed/triage")
        let swipe = Task { await store.perform(.done, on: try! fixture.id("failed", on: "studio")) }
        await fixture.waitUntil("the write to go out") {
            fixture.requests("POST /chats/failed/triage", on: "studio") == 1
        }

        await store.refreshAll()

        XCTAssertFalse(store.inbox.listedIDs.contains("failed"), "The poll brought the row back")
        XCTAssertEqual(store.needsYouCount, 0, "The poll put the badge back up")
        release()
        await swipe.value
        await fixture.waitUntil("the notice") { store.notice != nil }
        XCTAssertFalse(store.inbox.listedIDs.contains("failed"))
    }

    @MainActor
    func testAPollLandingDuringMarkReadKeepsTheDotOff() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.failedRow("failed", age: 90)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the failed row") { store.needsYouCount == 1 }
        fixture.serveRead(of: "failed", on: "studio")
        let release = fixture.responder.hold(instanceId: "studio", path: "/chats/failed/read")
        let swipe = Task { await store.perform(.markRead, on: try! fixture.id("failed", on: "studio")) }
        await fixture.waitUntil("the write to go out") {
            fixture.requests("POST /chats/failed/read", on: "studio") == 1
        }

        await store.refreshAll()

        XCTAssertEqual(store.homeModel(for: "studio")?.chats.first?.unread, false, "The poll brought the dot back")
        XCTAssertEqual(store.needsYouCount, 0)
        release()
        await swipe.value
    }

    /// The write is what decides. A refusal still brings the row back.
    @MainActor
    func testARefusalAfterAPollLandedPutsTheRowBack() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        fixture.serve([fixture.row("row", age: 90)], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.inbox.listedIDs.contains("row") }
        fixture.responder.reply(instanceId: "studio", method: "POST", path: "/chats/row/triage", status: 500, json: Data("{}".utf8))
        let release = fixture.responder.hold(instanceId: "studio", path: "/chats/row/triage")
        let swipe = Task { await store.perform(.done, on: try! fixture.id("row", on: "studio")) }
        await fixture.waitUntil("the write to go out") { fixture.requests("POST /chats/row/triage", on: "studio") == 1 }
        await store.refreshAll()
        XCTAssertFalse(store.inbox.listedIDs.contains("row"))

        release()
        await swipe.value

        await fixture.waitUntil("the row to come back") { store.inbox.listedIDs.contains("row") }
        await fixture.waitUntil("the notice") { store.notice != nil }
    }

    // MARK: Polls landing under Load more

    /// Load more, parked at the machine, while a poll comes and goes.
    @MainActor
    private func loadMoreUnderAPoll(_ fixture: AidenInboxTabFixture, store: AidenUnifiedInboxStore, cursor: String, poll: () -> Void) async {
        let query = "limit=100&cursor=\(cursor)"
        let release = fixture.responder.hold(instanceId: "studio", path: "/chat-summaries", query: query)
        let sent = fixture.requests("GET /chat-summaries", on: "studio")
        let more = Task { await store.loadMoreChats() }
        await fixture.waitUntil("Load more to go out") { fixture.requests("GET /chat-summaries", on: "studio") == sent + 1 }
        poll()
        await store.refreshAll()
        XCTAssertEqual(store.moreChats, .loading, "A poll ended Load more's spinner")
        release()
        await more.value
    }

    @MainActor
    func testAPollDuringLoadMoreKeepsThePage() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let cursor = "cur_next.\(String(repeating: "a", count: 43))"
        fixture.serve([fixture.row("first", age: 1)], next: cursor, on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("a page left") { store.moreChats == .available }
        fixture.responder.reply(
            instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor)",
            status: 200, json: fixture.page([fixture.row("second", age: 5)])
        )

        await loadMoreUnderAPoll(fixture, store: store, cursor: cursor) {}

        await fixture.waitUntil("the next page") { store.inbox.listedIDs.contains("second") }
        await fixture.waitUntil("nothing left") { store.moreChats == .none }
    }

    /// A new reply moves the first page's end, so the old cursor no longer
    /// follows on from the list, and the page is read again from the new one.
    @MainActor
    func testAPollThatMovesTheCursorDuringLoadMoreReadsOnFromTheNewOne() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let cursor = "cur_next.\(String(repeating: "a", count: 43))"
        let moved = "cur_next.\(String(repeating: "b", count: 43))"
        fixture.serve([fixture.row("first", age: 1)], next: cursor, on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("a page left") { store.moreChats == .available }
        fixture.responder.reply(
            instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(moved)",
            status: 200, json: fixture.page([fixture.row("second", age: 5)])
        )

        await loadMoreUnderAPoll(fixture, store: store, cursor: cursor) {
            fixture.serve([fixture.row("new", age: 0), fixture.row("first", age: 1)], next: moved, on: "studio")
        }

        await fixture.waitUntil("the next page") { store.inbox.listedIDs.contains("second") }
        await fixture.waitUntil("nothing left") { store.moreChats == .none }
    }

    /// However busy the machine, Load more ends in rows or in words.
    @MainActor
    func testLoadMoreThatKeepsBeingOvertakenSaysSo() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        func cursor(_ index: Int) -> String { "cur_next.\(String(repeating: "\(index)", count: 43))" }
        fixture.serve([fixture.row("first", age: 1)], next: cursor(1), on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("a page left") { store.moreChats == .available }
        let releases = (1...3).map { fixture.responder.hold(instanceId: "studio", path: "/chat-summaries", query: "limit=100&cursor=\(cursor($0))") }

        let sent = fixture.requests("GET /chat-summaries", on: "studio")

        let more = Task { await store.loadMoreChats() }
        for index in 1...3 {
            // Each round is one read of the page and one poll.
            await fixture.waitUntil("page \(index) to go out") {
                fixture.requests("GET /chat-summaries", on: "studio") == sent + 2 * index - 1
            }
            fixture.serve([fixture.row("first", age: 1)], next: cursor(index + 1), on: "studio")
            await store.refreshAll()
            releases[index - 1]()
        }
        await more.value

        await fixture.waitUntil("the failure") {
            if case .failed = store.moreChats { return true }
            return false
        }
    }

    // MARK: The chat write gate

    /// Done and Snooze need the pairing's write grant as well as the feature.
    @MainActor
    func testAMachineWithoutChatWriteOffersNoTriage() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio", "laptop"], readOnly: ["laptop"])
        await fixture.connectAll()
        fixture.serve([fixture.row("writable", age: 90)], on: "studio")
        fixture.serve([fixture.row("readable", age: 91)], on: "laptop")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the rows") { store.inbox.listedIDs.count == 2 }

        let rows = store.inbox.needsYou + store.inbox.updates + store.inbox.earlier
        let offers = Dictionary(uniqueKeysWithValues: rows.map { ($0.id.instanceId, $0.offer) })
        XCTAssertEqual(offers["studio"]?.done, true)
        XCTAssertEqual(offers["studio"]?.snooze, true)
        XCTAssertEqual(offers["laptop"]?.done, false, "A pairing that can't write was offered Done")
        XCTAssertEqual(offers["laptop"]?.snooze, false, "A pairing that can't write was offered Snooze")
    }

    // MARK: Saved transcripts

    /// The Inbox never calls `load`, so a cold start's poll is what saves the
    /// newest transcripts, and a first open works with the machine gone.
    @MainActor
    func testAColdStartSavesTheNewestTranscriptsForAFirstOpenOffline() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let limit = AidenHomeModel.recentTranscriptPrefetchLimit
        let rows = (1...(limit + 2)).map { fixture.row("chat\($0)", age: $0) }
        rows.forEach { fixture.serveTranscript(of: $0, on: "studio") }
        fixture.serve(rows, on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }

        await fixture.waitUntil("the reads") { fixture.requests("GET /chats/chat\(limit)", on: "studio") == 1 }
        for _ in 0..<500 {
            if await fixture.cache.loadChat(instanceId: "studio", chatId: "chat\(limit)") != nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(fixture.requests("GET /chats/chat\(limit + 1)", on: "studio"), 0, "Read past the limit")

        // Only a cold start reads ahead, however much a later poll says changed.
        var changed = rows[0]
        changed["revision"] = "rev_" + String(repeating: "9", count: 43)
        fixture.serve([changed] + rows.dropFirst(), on: "studio")
        await store.refreshAll()
        XCTAssertEqual(fixture.requests("GET /chats/chat1", on: "studio"), 1, "A later poll read ahead")

        fixture.responder.fail(instanceId: "studio", path: "*", code: .notConnectedToInternet)
        let route = AidenChatRouteModel(id: try fixture.id("chat1", on: "studio"), cache: fixture.cache)
        await route.load(coordinator: fixture.coordinator)
        guard case .ready = route.state else { return XCTFail("A first open offline got \(route.state)") }
    }

    @MainActor
    func testGoingToTheBackgroundEndsTheReadAhead() async throws {
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let rows = (1...3).map { fixture.row("chat\($0)", age: $0) }
        rows.forEach { fixture.serveTranscript(of: $0, on: "studio") }
        fixture.serve(rows, on: "studio")
        let release = fixture.responder.hold(instanceId: "studio", path: "/chats/chat1")
        let store = fixture.makeStore()
        store.start()
        await fixture.waitUntil("the first read") { fixture.requests("GET /chats/chat1", on: "studio") == 1 }

        store.stop()
        release()

        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(fixture.requests("GET /chats/chat2", on: "studio"), 0, "It read on in the background")
    }

    // MARK: The badge

    /// The shell's body reads this, so a row changing mustn't redraw the tabs
    /// and any chat pushed on them.
    @MainActor
    func testOnlyACountChangeReachesTheBadge() async throws {
        final class Heard: @unchecked Sendable { var changed = false }
        let fixture = AidenInboxTabFixture(machines: ["studio"])
        await fixture.connectAll()
        let approval = fixture.row("approval", age: 1, state: "needs_approval")
        fixture.serve([approval], on: "studio")
        let store = fixture.makeStore()
        store.start()
        defer { store.stop() }
        await fixture.waitUntil("the row") { store.needsYouCount == 1 }
        // The count can show while that first poll is still reading workspaces
        // and Bots, and a refresh joins a poll that's still out. Let it finish,
        // so the refresh below reads the new page instead of joining it.
        await store.refreshAll()
        let heard = Heard()
        withObservationTracking { _ = store.needsYouCount } onChange: { heard.changed = true }

        fixture.serve([approval, fixture.row("quiet", age: 2)], on: "studio")
        await store.refreshAll()
        await fixture.waitUntil("the new row") { store.inbox.listedIDs.contains("quiet") }
        XCTAssertFalse(heard.changed, "A row that isn't counted redrew the badge")

        fixture.serve([approval, fixture.row("question", age: 3, state: "needs_input")], on: "studio")
        await store.refreshAll()
        await fixture.waitUntil("the count") { store.needsYouCount == 2 }
        XCTAssertTrue(heard.changed)
    }
}
#endif
