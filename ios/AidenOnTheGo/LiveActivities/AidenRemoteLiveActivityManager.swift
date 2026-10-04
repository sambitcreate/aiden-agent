import ActivityKit
import Foundation

/// Owns the app-side Live Activity lifecycle. The widget renders only the
/// bounded state written here and never receives network credentials.
@MainActor
final class AidenRemoteLiveActivityManager {
    static let shared = AidenRemoteLiveActivityManager()

    static let responseExcerptPreferenceKey = "aiden.live-activities.response-excerpts"

    /// ActivityKit budgets updates, so streamed tokens, reasoning, and tool
    /// churn coalesce to the newest state at most once per interval. Phase
    /// changes (status, approval, stale, end) bypass the window.
    static let coalescedUpdateInterval: Duration = .seconds(1)

    private enum UpdateUrgency {
        case coalesced
        case immediate
    }

    private typealias ContentState = AgentRunActivityAttributes.ContentState

    private let defaults: UserDefaults
    private var currentActivity: Activity<AgentRunActivityAttributes>?
    private var stateByActivityID: [String: ContentState] = [:]
    private var throttleByActivityID: [String: AidenLatestValueThrottle<ContentState>] = [:]

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
            await throttle(for: existing).submitUrgent(state)
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
            throttle(for: activity).markDelivered(state)
        } catch {
            currentActivity = nil
            AidenDiagnostics.record(.liveActivity, event: .liveActivityFailed, outcome: .degraded, code: .unavailable)
        }
    }

    func updateStatus(
        instanceID: String,
        streamID: String,
        state: AidenStreamState
    ) async {
        switch state {
        case .queued, .reconciling:
            await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
                AgentRunActivityStateReducer.refreshedStatus(
                    .starting,
                    activity: String(localized: "Starting response"),
                    state: $0
                )
            }
        case .running:
            await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
                AgentRunActivityStateReducer.refreshedStatus(
                    .responding,
                    activity: String(localized: "Writing response"),
                    state: $0
                )
            }
        case .waitingForApproval:
            await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
                AgentRunActivityStateReducer.refreshedStatus(
                    .waitingForApproval,
                    activity: String(localized: "Waiting for approval"),
                    state: $0
                )
            }
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
        await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
            AgentRunActivityStateReducer.waitingForApproval(state: $0)
        }
    }

    func markStale(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
            AgentRunActivityStateReducer.stale(state: $0)
        }
    }

    func markAllStale() async {
        for activity in Activity<AgentRunActivityAttributes>.activities where isLive(activity) {
            let state = AgentRunActivityStateReducer.stale(state: state(for: activity))
            stateByActivityID[activity.id] = state
            await throttle(for: activity).submitUrgent(state)
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
            discardThrottle(for: activity.id)
            await activity.end(content(for: state), dismissalPolicy: .immediate)
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
        discardThrottle(for: activity.id)
        let policy: ActivityUIDismissalPolicy = status == .complete
            ? .after(Date().addingTimeInterval(300))
            : .after(Date().addingTimeInterval(30))
        await activity.end(content(for: state), dismissalPolicy: policy)
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
                discardThrottle(for: activity.id)
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
                await updateStatus(
                    instanceID: instanceID,
                    streamID: streamID,
                    state: status.state
                )
            } catch {
                guard isCurrent() else { return }
                let state = AgentRunActivityStateReducer.stale(state: state(for: activity))
                stateByActivityID[activity.id] = state
                await throttle(for: activity).submitUrgent(state)
            }
        }
    }

    private func update(
        instanceID: String,
        streamID: String,
        urgency: UpdateUrgency = .coalesced,
        transform: (ContentState) -> ContentState
    ) async {
        guard let activity = activity(instanceID: instanceID, streamID: streamID), isLive(activity) else { return }
        currentActivity = activity
        var state = transform(state(for: activity))
        if !includesResponseExcerpts, !state.responseExcerpt.isEmpty {
            state = AgentRunActivityStateReducer.clearingResponseExcerpt(state: state)
        }
        // The reducer state always advances; only the ActivityKit write is
        // coalesced, so a later urgent update or end carries every token.
        stateByActivityID[activity.id] = state
        switch urgency {
        case .coalesced:
            await throttle(for: activity).submit(state)
        case .immediate:
            await throttle(for: activity).submitUrgent(state)
        }
    }

    private func throttle(
        for activity: Activity<AgentRunActivityAttributes>
    ) -> AidenLatestValueThrottle<ContentState> {
        if let existing = throttleByActivityID[activity.id] { return existing }
        let throttle = AidenLatestValueThrottle<ContentState>(
            interval: Self.coalescedUpdateInterval
        ) { [weak self, weak activity] state in
            guard let self, let activity, self.isLive(activity) else { return }
            await activity.update(self.content(for: state))
        }
        throttleByActivityID[activity.id] = throttle
        return throttle
    }

    private func discardThrottle(for activityID: String) {
        throttleByActivityID.removeValue(forKey: activityID)?.cancel()
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

    private func content(for state: AgentRunActivityAttributes.ContentState) -> ActivityContent<AgentRunActivityAttributes.ContentState> {
        ActivityContent(state: state, staleDate: AgentRunFreshness.staleDate(for: state))
    }
}
