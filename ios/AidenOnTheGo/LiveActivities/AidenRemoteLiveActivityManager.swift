import ActivityKit
import Foundation

/// Owns the app-side Live Activity lifecycle. The widget renders only the
/// bounded state written here and never receives network credentials.
@MainActor
final class AidenRemoteLiveActivityManager {
    /// The unit-test host never drives the device's ActivityKit through the
    /// shared manager (chat models, coordinator purges): ActivityKit is
    /// system-wide and slow on loaded simulators, and those flows await it
    /// before transcript reads and purges. ActivityKit tests build their own
    /// managers.
    static let shared = AidenRemoteLiveActivityManager(
        drivesActivityKit: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
    )

    /// ActivityKit budgets updates, so streamed tokens, reasoning, and tool
    /// churn coalesce to the newest state at most once per interval. Phase
    /// changes (status, approval, stale, end) bypass the window.
    static let coalescedUpdateInterval: Duration = .seconds(1)

    private enum UpdateUrgency {
        case coalesced
        case immediate
    }

    private typealias ContentState = AgentRunActivityAttributes.ContentState
    private typealias SummaryActivity = Activity<AidenRunsSummaryActivityAttributes>
    private typealias SummaryState = AidenRunsSummaryActivityAttributes.ContentState

    private struct SummaryRun {
        var chatID: String
        var state: ContentState
    }

    private let preferences: @MainActor () -> AidenNotificationPreferences
    /// False keeps this manager off the device's ActivityKit entirely: it
    /// requests, updates and ends nothing and sees no existing activities.
    private let drivesActivityKit: Bool
    private var currentActivity: Activity<AgentRunActivityAttributes>?
    private var stateByActivityID: [String: ContentState] = [:]
    private var throttleByActivityID: [String: AidenLatestValueThrottle<ContentState>] = [:]
    /// Runs on each Mac's summary card, by Mac then stream. The reducer
    /// state keeps advancing here after the run's own card has ended.
    private var summaryRuns: [String: [String: SummaryRun]] = [:]
    private var summaryThrottleByID: [String: AidenLatestValueThrottle<SummaryState>] = [:]
    /// Single-run cards being folded into a summary. They stay live until
    /// their end lands, so updates skip them and go to the summary row.
    private var mergingActivityIDs: Set<String> = []
    /// Every run started and not yet finished, by Mac then stream, whether or
    /// not it has a card: background grace keeps alerts going without one.
    private var liveRuns: [String: Set<String>] = [:] {
        didSet {
            let now = hasLiveRuns
            guard now != (oldValue.values.contains { !$0.isEmpty }) else { return }
            onLiveRunsChange?(now)
        }
    }

    /// Whether any run is still going on any Mac, merged into a summary or not.
    var hasLiveRuns: Bool {
        liveRuns.values.contains { !$0.isEmpty }
    }

    /// Called once each time `hasLiveRuns` flips.
    var onLiveRunsChange: (@MainActor (Bool) -> Void)?

    /// `preferences` defaults to the person's saved ones in `defaults`.
    init(
        defaults: UserDefaults = .standard,
        drivesActivityKit: Bool = true,
        preferences: (@MainActor () -> AidenNotificationPreferences)? = nil
    ) {
        self.drivesActivityKit = drivesActivityKit
        self.preferences = preferences ?? { AidenNotificationPreferences.load(from: defaults) }
    }

    private var systemActivities: [Activity<AgentRunActivityAttributes>] {
        drivesActivityKit ? Activity<AgentRunActivityAttributes>.activities : []
    }

    private var systemSummaries: [SummaryActivity] {
        drivesActivityKit ? SummaryActivity.activities : []
    }

    /// Settings → Notifications → Reply text on Lock Screen; off by default.
    var includesResponseExcerpts: Bool {
        preferences().replyTextOnLockScreen
    }

    static func matches(
        _ attributes: AgentRunActivityAttributes,
        instanceID: String,
        streamID: String
    ) -> Bool {
        attributes.instanceID == instanceID && attributes.streamID == streamID
    }

    /// A second live run on the same Mac turns that Mac's cards into one
    /// summary card, named after `machineName`.
    func start(
        instanceID: String,
        deviceID: String? = nil,
        chatID: String,
        title: String,
        streamID: String,
        machineName: String = String(localized: "your computer")
    ) async {
        liveRuns[instanceID, default: []].insert(streamID)
        guard drivesActivityKit, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let startedAt = Date()
        let attributes = AgentRunActivityAttributes(
            instanceID: instanceID,
            deviceID: deviceID,
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

        let others = systemActivities.filter {
            $0.attributes.instanceID == instanceID && isLive($0) && !self.state(for: $0).isFinal
                && !mergingActivityIDs.contains($0.id)
        }
        if summary(for: instanceID) != nil || !others.isEmpty {
            await mergeIntoSummary(
                instanceID: instanceID,
                deviceID: deviceID,
                machineName: machineName,
                others: others,
                adding: (streamID: streamID, run: SummaryRun(chatID: chatID, state: state))
            )
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
                AgentRunActivityStateReducer.refreshedWaiting(state: $0)
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

    /// `target` is set only when this device may answer the approval, so
    /// the card can offer Deny.
    func approvalRequired(instanceID: String, streamID: String, target: AgentRunApprovalTarget?) async {
        await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
            AgentRunActivityStateReducer.waitingForApproval(state: $0, target: target)
        }
    }

    /// An approval answered from a card or notification: every card still
    /// waiting on it shows the answer and drops its buttons. A nil decision
    /// means it was settled elsewhere without saying how.
    func approvalAnswered(approvalID: String, decision: AgentRunApprovalAnswer?) async {
        for activity in systemActivities where isLive(activity) {
            let current = state(for: activity)
            guard current.approval?.approvalID == approvalID else { continue }
            let next = AgentRunActivityStateReducer.answered(decision: decision, state: current)
            stateByActivityID[activity.id] = next
            currentActivity = activity
            await throttle(for: activity).submitUrgent(next)
        }
        for (instanceID, runs) in summaryRuns {
            for (streamID, run) in runs where run.state.approval?.approvalID == approvalID {
                await updateSummaryRun(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
                    AgentRunActivityStateReducer.answered(decision: decision, state: $0)
                }
            }
        }
    }

    /// A reply sent from a notification: every card for that chat still
    /// asking stops asking. `landed` is false when the question was already
    /// answered or gone, so the card says it no longer waits.
    func questionAnswered(instanceID: String, chatID: String, landed: Bool) async {
        func next(_ state: ContentState) -> ContentState {
            landed
                ? AgentRunActivityStateReducer.replied(state: state)
                : AgentRunActivityStateReducer.answered(decision: nil, state: state)
        }
        for activity in systemActivities where isLive(activity) && activity.attributes.instanceID == instanceID
            && activity.attributes.sessionID == chatID && !mergingActivityIDs.contains(activity.id) {
            let current = state(for: activity)
            guard current.status == .waitingForAnswer else { continue }
            let updated = next(current)
            stateByActivityID[activity.id] = updated
            currentActivity = activity
            await throttle(for: activity).submitUrgent(updated)
        }
        // A Reply can launch a fresh process: read the rows off the summary.
        if let summary = summary(for: instanceID) { rehydrateSummaryRuns(from: summary) }
        for (streamID, run) in summaryRuns[instanceID] ?? [:]
        where run.chatID == chatID && run.state.status == .waitingForAnswer {
            await updateSummaryRun(instanceID: instanceID, streamID: streamID, urgency: .immediate, transform: next)
        }
    }

    func questionRequired(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
            AgentRunActivityStateReducer.waitingForAnswer(state: $0)
        }
    }

    func markStale(instanceID: String, streamID: String) async {
        await update(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
            AgentRunActivityStateReducer.stale(state: $0)
        }
    }

    func markAllStale() async {
        for activity in systemActivities where isLive(activity) {
            let state = AgentRunActivityStateReducer.stale(state: state(for: activity))
            stateByActivityID[activity.id] = state
            await throttle(for: activity).submitUrgent(state)
        }
        for summary in systemSummaries where isLive(summary) {
            rehydrateSummaryRuns(from: summary)
            var state = summaryState(for: summary.attributes.instanceID)
            guard state.rows.contains(where: { !$0.isFinal }) else { continue }
            state.isStale = true
            await summaryThrottle(for: summary).submitUrgent(state)
        }
    }

    func endAll(forInstanceID instanceID: String) async {
        for activity in systemActivities
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
        for summary in systemSummaries where summary.attributes.instanceID == instanceID && isLive(summary) {
            await endSummary(summary, state: summary.content.state, dismissalPolicy: .immediate)
        }
        summaryRuns[instanceID] = nil
        liveRuns[instanceID] = nil
    }

    func finish(
        instanceID: String,
        streamID: String,
        status: AgentRunActivityStatus,
        message: String,
        errorSummary: String? = nil
    ) async {
        // The card's final write goes first; the change can end the grace.
        defer { liveRuns[instanceID]?.remove(streamID) }
        guard let activity = activity(instanceID: instanceID, streamID: streamID) else {
            await updateSummaryRun(instanceID: instanceID, streamID: streamID, urgency: .immediate) {
                AgentRunActivityStateReducer.final(
                    status: status,
                    activity: message,
                    state: $0,
                    errorSummary: errorSummary
                )
            }
            return
        }
        var state = AgentRunActivityStateReducer.final(
            status: status,
            activity: message,
            state: state(for: activity),
            errorSummary: errorSummary
        )
        if !includesResponseExcerpts, !state.responseExcerpt.isEmpty {
            state = AgentRunActivityStateReducer.clearingResponseExcerpt(state: state)
        }
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
        deviceID: String? = nil,
        client: AidenRemoteClient,
        isCurrent: @MainActor () -> Bool
    ) async {
        for activity in systemActivities
        where activity.attributes.instanceID == instanceID && isLive(activity) {
            guard isCurrent() else { return }
            // No stream to ask about, or a run from an older pairing of the machine.
            guard let streamID = activity.attributes.streamID,
                  Self.isSamePairing(activity.attributes.deviceID, deviceID) else {
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
        for summary in systemSummaries where summary.attributes.instanceID == instanceID && isLive(summary) {
            guard isCurrent() else { return }
            // A summary from an older pairing of the machine.
            guard Self.isSamePairing(summary.attributes.deviceID, deviceID) else {
                await endSummary(summary, state: summary.content.state, dismissalPolicy: .immediate)
                summaryRuns[instanceID] = nil
                continue
            }
            rehydrateSummaryRuns(from: summary)
            for (streamID, run) in summaryRuns[instanceID] ?? [:] where !run.state.isFinal {
                guard let status = try? await client.streamStatus(id: streamID) else { continue }
                guard isCurrent() else { return }
                await updateStatus(instanceID: instanceID, streamID: streamID, state: status.state)
            }
        }
    }

    /// Unset on either side counts as a match: an activity from an older build
    /// has no device, and the single-machine reconcile doesn't name one.
    private static func isSamePairing(_ first: String?, _ second: String?) -> Bool {
        guard let first, let second else { return true }
        return first == second
    }

    /// Every machine with a live connection, selected or not.
    func reconcileTargets(of coordinator: AidenRemoteCoordinator) -> [AidenHostConnection] {
        coordinator.hosts.ordered.filter { $0.connectionState == .connected && !$0.isRevoked }
    }

    /// Reconciles each connected machine through its own client, or only the
    /// ones in `instanceIDs`. Machines run side by side, so one that stopped
    /// answering can't hold up the others' activities. The selection plays no part.
    func reconcileConnectedMachines(
        of coordinator: AidenRemoteCoordinator,
        only instanceIDs: Set<String>? = nil
    ) async {
        await withTaskGroup(of: Void.self) { group in
            for connection in reconcileTargets(of: coordinator)
            where instanceIDs?.contains(connection.instanceId) != false {
                guard let owner = try? coordinator.ownerContext(for: connection.instanceId),
                      let client = try? coordinator.remoteClient(for: owner) else { continue }
                group.addTask { @MainActor in
                    await self.reconcile(
                        instanceID: owner.instanceId,
                        deviceID: owner.deviceId,
                        client: client,
                        isCurrent: { coordinator.isLive(owner) }
                    )
                }
            }
        }
    }

    // MARK: Summary card

    private func summary(for instanceID: String) -> SummaryActivity? {
        systemSummaries.first { $0.attributes.instanceID == instanceID && isLive($0) }
    }

    /// Requests the Mac's summary (or updates the one there), then ends the
    /// single-run cards it replaces. It stays a summary until every run ends.
    private func mergeIntoSummary(
        instanceID: String,
        deviceID: String?,
        machineName: String,
        others: [Activity<AgentRunActivityAttributes>],
        adding new: (streamID: String, run: SummaryRun)
    ) async {
        let existing = summary(for: instanceID)
        if let existing { rehydrateSummaryRuns(from: existing) }
        // From here on, before the first await, events for these runs land on
        // their summary rows rather than the cards that are ending.
        mergingActivityIDs.formUnion(others.map(\.id))
        defer { mergingActivityIDs.subtract(others.map(\.id)) }
        var runs = summaryRuns[instanceID] ?? [:]
        for other in others {
            runs[other.attributes.streamID ?? other.id] = SummaryRun(
                chatID: other.attributes.sessionID,
                state: state(for: other)
            )
        }
        // A run already on the summary is reattaching: its row keeps what it
        // last showed, and the status that follows brings it up to date.
        if runs[new.streamID] == nil { runs[new.streamID] = new.run }
        summaryRuns[instanceID] = runs
        let summaryState = summaryState(for: instanceID)

        if let existing {
            await summaryThrottle(for: existing).submitUrgent(summaryState)
        } else {
            do {
                let activity = try SummaryActivity.request(
                    attributes: AidenRunsSummaryActivityAttributes(
                        instanceID: instanceID,
                        deviceID: deviceID,
                        machineName: machineName
                    ),
                    content: summaryContent(summaryState),
                    pushType: nil
                )
                summaryThrottle(for: activity).markDelivered(summaryState)
            } catch {
                summaryRuns[instanceID] = nil
                AidenDiagnostics.record(.liveActivity, event: .liveActivityFailed, outcome: .degraded, code: .unavailable)
                return
            }
        }

        for other in others {
            let state = state(for: other)
            discardThrottle(for: other.id)
            await other.end(content(for: state), dismissalPolicy: .immediate)
            stateByActivityID[other.id] = nil
            if currentActivity?.id == other.id { currentActivity = nil }
        }
    }

    private func updateSummaryRun(
        instanceID: String,
        streamID: String,
        urgency: UpdateUrgency,
        transform: (ContentState) -> ContentState
    ) async {
        guard let summary = summary(for: instanceID) else {
            summaryRuns[instanceID] = nil
            return
        }
        rehydrateSummaryRuns(from: summary)
        guard var run = summaryRuns[instanceID]?[streamID] else { return }
        run.state = transform(run.state)
        summaryRuns[instanceID]?[streamID] = run
        let state = summaryState(for: instanceID)
        if state.rows.allSatisfy(\.isFinal) {
            await endSummary(summary, state: state, dismissalPolicy: .after(Date().addingTimeInterval(300)))
            return
        }
        switch urgency {
        case .coalesced:
            await summaryThrottle(for: summary).submit(state)
        case .immediate:
            await summaryThrottle(for: summary).submitUrgent(state)
        }
    }

    /// After a relaunch the summary's rows are all that's left of its runs.
    private func rehydrateSummaryRuns(from summary: SummaryActivity) {
        let instanceID = summary.attributes.instanceID
        guard summaryRuns[instanceID]?.isEmpty != false else { return }
        var runs: [String: SummaryRun] = [:]
        for row in summary.content.state.rows {
            var state = AgentRunActivityStateReducer.initialState(
                sessionID: row.chatID,
                sessionTitle: row.title,
                startedAt: row.updatedAt
            )
            state.status = row.status
            state.updatedAt = row.updatedAt
            state.isFinal = row.isFinal
            runs[row.streamID] = SummaryRun(chatID: row.chatID, state: state)
        }
        summaryRuns[instanceID] = runs
    }

    private func summaryState(for instanceID: String) -> SummaryState {
        let rows = (summaryRuns[instanceID] ?? [:]).map { streamID, run in
            AidenRunsSummaryActivityAttributes.Row(
                streamID: streamID,
                chatID: run.chatID,
                title: run.state.sessionTitle,
                status: run.state.status,
                updatedAt: run.state.updatedAt,
                isFinal: run.state.isFinal
            )
        }
        return SummaryState(rows: AidenRunsSummaryPolicy.ordered(rows))
    }

    private func endSummary(
        _ summary: SummaryActivity,
        state: SummaryState,
        dismissalPolicy: ActivityUIDismissalPolicy
    ) async {
        summaryThrottleByID.removeValue(forKey: summary.id)?.cancel()
        summaryRuns[summary.attributes.instanceID] = nil
        await summary.end(summaryContent(state), dismissalPolicy: dismissalPolicy)
    }

    private func summaryThrottle(for activity: SummaryActivity) -> AidenLatestValueThrottle<SummaryState> {
        if let existing = summaryThrottleByID[activity.id] { return existing }
        let throttle = AidenLatestValueThrottle<SummaryState>(
            interval: Self.coalescedUpdateInterval
        ) { [weak self, weak activity] state in
            guard let self, let activity, self.isLive(activity) else { return }
            await activity.update(self.summaryContent(state))
        }
        summaryThrottleByID[activity.id] = throttle
        return throttle
    }

    private func update(
        instanceID: String,
        streamID: String,
        urgency: UpdateUrgency = .coalesced,
        transform: (ContentState) -> ContentState
    ) async {
        guard let activity = activity(instanceID: instanceID, streamID: streamID), isLive(activity) else {
            await updateSummaryRun(instanceID: instanceID, streamID: streamID, urgency: urgency, transform: transform)
            return
        }
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
           isLive(currentActivity),
           !mergingActivityIDs.contains(currentActivity.id) {
            return currentActivity
        }
        return systemActivities.first {
            Self.matches($0.attributes, instanceID: instanceID, streamID: streamID)
                && isLive($0)
                && !mergingActivityIDs.contains($0.id)
        }
    }

    private func isLive<Attributes: ActivityAttributes>(_ activity: Activity<Attributes>) -> Bool {
        activity.activityState == .active || activity.activityState == .stale
    }

    private func summaryContent(_ state: SummaryState) -> ActivityContent<SummaryState> {
        ActivityContent(state: state, staleDate: AidenRunsSummaryPolicy.staleDate(state))
    }

    private func content(for state: AgentRunActivityAttributes.ContentState) -> ActivityContent<AgentRunActivityAttributes.ContentState> {
        ActivityContent(state: state, staleDate: AgentRunFreshness.staleDate(for: state))
    }
}
