import SwiftUI

struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    /// The workspace's own machine, which its chats and Settings read and write.
    let owner: AidenRemoteRequestContext
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    /// Opens a chat the workspace just made, over the workspace.
    let onOpenChat: @MainActor (AidenHostObjectID) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        owner: AidenRemoteRequestContext,
        onRemoved: @escaping () -> Void,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onOpenChat: @escaping @MainActor (AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.owner = owner
        self.onRemoved = onRemoved
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onOpenChat = onOpenChat
    }

    /// The open Settings sheet and the machine it saves through, fixed when it
    /// opens. One value drives the sheet, so its content never reads a context
    /// that has not landed yet (which showed an empty sheet).
    @State private var settingsPresentation: AidenWorkspaceSettingsPresentation?

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
                        settingsPresentation = Self.settingsContext(owner: owner, coordinator: coordinator)
                            .map(AidenWorkspaceSettingsPresentation.init(context:))
                    } label: {
                        Label("Workspace Settings", systemImage: "gearshape")
                    }
                } label: {
                    // A title as well as the symbol, for the side rail's overflow.
                    Label("Workspace menu", systemImage: AidenChromeSymbols.overflowMenu)
                }
            }
        }
        .sheet(item: $settingsPresentation) { presentation in
            AidenWorkspaceSettingsView(
                coordinator: coordinator,
                workspace: workspace,
                context: presentation.context,
                onRemoved: {
                    settingsPresentation = nil
                    onRemoved()
                }
            )
        }
        // A sheet that opened for another machine, or that follows the default
        // (Git), closes rather than save somewhere new.
        .onChange(of: owner) { _, _ in settingsPresentation = nil }
        .onChange(of: coordinator.defaultInstanceId) { old, _ in
            if settingsPresentation?.context.instanceId == old {
                settingsPresentation = nil
            }
        }
    }
}

/// An open Workspace Settings sheet: the machine it saves through.
private struct AidenWorkspaceSettingsPresentation: Identifiable {
    let context: AidenRemoteRequestContext
    var id: AidenRemoteRequestContext { context }
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
