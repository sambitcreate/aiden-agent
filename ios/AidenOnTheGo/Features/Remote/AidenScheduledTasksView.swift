import CryptoKit
import Foundation
import Observation
import SwiftUI

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
        let retainedRuns = load(instanceId: instanceId)?.runs ?? [:]
        try persist(Snapshot(instanceId: instanceId, tasks: tasks, settings: settings, runs: retainedRuns))
    }

    func store(runs: [AidenScheduledRun], taskId: String, instanceId: String) throws {
        var snapshot = load(instanceId: instanceId)
            ?? Snapshot(instanceId: instanceId, tasks: [], settings: nil, runs: [:])
        snapshot.runs[taskId] = Array(runs.prefix(50))
        try persist(snapshot)
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
    private var pendingRunKeys: [String: UUID] = [:]
    private(set) var tasks: [AidenScheduledTask] = []
    private(set) var settings: AidenScheduledSettings?
    private(set) var catalog: AidenModelCatalog?
    private(set) var scripts: [AidenScheduledScript] = []
    private(set) var mcpServers: [AidenScheduledMcpServer] = []
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
    }

    var isConnected: Bool { coordinator.connectionState == .connected }
    var workspaces: [AidenWorkspace] { coordinator.workspaces.filter { $0.permission != .none } }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        guard let instanceId = coordinator.activeInstanceId else { return }
        if tasks.isEmpty, let cached = await cache.load(instanceId: instanceId) {
            tasks = cached.tasks.sorted(by: Self.sort)
            settings = cached.settings
        }
        guard isConnected else { return }
        do {
            let client = try coordinator.remoteClient()
            async let loadedTasks = client.scheduledTasks()
            async let loadedSettings = client.scheduledSettings()
            async let loadedCatalog = client.modelCatalog()
            async let loadedMcpServers = client.scheduledMcpServers()
            let values = try await (loadedTasks, loadedSettings, loadedCatalog, loadedMcpServers)
            tasks = values.0.sorted(by: Self.sort)
            settings = values.1
            catalog = values.2
            mcpServers = values.3
            try? await cache.store(instanceId: instanceId, tasks: tasks, settings: settings)
            presentedError = nil
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func loadScripts(workspaceId: String?) async {
        do {
            scripts = try await coordinator.remoteClient().scheduledScripts(workspaceId: workspaceId)
        } catch {
            scripts = []
            presentedError = error.localizedDescription
        }
    }

    func preview(_ draft: AidenScheduledTaskDraft) async throws -> [Date] {
        try await coordinator.remoteClient().previewSchedule(
            cron: draft.schedule.trimmingCharacters(in: .whitespacesAndNewlines),
            timezone: draft.timezone.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    func save(_ draft: AidenScheduledTaskDraft, replacing task: AidenScheduledTask?) async -> Bool {
        guard draft.validationMessage == nil, !isMutating, isConnected else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let client = try coordinator.remoteClient()
            let saved = if let task {
                try await client.updateScheduledTask(id: task.id, revision: task.revision, mutation: draft.mutation)
            } else {
                try await client.createScheduledTask(draft.mutation)
            }
            upsert(saved)
            outcomeMessage = task == nil ? String(localized: "Scheduled task created.") : String(localized: "Scheduled task updated.")
            return true
        } catch {
            presentedError = error.localizedDescription
            await load()
            return false
        }
    }

    func pauseOrResume(_ task: AidenScheduledTask) async {
        await mutate {
            task.enabled
                ? try await $0.pauseScheduledTask(id: task.id, revision: task.revision)
                : try await $0.resumeScheduledTask(id: task.id, revision: task.revision)
        }
    }

    func remove(_ task: AidenScheduledTask) async -> Bool {
        guard !isMutating, isConnected else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await coordinator.remoteClient().removeScheduledTask(id: task.id, revision: task.revision)
            tasks.removeAll { $0.id == task.id }
            return true
        } catch {
            presentedError = error.localizedDescription
            await load()
            return false
        }
    }

    func run(_ task: AidenScheduledTask) async {
        guard !isMutating, isConnected else { return }
        isMutating = true
        defer { isMutating = false }
        let key = pendingRunKeys[task.id] ?? UUID()
        pendingRunKeys[task.id] = key
        do {
            let accepted = try await coordinator.remoteClient().runScheduledTask(id: task.id, idempotencyKey: key)
            pendingRunKeys[task.id] = nil
            outcomeMessage = String(localized: "Run accepted (\(accepted.runId.prefix(12))…). It continues on your Mac if this phone disconnects.")
            await load()
        } catch {
            if !Self.isAmbiguous(error) { pendingRunKeys[task.id] = nil }
            presentedError = error.localizedDescription
        }
    }

    func runs(_ task: AidenScheduledTask) async throws -> [AidenScheduledRun] {
        guard let instanceId = coordinator.activeInstanceId else {
            throw AidenRemoteClientError.missingCredential
        }
        do {
            let values = try await coordinator.remoteClient().scheduledRuns(taskId: task.id)
            try? await cache.store(runs: values, taskId: task.id, instanceId: instanceId)
            return values
        } catch {
            if let retained = await cache.load(instanceId: instanceId)?.runs[task.id] {
                return retained
            }
            throw error
        }
    }

    func updateSettings(_ mutation: AidenScheduledSettingsMutation) async -> Bool {
        guard let settings, !isMutating, isConnected else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            self.settings = try await coordinator.remoteClient().updateScheduledSettings(
                revision: settings.revision,
                mutation: mutation
            )
            return true
        } catch {
            presentedError = error.localizedDescription
            await load()
            return false
        }
    }

    private func mutate(_ operation: (AidenRemoteClient) async throws -> AidenScheduledTask) async {
        guard !isMutating, isConnected else { return }
        isMutating = true
        defer { isMutating = false }
        do { upsert(try await operation(coordinator.remoteClient())) }
        catch {
            presentedError = error.localizedDescription
            await load()
        }
    }

    private func upsert(_ task: AidenScheduledTask) {
        tasks.removeAll { $0.id == task.id }
        tasks.append(task)
        tasks.sort(by: Self.sort)
        if let instanceId = coordinator.activeInstanceId {
            Task { try? await cache.store(instanceId: instanceId, tasks: tasks, settings: settings) }
        }
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
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration: return false
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
        model.tasks.filter { task in
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
                        description: Text("Create unattended work that Aiden Agent runs on your Mac, even while this phone is disconnected.")
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
                                    Text(task.schedule).font(.subheadline).foregroundStyle(.secondary)
                                    if let next = task.nextRunAt {
                                        Text("Next \(next.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                Button(task.enabled ? "Pause" : "Resume") {
                                    Task { await model.pauseOrResume(task) }
                                }
                                .tint(.orange)
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
                    Button { isCreating = true } label: { Label("New Task", systemImage: "plus") }
                        .disabled(!model.isConnected || model.isMutating)
                }
            }
            .refreshable { await model.load() }
            .overlay { if model.isLoading && model.tasks.isEmpty { ProgressView("Loading tasks…") } }
            .safeAreaInset(edge: .top) {
                if !model.isConnected {
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

    private var task: AidenScheduledTask? { model.tasks.first { $0.id == taskId } }

    var body: some View {
        List {
            if let task {
                Section("Task") {
                    LabeledContent("Status", value: task.running ? "Running" : (task.enabled ? "Active" : "Paused"))
                    LabeledContent("Schedule", value: task.schedule)
                    LabeledContent("Timezone", value: task.timezone)
                    LabeledContent("Mode", value: task.mode.title)
                    LabeledContent("Permission", value: task.permission.title)
                    if let prompt = task.prompt { Text(prompt).textSelection(.enabled) }
                }
                Section("Actions") {
                    Button("Run Now", systemImage: "play.fill") { isConfirmingRun = true }
                    Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play") {
                        Task { await model.pauseOrResume(task) }
                    }
                    Button("Edit", systemImage: "pencil") { isEditing = true }
                    Button("Delete", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                }
                .disabled(!model.isConnected || model.isMutating)
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
            if let task { AidenScheduledTaskEditor(model: model, task: task) { isEditing = false } }
        }
        .confirmationDialog("Run this task now?", isPresented: $isConfirmingRun, titleVisibility: .visible) {
            if let task { Button("Run Now") { Task { await model.run(task); await loadRuns() } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Aiden Agent owns the run. It continues if this phone disconnects.") }
        .confirmationDialog("Delete this scheduled task?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            if let task { Button("Delete", role: .destructive) { Task { if await model.remove(task) { dismiss() } } } }
            Button("Cancel", role: .cancel) {}
        }
        .task { await loadRuns() }
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
        _draft = State(initialValue: task.map(AidenScheduledTaskDraft.init(task:)) ?? AidenScheduledTaskDraft())
    }

    private var providers: [AidenProvider] { model.catalog?.providers ?? [] }
    private var models: [AidenModel] { providers.first { $0.id == draft.providerId }?.models ?? [] }

    var body: some View {
        NavigationStack {
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
                    TextField("Cron schedule", text: $draft.schedule)
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
                        Picker("Provider", selection: $draft.providerId) {
                            Text("Default").tag(String?.none)
                            ForEach(providers) { Text($0.label).tag(Optional($0.id)) }
                        }
                        Picker("Model", selection: $draft.modelId) {
                            Text("Default").tag(String?.none)
                            ForEach(models) { Text($0.label).tag(Optional($0.id)) }
                        }
                    }
                    if !model.mcpServers.isEmpty {
                        Section("MCP Access") {
                            ForEach(model.mcpServers) { server in
                                Toggle(server.name, isOn: Binding(
                                    get: { draft.mcpServerIds.contains(server.id) },
                                    set: { selected in
                                        if selected { draft.mcpServerIds.insert(server.id) }
                                        else { draft.mcpServerIds.remove(server.id) }
                                    }
                                ))
                            }
                            Text("Only enabled server names are shown. Connection details and credentials remain on your Mac.")
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
                    Toggle("Mac notification", isOn: $draft.notify)
                    Text("Enabled tasks can run on your Mac while this phone is disconnected. Full permission can edit files and run commands without asking.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let validation = draft.validationMessage { Section { Text(validation).foregroundStyle(.red) } }
            }
            .navigationTitle(task == nil ? "New Task" : "Edit Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Review") { isReviewing = true }.disabled(draft.validationMessage != nil) }
            }
            .onChange(of: draft.mode) { _, mode in
                if mode == .script { draft.permission = .full; Task { await model.loadScripts(workspaceId: draft.workspaceId) } }
            }
            .onChange(of: draft.providerId) { _, providerId in
                guard let providerId,
                      let provider = providers.first(where: { $0.id == providerId }) else {
                    draft.modelId = nil
                    return
                }
                if !provider.models.contains(where: { $0.id == draft.modelId }) {
                    draft.modelId = provider.models.first?.id
                }
            }
            .onChange(of: draft.workspaceId) { _, workspaceId in
                if draft.mode == .script { draft.scriptId = nil; Task { await model.loadScripts(workspaceId: workspaceId) } }
            }
            .task {
                if draft.providerId == nil { draft.providerId = model.catalog?.defaults["providerId"] }
                if draft.modelId == nil { draft.modelId = model.catalog?.defaults["modelId"] }
                if draft.mode == .script { await model.loadScripts(workspaceId: draft.workspaceId) }
            }
            .sheet(isPresented: $isReviewing) {
                NavigationStack {
                    Form {
                        Section("Final Review") {
                            LabeledContent("Task", value: draft.name)
                            LabeledContent("Schedule", value: draft.schedule)
                            LabeledContent("Timezone", value: draft.timezone)
                            LabeledContent("Mode", value: draft.mode.title)
                            LabeledContent("Permission", value: draft.permission.title)
                            LabeledContent("Notifications", value: draft.notify ? "On" : "Off")
                        }
                        Section { Text("Confirm only if this unattended work should run on your Mac while the phone is disconnected.") }
                    }
                    .navigationTitle("Review Task")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Back") { isReviewing = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(task == nil ? "Create" : "Save") {
                                Task { if await model.save(draft, replacing: task) { isReviewing = false; onSaved(); dismiss() } }
                            }
                            .disabled(model.isMutating)
                        }
                    }
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
                    .disabled(!model.isConnected || model.isMutating)
                }
            }
            .task {
                if let settings = model.settings {
                    enabled = settings.enabled; mode = settings.defaultMode
                    permission = settings.defaultPermission; notify = settings.defaultNotify
                    mcpEnabled = settings.defaultMcpEnabled
                    timezone = settings.defaultTimezone
                }
            }
        }
    }
}
