import ActivityKit
import Foundation

struct AgentRunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var sessionID: String
        var sessionTitle: String
        var status: AgentRunActivityStatus
        var currentActivity: String
        var responseExcerpt: String
        var startedAt: Date
        var updatedAt: Date
        var isStale: Bool
        var isFinal: Bool
        var errorSummary: String?
        /// Tool calls started during this run, shown as a freshness chip. It is
        /// a bounded counter only: tool names and arguments never reach the
        /// widget beyond the sanitized activity line.
        var toolCallCount: Int

        init(
            sessionID: String,
            sessionTitle: String,
            status: AgentRunActivityStatus,
            currentActivity: String,
            responseExcerpt: String = "",
            startedAt: Date,
            updatedAt: Date,
            isStale: Bool = false,
            isFinal: Bool = false,
            errorSummary: String? = nil,
            toolCallCount: Int = 0
        ) {
            self.sessionID = sessionID
            self.sessionTitle = AgentRunActivitySanitizer.sessionTitle(sessionTitle)
            self.status = status
            self.currentActivity = AgentRunActivitySanitizer.activityLine(currentActivity)
            self.responseExcerpt = AgentRunActivitySanitizer.responseExcerpt(responseExcerpt)
            self.startedAt = startedAt
            self.updatedAt = updatedAt
            self.isStale = isStale
            self.isFinal = isFinal
            self.errorSummary = errorSummary.map(AgentRunActivitySanitizer.activityLine)
            self.toolCallCount = AgentRunFreshness.clampedToolCallCount(toolCallCount)
        }

        // iOS persists running activities across app updates, so state encoded
        // by an older build (without `toolCallCount`) must still decode.
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                sessionID: try values.decode(String.self, forKey: .sessionID),
                sessionTitle: try values.decode(String.self, forKey: .sessionTitle),
                status: try values.decode(AgentRunActivityStatus.self, forKey: .status),
                currentActivity: try values.decode(String.self, forKey: .currentActivity),
                responseExcerpt: try values.decode(String.self, forKey: .responseExcerpt),
                startedAt: try values.decode(Date.self, forKey: .startedAt),
                updatedAt: try values.decode(Date.self, forKey: .updatedAt),
                isStale: try values.decode(Bool.self, forKey: .isStale),
                isFinal: try values.decode(Bool.self, forKey: .isFinal),
                errorSummary: try values.decodeIfPresent(String.self, forKey: .errorSummary),
                toolCallCount: try values.decodeIfPresent(Int.self, forKey: .toolCallCount) ?? 0
            )
        }
    }

    var instanceID: String
    var sessionID: String
    var sessionTitle: String
    var streamID: String?
    var startedAt: Date

    init(
        instanceID: String,
        sessionID: String,
        sessionTitle: String,
        streamID: String? = nil,
        startedAt: Date
    ) {
        self.instanceID = instanceID
        self.sessionID = sessionID
        self.sessionTitle = AgentRunActivitySanitizer.sessionTitle(sessionTitle)
        self.streamID = AgentLiveActivityReusePolicy.normalizedStreamID(streamID)
        self.startedAt = startedAt
    }
}

enum AgentRunActivityStatus: String, Codable, Hashable, CaseIterable {
    case starting
    case thinking
    case usingTool
    case searchingFiles
    case readingFiles
    case runningCommand
    case responding
    case waitingForApproval
    case complete
    case failed
    case cancelled

    var title: String {
        switch self {
        case .starting:
            String(localized: "Starting")
        case .thinking:
            String(localized: "Thinking")
        case .usingTool:
            String(localized: "Using tool")
        case .searchingFiles:
            String(localized: "Searching files")
        case .readingFiles:
            String(localized: "Reading files")
        case .runningCommand:
            String(localized: "Running command")
        case .responding:
            String(localized: "Responding")
        case .waitingForApproval:
            String(localized: "Waiting for approval")
        case .complete:
            String(localized: "Complete")
        case .failed:
            String(localized: "Failed")
        case .cancelled:
            String(localized: "Cancelled")
        }
    }

    var compactTitle: String {
        switch self {
        case .starting:
            String(localized: "Start")
        case .thinking:
            String(localized: "Think")
        case .usingTool:
            String(localized: "Tool")
        case .searchingFiles:
            String(localized: "Search")
        case .readingFiles:
            String(localized: "Files")
        case .runningCommand:
            String(localized: "Cmd")
        case .responding:
            String(localized: "Reply")
        case .waitingForApproval:
            String(localized: "Approve")
        case .complete:
            String(localized: "Done")
        case .failed:
            String(localized: "Fail")
        case .cancelled:
            String(localized: "Stop")
        }
    }
}

enum AgentRunActivityToolKind: Equatable {
    case generic(String)
    case search
    case files
    case command
}

enum AgentRunActivitySanitizer {
    static let maximumSessionTitleCharacters = 42
    static let maximumActivityCharacters = 64
    static let maximumExcerptCharacters = 140
    static let maximumToolLabelCharacters = 28

    static func sessionTitle(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized.isEmpty ? String(localized: "Aiden chat") : normalized, limit: maximumSessionTitleCharacters)
    }

    static func activityLine(_ rawValue: String) -> String {
        trimmed(normalizedSingleLine(rawValue), limit: maximumActivityCharacters)
    }

    static func responseExcerpt(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized, limit: maximumExcerptCharacters)
    }

    static func toolKind(name: String?) -> AgentRunActivityToolKind {
        let label = toolLabel(name)
        let lowercasedName = (name ?? "").lowercased()
        let lowercasedLabel = label.lowercased()
        let haystack = "\(lowercasedName) \(lowercasedLabel)"

        if haystack.contains("shell")
            || haystack.contains("bash")
            || haystack.contains("terminal")
            || haystack.contains("exec")
            || haystack.contains("command")
            || haystack.contains("xcodebuild")
            || haystack.contains("simctl") {
            return .command
        }

        if haystack.contains("search")
            || haystack.contains("grep")
            || haystack.contains("ripgrep")
            || haystack.contains("rg")
            || haystack.contains("find") {
            return .search
        }

        if haystack.contains("read")
            || haystack.contains("file")
            || haystack.contains("list")
            || haystack.contains("glob")
            || haystack.contains("workspace") {
            return .files
        }

        return .generic(label)
    }

    static func toolLabel(_ rawValue: String?) -> String {
        let fallback = String(localized: "tool")
        guard let rawValue else { return fallback }

        let noPathSeparators = rawValue
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .last
            .map(String.init) ?? rawValue
        let words = noPathSeparators
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        let normalized = normalizedSingleLine(words)
        return trimmed(normalized.isEmpty ? fallback : normalized, limit: maximumToolLabelCharacters)
    }

    private static func normalizedSingleLine(_ rawValue: String) -> String {
        rawValue
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func trimmed(_ value: String, limit: Int) -> String {
        guard value.count > limit else { return value }
        guard limit > 3 else {
            return String(value.prefix(limit))
        }

        let endIndex = value.index(value.startIndex, offsetBy: limit - 3)
        return String(value[..<endIndex]) + "..."
    }
}

/// Freshness chips make a stale Live Activity obvious: how many tools the run
/// has started, and when the last real agent update arrived.
enum AgentRunFreshness {
    static let maximumDisplayedToolCalls = 99
    static let staleAfter: TimeInterval = 300

    static func clampedToolCallCount(_ count: Int) -> Int {
        min(max(0, count), 9_999)
    }

    /// `nil` hides the chip until the run starts its first tool.
    static func toolCallLabel(count: Int) -> String? {
        guard count > 0 else { return nil }
        if count > maximumDisplayedToolCalls {
            return String(localized: "\(maximumDisplayedToolCalls)+ tools")
        }
        return count == 1 ? String(localized: "1 tool") : String(localized: "\(count) tools")
    }

    /// A finished run is never "stale"; otherwise either the app marked it
    /// stale (backgrounded, unreachable Mac) or ActivityKit passed its
    /// `staleDate` without a newer update.
    static func isStale(
        _ state: AgentRunActivityAttributes.ContentState,
        systemMarkedStale: Bool
    ) -> Bool {
        !state.isFinal && (state.isStale || systemMarkedStale)
    }

    static func staleDate(for state: AgentRunActivityAttributes.ContentState) -> Date? {
        state.isFinal ? nil : state.updatedAt.addingTimeInterval(staleAfter)
    }
}

/// Lock Screen and expanded Dynamic Island copy for a stale activity.
/// Staleness normally replaces the activity line with "Latest status shown",
/// but a run waiting for approval is still blocked on the user after the
/// phone stops receiving updates, so it keeps its ask and offers an action.
/// Fresh and finished runs return `nil`, so each surface keeps its own lead.
enum AgentRunStalePresentation {
    struct Copy: Equatable {
        var lead: String
        /// Present only when the user can unblock the run by opening the app.
        var action: String?
    }

    static func copy(
        for state: AgentRunActivityAttributes.ContentState,
        systemMarkedStale: Bool
    ) -> Copy? {
        guard AgentRunFreshness.isStale(state, systemMarkedStale: systemMarkedStale) else { return nil }
        return Copy(lead: lead(for: state.status), action: action(for: state.status))
    }

    static func lead(for status: AgentRunActivityStatus) -> String {
        status == .waitingForApproval ? status.title : String(localized: "Latest status shown")
    }

    static func action(for status: AgentRunActivityStatus) -> String? {
        status == .waitingForApproval ? String(localized: "Open to answer") : nil
    }
}

enum AgentRunElapsedTimeFormatter {
    static func label(startedAt: Date, updatedAt: Date) -> String {
        let elapsedSeconds = max(0, Int(updatedAt.timeIntervalSince(startedAt).rounded(.down)))
        let hours = elapsedSeconds / 3_600
        let minutes = (elapsedSeconds % 3_600) / 60
        let seconds = elapsedSeconds % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }

        return String(format: "%02d:%02d", minutes, seconds)
    }
}

enum AgentLiveActivityReusePolicy {
    static func normalizedStreamID(_ streamID: String?) -> String? {
        guard let streamID else { return nil }

        let normalized = streamID.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    static func canReuseActivity(
        existingSessionID: String,
        existingStreamID: String?,
        requestedSessionID: String,
        requestedStreamID: String?
    ) -> Bool {
        existingSessionID == requestedSessionID
            && normalizedStreamID(existingStreamID) == normalizedStreamID(requestedStreamID)
    }
}

enum AgentRunActivityStateReducer {
    static func updatingSessionTitle(
        _ title: String,
        state: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: title,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            // Renaming the chat changes presentation metadata, not run progress.
            updatedAt: state.updatedAt,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            toolCallCount: state.toolCallCount
        )
    }

    /// `toolCallCount` lets a queued/reconciling restart keep the count the
    /// run already earned instead of resetting the freshness chip.
    static func initialState(
        sessionID: String,
        sessionTitle: String,
        startedAt: Date = Date(),
        toolCallCount: Int = 0
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            status: .starting,
            currentActivity: String(localized: "Starting response"),
            startedAt: startedAt,
            updatedAt: startedAt,
            toolCallCount: toolCallCount
        )
    }

    static func appendingToken(
        _ text: String,
        to state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        guard !text.isEmpty else { return state }
        return AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: .responding,
            currentActivity: String(localized: "Writing response"),
            responseExcerpt: state.responseExcerpt + text,
            startedAt: state.startedAt,
            updatedAt: now,
            toolCallCount: state.toolCallCount
        )
    }

    static func responding(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(
            .responding,
            activity: String(localized: "Writing response"),
            state: state,
            now: now
        )
    }

    /// A server status snapshot can refresh labels without claiming new agent progress.
    static func refreshedStatus(
        _ status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(status, activity: activity, state: state, now: state.updatedAt)
    }

    static func settingInterimAssistant(
        _ text: String,
        on state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let excerpt = AgentRunActivitySanitizer.responseExcerpt(text)
        guard !excerpt.isEmpty else { return state }
        return AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: .responding,
            currentActivity: String(localized: "Writing response"),
            responseExcerpt: excerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            toolCallCount: state.toolCallCount
        )
    }

    static func clearingResponseExcerpt(
        state: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: "",
            startedAt: state.startedAt,
            // Clearing a now-disallowed excerpt is a privacy update, not progress.
            updatedAt: state.updatedAt,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            toolCallCount: state.toolCallCount
        )
    }

    static func reasoning(
        _ text: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let activity = String(localized: "Thinking")
        return statusState(.thinking, activity: activity, state: state, now: now)
    }

    static func toolStarted(
        name: String?,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        var state = state
        state.toolCallCount = AgentRunFreshness.clampedToolCallCount(state.toolCallCount + 1)
        switch AgentRunActivitySanitizer.toolKind(name: name) {
        case .command:
            return statusState(.runningCommand, activity: String(localized: "Running command"), state: state, now: now)
        case .search:
            return statusState(.searchingFiles, activity: String(localized: "Searching files"), state: state, now: now)
        case .files:
            return statusState(.readingFiles, activity: String(localized: "Reading files"), state: state, now: now)
        case .generic(let label):
            return statusState(.usingTool, activity: String(localized: "Using \(label)"), state: state, now: now)
        }
    }

    static func toolCompleted(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.responding, activity: String(localized: "Processing result"), state: state, now: now)
    }

    static func waitingForApproval(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.waitingForApproval, activity: String(localized: "Waiting for approval"), state: state, now: now)
    }

    static func stale(
        state: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity.isEmpty ? AgentRunStalePresentation.lead(for: state.status) : state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            // Keep the last real agent update: marking stale is not progress,
            // and the "updated … ago" chip must keep aging.
            updatedAt: state.updatedAt,
            isStale: true,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            toolCallCount: state.toolCallCount
        )
    }

    static func final(
        status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        errorSummary: String? = nil,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: status,
            currentActivity: activity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: false,
            isFinal: true,
            errorSummary: errorSummary,
            toolCallCount: state.toolCallCount
        )
    }

    private static func statusState(
        _ status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: status,
            currentActivity: activity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            toolCallCount: state.toolCallCount
        )
    }
}
