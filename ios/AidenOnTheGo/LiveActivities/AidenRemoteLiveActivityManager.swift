import ActivityKit
import Foundation

/// Owns the app-side Live Activity lifecycle. The widget renders only the
/// bounded state written here and never receives network credentials.
@MainActor
final class AidenRemoteLiveActivityManager {
    static let shared = AidenRemoteLiveActivityManager()

    static let responseExcerptPreferenceKey = "aiden.live-activities.response-excerpts"

    private let defaults: UserDefaults
    private var currentActivity: Activity<AgentRunActivityAttributes>?
    private var stateByActivityID: [String: AgentRunActivityAttributes.ContentState] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var includesResponseExcerpts: Bool {
        defaults.bool(forKey: Self.responseExcerptPreferenceKey)
    }

    static func matches(
        _ attributes: AgentRunActivityAttributes,
        instanceID: String,
        streamID: String
    ) -> Bool {
        attributes.instanceID == instanceID && attributes.streamID == streamID
    }

    func start(instanceID: String, chatID: String, title: String, streamID: String) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let startedAt = Date()
        let attributes = AgentRunActivityAttributes(
            instanceID: instanceID,
            sessionID: chatID,
            sessionTitle: title,
            streamID: streamID,
            startedAt: startedAt
        )
        let state = AgentRunActivityStateReducer.initialState(
            sessionID: chatID,
            sessionTitle: title,
            startedAt: startedAt
        )

        if let existing = activity(instanceID: instanceID, streamID: streamID) {
            currentActivity = existing
            stateByActivityID[existing.id] = state
            await existing.update(content(for: state))
            return
        }

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: content(for: state),
                pushType: nil
            )
            currentActivity = activity
            stateByActivityID[activity.id] = state
        } catch {
            currentActivity = nil
            AidenDiagnostics.record(.liveActivity, event: .liveActivityFailed, outcome: .degraded, code: .unavailable)
        }
    }

    func updateStatus(instanceID: String, streamID: String, state: AidenStreamState) async {
        switch state {
        case .queued, .reconciling:
            await update(instanceID: instanceID, streamID: streamID) {
                AgentRunActivityStateReducer.initialState(
                    sessionID: $0.sessionID,
                    sessionTitle: $0.sessionTitle,
                    startedAt: $0.startedAt
                )
            }
        case .running:
            await update(instanceID: instanceID, streamID: streamID) {
                AgentRunActivityStateReducer.responding(state: $0)
            }
        case .waitingForApproval:
            await approvalRequired(instanceID: instanceID, streamID: streamID)
        case .done:
            await finish(instanceID: instanceID, streamID: streamID, status: .complete, message: String(localized: "Response complete"))
        case .error, .interrupted:
            await finish(instanceID: instanceID, streamID: streamID, status: .failed, message: String(localized: "Response failed"))
        case .cancelled:
            await finish(instanceID: instanceID, streamID: streamID, status: .cancelled, message: String(localized: "Response cancelled"))
        }
    }

    func appendResponse(_ text: String, instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) { state in
            let updated = AgentRunActivityStateReducer.appendingToken(
                includesResponseExcerpts ? text : " ",
                to: state
            )
            return includesResponseExcerpts
                ? updated
                : AgentRunActivityStateReducer.clearingResponseExcerpt(state: updated)
        }
    }

    func reasoning(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) {
            AgentRunActivityStateReducer.reasoning("", state: $0)
        }
    }

    func toolStarted(name: String?, instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) {
            AgentRunActivityStateReducer.toolStarted(name: name, state: $0)
        }
    }

    func toolFinished(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) {
            AgentRunActivityStateReducer.toolCompleted(state: $0)
        }
    }

    func approvalRequired(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) {
            AgentRunActivityStateReducer.waitingForApproval(state: $0)
        }
    }

    func markStale(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID) {
            AgentRunActivityStateReducer.stale(state: $0)
        }
    }

    func markAllStale() async {
        for activity in Activity<AgentRunActivityAttributes>.activities where isLive(activity) {
            let state = AgentRunActivityStateReducer.stale(state: state(for: activity))
            stateByActivityID[activity.id] = state
            await activity.update(content(for: state))
        }
    }

    func endAll(forInstanceID instanceID: String) async {
        for activity in Activity<AgentRunActivityAttributes>.activities
        where activity.attributes.instanceID == instanceID && isLive(activity) {
            let state = AgentRunActivityStateReducer.final(
                status: .failed,
                activity: String(localized: "Connection revoked"),
                state: state(for: activity)
            )
            stateByActivityID[activity.id] = state
            await activity.end(content(for: state, staleDate: nil), dismissalPolicy: .immediate)
            stateByActivityID[activity.id] = nil
            if currentActivity?.id == activity.id { currentActivity = nil }
        }
    }

    func finish(
        instanceID: String,
        streamID: String,
        status: AgentRunActivityStatus,
        message: String,
        errorSummary: String? = nil
    ) async {
        guard let activity = activity(instanceID: instanceID, streamID: streamID) else { return }
        let state = AgentRunActivityStateReducer.final(
            status: status,
            activity: message,
            state: state(for: activity),
            errorSummary: errorSummary
        )
        stateByActivityID[activity.id] = state
        let policy: ActivityUIDismissalPolicy = status == .complete
            ? .after(Date().addingTimeInterval(300))
            : .after(Date().addingTimeInterval(30))
        await activity.end(content(for: state, staleDate: nil), dismissalPolicy: policy)
        stateByActivityID[activity.id] = nil
        if currentActivity?.id == activity.id { currentActivity = nil }
    }

    /// Reconciles activities persisted by iOS after relaunch against the pinned,
    /// authenticated Aiden client. An unreachable server leaves state stale.
    func reconcile(
        instanceID: String,
        client: AidenRemoteClient,
        isCurrent: @MainActor () -> Bool
    ) async {
        for activity in Activity<AgentRunActivityAttributes>.activities
        where activity.attributes.instanceID == instanceID && isLive(activity) {
            guard isCurrent() else { return }
            guard let streamID = activity.attributes.streamID else {
                await activity.end(nil, dismissalPolicy: .immediate)
                stateByActivityID[activity.id] = nil
                continue
            }
            if stateByActivityID[activity.id] == nil {
                stateByActivityID[activity.id] = activity.content.state
            }
            do {
                let status = try await client.streamStatus(id: streamID)
                guard isCurrent() else { return }
                currentActivity = activity
                await updateStatus(instanceID: instanceID, streamID: streamID, state: status.state)
            } catch {
                guard isCurrent() else { return }
                let state = AgentRunActivityStateReducer.stale(state: state(for: activity))
                stateByActivityID[activity.id] = state
                await activity.update(content(for: state))
            }
        }
    }

    private func update(
        instanceID: String,
        streamID: String,
        transform: (AgentRunActivityAttributes.ContentState) -> AgentRunActivityAttributes.ContentState
    ) async {
        guard let activity = activity(instanceID: instanceID, streamID: streamID), isLive(activity) else { return }
        currentActivity = activity
        var state = transform(state(for: activity))
        if !includesResponseExcerpts, !state.responseExcerpt.isEmpty {
            state = AgentRunActivityStateReducer.clearingResponseExcerpt(state: state)
        }
        stateByActivityID[activity.id] = state
        await activity.update(content(for: state))
    }

    private func state(
        for activity: Activity<AgentRunActivityAttributes>
    ) -> AgentRunActivityAttributes.ContentState {
        if let state = stateByActivityID[activity.id] { return state }
        let state = activity.content.state
        stateByActivityID[activity.id] = state
        return state
    }

    private func activity(instanceID: String, streamID: String) -> Activity<AgentRunActivityAttributes>? {
        if let currentActivity,
           Self.matches(currentActivity.attributes, instanceID: instanceID, streamID: streamID),
           isLive(currentActivity) {
            return currentActivity
        }
        return Activity<AgentRunActivityAttributes>.activities.first {
            Self.matches($0.attributes, instanceID: instanceID, streamID: streamID) && isLive($0)
        }
    }

    private func isLive(_ activity: Activity<AgentRunActivityAttributes>) -> Bool {
        activity.activityState == .active || activity.activityState == .stale
    }

    private func content(
        for state: AgentRunActivityAttributes.ContentState,
        staleDate: Date? = Date().addingTimeInterval(300)
    ) -> ActivityContent<AgentRunActivityAttributes.ContentState> {
        ActivityContent(state: state, staleDate: state.isFinal ? nil : staleDate)
    }
}
