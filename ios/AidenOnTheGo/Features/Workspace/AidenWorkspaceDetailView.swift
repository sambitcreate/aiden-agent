import SwiftUI

struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    /// The workspace's own machine, which its chats and Settings read and write.
    let owner: AidenRemoteRequestContext
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    /// Opens a chat the workspace just made, over the workspace.
    let onOpenChat: @MainActor (AidenHostObjectID) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        owner: AidenRemoteRequestContext,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onOpenChat: @escaping @MainActor (AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.owner = owner
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onOpenChat = onOpenChat
    }

    /// The shell's Settings sheet. It sits above the split/stack switch, so
    /// a fold or this page's rebuild on a rename neither closes it nor drops
    /// its edits.
    @Environment(\.aidenWorkspaceSettings) private var settingsSheet

    var body: some View {
        AidenWorkspaceChatsView(
            coordinator: coordinator,
            workspace: workspace,
            owner: owner,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved,
            onOpenChat: onOpenChat
        )
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        guard let context = Self.settingsContext(owner: owner, coordinator: coordinator) else { return }
                        settingsSheet?.present(
                            workspace,
                            id: AidenHostObjectID(instanceId: owner.instanceId, deviceId: owner.deviceId, objectId: workspace.id),
                            context: context
                        )
                    } label: {
                        Label("Workspace Settings", systemImage: "gearshape")
                    }
                } label: {
                    // A title as well as the symbol, for the side rail's overflow.
                    Label("Workspace menu", systemImage: AidenChromeSymbols.overflowMenu)
                }
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
