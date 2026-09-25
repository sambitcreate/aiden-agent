import Accessibility
import SwiftUI

/// Small pure presentation helpers keep the compact composer controls and
/// their tests independent from the network lifecycle.
enum AidenProgressPresentation {
    /// Snapshot revisions are authoritative within an epoch. Equal revisions
    /// are duplicates, so a late response cannot replace an already accepted
    /// snapshot even when it belongs to another turn.
    static func acceptsSnapshot(
        currentEpoch: String?,
        currentRevision: Int?,
        incomingEpoch: String,
        incomingRevision: Int
    ) -> Bool {
        guard let currentEpoch, let currentRevision else { return true }
        return currentEpoch != incomingEpoch || incomingRevision > currentRevision
    }

    static func visibleTasks(_ progress: AidenRemoteChatTaskProgress?) -> [AidenRemoteChatTask] {
        progress?.tasks.filter { $0.status != .deleted } ?? []
    }

    static func completedTaskCount(_ progress: AidenRemoteChatTaskProgress?) -> Int {
        visibleTasks(progress).filter { $0.status == .completed }.count
    }

    static func remainingTaskCount(_ progress: AidenRemoteChatTaskProgress?) -> Int {
        visibleTasks(progress).filter { $0.status != .completed }.count
    }

    static func showsTaskChip(_ progress: AidenRemoteChatTaskProgress?) -> Bool {
        remainingTaskCount(progress) > 0
    }

    static func transitionedToAllTasksCompleted(
        previous: AidenRemoteChatTaskProgress?,
        current: AidenRemoteChatTaskProgress?
    ) -> Bool {
        guard let previous,
              let current,
              previous.isAvailable,
              current.isAvailable,
              remainingTaskCount(previous) > 0,
              !visibleTasks(current).isEmpty else { return false }
        return remainingTaskCount(current) == 0
    }

    static func activeTask(_ progress: AidenRemoteChatTaskProgress?) -> AidenRemoteChatTask? {
        progress?.tasks.first { $0.status == .inProgress }
    }

    static func activeAgentCount(_ roster: AidenRemoteChatAgentRoster?) -> Int {
        roster?.agents.filter { !$0.state.isTerminal }.count ?? 0
    }

    static func showsAgentChip(_ roster: AidenRemoteChatAgentRoster?) -> Bool {
        guard let roster else { return false }
        if !roster.isAvailable {
            return roster.unavailableReason != .unsupported
        }
        // Retained earlier turns must remain inspectable rather than hiding
        // the surface entirely.
        return !roster.agents.isEmpty || !roster.previousTurns.isEmpty
    }

    static func agentGroups(
        _ roster: AidenRemoteChatAgentRoster?
    ) -> [(title: String, agents: [AidenRemoteChatAgent])] {
        guard let roster, roster.isAvailable else { return [] }
        let activeStates: Set<AidenRemoteChatAgentState> = [
            .queued, .starting, .running,
        ]
        let attentionStates: Set<AidenRemoteChatAgentState> = [.needsAttention]
        let active = roster.agents.filter { activeStates.contains($0.state) }
        let attention = roster.agents.filter { attentionStates.contains($0.state) }
        let finished = roster.agents.filter { !activeStates.contains($0.state) && !attentionStates.contains($0.state) }
        return [
            (String(localized: "Working"), active),
            (String(localized: "Needs attention"), attention),
            (String(localized: "Finished"), finished),
        ].filter { !$0.agents.isEmpty }
    }
}

struct AidenChatProgressControls: View {
    @Environment(\.aidenPalette) private var palette

    let taskProgress: AidenRemoteChatTaskProgress?
    let agentRoster: AidenRemoteChatAgentRoster?
    let canReadTasks: Bool
    let canReadAgents: Bool
    let taskIsStale: Bool
    let agentIsStale: Bool
    let openTasks: () -> Void
    let openAgents: () -> Void

    var body: some View {
        Group {
            if (canReadTasks && taskProgress?.isAvailable == true
                && AidenProgressPresentation.showsTaskChip(taskProgress))
                || (canReadTasks && showsUnavailableTaskChip)
                || (canReadAgents && AidenProgressPresentation.showsAgentChip(agentRoster)) {
                HStack(spacing: 8) {
                    if let taskProgress,
                       canReadTasks,
                       taskProgress.isAvailable,
                       AidenProgressPresentation.showsTaskChip(taskProgress) {
                        Button(action: openTasks) {
                            AidenProgressChipLabel(
                                systemImage: "checklist",
                                title: taskTitle(taskProgress),
                                stale: taskIsStale
                            )
                        }
                        .accessibilityLabel(Text(taskAccessibilityLabel(taskProgress)))
                        .accessibilityHint(Text("Opens task progress"))
                        .buttonStyle(.plain)
                    } else if showsUnavailableTaskChip {
                        // An unavailable projection keeps a reachable affordance
                        // so the sheet can explain why; unsupported servers stay
                        // hidden entirely.
                        Button(action: openTasks) {
                            AidenProgressChipLabel(
                                systemImage: "checklist",
                                title: String(localized: "Tasks unavailable"),
                                stale: taskIsStale
                            )
                        }
                        .accessibilityLabel(Text("Task progress unavailable"))
                        .accessibilityHint(Text("Opens task progress details"))
                        .buttonStyle(.plain)
                    }
                    if let agentRoster, canReadAgents, AidenProgressPresentation.showsAgentChip(agentRoster) {
                        Button(action: openAgents) {
                            AidenProgressChipLabel(
                                systemImage: "person.2",
                                title: agentTitle(agentRoster),
                                stale: agentIsStale
                            )
                        }
                        .accessibilityLabel(Text(agentAccessibilityLabel(agentRoster)))
                        .accessibilityHint(Text("Opens delegated agents"))
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 6)
            }
        }
        .onChange(of: taskProgress) { previous, current in
            guard AidenProgressPresentation.transitionedToAllTasksCompleted(
                previous: previous,
                current: current
            ) else { return }
            AccessibilityNotification.Announcement(
                String(localized: "All tasks completed")
            ).post()
        }
    }

    private var showsUnavailableTaskChip: Bool {
        guard let taskProgress, !taskProgress.isAvailable else { return false }
        return taskProgress.unavailableReason != .unsupported
    }

    private func taskTitle(_ progress: AidenRemoteChatTaskProgress) -> String {
        if let active = AidenProgressPresentation.activeTask(progress) {
            let tasks = AidenProgressPresentation.visibleTasks(progress)
            let index = tasks.firstIndex(where: { $0.id == active.id }).map { $0 + 1 } ?? 1
            return String(localized: "Step \(index) of \(tasks.count) · \(active.activeForm ?? active.subject)")
        }
        return String(localized: "Tasks \(AidenProgressPresentation.completedTaskCount(progress))/\(AidenProgressPresentation.visibleTasks(progress).count)")
    }

    private func agentTitle(_ roster: AidenRemoteChatAgentRoster) -> String {
        if !roster.isAvailable {
            return String(localized: "Agents unavailable")
        }
        let active = AidenProgressPresentation.activeAgentCount(roster)
        if roster.agents.isEmpty, !roster.previousTurns.isEmpty {
            return String(localized: "Earlier agents")
        }
        return active > 0
            ? String(localized: "Agents \(active) active")
            : String(localized: "Agents \(roster.agents.count)")
    }

    private func taskAccessibilityLabel(_ progress: AidenRemoteChatTaskProgress) -> String {
        String(localized: "Task progress: \(AidenProgressPresentation.completedTaskCount(progress)) of \(AidenProgressPresentation.visibleTasks(progress).count) completed")
    }

    private func agentAccessibilityLabel(_ roster: AidenRemoteChatAgentRoster) -> String {
        if !roster.isAvailable {
            return String(localized: "Delegated-agent status unavailable")
        }
        if roster.agents.isEmpty, !roster.previousTurns.isEmpty {
            return String(localized: "Earlier delegated agents: \(roster.previousTurns.count) turns available")
        }
        return String(localized: "Delegated agents: \(AidenProgressPresentation.activeAgentCount(roster)) active, \(roster.agents.count) total")
    }
}

private struct AidenProgressChipLabel: View {
    @Environment(\.aidenPalette) private var palette

    let systemImage: String
    let title: String
    let stale: Bool

    var body: some View {
        Label {
            HStack(spacing: 4) {
                Text(title)
                    .lineLimit(1)
                if stale {
                    Text("· Last known")
                        .foregroundStyle(palette.secondary)
                }
            }
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(palette.accent)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(palette.foreground)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(palette.raised, in: Capsule())
        .contentShape(Capsule())
    }
}

enum AidenProgressSheet: String, Identifiable {
    case tasks
    case agents

    var id: String { rawValue }
}

struct AidenChatProgressSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    let kind: AidenProgressSheet
    let model: AidenChatViewModel
    @State private var selectedTurnId: String?
    @State private var isScrolledAwayFromTaskLatest = false

    var body: some View {
        NavigationStack {
            Group {
                switch kind {
                case .tasks:
                    taskList
                case .agents:
                    agentList
                }
            }
            .navigationTitle(kind == .tasks ? "Task progress" : "Delegated agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var taskList: some View {
        if !model.canReadTaskProgress {
            AidenProgressUnavailableView(text: "Task progress is unavailable for this connection.")
        } else if let progress = model.taskProgress, progress.isAvailable {
            let tasks = AidenProgressPresentation.visibleTasks(progress)
            ScrollViewReader { proxy in
                List {
                    Section {
                        ForEach(tasks) { task in
                            AidenTaskProgressRow(task: task)
                                .id(task.id)
                        }
                    } header: {
                        Text("\(AidenProgressPresentation.completedTaskCount(progress)) of \(tasks.count) completed")
                    } footer: {
                        if model.isTaskProgressStale {
                            Text("Last known progress")
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .defaultScrollAnchor(AidenChatScrollPolicy.initialTranscriptAnchor, for: .initialOffset)
                .defaultScrollAnchor(
                    AidenChatScrollPolicy.sizeChangeAnchor(shouldFollowLatest: !isScrolledAwayFromTaskLatest),
                    for: .sizeChanges
                )
                .onScrollGeometryChange(for: AidenScrollFollowGeometry.self) { geometry in
                    AidenScrollFollowGeometry(
                        isAwayFromLatest: aidenChatIsScrolledAwayFromLatest(
                            contentOffsetY: geometry.contentOffset.y,
                            containerHeight: geometry.containerSize.height,
                            contentHeight: geometry.contentSize.height,
                            bottomInset: geometry.contentInsets.bottom
                        ),
                        contentHeight: geometry.contentSize.height
                    )
                } action: { previous, next in
                    isScrolledAwayFromTaskLatest = AidenChatScrollPolicy.shouldTreatAsScrolledAway(
                        wasScrolledAway: isScrolledAwayFromTaskLatest,
                        isAwayFromLatest: next.isAwayFromLatest,
                        contentGrew: next.contentHeight > previous.contentHeight
                    )
                }
                .onAppear {
                    if let anchorID = AidenChatScrollPolicy.taskListAnchorID(tasks) {
                        proxy.scrollTo(anchorID, anchor: .bottom)
                    }
                    isScrolledAwayFromTaskLatest = false
                }
                .onChange(of: AidenChatScrollPolicy.taskListFollowKey(tasks)) { _, _ in
                    guard AidenChatScrollPolicy.shouldPinTaskListAfterGrowth(wasFollowingLatest: !isScrolledAwayFromTaskLatest) else {
                        return
                    }
                    if let anchorID = AidenChatScrollPolicy.taskListAnchorID(tasks) {
                        proxy.scrollTo(anchorID, anchor: .bottom)
                    }
                }
            }
        } else {
            AidenProgressUnavailableView(text: taskUnavailableMessage)
        }
    }

    private var taskUnavailableMessage: String {
        guard let reason = model.taskProgress?.unavailableReason else {
            return "Task progress is unavailable for this chat."
        }
        return taskUnavailableReason(reason)
    }

    private func taskUnavailableReason(_ reason: AidenRemoteChatTaskUnavailableReason) -> String {
        switch reason {
        case .storageNotEnabled:
            "Task tracking is turned off for this workspace."
        case .invalidSnapshot:
            "The Mac could not read a valid task snapshot."
        case .unsupported:
            "Task tracking is unavailable on this Aiden Agent."
        }
    }

    private func rosterUnavailableMessage(_ roster: AidenRemoteChatAgentRoster?) -> String {
        if let reason = roster?.unavailableReason {
            switch reason {
            case .invalidSnapshot:
                return String(localized: "Agent progress is temporarily unavailable.")
            case .unsupported:
                return String(localized: "Delegated-agent status is unavailable on this Aiden Agent.")
            }
        }
        return roster?.previousTurns.isEmpty == false
            ? String(localized: "No delegated agents are available in this turn. Choose an earlier turn to inspect its roster.")
            : String(localized: "No delegated agents are available for this chat.")
    }

    @ViewBuilder
    private var agentList: some View {
        if !model.canReadAgentRoster {
            AidenProgressUnavailableView(text: "Delegated-agent status is unavailable for this connection.")
        } else {
            let roster = model.agentRoster(for: selectedTurnId)
            VStack(spacing: 0) {
                Text("Read-only status from the Mac. Private child transcripts stay on the Mac.")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.top, 10)
                if model.availableAgentTurnIds.count > 1 {
                    Picker("Turn", selection: Binding(
                        get: { selectedTurnId ?? model.currentAgentTurnId ?? "" },
                        set: { value in
                            selectedTurnId = value.isEmpty ? nil : value
                            if !value.isEmpty {
                                Task { await model.loadAgentRoster(turnId: value) }
                            }
                        }
                    )) {
                        Text("Most recent turn").tag(model.currentAgentTurnId ?? "")
                        ForEach(model.availableAgentTurnIds.filter { $0 != model.currentAgentTurnId }, id: \.self) { turnId in
                            Text(model.turnLabel(turnId)).tag(turnId)
                        }
                    }
                    .pickerStyle(.menu)
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                    .accessibilityHint(Text("Choose a turn to view its agent roster"))
                }
                if let roster, roster.isAvailable, !roster.agents.isEmpty {
                    List {
                        ForEach(AidenProgressPresentation.agentGroups(roster), id: \.title) { group in
                            Section(group.title) {
                                ForEach(group.agents) { agent in
                                    NavigationLink(value: agent.agentId) {
                                        AidenAgentRosterRow(agent: agent)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .navigationDestination(for: String.self) { agentId in
                        if let agent = roster.agents.first(where: { $0.agentId == agentId }) {
                            AidenAgentDetailView(agent: agent)
                        } else {
                            AidenProgressUnavailableView(text: "This agent is no longer in the selected roster.")
                        }
                    }
                } else {
                    AidenProgressUnavailableView(text: rosterUnavailableMessage(roster))
                }
            }
        }
    }
}

private struct AidenTaskProgressRow: View {
    @Environment(\.aidenPalette) private var palette
    let task: AidenRemoteChatTask

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .foregroundStyle(iconColor)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.subject)
                    .font(.body)
                if let activeForm = task.activeForm, task.status == .inProgress {
                    Text(activeForm)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                }
                if let blockedBy = task.blockedBy, !blockedBy.isEmpty {
                    Text(String(localized: "Blocked by step \(blockedBy.map(String.init).joined(separator: ", "))"))
                        .font(.caption)
                        .foregroundStyle(palette.warning)
                }
                Text(statusLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(task.subject), \(statusLabel)"))
    }

    private var statusLabel: String {
        switch task.status {
        case .pending: "Pending"
        case .inProgress: "In progress"
        case .completed: "Completed"
        case .deleted: "Deleted"
        }
    }

    private var iconName: String {
        switch task.status {
        case .pending: "circle"
        case .inProgress: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .deleted: "minus.circle"
        }
    }

    private var iconColor: Color {
        switch task.status {
        case .pending: palette.secondary
        case .inProgress: palette.accent
        case .completed: palette.success
        case .deleted: palette.secondary
        }
    }
}

private struct AidenAgentRosterRow: View {
    @Environment(\.aidenPalette) private var palette
    let agent: AidenRemoteChatAgent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .foregroundStyle(statusColor)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.label)
                    .font(.body.weight(.medium))
                Text(agent.taskPreview)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(stateLabel)
                    if let activity = agent.activity {
                        Text("·")
                        Text(activity)
                    }
                }
                .font(.caption)
                .foregroundStyle(palette.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(agent.label), \(stateLabel)"))
        .accessibilityHint(Text("Opens agent details"))
    }

    private var stateLabel: String {
        switch agent.state {
        case .queued: "Queued"
        case .starting: "Starting"
        case .running: "Running"
        case .needsAttention: "Needs attention"
        case .completed: "Completed"
        case .failed: "Failed"
        case .timedOut: "Timed out"
        case .interrupted: "Interrupted"
        case .stopped: "Stopped"
        case .unknown: "Unknown"
        }
    }

    private var iconName: String {
        switch agent.state {
        case .queued: "clock"
        case .starting, .running: "person.crop.circle"
        case .needsAttention: "exclamationmark.circle"
        case .completed: "checkmark.circle"
        case .failed: "xmark.circle"
        case .timedOut: "clock.badge.exclamationmark"
        case .interrupted, .stopped: "stop.circle"
        case .unknown: "questionmark.circle"
        }
    }

    private var statusColor: Color {
        switch agent.state {
        case .running, .starting, .queued: palette.accent
        case .needsAttention, .failed, .timedOut: palette.warning
        case .completed: palette.success
        case .interrupted, .stopped, .unknown: palette.secondary
        }
    }
}

private struct AidenAgentDetailView: View {
    @Environment(\.aidenPalette) private var palette
    let agent: AidenRemoteChatAgent

    var body: some View {
        List {
            Section("Assignment") {
                LabeledContent("Role", value: roleLabel)
                LabeledContent("Status", value: stateLabel)
                LabeledContent("Task", value: agent.taskPreview)
                if let activity = agent.activity {
                    LabeledContent("Activity", value: activity)
                }
            }
            Section("Run") {
                LabeledContent("Started", value: agent.startedAt.date.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Updated", value: agent.updatedAt.date.formatted(date: .abbreviated, time: .shortened))
                if let finishedAt = agent.finishedAt {
                    LabeledContent("Finished", value: finishedAt.date.formatted(date: .abbreviated, time: .shortened))
                }
                LabeledContent("Model", value: agent.modelId)
                LabeledContent("Depth", value: String(agent.depth))
            }
            Section("Usage") {
                LabeledContent("Turns", value: String(agent.turns))
                LabeledContent("Tools", value: String(agent.tools))
                LabeledContent("Tokens", value: String(agent.tokens))
            }
            if let milestones = agent.milestones, !milestones.isEmpty {
                Section("Milestones") {
                    Text(milestones.map { $0.rawValue.capitalized }.joined(separator: " · "))
                }
            }
            if let notices = agent.notices, !notices.isEmpty {
                Section("Notices") {
                    Text(notices.map { $0.rawValue.replacingOccurrences(of: "_", with: " ").capitalized }.joined(separator: " · "))
                        .foregroundStyle(palette.warning)
                }
            }
            // Raw error/warning strings can carry private child-run text; like
            // Android, they are decoded for contract tolerance but never shown.
        }
        .listStyle(.insetGrouped)
        .navigationTitle(agent.label)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var roleLabel: String { agent.role.rawValue.capitalized }

    private var stateLabel: String {
        agent.state.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

private struct AidenProgressUnavailableView: View {
    @Environment(\.aidenPalette) private var palette
    let text: String

    var body: some View {
        ContentUnavailableView {
            Label("Progress unavailable", systemImage: "chart.bar.xaxis")
        } description: {
            Text(text)
        }
        .foregroundStyle(palette.secondary)
    }
}
