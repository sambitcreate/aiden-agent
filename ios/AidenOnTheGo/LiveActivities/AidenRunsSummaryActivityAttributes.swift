import ActivityKit
import Foundation

/// One Live Activity for every live run on one Mac, once a second run starts
/// there. Each row is a chat; the card stays a summary until every run ends.
struct AidenRunsSummaryActivityAttributes: ActivityAttributes {
    struct Row: Codable, Hashable, Sendable {
        var streamID: String
        var chatID: String
        var title: String
        var status: AgentRunActivityStatus
        var updatedAt: Date
        var isFinal: Bool
    }

    struct ContentState: Codable, Hashable, Sendable {
        var rows: [Row]
        /// Set when the app stops updating (it left the screen); any update
        /// clears it.
        var isStale: Bool

        init(rows: [Row], isStale: Bool = false) {
            self.rows = rows
            self.isStale = isStale
        }
    }

    var instanceID: String
    var deviceID: String?
    var machineName: String
}

/// What the summary card says, in plain words.
enum AidenRunsSummaryPolicy {
    typealias Row = AidenRunsSummaryActivityAttributes.Row
    typealias ContentState = AidenRunsSummaryActivityAttributes.ContentState

    static let maximumShownRows = 3

    /// Waiting on the person first, then failed, working, and finished; ties
    /// newest first.
    static func ordered(_ rows: [Row]) -> [Row] {
        rows.sorted { lhs, rhs in
            let left = rank(lhs), right = rank(rhs)
            if left != right { return left < right }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    static func headline(rows: [Row], machineName: String) -> (title: String, trailing: String?) {
        let title = String(localized: "\(rows.count) runs on \(machineName)")
        let waiting = rows.filter(needsYou).count
        guard waiting > 0 else { return (title, nil) }
        let trailing = waiting == 1
            ? String(localized: "1 needs you")
            : String(localized: "\(waiting) need you")
        return (title, trailing)
    }

    static func visible(_ rows: [Row]) -> (shown: [Row], hiddenCount: Int) {
        let sorted = ordered(rows)
        let shown = Array(sorted.prefix(maximumShownRows))
        return (shown, sorted.count - shown.count)
    }

    static func rowStatus(_ row: Row) -> String {
        switch row.status {
        case .waitingForApproval: String(localized: "Needs approval")
        case .waitingForAnswer: String(localized: "Has a question")
        case .complete: String(localized: "Done")
        case .failed: String(localized: "Failed")
        case .cancelled: String(localized: "Stopped")
        default: row.status.title
        }
    }

    /// Shown under the rows when they may be out of date: the app marked the
    /// card stale, or ActivityKit passed its stale date. Never once every run
    /// has ended.
    static func staleNote(_ state: ContentState, systemMarkedStale: Bool) -> String? {
        guard state.rows.contains(where: { !$0.isFinal }), state.isStale || systemMarkedStale else { return nil }
        return String(localized: "Latest status shown")
    }

    /// When ActivityKit should treat the card as stale: the newest unfinished
    /// run's last update plus a single card's window.
    static func staleDate(_ state: ContentState) -> Date? {
        latestUnfinishedUpdate(state.rows)?.addingTimeInterval(AgentRunFreshness.staleAfter)
    }

    static func latestUnfinishedUpdate(_ rows: [Row]) -> Date? {
        rows.filter { !$0.isFinal }.map(\.updatedAt).max()
    }

    /// The chat a tap on the card opens: the most urgent one.
    static func tapChatID(_ rows: [Row]) -> String? {
        ordered(rows).first?.chatID
    }

    private static func needsYou(_ row: Row) -> Bool {
        !row.isFinal && (row.status == .waitingForApproval || row.status == .waitingForAnswer)
    }

    private static func rank(_ row: Row) -> Int {
        switch row.status {
        case .waitingForApproval, .waitingForAnswer: row.isFinal ? 3 : 0
        case .failed: 1
        case .complete, .cancelled: 3
        default: row.isFinal ? 3 : 2
        }
    }
}
