import Foundation

/// Home's "From your Bots" card: one row per Bot that has something to say,
/// joined from the roster's attention and the routine-notification feed.
/// Pure, so tests drive it with fixed rosters and feeds.
struct AidenHomeDigest: Equatable, Sendable {
    static let limit = 3
    /// News older than this has had its moment; Home leaves it to the Bot.
    static let newsWindow: TimeInterval = 24 * 60 * 60

    struct Row: Equatable, Identifiable, Sendable {
        enum Status: Equatable, Sendable {
            /// Open "Needs you" cards, a stopped session or a missing model.
            case needsYou
            case working
            /// A routine run that failed.
            case failed
            /// A finished routine, a reply or a peer message.
            case update
        }

        let instanceId: String
        let bot: AidenBotSummary
        let status: Status
        /// What happened: the routine's name, or the reason the Bot needs you.
        let title: String
        /// The start of the reply, redacted on the Mac. Empty when there is none.
        let preview: String
        /// When the row's news happened, for ordering.
        let date: Date

        var id: String { "\(instanceId)\u{1f}\(bot.id)" }
    }

    struct BotEntry: Sendable {
        let instanceId: String
        let bot: AidenBotSummary
    }

    struct FeedEntry: Sendable {
        let instanceId: String
        let notification: AidenBotRoutineNotification
    }

    /// At most `limit` rows.
    let rows: [Row]
    /// How many Bots had something to say before the cap.
    let total: Int
    /// When the newest finished run (news or a failure) in any row happened,
    /// capped or not.
    var newestNews: Date? = nil

    /// The card offers "See all" when the cap hid a row.
    var hasMore: Bool { total > rows.count }

    /// True when a run finished after `date`: the Bots worked while the
    /// person was away. Always false without a last visit to compare with.
    func hasNewSince(_ date: Date?) -> Bool {
        guard let date, let newestNews else { return false }
        return newestNews > date
    }

    static let empty = AidenHomeDigest(rows: [], total: 0)

    /// One row per Bot (a Bot that both needs you and has a fresh routine shows
    /// once, as needing you), ordered needs-you, then failed, then working,
    /// then newest news first. Whether a Bot needs you is the roster's live
    /// answer: the feed keeps issue cards after they're resolved, so an issue
    /// item only names what needs you while the roster still counts one. A feed item for a Bot the roster doesn't list is dropped:
    /// the Bot is gone or hidden from this phone. A finished run before
    /// `since` is old news and makes no row of its own; what needs you, and
    /// what's working, always shows.
    static func make(
        bots: [BotEntry],
        feed: [FeedEntry],
        since: Date? = nil,
        limit: Int = Self.limit
    ) -> AidenHomeDigest {
        var latest: [String: AidenBotRoutineNotification] = [:]
        var latestIssue: [String: AidenBotRoutineNotification] = [:]
        for entry in feed {
            if entry.notification.kind != .issue, let since, entry.notification.finishedAt.date < since { continue }
            let key = Self.key(entry.instanceId, entry.notification.botId)
            let item = entry.notification
            if entry.notification.kind == .issue {
                if latestIssue[key].map({ $0.finishedAt.date < item.finishedAt.date }) ?? true {
                    latestIssue[key] = item
                }
            } else if latest[key].map({ $0.finishedAt.date < item.finishedAt.date }) ?? true {
                latest[key] = item
            }
        }

        var seen: Set<String> = []
        var rows: [Row] = []
        for entry in bots {
            let key = Self.key(entry.instanceId, entry.bot.id)
            guard seen.insert(key).inserted else { continue }
            if let row = row(for: entry, issue: latestIssue[key], latest: latest[key]) {
                rows.append(row)
            }
        }
        rows.sort { lhs, rhs in
            if rank(lhs.status) != rank(rhs.status) { return rank(lhs.status) < rank(rhs.status) }
            if lhs.date != rhs.date { return lhs.date > rhs.date }
            return lhs.id < rhs.id
        }
        let news = rows.lazy.filter { $0.status == .update || $0.status == .failed }.map(\.date).max()
        return AidenHomeDigest(rows: Array(rows.prefix(max(0, limit))), total: rows.count, newestNews: news)
    }

    private static func row(
        for entry: BotEntry,
        issue: AidenBotRoutineNotification?,
        latest: AidenBotRoutineNotification?
    ) -> Row? {
        let bot = entry.bot
        if AidenBotAttention.needsYou(bot) {
            let issue = (bot.issueCount ?? 0) > 0 ? issue : nil
            let title = issue?.routineName ?? AidenBotAttention.reason(bot) ?? String(localized: "Needs you")
            return Row(
                instanceId: entry.instanceId, bot: bot, status: .needsYou, title: title,
                preview: issue?.preview ?? "",
                date: max(issue?.finishedAt.date ?? .distantPast, bot.updatedAt)
            )
        }
        if AidenBotAttention.isRunning(bot) {
            return Row(
                instanceId: entry.instanceId, bot: bot, status: .working,
                title: latest?.routineName ?? String(localized: "Working"),
                preview: latest?.preview ?? "",
                date: max(latest?.finishedAt.date ?? .distantPast, bot.updatedAt)
            )
        }
        guard let latest else { return nil }
        return Row(
            instanceId: entry.instanceId, bot: bot,
            status: latest.status == .failed ? .failed : .update,
            title: latest.routineName, preview: latest.preview, date: latest.finishedAt.date
        )
    }

    private static func rank(_ status: Row.Status) -> Int {
        switch status {
        case .needsYou: 0
        case .failed: 1
        case .working: 2
        case .update: 3
        }
    }

    private static func key(_ instanceId: String, _ botId: String) -> String {
        "\(instanceId)\u{1f}\(botId)"
    }
}

/// What Home shows where its Bots go, so it never flashes "nothing" while a
/// machine is still answering.
enum AidenHomeBotsState: Equatable, Sendable {
    /// At least one Bot to show.
    case bots
    /// A machine that may have Bots hasn't answered yet: skeleton sprites.
    case loading
    /// Every machine that can show Bots answered, and none has one.
    case noBots
    /// Every machine that can show Bots is offline.
    case offline
    /// No paired machine lets this phone see Bots; Home leaves the space out.
    case none

    /// A paired machine as Home's Bots see it.
    struct Machine: Equatable, Sendable {
        /// The pairing has `bot:read`.
        var readsBots: Bool
        var isHidden = false
        var isBlocked = false
        var isOnline: Bool
        var isOffline: Bool
        /// The machine's lists were read at least once.
        var answered: Bool
    }

    static func make(hasBots: Bool, machines: [Machine]) -> Self {
        if hasBots { return .bots }
        let readers = machines.filter { $0.readsBots && !$0.isHidden && !$0.isBlocked }
        guard !readers.isEmpty else { return .none }
        if readers.contains(where: { $0.isOnline ? !$0.answered : !$0.isOffline }) { return .loading }
        if readers.contains(where: \.isOnline) { return .noBots }
        return .offline
    }

    /// True when every machine that can show Bots is known to be offline, so
    /// the Bots on Home are the ones they last listed.
    static func isAllOffline(_ machines: [Machine]) -> Bool {
        let readers = machines.filter { $0.readsBots && !$0.isHidden && !$0.isBlocked }
        return !readers.isEmpty && readers.allSatisfy(\.isOffline)
    }
}

/// What "From your Bots" says when it has no rows. A machine still being read
/// (or still connecting since launch) holds skeletons; "Nothing new" is said
/// only once every shown machine was read in full. A machine that is offline,
/// failed or wasn't asked never counts as quiet: the card says it couldn't
/// hear from it instead, so it never resolves to an endless skeleton either.
enum AidenHomeFeedState: Equatable, Sendable {
    case rows
    case loading
    /// No machine could be read, and at least one didn't answer.
    case failed
    /// No machine could be read, and they're offline.
    case offline
    /// Nothing new from the machines read; others couldn't be.
    case partial
    case quiet

    /// A machine whose Bots Home shows.
    struct Machine: Equatable, Sendable {
        var id: String
        /// Connected now, so Home reads it.
        var isConnected: Bool
        /// Known offline, so no read is coming.
        var isOffline: Bool
    }

    static func make(
        hasRows: Bool,
        machines: [Machine],
        outcomes: [String: AidenBotRoutineFeedReader.Outcome],
        hasRead: (String) -> Bool
    ) -> Self {
        if hasRows { return .rows }
        var read = 0
        var failed = 0
        var offline = 0
        for machine in machines {
            if hasRead(machine.id) {
                read += 1
            } else if machine.isConnected {
                // `.read` without a full window means it was forgotten since.
                guard let outcome = outcomes[machine.id], outcome != .read else { return .loading }
                failed += 1
            } else if machine.isOffline {
                offline += 1
            } else {
                return .loading
            }
        }
        if failed == 0, offline == 0 { return .quiet }
        if read > 0 { return .partial }
        return failed > 0 ? .failed : .offline
    }
}

/// The Bots Home shows as sprites: needs-you first, then working, then the
/// most recently changed. One machine's Bot never hides another's.
enum AidenHomeBotRoster {
    static let limit = 3

    static func sprites(_ bots: [AidenHomeDigest.BotEntry], limit: Int = Self.limit) -> [AidenHomeDigest.BotEntry] {
        func rank(_ bot: AidenBotSummary) -> Int {
            if AidenBotAttention.needsYou(bot) { return 0 }
            if AidenBotAttention.isRunning(bot) { return 1 }
            return 2
        }
        let sorted = bots.sorted { lhs, rhs in
            if rank(lhs.bot) != rank(rhs.bot) { return rank(lhs.bot) < rank(rhs.bot) }
            if lhs.bot.updatedAt != rhs.bot.updatedAt { return lhs.bot.updatedAt > rhs.bot.updatedAt }
            return (lhs.instanceId, lhs.bot.id) < (rhs.instanceId, rhs.bot.id)
        }
        return Array(sorted.prefix(max(0, limit)))
    }
}

/// Home's greeting: the time of day, and the person's name when Aiden knows it.
enum AidenGreeting {
    static func make(date: Date, name: String?, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: date)
        let salutation = switch hour {
        case 5..<12: String(localized: "Good morning")
        case 12..<17: String(localized: "Good afternoon")
        case 17..<22: String(localized: "Good evening")
        default: String(localized: "Hello")
        }
        guard let name = AidenHomeName.clean(name) else { return salutation }
        return "\(salutation), \(name)"
    }
}

/// What Home calls the person. The phone never learns the Mac's username (the
/// Remote API forbids sending it), so a host name is used only if a host ever
/// offers one; otherwise the name the person typed on this device; otherwise
/// none, and the greeting stays neutral.
enum AidenHomeName {
    static let defaultsKey = "aiden.home.name"
    static let maximumLength = 40

    static func resolve(host: String?, local: String?) -> String? {
        clean(host) ?? clean(local)
    }

    /// Trimmed, single-line and bounded; nil when nothing is left.
    static func clean(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let line = raw.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maximumLength))
    }
}
