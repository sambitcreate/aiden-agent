import CryptoKit
import Foundation
import Observation
import SwiftUI

struct AidenScheduledTaskAccess: Equatable, Sendable {
    let canRead: Bool
    let canWrite: Bool

    static let unavailable = Self(canRead: false, canWrite: false)

    static func resolve(
        installation: AidenInstallation?,
        instanceId: String,
        deviceId: String,
        isCurrent: Bool
    ) -> Self {
        guard isCurrent,
              let installation,
              installation.instanceId == instanceId,
              installation.deviceId == deviceId else { return .unavailable }
        return Self(
            canRead: installation.hasNegotiatedAccess(to: .scheduleRead),
            canWrite: installation.hasNegotiatedAccess(to: .scheduleWrite)
        )
    }
}

actor AidenScheduledTaskCache {
    static let shared = AidenScheduledTaskCache()

    struct Snapshot: Codable, Sendable {
        let instanceId: String
        var tasks: [AidenScheduledTask]
        var settings: AidenScheduledSettings?
        var runs: [String: [AidenScheduledRun]]
    }

    private let root: URL
    private let fileManager: FileManager
    private let maximumBytes = 10 * 1_024 * 1_024

    init(root: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        if let root {
            self.root = root
        } else {
            let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            self.root = support
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
                .appending(path: "RemoteScheduledTaskCache-v1", directoryHint: .isDirectory)
        }
    }

    func load(instanceId: String) -> Snapshot? {
        let url = file(instanceId: instanceId)
        guard let data = try? Data(contentsOf: url), data.count <= maximumBytes,
              let value = try? JSONDecoder().decode(Snapshot.self, from: data),
              value.instanceId == instanceId else { return nil }
        return value
    }

    func store(
        instanceId: String,
        tasks: [AidenScheduledTask],
        settings: AidenScheduledSettings?
    ) throws {
        let retainedTaskIDs = Set(tasks.map(\.id))
        let retainedRuns = (load(instanceId: instanceId)?.runs ?? [:]).filter {
            retainedTaskIDs.contains($0.key)
        }
        try persist(Snapshot(instanceId: instanceId, tasks: tasks, settings: settings, runs: retainedRuns))
    }

    func store(runs: [AidenScheduledRun], taskId: String, instanceId: String) throws {
        guard var snapshot = load(instanceId: instanceId),
              snapshot.tasks.contains(where: { $0.id == taskId }) else { return }
        snapshot.runs[taskId] = Array(runs.prefix(50))
        try persist(snapshot)
    }

    func purge(instanceId: String) {
        try? fileManager.removeItem(at: file(instanceId: instanceId))
    }

    private func persist(_ snapshot: Snapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        guard data.count <= maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        let url = file(instanceId: snapshot.instanceId)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func file(instanceId: String) -> URL {
        let digest = SHA256.hash(data: Data(instanceId.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return root.appending(path: "\(digest).json")
    }
}

@MainActor
@Observable
final class AidenScheduledTasksModel {
    private let coordinator: AidenRemoteCoordinator
    private let cache: AidenScheduledTaskCache
    private let activationContext: AidenRemoteRequestContext?
    private var pendingRunKeys: [String: UUID] = [:]
    private let hapticScope = UUID()
    private var taskStorage: [AidenScheduledTask] = []
    private var settingsStorage: AidenScheduledSettings?
    private(set) var catalog: AidenModelCatalog?
    private(set) var scripts: [AidenScheduledScript] = []
    private(set) var mcpServers: [AidenScheduledMcpServer] = []
    private(set) var hasCurrentMcpInventory = false
    private(set) var isLoading = false
    private(set) var isMutating = false
    var presentedError: String?
    var outcomeMessage: String?

    init(
        coordinator: AidenRemoteCoordinator,
        cache: AidenScheduledTaskCache = .shared
    ) {
        self.coordinator = coordinator
        self.cache = cache
        activationContext = try? coordinator.requestContext()
    }

    var isConnected: Bool {
        coordinator.connectionState == .connected
            && activationContext.map(coordinator.isCurrent) == true
    }
    var canReadSchedules: Bool { currentAccess.canRead }
    var canWriteSchedules: Bool { currentAccess.canWrite }
    var canManageSchedules: Bool { canReadSchedules && canWriteSchedules }
    var tasks: [AidenScheduledTask] { canReadSchedules ? taskStorage : [] }
    var settings: AidenScheduledSettings? { canReadSchedules ? settingsStorage : nil }
    var workspaces: [AidenWorkspace] {
        guard canManageSchedules else { return [] }
        return coordinator.workspaces.filter { $0.permission != .none }
    }

    private var currentAccess: AidenScheduledTaskAccess {
        guard let activationContext else { return .unavailable }
        return access(for: activationContext)
    }

    private func access(for context: AidenRemoteRequestContext) -> AidenScheduledTaskAccess {
        AidenScheduledTaskAccess.resolve(
            installation: coordinator.installationStore.activeInstallation,
            instanceId: context.instanceId,
            deviceId: context.deviceId,
            isCurrent: coordinator.isCurrent(context)
        )
    }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func reconcileAccess() async {
        guard let context = try? requestContext() else {
            clearReadProtectedState()
            return
        }
        let current = access(for: context)
        guard current.canRead else {
            clearReadProtectedState()
            await cache.purge(instanceId: context.instanceId)
            return
        }
        if !current.canWrite {
            catalog = nil
            scripts = []
            mcpServers = []
            hasCurrentMcpInventory = false
        }
    }

    private func requestContext() throws -> AidenRemoteRequestContext {
        guard let activationContext, coordinator.isCurrent(activationContext) else {
            throw AidenRemoteClientError.installationChanged
        }
        return activationContext
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        guard let context = try? requestContext() else { return }
        let instanceId = context.instanceId
        guard access(for: context).canRead else {
            clearReadProtectedState()
            await cache.purge(instanceId: instanceId)
            return
        }
        if tasks.isEmpty, let cached = await cache.load(instanceId: instanceId) {
            guard access(for: context).canRead else {
                clearReadProtectedState()
                await cache.purge(instanceId: instanceId)
                return
            }
            taskStorage = cached.tasks.sorted(by: Self.sort)
            settingsStorage = cached.settings
        }
        guard isConnected else { return }
        do {
            let client = try coordinator.remoteClient(for: context)
            async let loadedTasks = client.scheduledTasks()
            async let loadedSettings = client.scheduledSettings()
            let values = try await (loadedTasks, loadedSettings)
            guard access(for: context).canRead else {
                clearReadProtectedState()
                await cache.purge(instanceId: instanceId)
                return
            }
            taskStorage = values.0.sorted(by: Self.sort)
            settingsStorage = values.1
            if access(for: context).canWrite {
                mcpServers = []
                hasCurrentMcpInventory = false
                async let loadedCatalog = client.modelCatalog()
                async let loadedMcpServers = client.scheduledMcpServers()
                let editorValues = try await (loadedCatalog, loadedMcpServers)
                guard access(for: context).canRead,
                      access(for: context).canWrite else {
                    catalog = nil
                    mcpServers = []
                    hasCurrentMcpInventory = false
                    try? await cache.store(
                        instanceId: instanceId,
                        tasks: taskStorage,
                        settings: settingsStorage
                    )
                    return
                }
                catalog = editorValues.0
                mcpServers = editorValues.1
                hasCurrentMcpInventory = true
            } else {
                catalog = nil
                mcpServers = []
                hasCurrentMcpInventory = false
                scripts = []
            }
            try? await cache.store(
                instanceId: instanceId,
                tasks: taskStorage,
                settings: settingsStorage
            )
            presentedError = nil
        } catch {
            guard access(for: context).canRead else {
                clearReadProtectedState()
                await cache.purge(instanceId: instanceId)
                return
            }
            mcpServers = []
            hasCurrentMcpInventory = false
            presentedError = error.localizedDescription
        }
    }

    func loadScripts(workspaceId: String?) async {
        guard let context = try? requestContext() else { return }
        guard access(for: context).canRead, access(for: context).canWrite else {
            scripts = []
            presentedError = String(localized: "Schedule write access is required to load task scripts.")
            return
        }
        do {
            let loaded = try await coordinator.remoteClient(for: context).scheduledScripts(workspaceId: workspaceId)
            guard access(for: context).canRead, access(for: context).canWrite else {
                scripts = []
                return
            }
            scripts = loaded
        } catch {
            guard coordinator.isCurrent(context) else { return }
            scripts = []
            presentedError = error.localizedDescription
        }
    }

    func preview(_ draft: AidenScheduledTaskDraft) async throws -> [Date] {
        let context = try requestContext()
        guard access(for: context).canRead, access(for: context).canWrite else {
            throw AidenScheduledTaskAccessError.writeRequired
        }
        let result = try await coordinator.remoteClient(for: context).previewSchedule(
            cron: draft.schedule.trimmingCharacters(in: .whitespacesAndNewlines),
            timezone: draft.timezone.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        guard access(for: context).canRead, access(for: context).canWrite else {
            throw AidenRemoteClientError.installationChanged
        }
        return result
    }

    func save(_ draft: AidenScheduledTaskDraft, replacing task: AidenScheduledTask?) async -> Bool {
        guard draft.reviewValidationMessage(
            replacing: task,
            currentMcpServers: hasCurrentMcpInventory ? mcpServers : nil
        ) == nil, !isMutating, isConnected else {
            if task?.usesLegacyInheritedMcpAccess == true, !hasCurrentMcpInventory {
                presentedError = String(localized: "Refresh the enabled MCP server inventory before editing this legacy task.")
            }
            return false
        }
        guard canManageSchedules else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        isMutating = true
        defer { isMutating = false }
        guard let context = try? requestContext() else { return false }
        guard access(for: context).canRead, access(for: context).canWrite else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        do {
            let client = try coordinator.remoteClient(for: context)
            let saved = if let task {
                try await client.updateScheduledTask(id: task.id, revision: task.revision, mutation: draft.mutation)
            } else {
                try await client.createScheduledTask(draft.mutation)
            }
            guard access(for: context).canRead, access(for: context).canWrite else {
                presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
                await load()
                return false
            }
            upsert(saved)
            outcomeMessage = task == nil ? String(localized: "Scheduled task created.") : String(localized: "Scheduled task updated.")
            coordinator.haptics.play(
                .success,
                scope: hapticScope,
                dedupeKey: "scheduled-save:\(saved.id):\(saved.revision)"
            )
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            guard coordinator.isCurrent(context) else { return false }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
            return false
        }
    }

    func pauseOrResume(_ task: AidenScheduledTask) async {
        await mutate(successEvent: .selection) {
            task.enabled
                ? try await $0.pauseScheduledTask(id: task.id, revision: task.revision)
                : try await $0.resumeScheduledTask(id: task.id, revision: task.revision)
        }
    }

    func remove(_ task: AidenScheduledTask) async -> Bool {
        guard !isMutating, isConnected else { return false }
        guard canManageSchedules else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        isMutating = true
        defer { isMutating = false }
        guard let context = try? requestContext() else { return false }
        guard access(for: context).canRead, access(for: context).canWrite else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        do {
            try await coordinator.remoteClient(for: context).removeScheduledTask(id: task.id, revision: task.revision)
            guard access(for: context).canRead, access(for: context).canWrite else {
                await load()
                return false
            }
            taskStorage.removeAll { $0.id == task.id }
            try? await cache.store(
                instanceId: context.instanceId,
                tasks: taskStorage,
                settings: settingsStorage
            )
            coordinator.haptics.play(
                .success,
                scope: hapticScope,
                dedupeKey: "scheduled-remove:\(task.id):\(task.revision)"
            )
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            guard coordinator.isCurrent(context) else { return false }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
            return false
        }
    }

    func run(_ task: AidenScheduledTask) async {
        guard !isMutating, isConnected else { return }
        guard canManageSchedules else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return
        }
        isMutating = true
        defer { isMutating = false }
        let key = pendingRunKeys[task.id] ?? UUID()
        pendingRunKeys[task.id] = key
        guard let context = try? requestContext() else { return }
        guard access(for: context).canRead, access(for: context).canWrite else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return
        }
        do {
            let accepted = try await coordinator.remoteClient(for: context).runScheduledTask(
                id: task.id,
                revision: task.revision,
                idempotencyKey: key
            )
            guard access(for: context).canRead, access(for: context).canWrite else {
                await load()
                return
            }
            pendingRunKeys[task.id] = nil
            outcomeMessage = String(localized: "Run accepted (\(accepted.runId.prefix(12))…). It continues on your paired desktop if this phone disconnects.")
            coordinator.haptics.play(
                .actionStarted,
                scope: hapticScope,
                dedupeKey: "scheduled-run:\(task.id):\(key.uuidString)"
            )
            await load()
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            guard coordinator.isCurrent(context) else { return }
            if !Self.isAmbiguous(error) { pendingRunKeys[task.id] = nil }
            presentedError = error.localizedDescription
            coordinator.haptics.play(Self.isAmbiguous(error) ? .warning : .error, scope: hapticScope)
        }
    }

    func runs(_ task: AidenScheduledTask) async throws -> [AidenScheduledRun] {
        let context = try requestContext()
        guard access(for: context).canRead else { throw AidenScheduledTaskAccessError.readRequired }
        let instanceId = context.instanceId
        do {
            let values = try await coordinator.remoteClient(for: context).scheduledRuns(taskId: task.id)
            guard access(for: context).canRead else {
                throw AidenRemoteClientError.installationChanged
            }
            try? await cache.store(runs: values, taskId: task.id, instanceId: instanceId)
            return values
        } catch {
            guard access(for: context).canRead else {
                await cache.purge(instanceId: instanceId)
                throw AidenScheduledTaskAccessError.readRequired
            }
            if let retained = await cache.load(instanceId: instanceId)?.runs[task.id] {
                guard access(for: context).canRead else {
                    throw AidenRemoteClientError.installationChanged
                }
                return retained
            }
            guard coordinator.isCurrent(context) else {
                throw AidenRemoteClientError.installationChanged
            }
            throw error
        }
    }

    func updateSettings(_ mutation: AidenScheduledSettingsMutation) async -> Bool {
        guard let settings, !isMutating, isConnected else { return false }
        guard canManageSchedules else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        isMutating = true
        defer { isMutating = false }
        guard let context = try? requestContext() else { return false }
        guard access(for: context).canRead, access(for: context).canWrite else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return false
        }
        do {
            let updated = try await coordinator.remoteClient(for: context).updateScheduledSettings(
                revision: settings.revision,
                mutation: mutation
            )
            guard access(for: context).canRead, access(for: context).canWrite else {
                await load()
                return false
            }
            settingsStorage = updated
            try? await cache.store(instanceId: context.instanceId, tasks: taskStorage, settings: updated)
            coordinator.haptics.play(
                .success,
                scope: hapticScope,
                dedupeKey: "scheduled-settings:\(updated.revision)"
            )
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            guard coordinator.isCurrent(context) else { return false }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
            return false
        }
    }

    private func mutate(
        successEvent: AidenHapticEvent = .success,
        _ operation: (AidenRemoteClient) async throws -> AidenScheduledTask
    ) async {
        guard !isMutating, isConnected, let context = try? requestContext() else { return }
        guard access(for: context).canRead, access(for: context).canWrite else {
            presentedError = AidenScheduledTaskAccessError.writeRequired.localizedDescription
            return
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let updated = try await operation(coordinator.remoteClient(for: context))
            guard access(for: context).canRead, access(for: context).canWrite else {
                await load()
                return
            }
            upsert(updated)
            coordinator.haptics.play(
                successEvent,
                scope: hapticScope,
                dedupeKey: "scheduled-mutate:\(updated.id):\(updated.revision)"
            )
        } catch let error where aidenIsCancellation(error) {
            return
        }
        catch {
            guard coordinator.isCurrent(context) else { return }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
        }
    }

    private func upsert(_ task: AidenScheduledTask) {
        guard canManageSchedules else { return }
        taskStorage.removeAll { $0.id == task.id }
        taskStorage.append(task)
        taskStorage.sort(by: Self.sort)
        if let instanceId = activationContext?.instanceId,
           activationContext.map(coordinator.isCurrent) == true {
            let taskSnapshot = taskStorage
            let settingsSnapshot = settingsStorage
            Task {
                try? await cache.store(
                    instanceId: instanceId,
                    tasks: taskSnapshot,
                    settings: settingsSnapshot
                )
            }
        }
    }

    private func clearReadProtectedState() {
        taskStorage = []
        settingsStorage = nil
        catalog = nil
        scripts = []
        mcpServers = []
        hasCurrentMcpInventory = false
        outcomeMessage = nil
    }

    private static func sort(_ left: AidenScheduledTask, _ right: AidenScheduledTask) -> Bool {
        if left.enabled != right.enabled { return left.enabled }
        if left.nextRunAt != right.nextRunAt { return (left.nextRunAt ?? .distantFuture) < (right.nextRunAt ?? .distantFuture) }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }

    private static func isAmbiguous(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let error = error as? AidenRemoteClientError else { return false }
        switch error {
        case .invalidResponse, .unexpectedStatus: return true
        case .server(_, let body): return body.code.rawValue == "idempotency_in_flight" || body.code.rawValue == "internal_error"
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged: return false
        }
    }
}

private enum AidenScheduledTaskAccessError: LocalizedError {
    case readRequired
    case writeRequired

    var errorDescription: String? {
        switch self {
        case .readRequired:
            String(localized: "Schedule read access is required to view tasks and run history.")
        case .writeRequired:
            String(localized: "Schedule write access is required to change scheduled tasks.")
        }
    }
}

struct AidenScheduledTasksView: View {
    private enum TaskFilter: String, CaseIterable {
        case all = "All"
        case active = "Active"
        case paused = "Paused"
        case running = "Running"
    }

    @Environment(\.dismiss) private var dismiss
    @State private var model: AidenScheduledTasksModel
    @State private var editorTask: AidenScheduledTask?
    @State private var isCreating = false
    @State private var isShowingSettings = false
    @State private var searchText = ""
    @State private var filter: TaskFilter = .all

    init(coordinator: AidenRemoteCoordinator) {
        _model = State(initialValue: AidenScheduledTasksModel(coordinator: coordinator))
    }

    private var visibleTasks: [AidenScheduledTask] {
        guard model.canReadSchedules else { return [] }
        return model.tasks.filter { task in
            let matchesFilter = switch filter {
            case .all: true
            case .active: task.enabled
            case .paused: !task.enabled
            case .running: task.running
            }
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            return matchesFilter && (query.isEmpty
                || task.name.localizedCaseInsensitiveContains(query)
                || task.schedule.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Create tasks in any chat")
                                .font(.headline)
                            Text("Ask Aiden in any chat. Aiden proposes the schedule and unattended access for your approval before saving it.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "bubble.left.and.text.bubble.right")
                            .foregroundStyle(.tint)
                    }
                }
                if !model.canReadSchedules {
                    ContentUnavailableView(
                        "Schedule Access Required",
                        systemImage: "lock.shield",
                        description: Text("Enable schedule read access for this paired device on your desktop to view task definitions and cached run history.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    if !model.canWriteSchedules {
                        Section {
                            Label {
                                Text("View only — schedule write access is not granted. You can inspect tasks and run history, but changes are disabled.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            } icon: {
                                Image(systemName: "eye")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section {
                        Picker("Filter", selection: $filter) {
                            ForEach(TaskFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                    if let message = model.outcomeMessage {
                        Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if model.tasks.isEmpty && !model.isLoading {
                        ContentUnavailableView(
                            "No Scheduled Tasks",
                            systemImage: "clock.badge.plus",
                            description: Text("Ask Aiden in any chat to create unattended work that runs on your desktop.")
                        )
                        .listRowBackground(Color.clear)
                    } else if visibleTasks.isEmpty && !model.isLoading {
                        ContentUnavailableView.search(text: searchText)
                            .listRowBackground(Color.clear)
                    } else {
                        Section("Tasks") {
                            ForEach(visibleTasks) { task in
                                NavigationLink {
                                    AidenScheduledTaskDetailView(model: model, taskId: task.id)
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(task.name).font(.headline)
                                            if task.running { ProgressView().controlSize(.small) }
                                            Spacer()
                                            Text(task.enabled ? "Active" : "Paused")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Text(AidenScheduledTaskPresentation.cadence(schedule: task.schedule))
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                        if let next = task.nextRunAt {
                                            Text("Next \(next.formatted(date: .abbreviated, time: .shortened))")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .swipeActions(edge: .trailing) {
                                    if model.canManageSchedules {
                                        Button(task.enabled ? "Pause" : "Resume") {
                                            Task { await model.pauseOrResume(task) }
                                        }
                                        .tint(.orange)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Scheduled Tasks")
            .searchable(text: $searchText, prompt: "Search tasks")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { isShowingSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                        .disabled(!model.canManageSchedules || !model.isConnected || model.isMutating)
                    Menu {
                        Button { isCreating = true } label: {
                            Label("Create Manually", systemImage: "slider.horizontal.3")
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                        .disabled(!model.canManageSchedules || !model.isConnected || model.isMutating)
                }
            }
            .refreshable { await model.load() }
            .overlay { if model.isLoading && model.tasks.isEmpty { ProgressView("Loading tasks…") } }
            .safeAreaInset(edge: .top) {
                if model.canReadSchedules && !model.isConnected {
                    Text("Offline — task history remains visible, but changes are disabled.")
                        .font(.footnote).frame(maxWidth: .infinity).padding(8).background(.thinMaterial)
                }
            }
            .sheet(isPresented: $isCreating) {
                AidenScheduledTaskEditor(model: model, task: nil) { isCreating = false }
            }
            .sheet(item: $editorTask) { task in
                AidenScheduledTaskEditor(model: model, task: task) { editorTask = nil }
            }
            .sheet(isPresented: $isShowingSettings) {
                AidenScheduledSettingsView(model: model)
            }
            .alert("Scheduled Tasks", isPresented: Binding(
                get: { model.presentedError != nil },
                set: { if !$0 { model.presentedError = nil } }
            )) { Button("OK") { model.presentedError = nil } } message: {
                Text(model.presentedError ?? "")
            }
            .task { await model.load() }
            .onChange(of: model.canReadSchedules) { _, _ in
                Task { await model.reconcileAccess() }
            }
            .onChange(of: model.canWriteSchedules) { _, canWrite in
                if !canWrite {
                    isCreating = false
                    isShowingSettings = false
                    editorTask = nil
                }
                Task { await model.reconcileAccess() }
            }
            .onAppear { model.setHapticsActive(true) }
            .onDisappear { model.setHapticsActive(false) }
        }
    }
}

private struct AidenScheduledTaskDetailView: View {
    @Bindable var model: AidenScheduledTasksModel
    let taskId: String
    @State private var runs: [AidenScheduledRun] = []
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var isConfirmingRun = false
    @Environment(\.dismiss) private var dismiss

    private var task: AidenScheduledTask? {
        guard model.canReadSchedules else { return nil }
        return model.tasks.first { $0.id == taskId }
    }

    var body: some View {
        List {
            if !model.canReadSchedules {
                ContentUnavailableView(
                    "Schedule Access Required",
                    systemImage: "lock.shield",
                    description: Text("Schedule read access was removed. Task details and cached run history are hidden.")
                )
                .listRowBackground(Color.clear)
            } else if let task {
                Section("Task") {
                    LabeledContent("Status", value: task.running ? "Running" : (task.enabled ? "Active" : "Paused"))
                    LabeledContent(
                        "Schedule",
                        value: AidenScheduledTaskPresentation.cadence(schedule: task.schedule)
                    )
                    LabeledContent("Timezone", value: task.timezone)
                    LabeledContent("Mode", value: task.mode.title)
                    LabeledContent("Permission", value: task.permission.title)
                    if let mcpAccessSummary = task.mcpAccessSummary {
                        LabeledContent("MCP Access", value: mcpAccessSummary)
                    }
                    if let prompt = task.prompt { Text(prompt).textSelection(.enabled) }
                }
                if model.canWriteSchedules {
                    Section("Actions") {
                        Button("Run Now", systemImage: "play.fill") { isConfirmingRun = true }
                        Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play") {
                            Task { await model.pauseOrResume(task) }
                        }
                        Button("Edit", systemImage: "pencil") { isEditing = true }
                            .disabled(!task.canBeginEdit(hasCurrentMcpInventory: model.hasCurrentMcpInventory))
                        Button("Delete", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                        if task.usesLegacyInheritedMcpAccess, !model.hasCurrentMcpInventory {
                            Label(
                                "Editing is unavailable until Aiden refreshes the enabled MCP server inventory.",
                                systemImage: "arrow.clockwise"
                            )
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(!model.isConnected || model.isMutating)
                } else {
                    Section {
                        Label(
                            "View only — schedule write access is required to run, pause, edit, or delete this task.",
                            systemImage: "eye"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }
                Section("Run History") {
                    if runs.isEmpty { Text("No completed runs yet.").foregroundStyle(.secondary) }
                    ForEach(runs) { run in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack { Text(run.status.capitalized).font(.headline); Spacer(); Text(run.startedAt, style: .relative).font(.caption) }
                            if let summary = run.summary { Text(summary).font(.body).textSelection(.enabled) }
                            if let code = run.errorCode { Text(code).font(.caption).foregroundStyle(.red) }
                        }
                    }
                }
            } else {
                ContentUnavailableView("Task Removed", systemImage: "trash")
            }
        }
        .navigationTitle(task?.name ?? "Task")
        .sheet(isPresented: $isEditing) {
            if let task, task.canBeginEdit(hasCurrentMcpInventory: model.hasCurrentMcpInventory) {
                AidenScheduledTaskEditor(model: model, task: task) { isEditing = false }
            } else {
                ContentUnavailableView(
                    "MCP Inventory Required",
                    systemImage: "arrow.clockwise",
                    description: Text("Refresh Scheduled Tasks before editing this legacy task so Aiden can freeze its exact MCP access.")
                )
                .padding()
            }
        }
        .confirmationDialog("Run this task now?", isPresented: $isConfirmingRun, titleVisibility: .visible) {
            if model.canManageSchedules, let task {
                Button("Run Now") { Task { await model.run(task); await loadRuns() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Aiden Agent owns the run. It continues if this phone disconnects.") }
        .confirmationDialog("Delete this scheduled task?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            if model.canManageSchedules, let task {
                Button("Delete", role: .destructive) { Task { if await model.remove(task) { dismiss() } } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .task { await loadRuns() }
        .onChange(of: model.canReadSchedules) { _, canRead in
            if !canRead {
                runs = []
                isEditing = false
                isConfirmingDelete = false
                isConfirmingRun = false
            }
        }
        .onChange(of: model.canWriteSchedules) { _, canWrite in
            if !canWrite {
                isEditing = false
                isConfirmingDelete = false
                isConfirmingRun = false
            }
        }
        .onChange(of: model.hasCurrentMcpInventory) { _, hasInventory in
            if !hasInventory, task?.usesLegacyInheritedMcpAccess == true {
                isEditing = false
            }
        }
    }

    private func loadRuns() async {
        guard let task else { return }
        do { runs = try await model.runs(task) } catch { model.presentedError = error.localizedDescription }
    }
}

private struct AidenScheduledTaskEditor: View {
    @Bindable var model: AidenScheduledTasksModel
    let task: AidenScheduledTask?
    let onSaved: () -> Void
    @State private var draft: AidenScheduledTaskDraft
    @State private var preview: [Date] = []
    @State private var isReviewing = false
    @Environment(\.dismiss) private var dismiss

    init(model: AidenScheduledTasksModel, task: AidenScheduledTask?, onSaved: @escaping () -> Void) {
        self.model = model
        self.task = task
        self.onSaved = onSaved
        _draft = State(initialValue: task.map {
            AidenScheduledTaskDraft(
                task: $0,
                currentMcpServers: model.hasCurrentMcpInventory ? model.mcpServers : nil
            )
        } ?? AidenScheduledTaskDraft())
    }

    private var reviewValidationMessage: String? {
        draft.reviewValidationMessage(
            replacing: task,
            currentMcpServers: model.hasCurrentMcpInventory ? model.mcpServers : nil
        )
    }

    private var allProviders: [AidenProvider] { model.catalog?.providers ?? [] }
    private var providers: [AidenProvider] { model.catalog?.visibleProviders ?? [] }
    private var selectedProvider: AidenProvider? { allProviders.first { $0.id == draft.providerId } }
    private var models: [AidenModel] { selectedProvider?.visibleModels ?? [] }
    private var currentHiddenModel: AidenModel? {
        selectedProvider?.models.first { $0.id == draft.modelId && $0.isHidden }
    }
    private var currentHiddenProvider: AidenProvider? {
        guard let selectedProvider, selectedProvider.visibleModels.isEmpty else { return nil }
        return selectedProvider
    }
    private var selectedModel: AidenModel? {
        selectedProvider?.models.first { $0.id == draft.modelId }
    }
    private var selectedWorkspaceName: String {
        guard let workspaceId = draft.workspaceId else { return String(localized: "No workspace") }
        return model.workspaces.first { $0.id == workspaceId }?.name
            ?? String(localized: "Unavailable workspace")
    }
    private var selectedScriptName: String {
        guard let scriptId = draft.scriptId else { return String(localized: "No script") }
        return model.scripts.first { $0.id == scriptId }?.name
            ?? String(localized: "Unavailable script")
    }
    private var unavailableSelectedMcpServerIDs: [String] {
        let availableIDs = Set(model.mcpServers.map(\.id))
        return draft.mcpServerIds.subtracting(availableIDs).sorted()
    }

    private var providerPickerSelection: Binding<String?> {
        Binding(
            get: {
                providers.contains { $0.id == draft.providerId } ? draft.providerId : nil
            },
            set: { draft.providerId = $0 }
        )
    }

    private var modelPickerSelection: Binding<String?> {
        Binding(
            get: {
                models.contains { $0.id == draft.modelId } ? draft.modelId : nil
            },
            set: { draft.modelId = $0 }
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.canManageSchedules {
                    Form {
                        Section("Task") {
                    TextField("Name", text: $draft.name)
                    Picker("Mode", selection: $draft.mode) {
                        ForEach(AidenScheduledTaskMode.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    Picker("Workspace", selection: $draft.workspaceId) {
                        Text("No workspace").tag(String?.none)
                        ForEach(model.workspaces) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                Section("Schedule") {
                    TextField("Cron schedule (advanced)", text: $draft.schedule)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Timezone", text: $draft.timezone)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Preview Next Runs") {
                        Task { do { preview = try await model.preview(draft) } catch { model.presentedError = error.localizedDescription } }
                    }
                    ForEach(preview, id: \.self) { Text($0.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.secondary) }
                }
                if draft.mode == .llm {
                    Section("Ask Aiden") {
                        TextEditor(text: $draft.prompt).frame(minHeight: 120)
                        if let currentHiddenProvider {
                            LabeledContent("Current provider", value: "\(currentHiddenProvider.label) · Hidden")
                        }
                        Picker("Provider", selection: providerPickerSelection) {
                            Text("Default").tag(String?.none)
                            ForEach(providers) { provider in
                                Label {
                                    Text(provider.label)
                                } icon: {
                                    AidenProviderIcon(
                                        providerID: provider.id,
                                        providerLabel: provider.label,
                                        artwork: provider.artwork,
                                        size: 16
                                    )
                                }
                                .tag(Optional(provider.id))
                            }
                        }
                        if let currentHiddenModel {
                            LabeledContent("Current model", value: "\(currentHiddenModel.label) · Hidden")
                        }
                        Picker("Model", selection: modelPickerSelection) {
                            Text("Default").tag(String?.none)
                            ForEach(models) { candidate in
                                Text(candidate.label).tag(Optional(candidate.id))
                            }
                        }
                    }
                    if !model.mcpServers.isEmpty
                        || !draft.mcpServerIds.isEmpty
                        || task?.usesLegacyInheritedMcpAccess == true {
                        Section("MCP Access") {
                            if task?.usesLegacyInheritedMcpAccess == true {
                                Text("This legacy task inherits every enabled MCP server. Saving freezes access to the exact enabled servers listed here.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(model.mcpServers) { server in
                                Toggle(server.name, isOn: Binding(
                                    get: { draft.mcpServerIds.contains(server.id) },
                                    set: { selected in
                                        draft.setMcpServer(id: server.id, selected: selected)
                                    }
                                ))
                                .disabled(
                                    !draft.mcpServerIds.contains(server.id)
                                        && draft.mcpServerIds.count >= AidenScheduledTaskDraft.maximumMcpServerCount
                                )
                            }
                            ForEach(unavailableSelectedMcpServerIDs, id: \.self) { serverID in
                                Toggle(isOn: Binding(
                                    get: { draft.mcpServerIds.contains(serverID) },
                                    set: { selected in
                                        draft.setMcpServer(id: serverID, selected: selected)
                                    }
                                )) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Unavailable connection")
                                        Text(serverID)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            if model.mcpServers.isEmpty {
                                Text("No MCP servers are currently enabled. Saving freezes this task with no MCP access.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Text("Only enabled server names are shown. Connection details and credentials remain on your desktop.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section("Script") {
                        Picker("Aiden script", selection: $draft.scriptId) {
                            Text("Choose a script").tag(String?.none)
                            ForEach(model.scripts) { Text($0.name).tag(Optional($0.id)) }
                        }
                        Text("Only scripts inventoried by Aiden Agent can be selected. The phone never sends a path.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Unattended Access") {
                    Picker("Permission", selection: $draft.permission) {
                        ForEach(AidenScheduledTaskPermission.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    Toggle("Desktop notification", isOn: $draft.notify)
                    Text("Enabled tasks can run on your desktop while this phone is disconnected. Full permission can edit files and run commands without asking.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                        if let validation = reviewValidationMessage { Section { Text(validation).foregroundStyle(.red) } }
                    }
                } else {
                    ContentUnavailableView(
                        "Schedule Write Access Required",
                        systemImage: "lock.shield",
                        description: Text("Task fields are hidden because this paired device no longer has permission to manage scheduled tasks.")
                    )
                    .padding()
                }
            }
            .navigationTitle(task == nil ? "New Task" : "Edit Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Review") { isReviewing = true }
                        .disabled(!model.canManageSchedules || reviewValidationMessage != nil)
                }
            }
            .onChange(of: draft.mode) { _, mode in
                if mode == .script {
                    draft.mcpServerIds.removeAll()
                    draft.permission = .full
                    Task { await model.loadScripts(workspaceId: draft.workspaceId) }
                }
            }
                .onChange(of: draft.providerId) { _, providerId in
                    guard let providerId,
                          let provider = providers.first(where: { $0.id == providerId }) else {
                        draft.modelId = nil
                        return
                    }
                    if !provider.visibleModels.contains(where: { $0.id == draft.modelId }) {
                        draft.modelId = provider.visibleModels.first?.id
                    }
                }
            .onChange(of: draft.workspaceId) { _, workspaceId in
                if workspaceId != nil { draft.setWorkspace(workspaceId) }
                if draft.mode == .script { draft.scriptId = nil; Task { await model.loadScripts(workspaceId: workspaceId) } }
            }
            .onChange(of: draft.permission) { _, permission in
                if permission != .full { draft.setPermission(permission) }
            }
            .task {
                guard model.canManageSchedules else { return }
                if draft.providerId == nil { draft.providerId = model.catalog?.defaults["providerId"] }
                if draft.modelId == nil { draft.modelId = model.catalog?.defaults["modelId"] }
                if draft.mode == .script { await model.loadScripts(workspaceId: draft.workspaceId) }
            }
            .sheet(isPresented: $isReviewing) {
                if model.canManageSchedules {
                    NavigationStack {
                    Form {
                        Section("Final Review") {
                            LabeledContent("Task", value: draft.name)
                            LabeledContent(
                                "Schedule",
                                value: AidenScheduledTaskPresentation.cadence(schedule: draft.schedule)
                            )
                            LabeledContent("Timezone", value: draft.timezone)
                            LabeledContent("Mode", value: draft.mode.title)
                            LabeledContent("Workspace", value: selectedWorkspaceName)
                            LabeledContent("Permission", value: draft.permission.title)
                            if draft.mode == .llm {
                                LabeledContent("Provider", value: selectedProvider?.label ?? String(localized: "Default"))
                                LabeledContent("Model", value: selectedModel?.label ?? String(localized: "Default"))
                                LabeledContent("MCP Access") {
                                    Text(draft.mcpAccessReviewSummary(currentMcpServers: model.mcpServers))
                                        .multilineTextAlignment(.trailing)
                                }
                            } else {
                                LabeledContent("Script", value: selectedScriptName)
                            }
                            LabeledContent("Notifications", value: draft.notify ? "On" : "Off")
                        }
                        Section { Text("Confirm only if this unattended work should run on your desktop while the phone is disconnected.") }
                    }
                    .navigationTitle("Review Task")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Back") { isReviewing = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(task == nil ? "Create" : "Save") {
                                Task { if await model.save(draft, replacing: task) { isReviewing = false; onSaved(); dismiss() } }
                            }
                            .disabled(
                                !model.canManageSchedules
                                    || reviewValidationMessage != nil
                                    || model.isMutating
                            )
                        }
                    }
                }
                } else {
                    ContentUnavailableView(
                        "Schedule Write Access Required",
                        systemImage: "lock.shield",
                        description: Text("Close this review and restore schedule write access before saving the task.")
                    )
                    .padding()
                }
            }
            .onChange(of: model.canManageSchedules) { _, canManage in
                if !canManage {
                    preview = []
                    isReviewing = false
                }
            }
            .onChange(of: model.hasCurrentMcpInventory) { _, hasInventory in
                if !hasInventory, task?.usesLegacyInheritedMcpAccess == true {
                    preview = []
                    isReviewing = false
                }
            }
        }
    }
}

private struct AidenScheduledSettingsView: View {
    @Bindable var model: AidenScheduledTasksModel
    @Environment(\.dismiss) private var dismiss
    @State private var enabled = true
    @State private var mode: AidenScheduledTaskMode = .llm
    @State private var permission: AidenScheduledTaskPermission = .readOnly
    @State private var mcpEnabled = false
    @State private var notify = true
    @State private var timezone = TimeZone.current.identifier

    var body: some View {
        NavigationStack {
            Group {
                if model.canManageSchedules {
                    Form {
                        Section("Global") {
                            Toggle("Scheduled tasks enabled", isOn: $enabled)
                            Picker("Default mode", selection: $mode) { ForEach(AidenScheduledTaskMode.allCases, id: \.self) { Text($0.title).tag($0) } }
                            Picker("Default permission", selection: $permission) { ForEach(AidenScheduledTaskPermission.allCases, id: \.self) { Text($0.title).tag($0) } }
                            Toggle("Enable MCP by default", isOn: $mcpEnabled)
                            Toggle("Default notifications", isOn: $notify)
                            TextField("Default timezone", text: $timezone)
                        }
                        Section { Text("Disabling scheduled tasks stops active scheduled work without deleting task definitions.") }
                    }
                } else {
                    ContentUnavailableView(
                        "Schedule Write Access Required",
                        systemImage: "lock.shield",
                        description: Text("Settings are hidden because this paired device cannot change scheduled tasks.")
                    )
                    .padding()
                }
            }
            .navigationTitle("Task Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.updateSettings(AidenScheduledSettingsMutation(
                                enabled: enabled, defaultMode: mode, defaultPermission: permission,
                                defaultMcpEnabled: mcpEnabled, defaultNotify: notify, defaultTimezone: timezone
                            )) { dismiss() }
                        }
                    }
                    .disabled(!model.canManageSchedules || !model.isConnected || model.isMutating)
                }
            }
            .task {
                guard model.canManageSchedules else { return }
                if let settings = model.settings {
                    enabled = settings.enabled; mode = settings.defaultMode
                    permission = settings.defaultPermission; notify = settings.defaultNotify
                    mcpEnabled = settings.defaultMcpEnabled
                    timezone = settings.defaultTimezone
                }
            }
            .onChange(of: model.canManageSchedules) { _, canManage in
                if !canManage { dismiss() }
            }
        }
    }
}
