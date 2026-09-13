import CryptoKit
import WebKit
import UIKit
import Foundation
import Observation
import SwiftUI

actor AidenWorkspaceEnvironmentCache {
    struct Snapshot: Codable, Equatable {
        var index: AidenWorkspaceFileIndex
        var documents: [String: AidenWorkspaceFileDocument]
        var updatedAt: Date
    }

    static let shared = AidenWorkspaceEnvironmentCache()
    private let directory: URL
    private let maximumBytes = 8 * 1_048_576

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        )[0].appending(path: "AidenWorkspaceEnvironment", directoryHint: .isDirectory)
    }

    func load(instanceId: String, workspaceId: String) -> Snapshot? {
        if let current = try? JSONDecoder().decode(
            Snapshot.self,
            from: Data(contentsOf: file(instanceId: instanceId, workspaceId: workspaceId))
        ) {
            return current
        }
        let legacyURL = legacyFile(instanceId: instanceId, workspaceId: workspaceId)
        guard let legacy = try? JSONDecoder().decode(
            Snapshot.self,
            from: Data(contentsOf: legacyURL)
        ) else { return nil }
        try? persist(legacy, instanceId: instanceId, workspaceId: workspaceId)
        try? FileManager.default.removeItem(at: legacyURL)
        return legacy
    }

    func store(
        index: AidenWorkspaceFileIndex,
        instanceId: String,
        workspaceId: String
    ) throws {
        let retained = load(instanceId: instanceId, workspaceId: workspaceId)?.documents ?? [:]
        let validIDs = Set(index.entries.lazy.filter { $0.kind == .file }.map(\.id))
        try persist(
            Snapshot(
                index: index,
                documents: retained.filter { validIDs.contains($0.key) },
                updatedAt: Date()
            ),
            instanceId: instanceId,
            workspaceId: workspaceId
        )
    }

    func purge(instanceId: String, knownWorkspaceIds: Set<String> = []) {
        let instanceDirectory = directory.appending(
            path: instanceDigest(instanceId),
            directoryHint: .isDirectory
        )
        try? FileManager.default.removeItem(at: instanceDirectory)
        // The legacy flat format encoded instance + workspace identity in its
        // filename but not its payload. Delete only names attributable from a
        // known workspace snapshot; never erase another Mac's unknown cache.
        for workspaceId in knownWorkspaceIds {
            try? FileManager.default.removeItem(
                at: legacyFile(instanceId: instanceId, workspaceId: workspaceId)
            )
        }
    }

    func store(
        document: AidenWorkspaceFileDocument,
        instanceId: String,
        workspaceId: String
    ) throws {
        guard var snapshot = load(instanceId: instanceId, workspaceId: workspaceId) else { return }
        snapshot.documents[document.id] = document
        snapshot.updatedAt = Date()
        try persist(snapshot, instanceId: instanceId, workspaceId: workspaceId)
    }

    private func persist(_ snapshot: Snapshot, instanceId: String, workspaceId: String) throws {
        let destination = file(instanceId: instanceId, workspaceId: workspaceId)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var value = snapshot
        var data = try JSONEncoder().encode(value)
        if data.count > maximumBytes {
            value.documents = [:]
            data = try JSONEncoder().encode(value)
        }
        guard data.count <= maximumBytes else { return }
        try data.write(to: destination, options: .atomic)
    }

    private func file(instanceId: String, workspaceId: String) -> URL {
        let digest = SHA256.hash(data: Data(workspaceId.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directory
            .appending(path: instanceDigest(instanceId), directoryHint: .isDirectory)
            .appending(path: "\(digest).json")
    }

    private func instanceDigest(_ instanceId: String) -> String {
        SHA256.hash(data: Data(instanceId.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func legacyFile(instanceId: String, workspaceId: String) -> URL {
        let digest = SHA256.hash(data: Data("\(instanceId)\u{0}\(workspaceId)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directory.appending(path: "\(digest).json")
    }
}

/// Recovery contains text and its original version, never reusable file capabilities.
struct AidenWorkspaceFileRecovery: Codable, Equatable {
    let draft: String
    let expectedVersion: String

    var recoveryText: String? {
        guard let data = try? JSONEncoder().encode(self), data.count <= 90_000 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func key(workspaceID: String, displayPath: String, chatID: String = "workspace") -> String {
        "workspace-file:" + SHA256.hash(data: Data("\(workspaceID)\u{0}\(chatID)\u{0}\(displayPath)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
@Observable
final class AidenWorkspaceFilesModel {
    var index: AidenWorkspaceFileIndex?
    var search = ""
    var expandedDirectories: Set<String> = []
    var document: AidenWorkspaceFileDocument?
    var recoveryWarning: String?
    var draft = "" { didSet { if draft != oldValue { scheduleRecovery() } } }
    @ObservationIgnored private var recoverySession: AidenChatDraftStore.Session?
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    private let draftStore: AidenChatDraftStore
    private let installationID: String?
    private let recoveryScope: String
    private var openGeneration = 0
    var isLoading = false
    var isSaving = false
    var isOfflineSnapshot = false
    var errorMessage: String?

    private let workspace: AidenWorkspace
    private let cache: AidenWorkspaceEnvironmentCache
    private let hapticScope = UUID()

    init(workspace: AidenWorkspace, cache: AidenWorkspaceEnvironmentCache = .shared,
         installationID: String? = nil, recoveryScope: String = "workspace", draftStore: AidenChatDraftStore = .shared) {
        self.workspace = workspace
        self.cache = cache
        self.installationID = installationID
        self.recoveryScope = recoveryScope
        self.draftStore = draftStore
    }

    private func scheduleRecovery() {
        recoveryTask?.cancel()
        guard let recoverySession, let document else { return }
        let record = AidenWorkspaceFileRecovery(draft: draft, expectedVersion: document.version)
        let encoded = draft == document.content ? "" : record.recoveryText
        guard let encoded else {
            recoveryWarning = "This edit is too large for local recovery. Keep this chat open or save it to the Mac."
            return
        }
        recoveryTask = Task { [weak self, draftStore] in
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            guard !Task.isCancelled else { return }
            do {
                let saved = try await draftStore.save(encoded, session: recoverySession)
                guard let self, self.recoverySession == recoverySession else { return }
                self.recoveryWarning = saved ? nil : "Local recovery could not be updated. Keep this chat open or save it to the Mac."
            } catch {
                guard let self, self.recoverySession == recoverySession else { return }
                self.recoveryWarning = "Local recovery could not be updated. Keep this chat open or save it to the Mac."
            }
        }
    }

    func discardRecovery() async {
        recoveryTask?.cancel()
        let previous = recoverySession
        recoverySession = nil
        if let previous { _ = try? await draftStore.save("", session: previous) }
    }

    private func acceptDocument(_ value: AidenWorkspaceFileDocument, context: AidenRemoteRequestContext,
                                generation: Int, coordinator: AidenRemoteCoordinator) async {
        let instanceID = context.instanceId
        let session = await draftStore.beginSession(instanceId: instanceID,
            chatId: AidenWorkspaceFileRecovery.key(workspaceID: workspace.id, displayPath: value.displayPath, chatID: recoveryScope))
        let recovered = await draftStore.load(session: session)
        guard generation == openGeneration, coordinator.isCurrent(context) else { return }
        recoveryTask?.cancel()
        recoverySession = nil
        document = value
        draft = value.content
        if let recovered, let record = try? JSONDecoder().decode(AidenWorkspaceFileRecovery.self, from: Data(recovered.utf8)) {
            draft = record.draft
            document = AidenWorkspaceFileDocument(id: value.id, displayPath: value.displayPath, content: value.content,
                version: record.expectedVersion, truncated: value.truncated, warning: value.warning)
            if record.expectedVersion != value.version {
                errorMessage = "This file changed on the Mac. Your local draft is preserved; reload it before saving again."
            }
        }
        recoverySession = session
    }

    func setHapticsActive(_ active: Bool, coordinator: AidenRemoteCoordinator) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard !isLoading, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        guard installationID == nil || installationID == instanceId else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        if coordinator.connectionState == .connected {
            do {
                let value = try await coordinator.remoteClient(for: context).workspaceFiles(workspaceId: workspace.id)
                guard coordinator.isCurrent(context) else { return }
                index = value
                isOfflineSnapshot = false
                try? await cache.store(index: value, instanceId: instanceId, workspaceId: workspace.id)
                return
            } catch {
                guard coordinator.isCurrent(context) else { return }
                errorMessage = error.localizedDescription
            }
        }
        if let cached = await cache.load(instanceId: instanceId, workspaceId: workspace.id) {
            guard coordinator.isCurrent(context) else { return }
            index = cached.index
            isOfflineSnapshot = true
        } else if coordinator.isCurrent(context), errorMessage == nil {
            errorMessage = "Connect to Aiden Agent to load workspace files."
        }
    }

    func open(_ entry: AidenWorkspaceFileEntry, coordinator: AidenRemoteCoordinator) async {
        guard entry.kind == .file, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        guard installationID == nil || installationID == instanceId else { return }
        openGeneration += 1
        let generation = openGeneration
        errorMessage = nil
        if coordinator.connectionState == .connected {
            do {
                let value = try await coordinator.remoteClient(for: context).workspaceFile(
                    workspaceId: workspace.id,
                    fileId: entry.id
                )
                guard coordinator.isCurrent(context) else { return }
                await acceptDocument(value, context: context, generation: generation, coordinator: coordinator)
                guard generation == openGeneration, coordinator.isCurrent(context) else { return }
                isOfflineSnapshot = false
                try? await cache.store(document: value, instanceId: instanceId, workspaceId: workspace.id)
                return
            } catch {
                guard coordinator.isCurrent(context) else { return }
                errorMessage = error.localizedDescription
            }
        }
        if let cached = await cache.load(instanceId: instanceId, workspaceId: workspace.id),
           let value = cached.documents[entry.id] {
            guard coordinator.isCurrent(context) else { return }
            await acceptDocument(value, context: context, generation: generation, coordinator: coordinator)
            guard generation == openGeneration, coordinator.isCurrent(context) else { return }
            isOfflineSnapshot = true
        }
    }

    func save(coordinator: AidenRemoteCoordinator) async -> Bool {
        guard coordinator.connectionState == .connected,
              !isSaving,
              let document,
              let context = try? coordinator.requestContext() else { return false }
        let instanceId = context.instanceId
        guard installationID == nil || installationID == instanceId else { return false }
        isSaving = true
        errorMessage = nil
        let submittedDraft = draft
        defer { isSaving = false }
        do {
            let saved = try await coordinator.remoteClient(for: context).writeWorkspaceFile(
                workspaceId: workspace.id,
                fileId: document.id,
                content: submittedDraft,
                expectedVersion: document.version
            )
            guard coordinator.isCurrent(context) else { return false }
            if self.document?.id == document.id {
                self.document = saved
                // Typing while a save is in flight belongs to the next edit.
                if draft == submittedDraft { draft = saved.content }
                scheduleRecovery()
            }
            try? await cache.store(document: saved, instanceId: instanceId, workspaceId: workspace.id)
            coordinator.haptics.play(
                .success,
                scope: hapticScope,
                dedupeKey: "file-save:\(workspace.id):\(saved.id):\(saved.version)"
            )
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            guard coordinator.isCurrent(context) else { return false }
            if case AidenRemoteClientError.server(_, let body) = error,
               body.code.rawValue == "revision_conflict" {
                errorMessage = "This file changed on the Mac. Reload it before saving again."
                coordinator.haptics.play(.warning, scope: hapticScope)
            } else {
                errorMessage = error.localizedDescription
                coordinator.haptics.play(.error, scope: hapticScope)
            }
            return false
        }
    }

    func reloadDocument(coordinator: AidenRemoteCoordinator) async {
        guard let document,
              let entry = index?.entries.first(where: { $0.id == document.id }) else { return }
        await discardRecovery()
        await open(entry, coordinator: coordinator)
    }
}

/// A single native sheet keeps file browsing and change review attached to the chat.
struct AidenWorkspaceDiffView: View {
    @Environment(\.aidenPalette) private var palette
    let diff: AidenGitDiff
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(fill(line))
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if diff.truncated {
                Text("Diff truncated").font(.footnote).padding().frame(maxWidth: .infinity).background(.regularMaterial)
            }
        }
    }
    private func fill(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return palette.success.opacity(0.14) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return palette.danger.opacity(0.14) }
        return .clear
    }
}

struct AidenWorkspaceFileReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let files: AidenWorkspaceFilesModel
    let git: AidenWorkspaceGitModel
    @Binding var selection: AidenWorkspaceTool
    @State private var detent: PresentationDetent = .large

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Close", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly)
                Spacer()
                Text(selection == .changes ? (git.review?.branch ?? "Changes") : "Files").font(.headline)
                Spacer()
                Button(detent == .large ? "Reduce panel" : "Expand panel",
                       systemImage: detent == .large ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") {
                    detent = detent == .large ? .medium : .large
                }.labelStyle(.iconOnly)
            }
            .buttonStyle(.bordered)
            .padding()
            Picker("File view", selection: $selection) {
                Text("Modified").tag(AidenWorkspaceTool.changes)
                Text("All Files").tag(AidenWorkspaceTool.files)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 8)
            ZStack {
                AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace, model: files,
                                        embedded: true, active: selection == .files)
                    .opacity(selection == .files ? 1 : 0)
                    .allowsHitTesting(selection == .files)
                    .accessibilityHidden(selection != .files)
                AidenWorkspaceGitView(coordinator: coordinator, workspace: workspace, model: git,
                                      embedded: true, active: selection == .changes, reviewOnly: true)
                    .opacity(selection == .changes ? 1 : 0)
                    .allowsHitTesting(selection == .changes)
                    .accessibilityHidden(selection != .changes)
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }
}

/// The server remains the authority: paths organize the display; only opaque ids open files.
enum AidenWorkspaceFileTree {
    static func visible(_ entries: [AidenWorkspaceFileEntry], search: String,
                        expanded: Set<String>) -> [AidenWorkspaceFileEntry] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let directories = Set(entries.filter { $0.kind == .directory }.map(\.displayPath))
        return entries.filter { entry in
            if !query.isEmpty { return entry.displayPath.localizedCaseInsensitiveContains(query) }
            let parts = entry.displayPath.split(separator: "/")
            guard parts.count > 1 else { return true }
            return (1..<parts.count).allSatisfy { count in
                let parent = parts.prefix(count).joined(separator: "/")
                return !directories.contains(parent) || expanded.contains(parent)
            }
        }.sorted { $0.displayPath.localizedStandardCompare($1.displayPath) == .orderedAscending }
    }
}

struct AidenWorkspaceFilesView: View {
    let coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let injectedModel: AidenWorkspaceFilesModel?
    var embedded: Bool
    var active: Bool
    @State private var ownedModel: AidenWorkspaceFilesModel?

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace,
         model: AidenWorkspaceFilesModel? = nil, embedded: Bool = false, active: Bool = true) {
        self.coordinator = coordinator
        self.workspace = workspace
        injectedModel = model
        self.embedded = embedded
        self.active = active
        _ownedModel = State(initialValue: model == nil ? AidenWorkspaceFilesModel(workspace: workspace) : nil)
    }

    var body: some View {
        if let model = injectedModel ?? ownedModel {
            AidenWorkspaceFilesContent(coordinator: coordinator, workspace: workspace, model: model, embedded: embedded, active: active)
        }
    }
}

private struct AidenWorkspaceFilesContent: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    @Bindable var model: AidenWorkspaceFilesModel
    var embedded = false
    var active = true
    @State private var isShowingDocument = false

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace,
         model: AidenWorkspaceFilesModel? = nil, embedded: Bool = false, active: Bool = true) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.model = model ?? AidenWorkspaceFilesModel(workspace: workspace)
        self.embedded = embedded
        self.active = active
    }

    private var entries: [AidenWorkspaceFileEntry] {
        AidenWorkspaceFileTree.visible(model.index?.entries ?? [], search: model.search, expanded: model.expandedDirectories)
    }

    var body: some View {
        Group {
            if embedded && model.document != nil {
                AidenWorkspaceFileEditorContent(coordinator: coordinator, model: model, active: active) {
                    model.document = nil
                }
            } else if embedded {
                VStack(spacing: 0) {
                    TextField("Find a file", text: $model.search)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(12)
                    fileList
                }
            } else {
                fileList.navigationTitle("Files").searchable(text: $model.search, prompt: "Find a file")
            }
        }
    }

    private var fileList: some View {
        List {
            if model.isOfflineSnapshot {
                Section {
                    Label("Showing the last downloaded snapshot. Editing is disabled.", systemImage: "wifi.slash")
                        .foregroundStyle(.secondary)
                }
            }
            if let index = model.index, index.truncated {
                Section {
                    Label("This bounded index contains up to 4,000 entries and may be incomplete.", systemImage: "exclamationmark.triangle")
                }
            }
            Section("Files") {
                ForEach(entries) { entry in
                    Button {
                        if entry.kind == .directory {
                            if !model.expandedDirectories.insert(entry.displayPath).inserted {
                                model.expandedDirectories.remove(entry.displayPath)
                            }
                            return
                        }
                        guard entry.kind == .file else { return }
                        Task {
                            await model.open(entry, coordinator: coordinator)
                            isShowingDocument = !embedded && model.document != nil
                        }
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.name)
                                    .foregroundStyle(.primary)
                                Text(entry.displayPath)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        } icon: {
                            HStack(spacing: 6) {
                                if entry.kind == .directory {
                                    Image(systemName: model.expandedDirectories.contains(entry.displayPath) ? "chevron.down" : "chevron.right")
                                        .font(.caption)
                                }
                                Image(systemName: entry.kind == .directory ? "folder" : entry.kind == .symlink ? "link" : "doc.text")
                            }
                        }
                    }
                    .padding(.leading, model.search.isEmpty ? CGFloat(max(0, entry.displayPath.split(separator: "/").count - 1)) * 12 : 0)
                    .accessibilityHint(entry.kind == .directory ? "Expand or collapse folder" : "Open file")
                    .disabled(entry.kind == .symlink)
                }
            }
        }
        .overlay {
            if model.isLoading && model.index == nil { ProgressView("Loading files…") }
        }
        .refreshable { await model.load(coordinator: coordinator) }
        .task(id: active) {
            guard active, model.index == nil else { return }
            await model.load(coordinator: coordinator)
        }
        .onAppear { model.setHapticsActive(active, coordinator: coordinator) }
        .onChange(of: active) { _, value in model.setHapticsActive(value, coordinator: coordinator) }
        .onDisappear { model.setHapticsActive(false, coordinator: coordinator) }
        .sheet(isPresented: $isShowingDocument) {
            AidenWorkspaceFileEditorView(coordinator: coordinator, model: model)
        }
        .alert("Files", isPresented: Binding(
            get: { active && model.errorMessage != nil && !isShowingDocument },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "The file operation failed.")
        }
    }
}

private struct AidenWorkspaceFileEditorView: View {
    @Environment(\.dismiss) private var dismiss
    let coordinator: AidenRemoteCoordinator
    let model: AidenWorkspaceFilesModel
    var body: some View {
        NavigationStack {
            AidenWorkspaceFileEditorContent(coordinator: coordinator, model: model) { dismiss() }
        }
        .interactiveDismissDisabled(model.document?.content != model.draft && !model.isOfflineSnapshot)
    }
}

private struct AidenWorkspaceFileEditorContent: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var model: AidenWorkspaceFilesModel
    var active = true
    let onClose: () -> Void
    @FocusState private var editorFocused: Bool
    @State private var isConfirmingDiscard = false
    private var isDirty: Bool { model.document.map { $0.content != model.draft } ?? false }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Files", systemImage: "chevron.backward") {
                    if isDirty && !model.isOfflineSnapshot { isConfirmingDiscard = true }
                    else { Task { await model.discardRecovery(); onClose() } }
                }
                Text(model.document?.displayPath ?? "File")
                    .font(.subheadline).lineLimit(2).frame(maxWidth: .infinity)
                Button("Save") { Task { _ = await model.save(coordinator: coordinator) } }
                    .disabled(!isDirty || model.isSaving || model.isOfflineSnapshot ||
                              coordinator.connectionState != .connected || model.document?.truncated == true)
            }
            .padding(12)
            TextEditor(text: $model.draft)
                .focused($editorFocused)
                .onChange(of: active) { _, visible in if !visible { editorFocused = false } }
                .onDisappear { editorFocused = false }
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 8)
                .disabled(model.isOfflineSnapshot || model.document?.truncated == true)
                .accessibilityLabel(model.document?.displayPath ?? "File contents")
            if let warning = model.recoveryWarning {
                Text(warning).font(.footnote).foregroundStyle(.secondary).padding()
            }
            if let message = model.errorMessage {
                VStack(spacing: 8) {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                    if message.contains("changed on the Mac") {
                        Button("Reload from Mac") {
                            Task { await model.reloadDocument(coordinator: coordinator) }
                        }
                    }
                }.padding()
            }
        }
        .confirmationDialog("Discard unsaved changes?", isPresented: $isConfirmingDiscard) {
            Button("Discard Changes", role: .destructive) { Task { await model.discardRecovery(); onClose() } }
            Button("Keep Editing", role: .cancel) {}
        }
    }
}

private enum AidenPendingGitMutation {
    case commit(UUID, snapshot: String, message: String, stagedOnly: Bool)
    case checkout(UUID, snapshot: String, branch: String)
    case createBranch(UUID, name: String, startPoint: String)
    case push(UUID, snapshot: String, remote: String, branch: String)
    case createWorktree(UUID, branch: String, name: String)

    var idempotencyKey: UUID {
        switch self {
        case .commit(let key, _, _, _), .checkout(let key, _, _),
             .createBranch(let key, _, _), .push(let key, _, _, _),
             .createWorktree(let key, _, _): key
        }
    }
}

@MainActor
@Observable
final class AidenWorkspaceGitModel {
    var review: AidenGitReview?
    var reviewSnapshotId: String?
    var branches: AidenGitBranches?
    var branchesSnapshotId: String?
    var worktrees: [AidenGitWorktree] = []
    var comparison: AidenGitComparison?
    var selectedDiff: AidenGitDiff?
    var pushCapability: AidenGitPushCapability?
    var pushSnapshotId: String?
    var isLoading = false
    var errorMessage: String?
    var lastMessage: String?
    private var pendingMutation: AidenPendingGitMutation?
    private let haptics: any AidenHapticEmitting
    private let hapticScope = UUID()
    private let installationID: String?

    init(haptics: (any AidenHapticEmitting)? = nil, installationID: String? = nil) {
        self.installationID = installationID
        self.haptics = haptics ?? AidenHapticCenter()
    }

    func accepts(installationID: String) -> Bool {
        self.installationID == nil || self.installationID == installationID
    }

    func setHapticsActive(_ active: Bool) {
        if active {
            haptics.activate(scope: hapticScope)
        } else {
            haptics.deactivate(scope: hapticScope)
        }
    }

    var canRetryPendingMutation: Bool { pendingMutation != nil }

    func refresh(
        client: AidenRemoteClient,
        workspaceId: String,
        isCurrent: @MainActor () -> Bool
    ) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let reviewResult = try await client.gitReview(workspaceId: workspaceId)
            guard isCurrent() else { return }
            if case .review(let value) = reviewResult.result {
                review = value
                reviewSnapshotId = reviewResult.snapshotId
            }
            let branchResult = try await client.gitBranches(workspaceId: workspaceId)
            guard isCurrent() else { return }
            if case .branches(let value) = branchResult.result {
                branches = value
                branchesSnapshotId = branchResult.snapshotId
            }
            let worktreeResult = try await client.gitWorktrees(workspaceId: workspaceId)
            guard isCurrent() else { return }
            if case .worktrees(let value) = worktreeResult.result { worktrees = value.worktrees }
        } catch {
            guard isCurrent() else { return }
            errorMessage = error.localizedDescription
        }
    }

    func diff(
        client: AidenRemoteClient,
        workspaceId: String,
        file: AidenGitFile,
        comparisonMode: Bool = false,
        isCurrent: @MainActor () -> Bool
    ) async {
        do {
            let result = comparisonMode
                ? try await client.gitComparisonDiff(
                    workspaceId: workspaceId,
                    comparisonId: comparison?.comparisonId ?? "",
                    fileId: file.id
                )
                : try await client.gitDiff(
                    workspaceId: workspaceId,
                    snapshotId: reviewSnapshotId ?? "",
                    fileId: file.id
                )
            guard isCurrent() else { return }
            if case .diff(let value) = result.result { selectedDiff = value }
        } catch {
            guard isCurrent() else { return }
            errorMessage = error.localizedDescription
        }
    }

    func commit(client: AidenRemoteClient, workspaceId: String, message: String, stagedOnly: Bool, isCurrent: @escaping @MainActor () -> Bool) async {
        let operation = AidenPendingGitMutation.commit(
            UUID(),
            snapshot: reviewSnapshotId ?? "",
            message: message,
            stagedOnly: stagedOnly
        )
        if await execute(operation, client: client, workspaceId: workspaceId, isCurrent: isCurrent) {
            await refresh(client: client, workspaceId: workspaceId, isCurrent: isCurrent)
        }
    }

    func checkout(client: AidenRemoteClient, workspaceId: String, branch: String, isCurrent: @escaping @MainActor () -> Bool) async {
        let operation = AidenPendingGitMutation.checkout(
            UUID(),
            snapshot: branchesSnapshotId ?? "",
            branch: branch
        )
        if await execute(operation, client: client, workspaceId: workspaceId, isCurrent: isCurrent) {
            await refresh(client: client, workspaceId: workspaceId, isCurrent: isCurrent)
        }
    }

    func createBranch(client: AidenRemoteClient, workspaceId: String, name: String, isCurrent: @escaping @MainActor () -> Bool) async {
        let operation = AidenPendingGitMutation.createBranch(
            UUID(),
            name: name,
            startPoint: branches?.current ?? "HEAD"
        )
        if await execute(operation, client: client, workspaceId: workspaceId, isCurrent: isCurrent) {
            await refresh(client: client, workspaceId: workspaceId, isCurrent: isCurrent)
        }
    }

    func preparePush(client: AidenRemoteClient, workspaceId: String, isCurrent: @MainActor () -> Bool) async {
        do {
            let result = try await client.gitPushCapability(workspaceId: workspaceId)
            guard isCurrent() else { return }
            if case .pushCapability(let value) = result.result {
                pushCapability = value
                pushSnapshotId = result.snapshotId
                if !value.allowed {
                    errorMessage = value.reason ?? "Push is unavailable for this workspace state."
                    haptics.play(
                        .warning,
                        scope: hapticScope,
                        dedupeKey: "git-push-capability:\(result.snapshotId ?? workspaceId)"
                    )
                }
            }
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            guard isCurrent() else { return }
            errorMessage = error.localizedDescription
            haptics.play(.error, scope: hapticScope)
        }
    }

    func push(client: AidenRemoteClient, workspaceId: String, isCurrent: @escaping @MainActor () -> Bool) async {
        guard let pushCapability, let remote = pushCapability.remote, let branch = pushCapability.branch else { return }
        _ = await execute(
            .push(UUID(), snapshot: pushSnapshotId ?? "", remote: remote, branch: branch),
            client: client,
            workspaceId: workspaceId,
            isCurrent: isCurrent
        )
    }

    func compare(client: AidenRemoteClient, workspaceId: String, baseRef: String, isCurrent: @MainActor () -> Bool) async {
        do {
            let result = try await client.compareGit(workspaceId: workspaceId, baseRef: baseRef)
            guard isCurrent() else { return }
            if case .comparison(let value) = result.result { comparison = value }
        } catch {
            guard isCurrent() else { return }
            errorMessage = error.localizedDescription
        }
    }

    func createWorktree(client: AidenRemoteClient, workspaceId: String, branch: String, name: String, isCurrent: @escaping @MainActor () -> Bool) async {
        if await execute(
            .createWorktree(UUID(), branch: branch, name: name),
            client: client,
            workspaceId: workspaceId,
            isCurrent: isCurrent
        ) {
            await refresh(client: client, workspaceId: workspaceId, isCurrent: isCurrent)
        }
    }

    func retryPendingMutation(client: AidenRemoteClient, workspaceId: String, isCurrent: @escaping @MainActor () -> Bool) async {
        guard let pendingMutation else { return }
        if await execute(pendingMutation, client: client, workspaceId: workspaceId, isCurrent: isCurrent) {
            await refresh(client: client, workspaceId: workspaceId, isCurrent: isCurrent)
        }
    }

    private func execute(
        _ operation: AidenPendingGitMutation,
        client: AidenRemoteClient,
        workspaceId: String,
        isCurrent: @MainActor () -> Bool
    ) async -> Bool {
        isLoading = true
        errorMessage = nil
        pendingMutation = operation
        defer { isLoading = false }
        do {
            let value: AidenGitResult
            switch operation {
            case .commit(let key, let snapshot, let message, let stagedOnly):
                value = try await client.commitGit(
                    workspaceId: workspaceId,
                    snapshotId: snapshot,
                    message: message,
                    stagedOnly: stagedOnly,
                    idempotencyKey: key
                )
            case .checkout(let key, let snapshot, let branch):
                value = try await client.checkoutGitBranch(
                    workspaceId: workspaceId,
                    branch: branch,
                    snapshotId: snapshot,
                    idempotencyKey: key
                )
            case .createBranch(let key, let name, let startPoint):
                value = try await client.createGitBranch(
                    workspaceId: workspaceId,
                    name: name,
                    startPoint: startPoint,
                    idempotencyKey: key
                )
            case .push(let key, let snapshot, let remote, let branch):
                value = try await client.pushGit(
                    workspaceId: workspaceId,
                    snapshotId: snapshot,
                    remote: remote,
                    branch: branch,
                    idempotencyKey: key
                )
            case .createWorktree(let key, let branch, let name):
                value = try await client.createGitWorktree(
                    workspaceId: workspaceId,
                    branch: branch,
                    name: name,
                    idempotencyKey: key
                )
            }
            guard isCurrent() else { return false }
            var event: AidenHapticEvent = .success
            if case .mutation(let mutation) = value.result {
                lastMessage = mutation.warning.map { "\(mutation.message) \($0)" } ?? mutation.message
                if mutation.warning != nil { event = .warning }
            }
            pendingMutation = nil
            haptics.play(
                event,
                scope: hapticScope,
                dedupeKey: "git:\(workspaceId):\(operation.idempotencyKey.uuidString)"
            )
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            guard isCurrent() else { return false }
            let retain = shouldRetainForReconciliation(error)
            if !retain { pendingMutation = nil }
            errorMessage = retain
                ? "\(error.localizedDescription) Reconnect, then use Retry Last Git Operation to reconcile safely."
                : error.localizedDescription
            haptics.play(retain ? .warning : .error, scope: hapticScope)
            return false
        }
    }

    private func shouldRetainForReconciliation(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let clientError = error as? AidenRemoteClientError else { return false }
        switch clientError {
        case .invalidResponse, .unexpectedStatus:
            return true
        case .server(_, let body):
            return body.code.rawValue == "idempotency_in_flight" || body.code.rawValue == "internal_error"
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
            return false
        }
    }
}

struct AidenWorkspaceGitView: View {
    let coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let injectedModel: AidenWorkspaceGitModel?
    var embedded: Bool
    var active: Bool
    var reviewOnly: Bool
    @State private var ownedModel: AidenWorkspaceGitModel?

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace,
         model: AidenWorkspaceGitModel? = nil, embedded: Bool = false, active: Bool = true, reviewOnly: Bool = false) {
        self.coordinator = coordinator
        self.workspace = workspace
        injectedModel = model
        self.embedded = embedded
        self.active = active
        self.reviewOnly = reviewOnly
        _ownedModel = State(initialValue: model == nil ? AidenWorkspaceGitModel(haptics: coordinator.haptics) : nil)
    }

    var body: some View {
        if let model = injectedModel ?? ownedModel {
            AidenWorkspaceGitContent(coordinator: coordinator, workspace: workspace, model: model, embedded: embedded, active: active, reviewOnly: reviewOnly)
        }
    }
}

private struct AidenWorkspaceGitContent: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    @Bindable var model: AidenWorkspaceGitModel
    var embedded = false
    var active = true
    var reviewOnly = false
    @State private var commitMessage = ""
    @State private var stagedOnly = false
    @State private var isShowingCommit = false
    @State private var isConfirmingCommit = false
    @State private var isConfirmingPush = false
    @State private var compareBase = ""
    @State private var isShowingCompare = false
    @State private var newBranch = ""
    @State private var isShowingNewBranch = false
    @State private var checkoutBranch: String?
    @State private var worktreeBranch = ""
    @State private var worktreeName = ""
    @State private var isShowingNewWorktree = false

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace,
         model: AidenWorkspaceGitModel? = nil, embedded: Bool = false, active: Bool = true, reviewOnly: Bool = false) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.model = model ?? AidenWorkspaceGitModel(haptics: coordinator.haptics)
        self.embedded = embedded
        self.active = active
        self.reviewOnly = reviewOnly
    }

    var body: some View {
        Group {
            if embedded, let diff = model.selectedDiff {
                VStack(spacing: 0) {
                    HStack {
                        Button("Changes", systemImage: "chevron.backward") { model.selectedDiff = nil }
                        Text(diff.displayPath).font(.subheadline).lineLimit(2)
                    }.padding(12)
                    diffContent(diff)
                }
            } else if embedded {
                VStack(spacing: 0) {
                    HStack {
                        if reviewOnly {
                            Button("Compare branch", systemImage: "arrow.left.arrow.right") { isShowingCompare = true }
                        }
                        Spacer()
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                            .disabled(coordinator.connectionState != .connected || model.isLoading)
                    }.padding(12)
                    gitConfirmations
                }
            } else {
                gitConfirmations.navigationTitle("Git")
                    .toolbar {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                        }
                    }
            }
        }
            .alert("Git", isPresented: Binding(
                get: { active && model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { model.errorMessage = nil }
            } message: { Text(model.errorMessage ?? "The Git operation failed.") }
    }

    private func presentation(_ value: Binding<Bool>) -> Binding<Bool> {
        Binding(get: { active && value.wrappedValue }, set: { value.wrappedValue = $0 })
    }

    private var gitList: some View {
        List {
            if let review = model.review {
                Section("Repository") {
                    LabeledContent("Branch", value: review.branch)
                    LabeledContent("Changes", value: "\(review.uncommitted)")
                }
                Section("Working changes") {
                    if review.files.isEmpty {
                        Label("Working tree is clean", systemImage: "checkmark.circle")
                    }
                    ForEach(review.files) { file in
                        gitFileButton(file, comparisonMode: false)
                    }
                }
            }

            if let comparison = model.comparison {
                Section("Compare \(comparison.base) → \(comparison.head)") {
                    ForEach(comparison.files) { file in gitFileButton(file, comparisonMode: true) }
                }
            }

            if !reviewOnly {
            Section("Actions") {
                Button("Commit reviewed changes", systemImage: "checkmark.circle") { isShowingCommit = true }
                    .disabled(model.review?.files.isEmpty != false)
                Button("Push reviewed commit", systemImage: "arrow.up.circle") {
                    Task {
                        await withRemoteContext { client, context in
                            await model.preparePush(
                                client: client,
                                workspaceId: workspace.id,
                                isCurrent: { coordinator.isCurrent(context) }
                            )
                            guard coordinator.isCurrent(context) else { return }
                            isConfirmingPush = model.pushCapability?.allowed == true
                        }
                    }
                }
                Button("Compare branch", systemImage: "arrow.left.arrow.right") { isShowingCompare = true }
            }
            .disabled(coordinator.connectionState != .connected || model.isLoading)

            if let branches = model.branches {
                Section("Branches") {
                    ForEach(branches.branches, id: \.self) { branch in
                        Button {
                            checkoutBranch = branch
                        } label: {
                            HStack {
                                Text(branch)
                                Spacer()
                                if branch == branches.current { Image(systemName: "checkmark") }
                            }
                        }
                        .disabled(branch == branches.current)
                    }
                    Button("New Branch", systemImage: "plus") { isShowingNewBranch = true }
                }
                .disabled(coordinator.connectionState != .connected || model.isLoading)
            }

            Section("Managed worktrees") {
                ForEach(model.worktrees) { worktree in
                    LabeledContent(worktree.name, value: worktree.branch)
                }
                Button("New Managed Worktree", systemImage: "hammer") { isShowingNewWorktree = true }
            }
            .disabled(coordinator.connectionState != .connected || model.isLoading)

            }

            if let message = model.lastMessage {
                Section { Label(message, systemImage: "checkmark.circle") }
            }
            if !reviewOnly && model.canRetryPendingMutation {
                Section {
                    Button("Retry Last Git Operation", systemImage: "arrow.clockwise") {
                        Task {
                            await withRemoteContext { client, context in
                                await model.retryPendingMutation(
                                    client: client,
                                    workspaceId: workspace.id,
                                    isCurrent: { coordinator.isCurrent(context) }
                                )
                            }
                        }
                    }
                } footer: {
                    Text("Reuses the original idempotency key so reconnecting cannot duplicate the mutation.")
                }
                .disabled(coordinator.connectionState != .connected || model.isLoading)
            }
        }
        .overlay { if model.isLoading && model.review == nil { ProgressView("Loading Git…") } }
        .refreshable { await refresh() }
        .task(id: active) {
            guard active, model.review == nil else { return }
            await refresh()
        }
        .onAppear { model.setHapticsActive(active) }
        .onChange(of: active) { _, value in model.setHapticsActive(value) }
        .onDisappear { model.setHapticsActive(false) }
    }

    private var gitSheets: some View {
        gitList
        .sheet(isPresented: presentation($isShowingCommit)) {
            commitSheet
        }
        .sheet(item: Binding(
            get: { embedded ? nil : model.selectedDiff },
            set: { model.selectedDiff = $0 }
        )) { diff in
            diffSheet(diff)
        }
    }

    private var gitAlerts: some View {
        gitSheets
        .alert("Compare Branch", isPresented: presentation($isShowingCompare)) {
            TextField("Base branch", text: $compareBase)
            Button("Compare") {
                let base = compareBase.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    await withRemoteContext { client, context in
                        await model.compare(
                            client: client,
                            workspaceId: workspace.id,
                            baseRef: base,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Branch", isPresented: presentation($isShowingNewBranch)) {
            TextField("Branch name", text: $newBranch)
            Button("Create and Check Out") {
                let value = newBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    await withRemoteContext { client, context in
                        await model.createBranch(
                            client: client,
                            workspaceId: workspace.id,
                            name: value,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Managed Worktree", isPresented: presentation($isShowingNewWorktree)) {
            TextField("Branch", text: $worktreeBranch)
            TextField("Workspace name", text: $worktreeName)
            Button("Create") {
                let branch = worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                let name = worktreeName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    await withRemoteContext { client, context in
                        await model.createWorktree(
                            client: client,
                            workspaceId: workspace.id,
                            branch: branch,
                            name: name,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                        guard coordinator.isCurrent(context) else { return }
                        await coordinator.refreshWorkspaces()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var gitConfirmations: some View {
        gitAlerts
        .confirmationDialog("Check out \(checkoutBranch ?? "this branch")?", isPresented: Binding(
            get: { checkoutBranch != nil },
            set: { if !$0 { checkoutBranch = nil } }
        )) {
            Button("Check Out Branch") {
                let branch = checkoutBranch
                checkoutBranch = nil
                Task {
                    guard let branch else { return }
                    await withRemoteContext { client, context in
                        await model.checkout(
                            client: client,
                            workspaceId: workspace.id,
                            branch: branch,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
            }
            Button("Cancel", role: .cancel) { checkoutBranch = nil }
        } message: { Text("Aiden Agent will switch the workspace to this branch.") }
        .confirmationDialog("Push the reviewed commit?", isPresented: presentation($isConfirmingPush)) {
            Button("Push to \(model.pushCapability?.remote ?? "remote")") {
                Task {
                    await withRemoteContext { client, context in
                        await model.push(
                            client: client,
                            workspaceId: workspace.id,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Destination: \(model.pushCapability?.branch ?? "current branch"). Aiden never force-pushes.")
        }
    }

    private var commitSheet: some View {
        NavigationStack {
            Form {
                Section("Commit message") {
                    TextField("Describe the change", text: $commitMessage, axis: .vertical)
                }
                Section { Toggle("Staged changes only", isOn: $stagedOnly) }
            }
            .navigationTitle("Commit Changes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isShowingCommit = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Review Commit") { isConfirmingCommit = true }
                        .disabled(commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .confirmationDialog("Commit the reviewed snapshot?", isPresented: presentation($isConfirmingCommit)) {
                Button("Commit Changes") {
                    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                    isShowingCommit = false
                    Task {
                        await withRemoteContext { client, context in
                            await model.commit(
                                client: client,
                                workspaceId: workspace.id,
                                message: message,
                                stagedOnly: stagedOnly,
                                isCurrent: { coordinator.isCurrent(context) }
                            )
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Aiden Agent will create a Git commit from the exact reviewed snapshot.")
            }
        }
    }

    private func diffSheet(_ diff: AidenGitDiff) -> some View {
        NavigationStack {
            diffContent(diff)
                .navigationTitle(diff.displayPath)
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func diffContent(_ diff: AidenGitDiff) -> some View {
        AidenWorkspaceDiffView(diff: diff)
    }

    private func gitFileButton(_ file: AidenGitFile, comparisonMode: Bool) -> some View {
        Button {
            Task {
                await withRemoteContext { client, context in
                    await model.diff(
                        client: client,
                        workspaceId: workspace.id,
                        file: file,
                        comparisonMode: comparisonMode,
                        isCurrent: { coordinator.isCurrent(context) }
                    )
                }
            }
        } label: {
            HStack {
                Text(file.status.symbol).font(.system(.body, design: .monospaced)).foregroundStyle(file.status.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.displayPath).foregroundStyle(.primary).lineLimit(1)
                    if file.additions != nil || file.deletions != nil {
                        Text("+\(file.additions ?? 0)  −\(file.deletions ?? 0)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func refresh() async {
        guard coordinator.connectionState == .connected else {
            model.errorMessage = "Connect to Aiden Agent to use Git."
            return
        }
        await withRemoteContext { client, context in
            await model.refresh(
                client: client,
                workspaceId: workspace.id,
                isCurrent: { coordinator.isCurrent(context) }
            )
        }
    }

    private func withRemoteContext(
        _ operation: @MainActor (AidenRemoteClient, AidenRemoteRequestContext) async -> Void
    ) async {
        guard let context = try? coordinator.requestContext(),
              model.accepts(installationID: context.instanceId),
              let client = try? coordinator.remoteClient(for: context) else { return }
        await operation(client, context)
    }
}

private extension AidenGitFileStatus {
    var symbol: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "?"
        case .conflicted: "U"
        }
    }

    var tint: Color {
        switch self {
        case .added, .untracked: .green
        case .deleted, .conflicted: .red
        case .modified, .renamed: .orange
        }
    }
}

@MainActor
@Observable
final class AidenWorkspaceSubagentsModel {
    enum Status: Equatable { case idle, loading, ready, unsupported, denied, offline, failed }
    let installationID: String
    let workspaceID: String
    let chatID: String
    private(set) var status = Status.idle
    private(set) var page: AidenWorkspaceSubagentPage?
    var selectedID: String?
    private var generation = 0
    private var isActive = false
    private var context: AidenRemoteRequestContext?

    init(installationID: String, workspaceID: String, chatID: String) {
        self.installationID = installationID
        self.workspaceID = workspaceID
        self.chatID = chatID
    }

    func clear() {
        generation += 1
        page = nil
        selectedID = nil
        context = nil
        isActive = false
        status = .idle
    }

    func clearUnless(context current: AidenRemoteRequestContext?) {
        if context != current { clear() }
    }

    func beginLoading() -> Int {
        generation += 1
        status = .loading
        return generation
    }

    func accept(_ page: AidenWorkspaceSubagentPage, generation request: Int) throws {
        guard request == generation else { return }
        let validated = try page.validated(workspaceID: workspaceID, chatID: chatID)
        let previousRevisions = Dictionary(uniqueKeysWithValues: (self.page?.runs ?? []).map { ($0.id, $0.revision) })
        guard validated.runs.allSatisfy({ $0.revision >= (previousRevisions[$0.id] ?? 0) }) else {
            throw AidenRemoteClientError.invalidResponse
        }
        self.page = validated
        if !page.runs.contains(where: { $0.id == selectedID }) { selectedID = nil }
        status = .ready
    }

    func activate(coordinator: AidenRemoteCoordinator, active: Bool, force: Bool = false) async {
        guard active else {
            if isActive { generation += 1 }
            isActive = false
            if status == .loading { status = .idle }
            return
        }
        guard coordinator.activeInstanceId == installationID,
              let requestContext = try? coordinator.requestContext(for: installationID) else { clear(); return }
        guard coordinator.connectionState == .connected else { clear(); status = .offline; return }
        guard coordinator.server?.features.contains("workspace-subagents-v1") == true else {
            clear(); status = .unsupported; return
        }
        if !force, isActive, context == requestContext, status == .ready || status == .loading { return }
        if context != requestContext { clear() }
        context = requestContext
        isActive = true
        let request = beginLoading()
        do {
            let page = try await coordinator.remoteClient(for: requestContext).workspaceSubagents(workspaceId: workspaceID, chatId: chatID)
            guard coordinator.isCurrent(requestContext), isActive else { return }
            try accept(page, generation: request)
        } catch {
            guard request == generation, coordinator.isCurrent(requestContext), isActive else { return }
            if await coordinator.handleCredentialRevocation(error, context: requestContext) { clear(); return }
            guard request == generation, coordinator.isCurrent(requestContext), isActive else { return }
            page = nil
            selectedID = nil
            if case AidenRemoteClientError.server(let statusCode, let body) = error,
               statusCode == 403 || body.code.rawValue == "capability_denied" {
                status = .denied
            } else {
                status = .failed
            }
        }
    }
}

struct AidenWorkspaceSubagentsView: View {
    @Bindable var model: AidenWorkspaceSubagentsModel
    let coordinator: AidenRemoteCoordinator
    let active: Bool
    private struct Activation: Equatable {
        let active: Bool
        let context: AidenRemoteRequestContext?
        let supported: Bool
        let connected: Bool
    }
    private var activation: Activation {
        Activation(active: active, context: try? coordinator.requestContext(),
                   supported: coordinator.server?.features.contains("workspace-subagents-v1") == true,
                   connected: coordinator.connectionState == .connected)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Subagents").font(.headline)
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await model.activate(coordinator: coordinator, active: active, force: true) }
                }
                .disabled(!active || coordinator.connectionState != .connected || model.status == .loading)
            }.padding(12)
            switch model.status {
            case .idle, .loading:
                ProgressView("Loading subagents…").frame(maxWidth: .infinity, maxHeight: .infinity)
            case .unsupported:
                message("Update Aiden Agent on the Mac to view subagent summaries here.", symbol: "arrow.down.app")
            case .denied:
                message("On the Mac, open Settings → Remote Access → Subagent summaries and allow this device for the current Mac session.", symbol: "lock")
            case .offline:
                message("Connect to the paired Mac to view subagent summaries.", symbol: "wifi.slash")
            case .failed:
                message("Subagent summaries could not be loaded. Try Refresh.", symbol: "exclamationmark.triangle")
            case .ready:
                if let selected = model.page?.runs.first(where: { $0.id == model.selectedID }) {
                    VStack(alignment: .leading, spacing: 16) {
                        Button("All subagents", systemImage: "chevron.backward") { model.selectedID = nil }
                        Text(selected.label).font(.title3)
                        LabeledContent("Role", value: selected.role.rawValue.capitalized)
                        LabeledContent("Status", value: selected.state.title)
                        LabeledContent("Updated") {
                            Text(Date(timeIntervalSince1970: Double(selected.updatedAt) / 1000), style: .relative)
                        }
                        Text("This summary does not include private task instructions or child conversation history.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                    }.padding()
                } else if model.page?.runs.isEmpty == true {
                    message("No subagent runs in this chat yet.", symbol: "person.2")
                } else {
                    List {
                        ForEach(model.page?.runs ?? []) { run in
                            Button { model.selectedID = run.id } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(run.label).foregroundStyle(.primary)
                                    Text("\(run.role.rawValue.capitalized) · \(run.state.title)")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        if model.page?.truncated == true {
                            Text("Showing the 100 most recent runs.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .task(id: activation) { await model.activate(coordinator: coordinator, active: active) }
    }

    private func message(_ text: String, symbol: String) -> some View {
        ContentUnavailableView("Subagents", systemImage: symbol, description: Text(text))
    }
}

/// Owns the actual page, independently of SwiftUI layout and Aiden's API transport.
@MainActor @Observable
final class AidenNativeBrowserTab: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id = UUID()
    let webView: WKWebView
    var title = "New tab"
    var address = ""
    var canGoBack = false
    var canGoForward = false
    var loading = false
    var message: String?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    init(dataStore: WKWebsiteDataStore) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        observations = [
            webView.observe(\.title, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.synchronize() } },
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.synchronize() } },
            webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.synchronize() } }
        ]
    }

    private func synchronize() {
        title = webView.title?.isEmpty == false ? webView.title! : (webView.url?.host ?? "New tab")
        address = webView.url?.absoluteString ?? ""
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
        loading = webView.isLoading
    }

    func open(_ input: String) {
        guard let url = AidenNativeBrowserAddress.url(input) else {
            message = "Enter a full http:// or https:// address without embedded credentials."
            return
        }
        message = nil
        // Deliberately a fresh request: no Aiden credential, pinning override, or script bridge.
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              AidenNativeBrowserAddress.url(url.absoluteString) != nil else {
            // Web apps commonly create empty/srcdoc iframes; these carry no external authority.
            let internalFrame = navigationAction.targetFrame?.isMainFrame == false
                && ["about:blank", "about:srcdoc"].contains(navigationAction.request.url?.absoluteString ?? "")
            decisionHandler(internalFrame ? .allow : .cancel)
            return
        }
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { message = error.localizedDescription }
        synchronize()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { message = error.localizedDescription }
        synchronize()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { synchronize() }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        message = "This page stopped. Reload to continue."
        synchronize()
    }
}

@MainActor @Observable
final class AidenWorkspaceBrowserModel {
    private var dataStore = WKWebsiteDataStore.nonPersistent()
    private var context: AidenRemoteRequestContext?
    private(set) var tabs: [AidenNativeBrowserTab] = []
    var selectedTabID: UUID?
    var addressInput = ""
    var portInput = "3000"
    var developmentHost: String?
    var message: String?
    var selectedTab: AidenNativeBrowserTab? { tabs.first { $0.id == selectedTabID } }

    func clearUnless(context next: AidenRemoteRequestContext?) {
        if next == nil || (context != nil && context != next) {
            for tab in tabs {
                tab.webView.stopLoading()
                tab.webView.navigationDelegate = nil
                tab.webView.uiDelegate = nil
                tab.webView.removeFromSuperview()
            }
            tabs.removeAll()
            selectedTabID = nil
            addressInput = ""
            developmentHost = nil
            message = nil
            dataStore = WKWebsiteDataStore.nonPersistent()
        }
        context = next
    }

    func updateHint(serverHost: String?, endpoint: URL?) {
        developmentHost = AidenNativeBrowserAddress.developmentHost(serverHost)
            ?? AidenNativeBrowserAddress.developmentHost(endpoint?.host)
    }

    func addTab() {
        guard tabs.count < 8 else { message = "Close a tab before opening another (8 maximum)."; return }
        let tab = AidenNativeBrowserTab(dataStore: dataStore)
        tabs.append(tab)
        select(tab)
    }

    func select(_ tab: AidenNativeBrowserTab) { selectedTabID = tab.id; addressInput = tab.address; message = nil }

    func close(_ tab: AidenNativeBrowserTab) {
        tab.webView.stopLoading()
        tabs.removeAll { $0.id == tab.id }
        if selectedTabID == tab.id {
            selectedTabID = tabs.last?.id
            addressInput = selectedTab?.address ?? ""
        }
    }

    func openAddress() {
        guard let destination = AidenNativeBrowserAddress.resolvedURL(addressInput, developmentHost: developmentHost) else {
            message = "Enter the Mac’s full http:// or https:// Tailscale address. Localhost requires a paired Mac Tailscale address."
            return
        }
        let original = addressInput
        let input = destination.absoluteString
        if selectedTab == nil { addTab() }
        selectedTab?.open(input)
        addressInput = input
        message = original == input ? nil : "Opening \(input)"
    }

    func openPort() {
        guard let url = AidenNativeBrowserAddress.developmentURL(host: developmentHost, port: portInput) else {
            message = "Enter a port from 1 to 65535, or enter the Mac’s full Tailscale URL above."
            return
        }
        addressInput = url.absoluteString
        openAddress()
    }
}

private struct AidenNativeBrowserPage: UIViewRepresentable {
    let tab: AidenNativeBrowserTab
    func makeUIView(context: Context) -> WKWebView { tab.webView }
    // Never load from updateUIView: resizing must preserve the DOM, forms, history, and HMR connection.
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct AidenWorkspaceBrowserView: View {
    @Bindable var model: AidenWorkspaceBrowserModel
    let coordinator: AidenRemoteCoordinator
    var active: Bool
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal) {
                HStack {
                    ForEach(model.tabs) { tab in
                        Button { model.select(tab) } label: {
                            Label(tab.title, systemImage: model.selectedTabID == tab.id ? "globe" : "rectangle")
                                .lineLimit(1).frame(maxWidth: 160)
                        }
                        Button("Close \(tab.title)", systemImage: "xmark") { model.close(tab) }.labelStyle(.iconOnly)
                    }
                    Button("New tab", systemImage: "plus") { model.addTab() }.labelStyle(.iconOnly)
                }.buttonStyle(.bordered)
            }
            HStack {
                Button("Back", systemImage: "chevron.left") { model.selectedTab?.webView.goBack() }
                    .disabled(model.selectedTab?.canGoBack != true)
                Button("Forward", systemImage: "chevron.right") { model.selectedTab?.webView.goForward() }
                    .disabled(model.selectedTab?.canGoForward != true)
                Button(model.selectedTab?.loading == true ? "Stop" : "Reload", systemImage: model.selectedTab?.loading == true ? "xmark" : "arrow.clockwise") {
                    guard let tab = model.selectedTab else { return }
                    if tab.loading { tab.webView.stopLoading() } else { tab.webView.reload() }
                }.disabled(model.selectedTab == nil)
                TextField("http://Mac-Tailscale-IP:3000", text: $model.addressInput)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder).focused($addressFocused)
                    .onSubmit { addressFocused = false; model.openAddress() }
                    .accessibilityLabel("Website address")
                Button("Open", systemImage: "arrow.up.right") { addressFocused = false; model.openAddress() }
            }.labelStyle(.iconOnly).buttonStyle(.bordered)
            if let host = model.developmentHost {
                HStack {
                    Text(host).font(.caption).lineLimit(1)
                    TextField("Port", text: $model.portInput).keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder).frame(width: 80).accessibilityLabel("Development server port")
                    Button("Open port") { model.openPort() }.buttonStyle(.bordered)
                }
            }
            if let message = model.message ?? model.selectedTab?.message { Text(message).font(.caption).foregroundStyle(.secondary) }
            if let tab = model.selectedTab {
                AidenNativeBrowserPage(tab: tab).id(tab.id)
            } else {
                ContentUnavailableView("Open your development website", systemImage: "globe", description: Text("Connect this device and your Mac to Tailscale. Start the Mac’s server on 0.0.0.0, then open its Tailscale address and port. Pages run here, with their own website sign-in."))
            }
        }
        .padding(8)
        .onAppear { updateHint() }
        .onChange(of: coordinator.server?.developmentHost) { _, _ in updateHint() }
        .onChange(of: active) { _, value in if value { updateHint() } else { addressFocused = false } }
        .onChange(of: model.selectedTab?.address) { _, address in if !addressFocused { model.addressInput = address ?? "" } }
    }

    private func updateHint() {
        model.clearUnless(context: try? coordinator.requestContext())
        model.updateHint(serverHost: coordinator.server?.developmentHost,
                         endpoint: coordinator.installationStore.activeInstallation?.endpoint)
    }
}
