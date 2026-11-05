import SwiftUI

struct AidenWorkspaceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let onRemoved: () -> Void

    @State private var name: String
    @State private var permission: AidenWorkspacePermission
    @State private var memoryEnabled: Bool
    @State private var isConfirmingRemoval = false
    @State private var hapticScope = UUID()

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        onRemoved: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.onRemoved = onRemoved
        _name = State(initialValue: workspace.name)
        _permission = State(initialValue: workspace.permission)
        _memoryEnabled = State(initialValue: workspace.memoryEnabled)
    }

    private var hasChanges: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != workspace.name || permission != workspace.permission || memoryEnabled != workspace.memoryEnabled
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    LabeledContent("Folder", value: workspace.hasFolder ? "Connected" : "None")
                    LabeledContent("Managed worktree", value: workspace.isManagedWorktree ? "Yes" : "No")
                    if let repository = workspace.repositoryName {
                        LabeledContent("Repository", value: repository)
                    }
                } header: {
                    Text("Workspace")
                } footer: {
                    Text("Renaming updates Aiden Agent and paired clients. It does not rename the folder on disk.")
                }

                Section {
                    Picker("Permission", selection: $permission) {
                        ForEach(AidenWorkspacePermission.allCases, id: \.self) { permission in
                            Text(permission.title).tag(permission)
                        }
                    }
                } header: {
                    Text("Permission")
                } footer: {
                    Text("\(permission.detail) This setting overrides the app default for this workspace.")
                }

                Section {
                    Toggle("Use memory", isOn: $memoryEnabled)
                } header: {
                    Text("Memory")
                } footer: {
                    Text("When off, Aiden does not index this workspace or expose memory tools in its chats. Existing memory stays on your Mac.")
                }

                Section("Workspace tools") {
                    NavigationLink {
                        AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace)
                    } label: {
                        Label("Files", systemImage: "doc.text")
                    }
                    .disabled(!workspace.hasFolder)

                    NavigationLink {
                        AidenWorkspaceGitView(coordinator: coordinator, workspace: workspace)
                    } label: {
                        Label("Git", systemImage: "arrow.triangle.branch")
                    }
                    .disabled(!workspace.hasFolder)
                }

                if workspace.isManagedWorktree || coordinator.workspaces.count > 1 {
                    Section {
                        Button(
                            workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent",
                            role: .destructive
                        ) {
                            isConfirmingRemoval = true
                        }
                    } footer: {
                        Text(workspace.isManagedWorktree
                             ? "Deleting an Aiden-managed worktree removes its checkout and may remove its branch when safe."
                             : "Removing unregisters this workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your desktop, but its chats will no longer be listed.")
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
                        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            let outcome = await coordinator.updateWorkspaceOutcome(
                                workspace,
                                name: trimmedName == workspace.name ? nil : trimmedName,
                                permission: permission == workspace.permission ? nil : permission,
                                memoryEnabled: memoryEnabled == workspace.memoryEnabled ? nil : memoryEnabled
                            )
                            if case .success = outcome {
                                coordinator.haptics.play(
                                    .success,
                                    scope: hapticScope,
                                    dedupeKey: "workspace-settings:\(workspace.id):\(workspace.revision)"
                                )
                                dismiss()
                            } else if outcome.isDefinitiveFailure {
                                coordinator.haptics.play(.error, scope: hapticScope)
                            }
                        }
                    }
                    .disabled(!hasChanges || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || coordinator.isMutating)
                }
            }
            .confirmationDialog(
                workspace.isManagedWorktree ? "Delete \(workspace.name)?" : "Remove \(workspace.name) from Aiden Agent?",
                isPresented: $isConfirmingRemoval,
                titleVisibility: .visible
            ) {
                Button(workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent", role: .destructive) {
                    Task {
                        let outcome = workspace.isManagedWorktree
                            ? await coordinator.removeManagedWorktreeOutcome(workspace)
                            : await coordinator.removeWorkspaceOutcome(workspace)
                        if case .success = outcome {
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
                     : "The folder, its files, and chats remain on your desktop, but the chats will no longer be listed. Delete the folder separately in your system file manager if you no longer need it.")
            }
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
    }
}
