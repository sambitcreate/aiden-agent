import SwiftUI

struct AidenWorkspaceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The unsaved edits and the workspace they edit, held by the shell
    /// (`AidenWorkspaceSettingsSheet`) so a fold or a rename on the computer
    /// keeps them.
    @Bindable var draft: AidenWorkspaceSettingsDraft
    let onRemoved: () -> Void

    @State private var isConfirmingRemoval = false
    /// Why Remove did nothing, shown under its button.
    @State private var removalNotice: String?
    @State private var hapticScope = UUID()

    /// The workspace as the computer last described it.
    private var workspace: AidenWorkspace { draft.workspace }
    /// The machine this sheet saves on, fixed when it opened
    /// (`AidenRemoteCoordinator.updateWorkspaceOutcome(_:on:)`).
    private var context: AidenRemoteRequestContext { draft.context }

    /// The workspaces on this sheet's machine, which Remove keeps at least one of.
    private var machineWorkspaceCount: Int {
        coordinator.hosts.connection(for: context.instanceId)?.workspaces.count ?? 0
    }

    var body: some View {
        NavigationStack {
            Form {
                if let notice = coordinator.workspaceSaveNotices[draft.id] {
                    Section {
                        AidenWorkspaceSaveNoticeRow(message: notice) {
                            coordinator.dismissWorkspaceSaveNotice(draft.id)
                        }
                    }
                }
                Section {
                    TextField("Name", text: $draft.name)
                    LabeledContent("Folder", value: workspace.hasFolder ? "Connected" : "None")
                    LabeledContent("Managed worktree", value: workspace.isManagedWorktree ? "Yes" : "No")
                    if let repository = workspace.repositoryName {
                        LabeledContent("Repository", value: repository)
                    }
                } header: {
                    Text("Workspace")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let nameOnComputer = draft.nameOnComputer {
                            Text("Renamed “\(nameOnComputer)” on your computer. Save to use the name above instead.")
                        }
                        Text("Renaming updates Aiden Agent and paired clients. It does not rename the folder on disk.")
                    }
                }

                Section {
                    Picker("Permission", selection: $draft.permission) {
                        ForEach(AidenWorkspacePermission.allCases, id: \.self) { permission in
                            Text(permission.title).tag(permission)
                        }
                    }
                } header: {
                    Text("Permission")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let permissionOnComputer = draft.permissionOnComputer {
                            Text("Changed to “\(permissionOnComputer.title)” on your computer. Save to use the choice above instead.")
                        }
                        Text("\(draft.permission.detail) This setting overrides the app default for this workspace.")
                    }
                }

                Section {
                    Toggle("Use memory", isOn: $draft.memoryEnabled)
                        .aidenSwitchStyle()
                } header: {
                    Text("Memory")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let memoryOnComputer = draft.memoryOnComputer {
                            Text("Memory was turned \(memoryOnComputer ? "on" : "off") on your computer. Save to use the setting above instead.")
                        }
                        Text("When off, Aiden does not index this workspace or expose memory tools in its chats. Existing memory stays on your computer.")
                    }
                }

                Section("Workspace tools") {
                    NavigationLink {
                        AidenWorkspaceFilesView(
                            coordinator: coordinator,
                            workspace: workspace,
                            owner: context
                        )
                    } label: {
                        Label("Files", systemImage: "doc.text")
                    }
                    .disabled(!workspace.hasFolder)

                    NavigationLink {
                        AidenWorkspaceGitView(coordinator: coordinator, workspace: workspace, context: context)
                    } label: {
                        Label("Git", systemImage: "arrow.triangle.branch")
                    }
                    .disabled(!workspace.hasFolder)
                }

                if workspace.isManagedWorktree || machineWorkspaceCount > 1 {
                    Section {
                        Button(
                            workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent",
                            role: .destructive
                        ) {
                            isConfirmingRemoval = true
                        }
                    } footer: {
                        VStack(alignment: .leading, spacing: 6) {
                            if let removalNotice {
                                Label(removalNotice, systemImage: "exclamationmark.circle")
                                    .foregroundStyle(palette.warningText)
                                    .accessibilityIdentifier("workspace-settings-removal-notice")
                            }
                            Text(workspace.isManagedWorktree
                                 ? "Deleting an Aiden-managed worktree removes its checkout and may remove its branch when safe."
                                 : "Removing unregisters this workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your computer, but its chats will no longer be listed.")
                        }
                    }
                }
            }
            .navigationTitle("Workspace Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        // Against the workspace as the computer last described
                        // it, so a field the person left alone stays as it is there.
                        let workspace = self.workspace
                        let changes = draft.changes
                        let context = self.context
                        // The edit shows at once and the sheet closes; the
                        // computer's answer settles it, and a failure puts the
                        // workspace back with a notice on it.
                        coordinator.haptics.play(
                            .success,
                            scope: hapticScope,
                            dedupeKey: "workspace-settings:\(workspace.id):\(workspace.revision)"
                        )
                        // The coordinator keeps the queued save, so closing
                        // the sheet doesn't cancel it.
                        coordinator.enqueueWorkspaceSave(
                            workspace,
                            name: changes.name,
                            permission: changes.permission,
                            memoryEnabled: changes.memoryEnabled,
                            on: context
                        )
                        dismiss()
                    }
                    .disabled(!draft.canSave || !coordinator.holds(context))
                }
            }
            .confirmationDialog(
                workspace.isManagedWorktree ? "Delete \(workspace.name)?" : "Remove \(workspace.name) from Aiden Agent?",
                isPresented: $isConfirmingRemoval,
                titleVisibility: .visible
            ) {
                Button(workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent", role: .destructive) {
                    let workspace = self.workspace
                    removalNotice = nil
                    Task {
                        let outcome = await coordinator.removeWorkspaceOutcome(workspace, on: context)
                        if case .busy = outcome {
                            removalNotice = String(localized: "Another change is still on its way to your computer. Try again in a moment.")
                            coordinator.haptics.play(.warning, scope: hapticScope)
                        } else if case .success = outcome {
                            coordinator.haptics.play(
                                .success,
                                scope: hapticScope,
                                dedupeKey: "workspace-remove:\(workspace.id):\(workspace.revision)"
                            )
                            onRemoved()
                        } else if outcome.isDefinitiveFailure {
                            coordinator.haptics.play(.error, scope: hapticScope)
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(workspace.isManagedWorktree
                     ? "This destructive Git operation is performed by Aiden Agent using its persisted worktree ownership record."
                     : "The folder, its files, and chats remain on your computer, but the chats will no longer be listed. Delete the folder separately in your system file manager if you no longer need it.")
            }
        }
        // The shell's alert sits under this sheet, so a failed Remove says so
        // here. A failed Save leaves a notice on the workspace instead.
        .alert(
            "Aiden On The Go",
            isPresented: Binding(
                get: { coordinator.presentedError != nil },
                set: { if !$0 { coordinator.presentedError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { coordinator.presentedError = nil }
        } message: {
            Text(coordinator.presentedError ?? "The operation could not be completed.")
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
    }
}

/// An open Workspace Settings sheet's unsaved edits, and the workspace they
/// edit as the computer last described it.
@MainActor
@Observable
final class AidenWorkspaceSettingsDraft: Identifiable {
    /// The workspace, on its own machine.
    let id: AidenHostObjectID
    /// The machine the sheet saves on, fixed when it opened.
    let context: AidenRemoteRequestContext
    var name: String
    var permission: AidenWorkspacePermission
    var memoryEnabled: Bool
    /// The workspace as the computer last described it: what Save compares
    /// against and what the rest of the sheet shows.
    private(set) var workspace: AidenWorkspace
    /// The computer renamed the workspace while this sheet's name was edited.
    private var renamedOnComputer = false
    private var permissionChangedOnComputer = false
    private var memoryChangedOnComputer = false
    /// The workspace as the machine itself last confirmed it, without this
    /// phone's unanswered edits. Nil when the opener didn't know it.
    private var confirmed: AidenWorkspace?

    init(
        workspace: AidenWorkspace,
        id: AidenHostObjectID,
        context: AidenRemoteRequestContext,
        confirmed: AidenWorkspace? = nil
    ) {
        self.id = id
        self.context = context
        self.workspace = workspace
        self.confirmed = confirmed
        name = workspace.name
        permission = workspace.permission
        memoryEnabled = workspace.memoryEnabled
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What Save sends: each field the person changed, and nil for the rest.
    var changes: (name: String?, permission: AidenWorkspacePermission?, memoryEnabled: Bool?) {
        (
            trimmedName == workspace.name ? nil : trimmedName,
            permission == workspace.permission ? nil : permission,
            memoryEnabled == workspace.memoryEnabled ? nil : memoryEnabled
        )
    }

    var canSave: Bool {
        let changes = changes
        return !trimmedName.isEmpty && (changes.name != nil || changes.permission != nil || changes.memoryEnabled != nil)
    }

    /// The name the computer gave the workspace while the person was editing
    /// theirs. Neither is dropped: the field keeps theirs, and this shows the
    /// computer's until they save, cancel or type the same.
    var nameOnComputer: String? {
        renamedOnComputer && trimmedName != workspace.name ? workspace.name : nil
    }

    /// The permission the computer set while the person had chosen another,
    /// shown the same way as `nameOnComputer`.
    var permissionOnComputer: AidenWorkspacePermission? {
        permissionChangedOnComputer && permission != workspace.permission ? workspace.permission : nil
    }

    /// The memory setting the computer chose while the person had changed it.
    var memoryOnComputer: Bool? {
        memoryChangedOnComputer && memoryEnabled != workspace.memoryEnabled ? workspace.memoryEnabled : nil
    }

    /// The workspace changed under the sheet (a rename on the computer, or
    /// this phone's own save settling). Fields the person hasn't touched
    /// follow it; edited ones stay as they set them. A field shows the
    /// computer's value beside theirs only when the computer's confirmed copy
    /// changed it, so this phone's own rollback is never blamed on the computer.
    func follow(_ latest: AidenWorkspace, confirmed latestConfirmed: AidenWorkspace? = nil) {
        let previousConfirmed = confirmed
        if let latestConfirmed { confirmed = latestConfirmed }
        guard latest != workspace else { return }
        func changedOnComputer<Value: Equatable>(_ field: KeyPath<AidenWorkspace, Value>) -> Bool {
            guard let previousConfirmed, let latestConfirmed else { return true }
            return previousConfirmed[keyPath: field] != latestConfirmed[keyPath: field]
        }
        if trimmedName == workspace.name {
            name = latest.name
        } else if latest.name != workspace.name, changedOnComputer(\.name) {
            renamedOnComputer = true
        }
        if permission == workspace.permission {
            permission = latest.permission
        } else if latest.permission != workspace.permission, changedOnComputer(\.permission) {
            permissionChangedOnComputer = true
        }
        if memoryEnabled == workspace.memoryEnabled {
            memoryEnabled = latest.memoryEnabled
        } else if latest.memoryEnabled != workspace.memoryEnabled, changedOnComputer(\.memoryEnabled) {
            memoryChangedOnComputer = true
        }
        workspace = latest
    }
}

/// The Workspace Settings sheet, held by the shell above the split/stack
/// switch. Opening or closing an iPhone Duo, or a rename on the computer,
/// rebuilds the workspace page, and the sheet and its edits outlive both.
@MainActor
@Observable
final class AidenWorkspaceSettingsSheet {
    private(set) var draft: AidenWorkspaceSettingsDraft?

    /// Opens the sheet on a workspace. The one already open on it keeps its edits.
    func present(
        _ workspace: AidenWorkspace,
        id: AidenHostObjectID,
        context: AidenRemoteRequestContext,
        confirmed: AidenWorkspace? = nil
    ) {
        if let draft, draft.id == id, draft.context.sharesLease(with: context) { return }
        draft = AidenWorkspaceSettingsDraft(workspace: workspace, id: id, context: context, confirmed: confirmed)
    }

    func close() {
        draft = nil
    }

    /// What the open sheet's workspace and machine are now. A workspace that
    /// was removed or archived, or a machine paired again or gone, closes it
    /// rather than save somewhere else.
    func follow(_ source: AidenWorkspaceSettingsSource) {
        guard let draft else { return }
        guard let latest = source.workspace, latest.id == draft.id.objectId,
              let owner = source.owner, owner.sharesLease(with: draft.context) else {
            close()
            return
        }
        draft.follow(latest, confirmed: source.confirmed)
    }

    /// The default machine changed. A sheet open on the old one closes, as
    /// its Git page follows the default.
    func defaultMachineChanged(from oldDefault: String?) {
        if let draft, draft.context.instanceId == oldDefault { close() }
    }
}

private extension AidenRemoteRequestContext {
    /// The same machine and pairing, as `AidenHostConnection.isLive` judges
    /// it. `generation` moves whenever a machine becomes the default, which
    /// changes nothing about where Settings save.
    func sharesLease(with other: AidenRemoteRequestContext) -> Bool {
        instanceId == other.instanceId && deviceId == other.deviceId && hostGeneration == other.hostGeneration
    }
}

/// An open Workspace Settings sheet's workspace and machine as they are now,
/// with nil for either once it's gone.
struct AidenWorkspaceSettingsSource: Equatable {
    var workspace: AidenWorkspace?
    var owner: AidenRemoteRequestContext?
    /// The workspace as its machine confirmed it, without this phone's
    /// unanswered edits.
    var confirmed: AidenWorkspace?

    @MainActor
    static func current(for id: AidenHostObjectID, on coordinator: AidenRemoteCoordinator) -> Self {
        let connection = coordinator.hosts.connection(for: id.instanceId)
        return AidenWorkspaceSettingsSource(
            workspace: AidenWorkspaceRoute.workspace(for: id, coordinator: coordinator),
            owner: try? connection?.requestContext(scope: .owner),
            confirmed: connection?.confirmedWorkspaces.first { $0.id == id.objectId }
        )
    }
}

extension EnvironmentValues {
    /// The shell's Workspace Settings sheet, which a workspace page opens.
    @Entry var aidenWorkspaceSettings: AidenWorkspaceSettingsSheet?
}

extension View {
    /// Presents the shell's Workspace Settings sheet. Applied above the
    /// split/stack switch (`.id(navigation.besideList)`), so neither that nor
    /// a workspace page's rebuild closes it.
    func aidenWorkspaceSettingsPresentation(
        _ sheet: AidenWorkspaceSettingsSheet,
        coordinator: AidenRemoteCoordinator,
        source: @escaping @MainActor (AidenHostObjectID) -> AidenWorkspaceSettingsSource,
        onRemoved: @escaping @MainActor (AidenHostObjectID) -> Void
    ) -> some View {
        modifier(AidenWorkspaceSettingsPresentation(
            sheet: sheet,
            coordinator: coordinator,
            source: source,
            onRemoved: onRemoved
        ))
    }
}

private struct AidenWorkspaceSettingsPresentation: ViewModifier {
    let sheet: AidenWorkspaceSettingsSheet
    let coordinator: AidenRemoteCoordinator
    let source: @MainActor (AidenHostObjectID) -> AidenWorkspaceSettingsSource
    let onRemoved: @MainActor (AidenHostObjectID) -> Void

    func body(content: Content) -> some View {
        content
            .sheet(item: Binding(get: { sheet.draft }, set: { if $0 == nil { sheet.close() } })) { draft in
                AidenWorkspaceSettingsView(coordinator: coordinator, draft: draft) {
                    sheet.close()
                    onRemoved(draft.id)
                }
            }
            .onChange(of: sheet.draft.map { source($0.id) }) { _, latest in
                if let latest { sheet.follow(latest) }
            }
            .onChange(of: coordinator.defaultInstanceId) { old, _ in
                sheet.defaultMachineChanged(from: old)
            }
    }
}

struct AidenWorkspaceDefaultApplication {
    /// Where this phone keeps the permission a new workspace starts with.
    static let permissionKey = "aiden.defaults.workspacePermission"

    let workspace: AidenWorkspace
    let feedback: AidenHapticEvent

    /// The workspace back with `permission`, or as it was when `update` returns nil.
    @MainActor
    static func applying(
        _ permission: AidenWorkspacePermission,
        to workspace: AidenWorkspace,
        update: (AidenWorkspacePermission) async -> AidenWorkspace?
    ) async -> AidenWorkspaceDefaultApplication {
        guard permission != workspace.permission else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .success)
        }
        guard let updated = await update(permission) else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .warning)
        }
        return AidenWorkspaceDefaultApplication(workspace: updated, feedback: .success)
    }
}

extension AidenWorkspacePermission {
    var title: String {
        switch self {
        case .full: "Full access"
        case .ask: "Ask before actions"
        case .none: "No access"
        }
    }

    var detail: String {
        switch self {
        case .full:
            "Aiden can use this workspace's approved tools without asking for each ordinary action. Consequential Git actions still require confirmation."
        case .ask:
            "Aiden asks before actions that need approval in this workspace."
        case .none:
            "Aiden can show existing chats but cannot use workspace tools."
        }
    }
}

/// The quiet note a refused Workspace Settings save leaves on its workspace,
/// on the workspace page and in its Settings, until the person dismisses it.
struct AidenWorkspaceSaveNoticeRow: View {
    @Environment(\.aidenPalette) private var palette
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(palette.warningText)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", action: onDismiss)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace-save-notice")
    }
}
