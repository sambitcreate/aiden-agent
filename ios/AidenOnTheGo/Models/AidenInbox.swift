import Foundation

/// The Inbox bucket a host reports on a summary row (`inboxBucket`, Remote
/// revision 50). Unknown values never decode into a case, so a newer host's
/// bucket falls back to local placement instead of failing the page.
enum AidenInboxBucket: String, Codable, Equatable, Sendable, CaseIterable {
    case needsYou = "needs_you"
    case pinned
    case updates
    case earlier
    case working
    case snoozed
    case done
}

/// The Inbox sections, in on-screen order. Working is the shelf under the
/// list.
enum AidenInboxSection: String, CaseIterable, Equatable, Sendable {
    case needsYou
    case pinned
    case updates
    case earlier
    case working

    var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .pinned: "Pinned"
        case .updates: "Updates"
        case .earlier: "Earlier"
        case .working: "Working"
        }
    }
}

/// The Inbox fields of a summary row (Remote revision 50). Every
/// field is optional: older hosts send none of them, and a malformed one is
/// dropped on its own. `bucket` and `sortAt` are kept only together.
struct AidenChatInboxSignals: Codable, Equatable, Sendable {
    var bucket: AidenInboxBucket?
    var sortAt: Date?
    var lastAssistantAt: Date?
    var attentionSince: Date?
    var runStartedAt: Date?
    var pinnedAt: Date?
    var doneAt: Date?
    var snoozedUntil: Date?
    /// The host's triage revision for the chat; nil for a chat with none.
    var triageRevision: Int?

    init(
        bucket: AidenInboxBucket? = nil,
        sortAt: Date? = nil,
        lastAssistantAt: Date? = nil,
        attentionSince: Date? = nil,
        runStartedAt: Date? = nil,
        pinnedAt: Date? = nil,
        doneAt: Date? = nil,
        snoozedUntil: Date? = nil,
        triageRevision: Int? = nil
    ) {
        let paired = bucket != nil && sortAt != nil
        self.bucket = paired ? bucket : nil
        self.sortAt = paired ? sortAt : nil
        self.lastAssistantAt = lastAssistantAt
        self.attentionSince = attentionSince
        self.runStartedAt = runStartedAt
        self.pinnedAt = pinnedAt
        self.doneAt = doneAt
        self.snoozedUntil = snoozedUntil
        self.triageRevision = triageRevision.flatMap { $0 > 0 ? $0 : nil }
    }

    /// Saved rows decode each field on its own, so a cache written by a newer
    /// build (an unknown bucket) still loads.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        func date(_ key: CodingKeys) -> Date? { (try? values.decodeIfPresent(Date.self, forKey: key)) ?? nil }
        self.init(
            bucket: ((try? values.decodeIfPresent(String.self, forKey: .bucket)) ?? nil).flatMap(AidenInboxBucket.init(rawValue:)),
            sortAt: date(.sortAt),
            lastAssistantAt: date(.lastAssistantAt),
            attentionSince: date(.attentionSince),
            runStartedAt: date(.runStartedAt),
            pinnedAt: date(.pinnedAt),
            doneAt: date(.doneAt),
            snoozedUntil: date(.snoozedUntil),
            triageRevision: (try? values.decodeIfPresent(Int.self, forKey: .triageRevision)) ?? nil
        )
    }

    /// Drops the host's bucket after a local change it no longer describes, so
    /// the row is placed by the local rules until the host reports again.
    mutating func invalidateHostPlacement() {
        bucket = nil
        sortAt = nil
    }

    private enum CodingKeys: String, CodingKey {
        case bucket, sortAt, lastAssistantAt, attentionSince, runStartedAt, pinnedAt, doneAt, snoozedUntil, triageRevision
    }
}

extension AidenChatInboxSignals {
    /// The row's signals once `chat` is admitted: a chat detail carries no
    /// triage, but its newest reply is newer output than the row may know of,
    /// which ends a Done hold and outdates the host's placement. Only
    /// replies the host counts for `lastAssistantAt` do (an empty or
    /// cancelled turn does not).
    func admitting(_ chat: AidenChat) -> Self {
        var signals = self
        guard let newest = chat.messages.filter(\.isInboxReply).map(\.createdAt).max(),
              newest > (lastAssistantAt ?? .distantPast) else { return signals }
        signals.lastAssistantAt = newest
        signals.invalidateHostPlacement()
        return signals
    }
}

/// Where one row sits in the Inbox. `section == nil` means hidden (Done,
/// snoozed, or older than the recent window).
struct AidenInboxPlacement: Equatable, Sendable {
    var section: AidenInboxSection?
    /// The Needs you tier (approval 0, question 1, failed 2); 0 elsewhere.
    var tier: Int
    var sortAt: Date

    static func hidden(_ sortAt: Date) -> Self { Self(section: nil, tier: 0, sortAt: sortAt) }
}

/// The desktop Inbox's placement rules (`renderer/shared/inbox-state.ts`),
/// ported for phones. The host's `inboxBucket` is used when it still agrees
/// with what the phone knows; otherwise, and for hosts that send no bucket,
/// the row is placed here from its signals.
enum AidenInbox {
    static let recentWindow: TimeInterval = 7 * 24 * 60 * 60
    static let earlierLimit = 20

    enum Tier {
        static let approval = 0
        static let input = 1
        static let failed = 2
    }

    /// The signals the rules read, in desktop terms.
    struct Signals: Equatable {
        var rowState: AidenChatRowState
        var unread: Bool
        var failed: Bool
        var isOpen: Bool
        var updatedAt: Date
        var lastAssistantAt: Date?
        var attentionSince: Date?
        var runStartedAt: Date?
        var pinnedAt: Date?
        var doneAt: Date?
        var snoozedUntil: Date?

        init(
            rowState: AidenChatRowState,
            unread: Bool = false,
            failed: Bool = false,
            isOpen: Bool = false,
            updatedAt: Date,
            lastAssistantAt: Date? = nil,
            attentionSince: Date? = nil,
            runStartedAt: Date? = nil,
            pinnedAt: Date? = nil,
            doneAt: Date? = nil,
            snoozedUntil: Date? = nil
        ) {
            self.rowState = rowState
            self.unread = unread
            self.failed = failed
            self.isOpen = isOpen
            self.updatedAt = updatedAt
            self.lastAssistantAt = lastAssistantAt
            self.attentionSince = attentionSince
            self.runStartedAt = runStartedAt
            self.pinnedAt = pinnedAt
            self.doneAt = doneAt
            self.snoozedUntil = snoozedUntil
        }

        init(summary: AidenChatSummary, isOpen: Bool) {
            self.init(
                rowState: summary.displayRowState,
                unread: summary.unread,
                failed: summary.lastRunFailed,
                isOpen: isOpen,
                updatedAt: summary.updatedAt,
                lastAssistantAt: summary.inbox.lastAssistantAt,
                attentionSince: summary.inbox.attentionSince,
                runStartedAt: summary.inbox.runStartedAt,
                pinnedAt: summary.inbox.pinnedAt,
                doneAt: summary.inbox.doneAt,
                snoozedUntil: summary.inbox.snoozedUntil
            )
        }
    }

    /// Done holds until newer output lands; a snooze holds until it ends on
    /// this phone's clock.
    static func triageHold(_ signals: Signals, now: Date) -> (done: Bool, snoozed: Bool) {
        let done: Bool
        if let doneAt = signals.doneAt {
            done = signals.lastAssistantAt.map { $0 <= doneAt } ?? true
        } else {
            done = false
        }
        let snoozed = signals.snoozedUntil.map { $0 > now } ?? false
        return (done, snoozed)
    }

    /// `inboxState`: the rules in the plan's order. `includeTriaged` (search)
    /// skips the Done and Snooze rule.
    static func localPlacement(
        _ signals: Signals,
        now: Date,
        recentWindow: TimeInterval = AidenInbox.recentWindow,
        includeTriaged: Bool = false
    ) -> AidenInboxPlacement {
        let unread = signals.unread && !signals.isOpen
        func needsYou(_ tier: Int) -> AidenInboxPlacement {
            AidenInboxPlacement(section: .needsYou, tier: tier, sortAt: signals.attentionSince ?? signals.updatedAt)
        }
        // 1. A live prompt overrides Done and Snooze.
        if signals.rowState == .needsApproval { return needsYou(Tier.approval) }
        if signals.rowState == .needsInput { return needsYou(Tier.input) }
        // 2. Unseen output from a failed run.
        if signals.rowState == .idle, signals.failed, unread { return needsYou(Tier.failed) }
        // 3. (Local desktop prompts only; phones never see them.)
        // 4. Running.
        if signals.rowState == .working {
            return AidenInboxPlacement(section: .working, tier: 0, sortAt: signals.runStartedAt ?? signals.updatedAt)
        }
        // 5. Done with no newer output, or snoozed.
        if !includeTriaged {
            let hold = triageHold(signals, now: now)
            if hold.done || hold.snoozed { return .hidden(signals.updatedAt) }
        }
        // 6–8.
        if let pinnedAt = signals.pinnedAt { return AidenInboxPlacement(section: .pinned, tier: 0, sortAt: pinnedAt) }
        if unread {
            return AidenInboxPlacement(section: .updates, tier: 0, sortAt: signals.lastAssistantAt ?? signals.updatedAt)
        }
        if signals.isOpen || now.timeIntervalSince(signals.updatedAt) <= recentWindow {
            return AidenInboxPlacement(section: .earlier, tier: 0, sortAt: signals.updatedAt)
        }
        return .hidden(signals.updatedAt)
    }

    /// The row's placement: the host's bucket when the phone has nothing newer,
    /// else the local rules. The phone rechecks what the host can't know: the
    /// open chat is never unread (so never in Updates or the failed tier), a
    /// snooze past its end on this phone's clock is awake, the recent window
    /// runs on this phone's clock, and live row state seen here wins.
    static func placement(
        for summary: AidenChatSummary,
        isOpen: Bool,
        now: Date,
        recentWindow: TimeInterval = AidenInbox.recentWindow
    ) -> AidenInboxPlacement {
        let signals = Signals(summary: summary, isOpen: isOpen)
        let local = localPlacement(signals, now: now, recentWindow: recentWindow)
        guard let bucket = summary.inbox.bucket, let sortAt = summary.inbox.sortAt else { return local }
        switch signals.rowState {
        case .needsApproval, .needsInput:
            // The tier comes from the row state; the host's time orders it.
            guard bucket == .needsYou else { return local }
            return AidenInboxPlacement(section: .needsYou, tier: local.tier, sortAt: sortAt)
        case .working:
            guard bucket == .working else { return local }
            return AidenInboxPlacement(section: .working, tier: 0, sortAt: sortAt)
        case .idle:
            break
        }
        let unread = signals.unread && !isOpen
        switch bucket {
        case .needsYou:
            // Idle in Needs you is the failed tier; it holds only while unseen here.
            guard signals.failed, unread else { return local }
            return AidenInboxPlacement(section: .needsYou, tier: Tier.failed, sortAt: sortAt)
        case .working:
            return local
        case .pinned:
            return AidenInboxPlacement(section: .pinned, tier: 0, sortAt: sortAt)
        case .updates:
            guard unread else { return local }
            return AidenInboxPlacement(section: .updates, tier: 0, sortAt: sortAt)
        case .earlier:
            guard isOpen || now.timeIntervalSince(summary.updatedAt) <= recentWindow else { return .hidden(sortAt) }
            return AidenInboxPlacement(section: .earlier, tier: 0, sortAt: sortAt)
        case .snoozed:
            // Awake on this phone's clock: place it as if never snoozed.
            guard let until = summary.inbox.snoozedUntil, until > now else { return local }
            return .hidden(sortAt)
        case .done:
            return .hidden(sortAt)
        }
    }

    /// The swipes one Inbox row offers, as the desktop's `inboxTriageOffer`:
    /// never Done or Snooze on a row that waits on approval or input or is
    /// running; Done only while the row isn't held done and Snooze only while
    /// it isn't snoozed; and on unseen failed output Done and Snooze also read
    /// it, so they are left out on a Mac that takes no read markers. Mark read
    /// is offered on any unread row of a Mac that takes them.
    static func rowOffer(
        for summary: AidenChatSummary,
        isOpen: Bool,
        now: Date,
        supportsReadState: Bool,
        supportsTriage: Bool
    ) -> AidenInboxRowOffer {
        let markRead = summary.unread && supportsReadState
        guard supportsTriage, summary.displayRowState == .idle else {
            return AidenInboxRowOffer(markRead: markRead, done: false, snooze: false, alsoMarkRead: false)
        }
        let alsoMarkRead = alsoMarksRead(summary, isOpen: isOpen)
        guard !alsoMarkRead || supportsReadState else {
            return AidenInboxRowOffer(markRead: markRead, done: false, snooze: false, alsoMarkRead: false)
        }
        let hold = triageHold(Signals(summary: summary, isOpen: isOpen), now: now)
        return AidenInboxRowOffer(markRead: markRead, done: !hold.done, snooze: !hold.snoozed, alsoMarkRead: alsoMarkRead)
    }

    /// Done or Snooze on unseen failed output also reads it, so the row
    /// doesn't come straight back to Needs you.
    static func alsoMarksRead(_ summary: AidenChatSummary, isOpen: Bool) -> Bool {
        summary.displayRowState == .idle && summary.showsFailed && !isOpen
    }

    /// The write that puts back what `change` changed on `before`, offered as
    /// Undo: each field the change named goes back to how the row held it.
    static func undo(of change: AidenChatTriageChange, before: AidenChatSummary, now: Date) -> AidenChatTriageChange? {
        var inverse = AidenChatTriageChange()
        let hold = triageHold(Signals(summary: before, isOpen: false), now: now)
        if change.pinned != nil { inverse.pinned = before.inbox.pinnedAt != nil }
        if change.done != nil { inverse.done = hold.done }
        if change.snooze != nil {
            if hold.snoozed, let until = before.inbox.snoozedUntil {
                inverse.snooze = .until(until)
            } else {
                inverse.snooze = .wake
            }
        }
        return inverse == AidenChatTriageChange() ? nil : inverse
    }

    /// A refused write's row: each field the write changed goes back to
    /// `before`, but only while it still shows the optimistic value, so newer
    /// output, a reload or a later write that landed meanwhile is kept. The
    /// host's placement comes back only when the whole row is as it was.
    /// `restoresUnread` is false for a chat viewed while the write was out:
    /// it has been read since, so its dot stays off.
    static func rollingBack(
        _ current: AidenChatSummary,
        optimistic: AidenChatSummary,
        before: AidenChatSummary,
        restoresUnread: Bool = true
    ) -> AidenChatSummary {
        var row = current
        func restore<Value: Equatable>(_ field: WritableKeyPath<AidenChatSummary, Value>) {
            guard optimistic[keyPath: field] != before[keyPath: field],
                  current[keyPath: field] == optimistic[keyPath: field] else { return }
            row[keyPath: field] = before[keyPath: field]
        }
        restore(\.inbox.pinnedAt)
        restore(\.inbox.doneAt)
        restore(\.inbox.snoozedUntil)
        if restoresUnread { restore(\.unread) }
        if row.inbox.bucket == nil, row.inbox.sortAt == nil {
            var placed = row
            placed.inbox.bucket = before.inbox.bucket
            placed.inbox.sortAt = before.inbox.sortAt
            if placed == before { row = placed }
        }
        return row
    }
}

/// The swipe actions one Inbox row offers (`AidenInbox.rowOffer`).
struct AidenInboxRowOffer: Equatable {
    var markRead: Bool
    var done: Bool
    var snooze: Bool
    /// Done or Snooze also reads the row's unseen failed output.
    var alsoMarkRead: Bool
}

/// The Inbox sections for the phone's sidebar, ordered like the desktop's
/// (`organizeInbox`): Needs you by tier then oldest first; Pinned, Updates and
/// Earlier newest first; the Working shelf oldest first. Ties go by id.
struct AidenInboxProjection: Equatable {
    struct Row: Identifiable, Equatable {
        let summary: AidenChatSummary
        let placement: AidenInboxPlacement
        var id: String { summary.id }
    }

    var needsYou: [Row] = []
    var pinned: [Row] = []
    var updates: [Row] = []
    var earlier: [Row] = []
    var working: [Row] = []
    /// Earlier rows past the cap, reached through Show more.
    var earlierOverflow: Int = 0

    var isEmpty: Bool {
        needsYou.isEmpty && pinned.isEmpty && updates.isEmpty && earlier.isEmpty && working.isEmpty
    }

    func rows(in section: AidenInboxSection) -> [Row] {
        switch section {
        case .needsYou: needsYou
        case .pinned: pinned
        case .updates: updates
        case .earlier: earlier
        case .working: working
        }
    }

    /// Search lists every match where it would sit untriaged, past the recent
    /// window and the Earlier cap.
    static func make(
        chats: [AidenChatSummary],
        workspaceNames: [String: String],
        openChatID: String?,
        now: Date,
        searchText: String = "",
        showAllEarlier: Bool = false,
        recentWindow: TimeInterval = AidenInbox.recentWindow,
        earlierLimit: Int = AidenInbox.earlierLimit
    ) -> Self {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = !query.isEmpty
        var projection = Self()
        for chat in chats {
            guard let workspaceName = workspaceNames[chat.workspaceId] else { continue }
            if searching,
               !chat.title.localizedCaseInsensitiveContains(query),
               !workspaceName.localizedCaseInsensitiveContains(query) { continue }
            let isOpen = chat.id == openChatID
            var placement = AidenInbox.placement(for: chat, isOpen: isOpen, now: now, recentWindow: recentWindow)
            if searching, placement.section == nil {
                placement = AidenInbox.localPlacement(
                    AidenInbox.Signals(summary: chat, isOpen: isOpen),
                    now: now,
                    recentWindow: .infinity,
                    includeTriaged: true
                )
            }
            guard let section = placement.section else { continue }
            let row = Row(summary: chat, placement: placement)
            switch section {
            case .needsYou: projection.needsYou.append(row)
            case .pinned: projection.pinned.append(row)
            case .updates: projection.updates.append(row)
            case .earlier: projection.earlier.append(row)
            case .working: projection.working.append(row)
            }
        }
        projection.needsYou.sort { left, right in
            if left.placement.tier != right.placement.tier { return left.placement.tier < right.placement.tier }
            return Self.oldestFirst(left, right)
        }
        projection.pinned.sort(by: Self.newestFirst)
        projection.updates.sort(by: Self.newestFirst)
        projection.earlier.sort(by: Self.newestFirst)
        projection.working.sort(by: Self.oldestFirst)
        if !searching, !showAllEarlier, projection.earlier.count > earlierLimit {
            projection.earlierOverflow = projection.earlier.count - earlierLimit
            projection.earlier = Array(projection.earlier.prefix(earlierLimit))
        }
        return projection
    }

    private static func newestFirst(_ left: Row, _ right: Row) -> Bool {
        left.placement.sortAt == right.placement.sortAt
            ? left.id < right.id
            : left.placement.sortAt > right.placement.sortAt
    }

    private static func oldestFirst(_ left: Row, _ right: Row) -> Bool {
        left.placement.sortAt == right.placement.sortAt
            ? left.id < right.id
            : left.placement.sortAt < right.placement.sortAt
    }
}

/// The desktop's Snooze presets (`snoozeOptions`), on this phone's clock and
/// calendar.
struct AidenSnoozeOption: Identifiable, Equatable {
    enum Preset: String, Equatable {
        case hour
        case evening
        case tomorrow
        case nextWeek = "next_week"
    }

    let preset: Preset
    let until: Date
    var id: String { preset.rawValue }

    var label: String {
        switch preset {
        case .hour: "1 hour"
        case .evening: "This evening"
        case .tomorrow: "Tomorrow"
        case .nextWeek: "Next week"
        }
    }

    /// One hour from now; this evening at 18:00 only while that is more than
    /// an hour away; tomorrow at 09:00; and the next Monday at 09:00 at least
    /// two days away, so it never repeats Tomorrow.
    static func options(now: Date, calendar: Calendar = .current) -> [Self] {
        let hour = now.addingTimeInterval(60 * 60)
        var options = [Self(preset: .hour, until: hour)]
        if let evening = at(now, dayOffset: 0, hour: 18, calendar: calendar), evening > hour {
            options.append(Self(preset: .evening, until: evening))
        }
        if let tomorrow = at(now, dayOffset: 1, hour: 9, calendar: calendar) {
            options.append(Self(preset: .tomorrow, until: tomorrow))
        }
        // Calendar weekdays run Sunday 1 … Saturday 7; Monday is 2.
        let weekday = calendar.component(.weekday, from: now) - 1
        let nextMonday = ((8 - weekday) % 7) == 0 ? 7 : (8 - weekday) % 7
        let daysToMonday = nextMonday < 2 ? nextMonday + 7 : nextMonday
        if let nextWeek = at(now, dayOffset: daysToMonday, hour: 9, calendar: calendar) {
            options.append(Self(preset: .nextWeek, until: nextWeek))
        }
        return options
    }

    private static func at(_ base: Date, dayOffset: Int, hour: Int, calendar: Calendar) -> Date? {
        let start = calendar.startOfDay(for: base)
        guard let day = calendar.date(byAdding: .day, value: dayOffset, to: start) else { return nil }
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
    }
}

/// Inbox durations ("<1m", "4m", "2h", "3d"), as the desktop shows them.
enum AidenInboxDuration {
    static func text(since: Date, now: Date) -> String {
        let minutes = Int(max(0, now.timeIntervalSince(since)) / 60)
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}

extension AidenInbox {
    /// The row a triage write leaves behind, before the Mac answers. Fields
    /// follow the host's rules: Done stamps now, Snooze keeps only a future
    /// time, and each field is independent of the others.
    static func applyingOptimisticTriage(
        _ change: AidenChatTriageChange,
        to summary: AidenChatSummary,
        now: Date,
        alsoMarkRead: Bool = false
    ) -> AidenChatSummary {
        var row = summary
        if let pinned = change.pinned { row.inbox.pinnedAt = pinned ? (row.inbox.pinnedAt ?? now) : nil }
        if let done = change.done { row.inbox.doneAt = done ? now : nil }
        switch change.snooze {
        case .until(let date): row.inbox.snoozedUntil = date > now ? date : nil
        case .wake: row.inbox.snoozedUntil = nil
        case nil: break
        }
        if alsoMarkRead { row.unread = false }
        // The host's bucket described the row before this change.
        row.inbox.invalidateHostPlacement()
        return row
    }
}

extension AidenChatTriageChange {
    /// Whether the change takes the row out of the Inbox (Done or a Snooze).
    var hidesRow: Bool {
        if done == true { return true }
        if case .until = snooze { return true }
        return false
    }

    var confirmation: String {
        if done == true { return String(localized: "Marked done") }
        if case .until(let date) = snooze {
            let time = date.formatted(date: .omitted, time: .shortened)
            let day = Calendar.current.isDateInToday(date)
                ? String(localized: "today")
                : date.formatted(.dateTime.weekday(.wide))
            return String(localized: "Snoozed until \(day) at \(time)")
        }
        return String(localized: "Updated")
    }
}

/// One Inbox banner. `undo`, when present, is offered as a button.
struct AidenInboxNotice: Identifiable, Equatable {
    let id = UUID()
    let message: String
    var undo: AidenChatTriageChange?
    var chatID: String?
}
