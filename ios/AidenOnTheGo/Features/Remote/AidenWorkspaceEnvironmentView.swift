import CryptoKit
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
        try? JSONDecoder().decode(
            Snapshot.self,
            from: Data(contentsOf: file(instanceId: instanceId, workspaceId: workspaceId))
        )
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
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var value = snapshot
        var data = try JSONEncoder().encode(value)
        if data.count > maximumBytes {
            value.documents = [:]
            data = try JSONEncoder().encode(value)
        }
        guard data.count <= maximumBytes else { return }
        try data.write(to: file(instanceId: instanceId, workspaceId: workspaceId), options: .atomic)
    }

    private func file(instanceId: String, workspaceId: String) -> URL {
        let digest = SHA256.hash(data: Data("\(instanceId)\u{0}\(workspaceId)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directory.appending(path: "\(digest).json")
    }
}

@MainActor
@Observable
final class AidenWorkspaceFilesModel {
    var index: AidenWorkspaceFileIndex?
    var document: AidenWorkspaceFileDocument?
    var draft = ""
    var isLoading = false
    var isSaving = false
    var isOfflineSnapshot = false
    var errorMessage: String?

    private let workspace: AidenWorkspace
    private let cache: AidenWorkspaceEnvironmentCache

    init(workspace: AidenWorkspace, cache: AidenWorkspaceEnvironmentCache = .shared) {
        self.workspace = workspace
        self.cache = cache
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard !isLoading, let instanceId = coordinator.activeInstanceId else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        if coordinator.connectionState == .connected {
            do {
                let value = try await coordinator.remoteClient().workspaceFiles(workspaceId: workspace.id)
                index = value
                isOfflineSnapshot = false
                try? await cache.store(index: value, instanceId: instanceId, workspaceId: workspace.id)
                return
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        if let cached = await cache.load(instanceId: instanceId, workspaceId: workspace.id) {
            index = cached.index
            isOfflineSnapshot = true
        } else if errorMessage == nil {
            errorMessage = "Connect to Aiden Agent to load workspace files."
        }
    }

    func open(_ entry: AidenWorkspaceFileEntry, coordinator: AidenRemoteCoordinator) async {
        guard entry.kind == .file, let instanceId = coordinator.activeInstanceId else { return }
        errorMessage = nil
        if coordinator.connectionState == .connected {
            do {
                let value = try await coordinator.remoteClient().workspaceFile(
                    workspaceId: workspace.id,
                    fileId: entry.id
                )
                document = value
                draft = value.content
                isOfflineSnapshot = false
                try? await cache.store(document: value, instanceId: instanceId, workspaceId: workspace.id)
                return
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        if let cached = await cache.load(instanceId: instanceId, workspaceId: workspace.id),
           let value = cached.documents[entry.id] {
            document = value
            draft = value.content
            isOfflineSnapshot = true
        }
    }

    func save(coordinator: AidenRemoteCoordinator) async -> Bool {
        guard coordinator.connectionState == .connected,
              !isSaving,
              let document,
              let instanceId = coordinator.activeInstanceId else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let saved = try await coordinator.remoteClient().writeWorkspaceFile(
                workspaceId: workspace.id,
                fileId: document.id,
                content: draft,
                expectedVersion: document.version
            )
            self.document = saved
            draft = saved.content
            try? await cache.store(document: saved, instanceId: instanceId, workspaceId: workspace.id)
            return true
        } catch {
            if case AidenRemoteClientError.server(_, let body) = error,
               body.code.rawValue == "revision_conflict" {
                errorMessage = "This file changed on the Mac. Reload it before saving again."
            } else {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    func reloadDocument(coordinator: AidenRemoteCoordinator) async {
        guard let document,
              let entry = index?.entries.first(where: { $0.id == document.id }) else { return }
        await open(entry, coordinator: coordinator)
    }
}

struct AidenWorkspaceFilesView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    @State private var model: AidenWorkspaceFilesModel
    @State private var search = ""
    @State private var isShowingDocument = false

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace) {
        self.coordinator = coordinator
        self.workspace = workspace
        _model = State(initialValue: AidenWorkspaceFilesModel(workspace: workspace))
    }

    private var entries: [AidenWorkspaceFileEntry] {
        let values = model.index?.entries ?? []
        guard !search.isEmpty else { return values }
        return values.filter { $0.displayPath.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
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
                        guard entry.kind == .file else { return }
                        Task {
                            await model.open(entry, coordinator: coordinator)
                            isShowingDocument = model.document != nil
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
                            Image(systemName: entry.kind == .directory ? "folder" : entry.kind == .symlink ? "link" : "doc.text")
                        }
                    }
                    .disabled(entry.kind != .file)
                }
            }
        }
        .overlay {
            if model.isLoading && model.index == nil { ProgressView("Loading files…") }
        }
        .navigationTitle("Files")
        .searchable(text: $search, prompt: "Find a file")
        .refreshable { await model.load(coordinator: coordinator) }
        .task { await model.load(coordinator: coordinator) }
        .sheet(isPresented: $isShowingDocument) {
            AidenWorkspaceFileEditorView(coordinator: coordinator, model: model)
        }
        .alert("Files", isPresented: Binding(
            get: { model.errorMessage != nil && !isShowingDocument },
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
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var model: AidenWorkspaceFilesModel
    @State private var isConfirmingDiscard = false

    private var isDirty: Bool { model.document.map { $0.content != model.draft } ?? false }

    var body: some View {
        NavigationStack {
            TextEditor(text: $model.draft)
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 8)
                .navigationTitle(model.document?.displayPath ?? "File")
                .navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom) {
                    if let message = model.errorMessage {
                        VStack(spacing: 8) {
                            Text(message).font(.footnote).foregroundStyle(.secondary)
                            if message.contains("changed on the Mac") {
                                Button("Reload from Mac") {
                                    Task { await model.reloadDocument(coordinator: coordinator) }
                                }
                            }
                        }
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.regularMaterial)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") {
                            if isDirty && !model.isOfflineSnapshot {
                                isConfirmingDiscard = true
                            } else {
                                dismiss()
                            }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { _ = await model.save(coordinator: coordinator) } }
                            .disabled(
                                !isDirty || model.isSaving || model.isOfflineSnapshot ||
                                coordinator.connectionState != .connected || model.document?.truncated == true
                            )
                    }
                }
        }
        .interactiveDismissDisabled(isDirty && !model.isOfflineSnapshot)
        .confirmationDialog("Discard unsaved changes?", isPresented: $isConfirmingDiscard) {
            Button("Discard Changes", role: .destructive) { dismiss() }
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

    var canRetryPendingMutation: Bool { pendingMutation != nil }

    func refresh(client: AidenRemoteClient, workspaceId: String) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let reviewResult = try await client.gitReview(workspaceId: workspaceId)
            if case .review(let value) = reviewResult.result {
                review = value
                reviewSnapshotId = reviewResult.snapshotId
            }
            let branchResult = try await client.gitBranches(workspaceId: workspaceId)
            if case .branches(let value) = branchResult.result {
                branches = value
                branchesSnapshotId = branchResult.snapshotId
            }
            let worktreeResult = try await client.gitWorktrees(workspaceId: workspaceId)
            if case .worktrees(let value) = worktreeResult.result { worktrees = value.worktrees }
        } catch { errorMessage = error.localizedDescription }
    }

    func diff(client: AidenRemoteClient, workspaceId: String, file: AidenGitFile, comparisonMode: Bool = false) async {
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
            if case .diff(let value) = result.result { selectedDiff = value }
        } catch { errorMessage = error.localizedDescription }
    }

    func commit(client: AidenRemoteClient, workspaceId: String, message: String, stagedOnly: Bool) async {
        let operation = AidenPendingGitMutation.commit(
            UUID(),
            snapshot: reviewSnapshotId ?? "",
            message: message,
            stagedOnly: stagedOnly
        )
        if await execute(operation, client: client, workspaceId: workspaceId) {
            await refresh(client: client, workspaceId: workspaceId)
        }
    }

    func checkout(client: AidenRemoteClient, workspaceId: String, branch: String) async {
        let operation = AidenPendingGitMutation.checkout(
            UUID(),
            snapshot: branchesSnapshotId ?? "",
            branch: branch
        )
        if await execute(operation, client: client, workspaceId: workspaceId) {
            await refresh(client: client, workspaceId: workspaceId)
        }
    }

    func createBranch(client: AidenRemoteClient, workspaceId: String, name: String) async {
        let operation = AidenPendingGitMutation.createBranch(
            UUID(),
            name: name,
            startPoint: branches?.current ?? "HEAD"
        )
        if await execute(operation, client: client, workspaceId: workspaceId) {
            await refresh(client: client, workspaceId: workspaceId)
        }
    }

    func preparePush(client: AidenRemoteClient, workspaceId: String) async {
        do {
            let result = try await client.gitPushCapability(workspaceId: workspaceId)
            if case .pushCapability(let value) = result.result {
                pushCapability = value
                pushSnapshotId = result.snapshotId
                if !value.allowed {
                    errorMessage = value.reason ?? "Push is unavailable for this workspace state."
                }
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func push(client: AidenRemoteClient, workspaceId: String) async {
        guard let pushCapability, let remote = pushCapability.remote, let branch = pushCapability.branch else { return }
        _ = await execute(
            .push(UUID(), snapshot: pushSnapshotId ?? "", remote: remote, branch: branch),
            client: client,
            workspaceId: workspaceId
        )
    }

    func compare(client: AidenRemoteClient, workspaceId: String, baseRef: String) async {
        do {
            let result = try await client.compareGit(workspaceId: workspaceId, baseRef: baseRef)
            if case .comparison(let value) = result.result { comparison = value }
        } catch { errorMessage = error.localizedDescription }
    }

    func createWorktree(client: AidenRemoteClient, workspaceId: String, branch: String, name: String) async {
        if await execute(
            .createWorktree(UUID(), branch: branch, name: name),
            client: client,
            workspaceId: workspaceId
        ) {
            await refresh(client: client, workspaceId: workspaceId)
        }
    }

    func retryPendingMutation(client: AidenRemoteClient, workspaceId: String) async {
        guard let pendingMutation else { return }
        if await execute(pendingMutation, client: client, workspaceId: workspaceId) {
            await refresh(client: client, workspaceId: workspaceId)
        }
    }

    private func execute(
        _ operation: AidenPendingGitMutation,
        client: AidenRemoteClient,
        workspaceId: String
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
            if case .mutation(let mutation) = value.result {
                lastMessage = mutation.warning.map { "\(mutation.message) \($0)" } ?? mutation.message
            }
            pendingMutation = nil
            return true
        } catch {
            let retain = shouldRetainForReconciliation(error)
            if !retain { pendingMutation = nil }
            errorMessage = retain
                ? "\(error.localizedDescription) Reconnect, then use Retry Last Git Operation to reconcile safely."
                : error.localizedDescription
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
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration:
            return false
        }
    }
}

struct AidenWorkspaceGitView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    @State private var model = AidenWorkspaceGitModel()
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

    private var client: AidenRemoteClient? { try? coordinator.remoteClient() }

    var body: some View {
        gitConfirmations
            .alert("Git", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { model.errorMessage = nil }
            } message: { Text(model.errorMessage ?? "The Git operation failed.") }
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

            Section("Actions") {
                Button("Commit reviewed changes", systemImage: "checkmark.circle") { isShowingCommit = true }
                    .disabled(model.review?.files.isEmpty != false)
                Button("Push reviewed commit", systemImage: "arrow.up.circle") {
                    Task {
                        guard let client else { return }
                        await model.preparePush(client: client, workspaceId: workspace.id)
                        isConfirmingPush = model.pushCapability?.allowed == true
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

            if let message = model.lastMessage {
                Section { Label(message, systemImage: "checkmark.circle") }
            }
            if model.canRetryPendingMutation {
                Section {
                    Button("Retry Last Git Operation", systemImage: "arrow.clockwise") {
                        Task {
                            if let client {
                                await model.retryPendingMutation(client: client, workspaceId: workspace.id)
                            }
                        }
                    }
                } footer: {
                    Text("Reuses the original idempotency key so reconnecting cannot duplicate the mutation.")
                }
                .disabled(coordinator.connectionState != .connected || model.isLoading)
            }
        }
        .navigationTitle("Git")
        .overlay { if model.isLoading && model.review == nil { ProgressView("Loading Git…") } }
        .refreshable { await refresh() }
        .task { await refresh() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
            }
        }
    }

    private var gitSheets: some View {
        gitList
        .sheet(isPresented: $isShowingCommit) {
            commitSheet
        }
        .sheet(item: $model.selectedDiff) { diff in
            diffSheet(diff)
        }
    }

    private var gitAlerts: some View {
        gitSheets
        .alert("Compare Branch", isPresented: $isShowingCompare) {
            TextField("Base branch", text: $compareBase)
            Button("Compare") {
                let base = compareBase.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { if let client { await model.compare(client: client, workspaceId: workspace.id, baseRef: base) } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Branch", isPresented: $isShowingNewBranch) {
            TextField("Branch name", text: $newBranch)
            Button("Create and Check Out") {
                let value = newBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { if let client { await model.createBranch(client: client, workspaceId: workspace.id, name: value) } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Managed Worktree", isPresented: $isShowingNewWorktree) {
            TextField("Branch", text: $worktreeBranch)
            TextField("Workspace name", text: $worktreeName)
            Button("Create") {
                let branch = worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                let name = worktreeName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    if let client {
                        await model.createWorktree(client: client, workspaceId: workspace.id, branch: branch, name: name)
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
                Task { if let branch, let client { await model.checkout(client: client, workspaceId: workspace.id, branch: branch) } }
            }
            Button("Cancel", role: .cancel) { checkoutBranch = nil }
        } message: { Text("Aiden Agent will switch the workspace to this branch.") }
        .confirmationDialog("Push the reviewed commit?", isPresented: $isConfirmingPush) {
            Button("Push to \(model.pushCapability?.remote ?? "remote")") {
                Task { if let client { await model.push(client: client, workspaceId: workspace.id) } }
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
            .confirmationDialog("Commit the reviewed snapshot?", isPresented: $isConfirmingCommit) {
                Button("Commit Changes") {
                    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                    isShowingCommit = false
                    Task {
                        guard let client else { return }
                        await model.commit(
                            client: client,
                            workspaceId: workspace.id,
                            message: message,
                            stagedOnly: stagedOnly
                        )
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
            ScrollView {
                Text(diff.diff)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(diff.displayPath)
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if diff.truncated {
                    Text("Diff truncated")
                        .font(.footnote)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.regularMaterial)
                }
            }
        }
    }

    private func gitFileButton(_ file: AidenGitFile, comparisonMode: Bool) -> some View {
        Button {
            Task {
                guard let client else { return }
                await model.diff(client: client, workspaceId: workspace.id, file: file, comparisonMode: comparisonMode)
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
        guard coordinator.connectionState == .connected, let client else {
            model.errorMessage = "Connect to Aiden Agent to use Git."
            return
        }
        await model.refresh(client: client, workspaceId: workspace.id)
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
