import SwiftUI

struct AidenWorkspacesDirectoryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var archiveStore: AidenWorkspaceArchiveStore
    /// This list is the Workspaces tab's root: rows push routes and the
    /// toolbar carries compose.
    let tabChrome: AidenWorkspacesTabChrome
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
        archiveStore.archivedWorkspaceIDs(for: coordinator.defaultInstanceId)
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

    private func matchesSearch(_ workspace: AidenWorkspace) -> Bool {
        searchText.isEmpty
            || workspace.name.localizedCaseInsensitiveContains(searchText)
            || workspace.repositoryName?.localizedCaseInsensitiveContains(searchText) == true
            || workspace.branchName?.localizedCaseInsensitiveContains(searchText) == true
    }

    /// Every shown machine's workspaces: the strip, then each machine's under its
    /// name when the strip says All. The selected machine's rows keep their
    /// actions; another machine's open its page, where Settings works on it.
    @ViewBuilder
    private func machineRows(_ machines: AidenWorkspacesTabMachines) -> some View {
        AidenMachineStrip(labels: machines.roster.tabMachines, offline: machines.roster.offlineIDs, filter: machines.filter)
            .listRowInsets(EdgeInsets(top: AidenSpacing.xs, leading: 0, bottom: AidenSpacing.xs, trailing: 0))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        let sections = machines.sections.map { section in
            AidenMachineSection(instanceId: section.instanceId, rows: section.rows.filter { matchesSearch($0.workspace) })
        }
        if sections.allSatisfy(\.rows.isEmpty) {
            ContentUnavailableView(
                searchText.isEmpty ? "No Workspaces" : "No Matching Workspaces",
                systemImage: searchText.isEmpty ? "folder" : "magnifyingglass",
                description: Text(searchText.isEmpty
                    ? "Create a workspace or add a folder to get started."
                    : "Try a different search term.")
            )
            .listRowBackground(Color.clear)
        }
        ForEach(sections) { section in
            if !section.rows.isEmpty {
                let positions = AidenListCardPosition.positions(section.rows.map(\.id))
                Section {
                    ForEach(section.rows) { row in
                        machineRow(row, card: positions[row.id])
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        if machines.filter.wrappedValue == .all {
                            AidenListSectionHeader(title: machines.roster.labels[section.instanceId]?.name ?? "")
                        }
                        AidenMachineSectionStatus(
                            coordinator: coordinator,
                            instanceId: section.instanceId,
                            savedListName: String(localized: "workspaces")
                        )
                        .textCase(nil)
                        .padding(.horizontal, AidenSpacing.xl)
                        .padding(.bottom, AidenSpacing.s)
                    }
                    // The header row is this stack, so the zero inset goes
                    // here for its titles to line up with the other lists'.
                    .listRowInsets(EdgeInsets())
                }
            }
        }
    }

    var body: some View {
        List {
            if let machines = tabChrome.machines {
                machineRows(machines)
            } else if filteredWorkspaces.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Workspaces" : "No Matching Workspaces",
                    systemImage: searchText.isEmpty ? "folder" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Create a workspace or add a folder to get started."
                        : "Try a different search term.")
                )
                .listRowBackground(Color.clear)
            } else {
                let positions = AidenListCardPosition.positions(filteredWorkspaces.map(\.id))
                Color.clear.frame(height: AidenSpacing.s)
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
                    .listRowInsets(EdgeInsets())
                ForEach(filteredWorkspaces) { workspace in
                    interactiveRow(workspace, isArchived: false, scrollRow: AnyHashable(workspace.id), card: positions[workspace.id])
                }
            }

            if searchText.isEmpty {
                Section {
                    if tabChrome.besideList {
                        // Beside the detail a page link would take the detail
                        // column outside the tab's path, and picking a
                        // workspace afterwards couldn't bring it back. An
                        // archived row only unarchives, so the rows open here.
                        DisclosureGroup {
                            if archivedWorkspaces.isEmpty {
                                Text("Workspaces archived on this device appear here.")
                                    .foregroundStyle(palette.secondary)
                            } else {
                                let positions = AidenListCardPosition.positions(archivedWorkspaces.map(\.id))
                                ForEach(archivedWorkspaces) { workspace in
                                    interactiveRow(workspace, isArchived: true, card: positions[workspace.id])
                                }
                            }
                        } label: {
                            Label("Archived Workspaces", systemImage: "archivebox")
                        }
                    } else {
                        NavigationLink {
                            AidenArchivedWorkspacesView(
                                coordinator: coordinator,
                                workspaces: archivedWorkspaces,
                                row: { interactiveRow($0, isArchived: $1, card: $2) }
                            )
                        } label: {
                            Label("Archived Workspaces", systemImage: "archivebox")
                                .padding(.vertical, AidenSpacing.m)
                                .padding(.horizontal, AidenSpacing.s)
                        }
                        .aidenListCardRow(.only)
                    }
                } footer: {
                    Text("Archived workspaces and their chats are hidden only on this device.")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(AidenSpacing.l)
        .aidenKeepsListScroll()
        .scrollContentBackground(.hidden)
        .background { palette.canvas.ignoresSafeArea() }
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(.automatic)
        .searchable(text: $searchText, prompt: "Search workspaces")
        .searchToolbarBehavior(.minimize)
        .refreshable {
            if let machines = tabChrome.machines {
                await machines.refresh()
            } else {
                await coordinator.refreshWorkspaces()
            }
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
        .toolbar {
            DefaultToolbarItem(kind: .search, placement: .primaryAction)
            ToolbarSpacer(.fixed, placement: .primaryAction)
            ToolbarItem(placement: .primaryAction) { addWorkspaceMenu }
            ToolbarSpacer(.fixed, placement: .primaryAction)
            ToolbarItem(placement: .primaryAction) {
                AidenNewWorkComposeButton(
                    flow: tabChrome.newWork,
                    preferredMachine: tabChrome.composeMachine,
                    offersHiddenMachines: true
                )
            }
            .aidenKeptLongestInBar()
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
            Text("Creates a workspace registry entry without a folder. You can add a folder later from Aiden Agent.")
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
            Text("Aiden Agent will create and manage the worktree on your computer.")
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
            Text("This updates the workspace name in Aiden Agent on your computer and paired clients. It does not rename the folder on disk.")
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
                    instanceID: coordinator.defaultInstanceId
                )
                workspacePendingFirstArchive = nil
            }
        } message: {
            Text("This hides the workspace and its chats only on this iPhone or iPad. It stays available in Aiden Agent on your computer and on other devices.")
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
                            instanceID: coordinator.defaultInstanceId
                        )
                        coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "workspace-remove:\(workspace.id):\(workspace.revision)")
                    } else if outcome.isDefinitiveFailure {
                        coordinator.haptics.play(.error, scope: hapticScope)
                    }
                }
            }
            .disabled(coordinator.connectionState != .connected || coordinator.isMutating)
        } message: {
            Text("This unregisters the workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your computer, but its chats will no longer be listed. Delete the folder separately in your system file manager if you no longer need it.")
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
                Label("Add Folder", systemImage: "folder.badge.plus")
            }
        } label: {
            // The bar shows only the icon; the title is what the menu reads
            // when the bar folds this into its overflow beside the detail.
            Label("Add Workspace", systemImage: "plus")
        }
        .accessibilityLabel("Add workspace")
    }

    /// A workspace on any machine: the default machine's can be changed from
    /// here, another's only opened.
    @ViewBuilder
    private func machineRow(_ row: AidenMachineWorkspaceRow, card: AidenListCardPosition?) -> some View {
        if row.id.instanceId == coordinator.defaultInstanceId {
            interactiveRow(row.workspace, isArchived: false, scrollRow: AnyHashable(row.id), card: card)
        } else {
            AidenWorkspaceOpenRow(
                workspace: row.workspace,
                route: .workspace(row.id),
                tabChrome: tabChrome,
                scrollRow: AnyHashable(row.id),
                card: card
            )
        }
    }

    private func interactiveRow(
        _ workspace: AidenWorkspace, isArchived: Bool, scrollRow: AnyHashable? = nil, card: AidenListCardPosition? = nil
    ) -> some View {
        AidenWorkspaceInteractiveRow(
            coordinator: coordinator,
            workspace: workspace,
            isArchived: isArchived,
            tabChrome: tabChrome,
            scrollRow: scrollRow,
            card: card,
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
                instanceID: coordinator.defaultInstanceId
            )
        } else if archiveStore.hasAcknowledgedDeviceOnlyArchive {
            archiveStore.archive(
                workspaceID: workspace.id,
                instanceID: coordinator.defaultInstanceId
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
    @ViewBuilder let row: (AidenWorkspace, Bool, AidenListCardPosition?) -> Row
    @Environment(\.aidenPalette) private var palette
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
                .listRowSeparator(.hidden)
            } else {
                let positions = AidenListCardPosition.positions(filteredWorkspaces.map(\.id))
                ForEach(filteredWorkspaces) { workspace in
                    row(workspace, true, positions[workspace.id])
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(AidenSpacing.l)
        // The canvas, as on the Workspaces list it opens from.
        .scrollContentBackground(.hidden)
        .background { palette.canvas.ignoresSafeArea() }
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
    let tabChrome: AidenWorkspacesTabChrome
    let scrollRow: AnyHashable?
    let card: AidenListCardPosition?
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
                .aidenListCardRow(card)
            } else {
                AidenWorkspaceOpenRow(workspace: workspace, route: tabChrome.route(workspace), tabChrome: tabChrome, scrollRow: scrollRow, card: card)
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

struct AidenWorkspaceRow: View {
    let workspace: AidenWorkspace
    @Environment(\.aidenPalette) private var palette
    // The folder sits in the mark column the other lists use, at a size that
    // grows with the text but never outgrows its column.
    @ScaledMetric(relativeTo: .body) private var scaledMarkSize: CGFloat = 24
    private var markSize: CGFloat { min(scaledMarkSize, 40) }

    private var detail: String {
        [workspace.permission.title, workspace.branchName ?? workspace.git?.branch]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    var body: some View {
        AidenListRowLayout(isStacked: false, hasSummary: true, markStyle: .avatar(markSize)) {
            Image(systemName: workspace.isManagedWorktree ? "hammer" : workspace.hasFolder ? "folder" : "folder.badge.questionmark")
                .resizable()
                .scaledToFit()
                .frame(width: markSize * 0.8, height: markSize * 0.8)
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
        } title: {
            Text(workspace.name)
                .font(.body)
                .foregroundStyle(palette.foreground)
                .lineLimit(1)
        } summary: {
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .lineLimit(1)
        } trailing: {
            EmptyView()
        }
        .accessibilityElement(children: .combine)
    }
}

/// A workspace row that opens its page on the Workspaces tab. The tab is a
/// split view at every width, so the row goes through the tab's navigation
/// rather than a link that pushes on the stack it sits in. On a stack it reads
/// as a link; beside the page it opened it's highlighted.
private struct AidenWorkspaceOpenRow: View {
    @Environment(\.aidenPalette) private var palette
    let workspace: AidenWorkspace
    let route: AidenAppRoute
    let tabChrome: AidenWorkspacesTabChrome
    /// The row's identity in a list that keeps its place across a fold.
    var scrollRow: AnyHashable? = nil
    /// The row's place in its section's card.
    var card: AidenListCardPosition? = nil

    private var isSelected: Bool { tabChrome.selection == route }

    var body: some View {
        Button { tabChrome.onOpen(route) } label: {
            AidenWorkspaceRow(workspace: workspace)
                .contentShape(Rectangle())
                .aidenListScrollRow(scrollRow)
        }
        .buttonStyle(.plain)
        .aidenListCardRow(card, isSelected: tabChrome.besideList && isSelected)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
}
