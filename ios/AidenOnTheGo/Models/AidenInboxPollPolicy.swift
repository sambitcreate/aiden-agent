import Foundation

/// How much a machine matters to the Inbox right now.
enum AidenInboxPollRole: Sendable {
    /// The Inbox is showing, and this is the machine with a chat open or the only one.
    case focused
    /// The Inbox is showing, and this is one of several machines.
    case background
    case inboxHidden
}

/// How often the Inbox reads each machine (spec, "Feed").
enum AidenInboxPollPolicy {
    /// One page can miss an old row that needs the person, so a cold start reads
    /// up to this many, stopping at a page with no such row.
    static let coldStartPageLimit = 3
    /// The most a delay stretches, so machines don't all fire together.
    static let jitterRange: ClosedRange<Double> = 0...0.2
    /// Reads of the workspace list for one unknown id while the machine answers 5xx.
    static let workspaceReadLimit = 3

    /// Failures replace the role's delay rather than add to it. `jitter`
    /// multiplies by `1 + jitter`, and is held to `jitterRange`.
    static func delay(role: AidenInboxPollRole, failures: Int, jitter: Double) -> Duration {
        let seconds: Double = switch failures {
        case ...0:
            switch role {
            case .focused: 15
            case .background: 30
            case .inboxHidden: 60
            }
        case 1: 30
        case 2: 60
        case 3: 120
        default: 300
        }
        return .seconds(seconds * (1 + min(max(jitter, jitterRange.lowerBound), jitterRange.upperBound)))
    }
}
