import SwiftUI

struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    /// The workspace's own machine. Its settings write the selected machine, so
    /// they're offered only there.
    let owner: AidenRemoteRequestContext?
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        owner: AidenRemoteRequestContext? = nil,
        onRemoved: @escaping () -> Void,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.owner = owner
        self.onRemoved = onRemoved
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onChatActivityChanged = onChatActivityChanged
    }

    @State private var isShowingSettings = false

    /// Workspace Settings reads and writes the selected machine.
    private var offersSettings: Bool {
        owner.map { $0.instanceId == coordinator.defaultInstanceId } ?? true
    }

    var body: some View {
        AidenWorkspaceChatsView(
            coordinator: coordinator,
            workspace: workspace,
            owner: owner,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved,
            onChatActivityChanged: onChatActivityChanged
        )
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if offersSettings {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            isShowingSettings = true
                        } label: {
                            Label("Workspace Settings", systemImage: "gearshape")
                        }
                    } label: {
                        Image(systemName: AidenChromeSymbols.overflowMenu)
                    }
                    .accessibilityLabel("Workspace menu")
                }
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            AidenWorkspaceSettingsView(
                coordinator: coordinator,
                workspace: workspace,
                onRemoved: {
                    isShowingSettings = false
                    onRemoved()
                }
            )
        }
    }
}
