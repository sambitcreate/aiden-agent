import SwiftUI

struct AidenWorkspacesDirectoryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var archiveStore: AidenWorkspaceArchiveStore
    /// Set in the tab shell, where this list is a tab root: rows push routes and
    /// the toolbar carries compose.
    var tabChrome: AidenWorkspacesTabChrome? = nil
    @Environment(\.aidenPalette) private var palette
    @State private var searchText = ""
    @State private var isShowingFolderBrowser = false
    @State private var isShowingNewWorkspace = false
    @State private var isConfirmingScratch = false
    @State private var newWorkspaceName = ""
    @State private var workspacePendingRename: AidenWorkspace?
    @State private var workspacePendingFirstArchive: AidenWorkspace?
    @State private var workspacePendingRemoval: AidenWorkspace?
    @State private var renameText = ""
    @State private var retainedRenameDraftWorkspaceID: String?
    @State private var hapticScope = UUID()
    @AppStorage(AidenWorkspaceDefaultApplication.permissionKey) private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    private var archivedWorkspaceIDs: Set<String> {
        archiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
    }

    // Chats without a workspace live under Chats in the sidebar, not here.
    private var activeWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.choices(coordinator.workspaces).filter { !archivedWorkspaceIDs.contains($0.id) }
    }

    private var archivedWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.choices(coordinator.workspaces).filter { archivedWorkspaceIDs.contains($0.id) }
    }

    private var filteredWorkspaces: [AidenWorkspace] {
        guard !searchText.isEmpty else { return activeWorkspaces }
        return activeWorkspaces.filter { workspace in
            workspace.name.localizedCaseInsensitiveContains(searchText)
                || workspace.repositoryName?.localizedCaseInsensitiveContains(searchText) == true
                || workspace.branchName?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    var body: some View {
        List {
            if filteredWorkspaces.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Workspaces" : "No Matching Workspaces",
                    systemImage: searchText.isEmpty ? "folder" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Create a workspace or add a desktop folder to get started."
                        : "Try a different search term.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredWorkspaces) { workspace in
                    interactiveRow(workspace, isArchived: false)
                }
            }

            if searchText.isEmpty {
                Section {
                    NavigationLink {
                        AidenArchivedWorkspacesView(
                            coordinator: coordinator,
                            workspaces: archivedWorkspaces,
                            row: interactiveRow
                        )
                    } label: {
                        Label("Archived Workspaces", systemImage: "archivebox")
                    }
                } footer: {
                    Text("Archived workspaces and their chats are hidden only on this device.")
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(tabChrome == nil ? .automatic : .hidden)
        .background {
            if tabChrome != nil { palette.canvas.ignoresSafeArea() }
        }
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(tabChrome == nil ? .inline : .automatic)
        .searchable(text: $searchText, prompt: "Search workspaces")
        .searchToolbarBehavior(tabChrome == nil ? .automatic : .minimize)
        .refreshable {
            await coordinator.refreshWorkspaces()
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
        .toolbar {
            if let tabChrome {
                DefaultToolbarItem(kind: .search, placement: .primaryAction)
                ToolbarSpacer(.fixed, placement: .primaryAction)
                ToolbarItem(placement: .primaryAction) { addWorkspaceMenu }
                ToolbarSpacer(.fixed, placement: .primaryAction)
                ToolbarItem(placement: .primaryAction) { AidenNewChatButton(flow: tabChrome.newChat) }
            } else {
                ToolbarItem(placement: .primaryAction) { addWorkspaceMenu }
            }
        }
        .sheet(isPresented: $isShowingFolderBrowser) {
            AidenFolderBrowserView(coordinator: coordinator) { workspace in
                Task {
                    let application = await applyGlobalDefault(to: workspace)
                    coordinator.haptics.play(
                        application.feedback,
                        scope: hapticScope,
                        dedupeKey: "workspace-folder-add:\(workspace.id):\(workspace.revision)"
                    )
                    isShowingFolderBrowser = false
                }
            }
        }
        .alert("New Workspace", isPresented: $isShowingNewWorkspace) {
            TextField("Workspace name", text: $newWorkspaceName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    let outcome = await coordinator.createWorkspaceOutcome(.folderless(name: name))
                    if case .success(let workspace) = outcome {
                        let application = await applyGlobalDefault(to: workspace)
                        coordinator.haptics.play(application.feedback, scope: hapticScope, dedupeKey: "workspace-create:\(workspace.id):\(workspace.revision)")
                    } else if outcome.isDefinitiveFailure {
                        coordinator.haptics.play(.error, scope: hapticScope)
                    }
                }
            }
            .disabled(newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Creates a workspace registry entry without a desktop folder. You can add a folder later from Aiden Agent.")
        }
        .confirmationDialog(
            "Create a managed scratch workspace?",
            isPresented: $isConfirmingScratch,
            titleVisibility: .visible
        ) {
            Button("Create Managed Scratch") {
                Task {
                    let outcome = await coordinator.createWorkspaceOutcome(.scratch)
                    if case .success(let workspace) = outcome {
                        let application = await applyGlobalDefault(to: workspace)
                        coordinator.haptics.play(application.feedback, scope: hapticScope, dedupeKey: "workspace-create:\(workspace.id):\(workspace.revision)")
                    } else if outcome.isDefinitiveFailure {
                        coordinator.haptics.play(.error, scope: hapticScope)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Aiden Agent will create and manage the worktree on your desktop.")
        }
        .alert(
            "Rename Workspace",
            isPresented: Binding(
                get: { workspacePendingRename != nil },
                set: { if !$0 { workspacePendingRename = nil } }
            )
        ) {
            TextField("Workspace name", text: $renameText)
            Button("Cancel", role: .cancel) {
                retainedRenameDraftWorkspaceID = nil
                workspacePendingRename = nil
            }
            Button("Rename") {
                guard let workspace = workspacePendingRename else { return }
                let trimmedName = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    let outcome = await coordinator.updateWorkspaceOutcome(workspace, name: trimmedName)
                    if case .success = outcome {
                        retainedRenameDraftWorkspaceID = nil
                        coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "workspace-rename:\(workspace.id):\(trimmedName)")
                    } else if outcome.isDefinitiveFailure {
                        coordinator.haptics.play(.error, scope: hapticScope)
                    }
                    workspacePendingRename = nil
                }
            }
            .disabled(
                renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || renameText.trimmingCharacters(in: .whitespacesAndNewlines) == workspacePendingRename?.name
                    || coordinator.connectionState != .connected
                    || coordinator.isMutating
            )
        } message: {
            Text("This updates the workspace name in Aiden Agent on your desktop and paired clients. It does not rename the folder on disk.")
        }
        .alert(
            "Archive on This Device?",
            isPresented: Binding(
                get: { workspacePendingFirstArchive != nil },
                set: { if !$0 { workspacePendingFirstArchive = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { workspacePendingFirstArchive = nil }
            Button("Archive on This Device") {
                guard let workspace = workspacePendingFirstArchive else { return }
                archiveStore.acknowledgeDeviceOnlyArchive()
                archiveStore.archive(
                    workspaceID: workspace.id,
                    instanceID: coordinator.activeInstanceId
                )
                workspacePendingFirstArchive = nil
            }
        } message: {
            Text("This hides the workspace and its chats only on this iPhone or iPad. It stays available in Aiden Agent on your desktop and on other devices.")
        }
        .alert(
            "Remove from Aiden Agent?",
            isPresented: Binding(
                get: { workspacePendingRemoval != nil },
                set: { if !$0 { workspacePendingRemoval = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { workspacePendingRemoval = nil }
            Button("Remove from Aiden Agent", role: .destructive) {
                guard let workspace = workspacePendingRemoval else { return }
                workspacePendingRemoval = nil
                Task {
                    let outcome = await coordinator.removeWorkspaceOutcome(workspace)
                    if case .success = outcome {
                        archiveStore.forget(
                            workspaceID: workspace.id,
                            instanceID: coordinator.activeInstanceId
                        )
                        coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "workspace-remove:\(workspace.id):\(workspace.revision)")
                    } else if outcome.isDefinitiveFailure {
                        coordinator.haptics.play(.error, scope: hapticScope)
                    }
                }
            }
            .disabled(coordinator.connectionState != .connected || coordinator.isMutating)
        } message: {
            Text("This unregisters the workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your desktop, but its chats will no longer be listed. Delete the folder separately in your system file manager if you no longer need it.")
        }
    }

    private var addWorkspaceMenu: some View {
        Menu {
            Button {
                newWorkspaceName = ""
                isShowingNewWorkspace = true
            } label: {
                Label("New Workspace", systemImage: "folder.badge.plus")
            }

            Button { isConfirmingScratch = true } label: {
                Label("New Managed Scratch", systemImage: "hammer")
            }

            Button { isShowingFolderBrowser = true } label: {
                Label("Add Desktop Folder", systemImage: "folder.badge.plus")
            }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("Add workspace")
    }

    private func interactiveRow(_ workspace: AidenWorkspace, isArchived: Bool) -> some View {
        AidenWorkspaceInteractiveRow(
            coordinator: coordinator,
            workspace: workspace,
            isArchived: isArchived,
            route: tabChrome?.route(workspace),
            onRename: { requestRename(workspace) },
            onToggleArchive: { toggleArchive(workspace, isArchived: isArchived) },
            onRemove: workspace.isManagedWorktree || coordinator.workspaces.count <= 1
                ? nil
                : { workspacePendingRemoval = workspace }
        )
    }

    private func requestRename(_ workspace: AidenWorkspace) {
        if retainedRenameDraftWorkspaceID != workspace.id {
            renameText = workspace.name
        }
        retainedRenameDraftWorkspaceID = workspace.id
        workspacePendingRename = workspace
    }

    private func toggleArchive(_ workspace: AidenWorkspace, isArchived: Bool) {
        if isArchived {
            archiveStore.unarchive(
                workspaceID: workspace.id,
                instanceID: coordinator.activeInstanceId
            )
        } else if archiveStore.hasAcknowledgedDeviceOnlyArchive {
            archiveStore.archive(
                workspaceID: workspace.id,
                instanceID: coordinator.activeInstanceId
            )
        } else {
            workspacePendingFirstArchive = workspace
        }
    }

    @MainActor
    private func applyGlobalDefault(to workspace: AidenWorkspace) async -> AidenWorkspaceDefaultApplication {
        let permission = AidenWorkspacePermission(rawValue: defaultWorkspacePermissionRaw) ?? .ask
        return await .applying(permission, to: workspace) { await coordinator.updateWorkspace(workspace, permission: $0) }
    }
}

private struct AidenArchivedWorkspacesView<Row: View>: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspaces: [AidenWorkspace]
    @ViewBuilder let row: (AidenWorkspace, Bool) -> Row
    @State private var searchText = ""

    private var filteredWorkspaces: [AidenWorkspace] {
        guard !searchText.isEmpty else { return workspaces }
        return workspaces.filter { workspace in
            workspace.name.localizedCaseInsensitiveContains(searchText)
                || workspace.repositoryName?.localizedCaseInsensitiveContains(searchText) == true
                || workspace.branchName?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    var body: some View {
        List {
            if filteredWorkspaces.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Archived Workspaces" : "No Matching Workspaces",
                    systemImage: searchText.isEmpty ? "archivebox" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Workspaces archived on this device appear here."
                        : "Try a different search term.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredWorkspaces) { workspace in
                    row(workspace, true)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archived Workspaces")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search archived workspaces")
        .refreshable { await coordinator.refreshWorkspaces() }
    }
}

private struct AidenWorkspaceInteractiveRow: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let isArchived: Bool
    /// What the row pushes in a stack of routes. Nil pushes the detail itself.
    let route: AidenAppRoute?
    let onRename: () -> Void
    let onToggleArchive: () -> Void
    let onRemove: (() -> Void)?

    private var serverMutationDisabled: Bool {
        coordinator.connectionState != .connected || coordinator.isMutating
    }

    var body: some View {
        Group {
            if isArchived {
                Button(action: onToggleArchive) {
                    AidenWorkspaceRow(workspace: workspace)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Unarchives this workspace on this device.")
            } else if let route {
                NavigationLink(value: route) {
                    AidenWorkspaceRow(workspace: workspace)
                }
            } else {
                NavigationLink {
                    AidenDirectoryWorkspaceDetail(
                        coordinator: coordinator,
                        workspace: workspace
                    )
                } label: {
                    AidenWorkspaceRow(workspace: workspace)
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(action: onRename) {
                Label("Rename", systemImage: "pencil")
            }
            .disabled(serverMutationDisabled)
            .tint(palette.fillAccent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let onRemove {
                Button(role: .destructive, action: onRemove) {
                    Label("Remove from Agent", systemImage: "minus.circle")
                }
                .disabled(serverMutationDisabled)
                .tint(palette.fillDanger)
            }

            Button(action: onToggleArchive) {
                Label(
                    isArchived ? "Unarchive" : "Archive",
                    systemImage: isArchived ? "tray.and.arrow.up" : "archivebox"
                )
            }
            .tint(palette.warning)
        }
        .contextMenu {
            Button(action: onRename) {
                Label("Rename", systemImage: "pencil")
            }
            .disabled(serverMutationDisabled)

            Button(action: onToggleArchive) {
                Label(
                    isArchived ? "Unarchive on This Device" : "Archive on This Device",
                    systemImage: isArchived ? "tray.and.arrow.up" : "archivebox"
                )
            }

            if let onRemove {
                Divider()
                Button(role: .destructive, action: onRemove) {
                    Label("Remove from Aiden Agent", systemImage: "minus.circle")
                }
                .disabled(serverMutationDisabled)
            }
        }
        .accessibilityAction(named: Text("Rename workspace"), onRename)
        .accessibilityAction(
            named: Text(isArchived ? "Unarchive on this device" : "Archive on this device"),
            onToggleArchive
        )
    }
}

private struct AidenDirectoryWorkspaceDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace

    var body: some View {
        AidenWorkspaceDetailView(
            coordinator: coordinator,
            workspace: workspace,
            owner: nil,
            onRemoved: { dismiss() }
        )
        .id(workspace.revision)
    }
}

struct AidenWorkspaceRow: View {
    let workspace: AidenWorkspace

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: workspace.isManagedWorktree ? "hammer.fill" : workspace.hasFolder ? "folder.fill" : "folder")
                .foregroundStyle(.tint)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(workspace.name)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Text(workspace.permission.title)
                    if let branch = workspace.branchName ?? workspace.git?.branch {
                        Text("·")
                        Text(branch)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
