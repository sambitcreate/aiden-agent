import Foundation

/// Home's "From your Bots" card: one row per Bot that has something to say,
/// joined from the roster's attention and the routine-notification feed.
/// Pure, so tests drive it with fixed rosters and feeds.
struct AidenHomeDigest: Equatable, Sendable {
    static let limit = 3

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

    /// The card offers "See all" when the cap hid a row.
    var hasMore: Bool { total > rows.count }

    static let empty = AidenHomeDigest(rows: [], total: 0)

    /// One row per Bot (a Bot that both needs you and has a fresh routine shows
    /// once, as needing you), ordered needs-you, then working, then newest
    /// news first. A feed item for a Bot the roster doesn't list is dropped:
    /// the Bot is gone or hidden from this phone.
    static func make(bots: [BotEntry], feed: [FeedEntry], limit: Int = Self.limit) -> AidenHomeDigest {
        var latest: [String: AidenBotRoutineNotification] = [:]
        var latestIssue: [String: AidenBotRoutineNotification] = [:]
        for entry in feed {
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
        return AidenHomeDigest(rows: Array(rows.prefix(max(0, limit))), total: rows.count)
    }

    private static func row(
        for entry: BotEntry,
        issue: AidenBotRoutineNotification?,
        latest: AidenBotRoutineNotification?
    ) -> Row? {
        let bot = entry.bot
        if AidenBotAttention.needsYou(bot) || issue != nil {
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
        case .working: 1
        case .failed, .update: 2
        }
    }

    private static func key(_ instanceId: String, _ botId: String) -> String {
        "\(instanceId)\u{1f}\(botId)"
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
