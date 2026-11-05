import SwiftUI

struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        onRemoved: @escaping () -> Void,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.onRemoved = onRemoved
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onChatActivityChanged = onChatActivityChanged
    }

    @State private var isShowingSettings = false

    var body: some View {
        AidenWorkspaceChatsView(
            coordinator: coordinator,
            workspace: workspace,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved,
            onChatActivityChanged: onChatActivityChanged
        )
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
