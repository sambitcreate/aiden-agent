import SwiftUI

struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    /// The workspace's own machine, which its chats and Settings read and write.
    let owner: AidenRemoteRequestContext
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        owner: AidenRemoteRequestContext,
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
    /// What an open Settings sheet saves through, fixed when it opens.
    @State private var settingsContext: AidenRemoteRequestContext?

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
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        settingsContext = Self.settingsContext(owner: owner, coordinator: coordinator)
                        isShowingSettings = settingsContext != nil
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
            if let settingsContext {
                AidenWorkspaceSettingsView(
                    coordinator: coordinator,
                    workspace: workspace,
                    context: settingsContext,
                    onRemoved: {
                        isShowingSettings = false
                        onRemoved()
                    }
                )
            }
        }
        // A sheet that opened for another machine, or that follows the default
        // (Git), closes rather than save somewhere new.
        .onChange(of: owner) { _, _ in isShowingSettings = false }
        .onChange(of: coordinator.defaultInstanceId) { old, _ in
            guard let settingsContext else { return }
            if settingsContext.instanceId == old {
                isShowingSettings = false
            }
        }
    }
}

extension AidenWorkspaceDetailView {
    /// Settings save on the workspace's own machine, through its owner context,
    /// and only while the coordinator still holds that machine's pairing.
    @MainActor
    static func settingsContext(
        owner: AidenRemoteRequestContext,
        coordinator: AidenRemoteCoordinator
    ) -> AidenRemoteRequestContext? {
        coordinator.holds(owner) ? owner : nil
    }
}
