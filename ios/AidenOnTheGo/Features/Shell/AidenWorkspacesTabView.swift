import SwiftUI

/// What the Workspaces list needs from the tab shell.
struct AidenWorkspacesTabChrome {
    let route: (AidenWorkspace) -> AidenAppRoute
    let newChat: AidenNewChatFlow
}

/// The workspace list as a tab root.
struct AidenWorkspacesTabView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let newChat: AidenNewChatFlow

    private func route(_ workspace: AidenWorkspace) -> AidenAppRoute {
        let installation = coordinator.installationStore.activeInstallation
        return .workspace(AidenHostObjectID(
            instanceId: installation?.id ?? "",
            deviceId: installation?.deviceId ?? "",
            objectId: workspace.id
        ))
    }

    var body: some View {
        AidenWorkspacesDirectoryView(
            coordinator: coordinator,
            archiveStore: coordinator.workspaceArchiveStore,
            tabChrome: AidenWorkspacesTabChrome(route: route, newChat: newChat)
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            AidenConnectionNotice(coordinator: coordinator)
        }
    }
}

/// Offline and connecting, on a plain surface. A failure the person has to act
/// on is `AidenConnectionRecoveryView`'s, so this stays out of its way.
struct AidenConnectionNotice: View {
    let coordinator: AidenRemoteCoordinator

    @Environment(\.aidenPalette) private var palette
    @State private var showsConnecting = false

    var body: some View {
        Group {
            if coordinator.connectionIssue != nil {
                EmptyView()
            } else if case .offline(let message) = coordinator.connectionState {
                HStack(spacing: 8) {
                    Image(systemName: "wifi.slash")
                    Text(message)
                        .font(.footnote)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button("Retry") {
                        Task { await coordinator.connectActiveInstallation() }
                    }
                    .font(.footnote.bold())
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(palette.raised)
                .accessibilityElement(children: .combine)
            } else if showsConnecting {
                AidenConnectingHint(installationName: coordinator.installationStore.activeInstallation?.name)
            }
        }
        .task(id: coordinator.connectionState) {
            // Fast reconnects finish before the hint would only flash.
            showsConnecting = false
            guard coordinator.connectionState == .connecting else { return }
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            showsConnecting = coordinator.connectionState == .connecting
        }
    }
}

enum AidenWorkspaceRoute {
    /// The workspace a route points at. Only the selected machine's workspaces are
    /// loaded, and machines can share workspace IDs, so a route to another machine
    /// finds nothing rather than the selected machine's namesake.
    @MainActor
    static func workspace(for id: AidenHostObjectID, coordinator: AidenRemoteCoordinator) -> AidenWorkspace? {
        guard let installation = coordinator.installationStore.activeInstallation,
              installation.id == id.instanceId,
              installation.deviceId == id.deviceId,
              !coordinator.workspaceArchiveStore.isArchived(workspaceID: id.objectId, instanceID: id.instanceId) else {
            return nil
        }
        // A hidden home has no page of its own (no chat list, settings or Remove).
        return coordinator.workspaces.first { $0.id == id.objectId && !$0.noWorkspace }
    }
}

/// A pushed workspace page. It's bound to the selection, so a route to another
/// machine says so instead of opening.
struct AidenWorkspaceRouteView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let id: AidenHostObjectID
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void

    @Environment(\.aidenPalette) private var palette

    private var isLoadingWorkspaces: Bool {
        coordinator.activeInstanceId == id.instanceId
            && coordinator.connectionState == .connecting
            && coordinator.workspaces.isEmpty
    }

    private var unavailableMessage: String {
        if coordinator.activeInstanceId == id.instanceId {
            return String(localized: "This workspace is no longer available on this machine.")
        }
        let name = coordinator.installationStore.installations.first { $0.id == id.instanceId }?.name
        return name.map { String(localized: "This workspace is on \($0). Select that machine in Settings to open it.") }
            ?? String(localized: "This machine is no longer paired. Pair it again to open this workspace.")
    }

    var body: some View {
        if let workspace = AidenWorkspaceRoute.workspace(for: id, coordinator: coordinator) {
            AidenWorkspaceDetailView(
                coordinator: coordinator,
                workspace: workspace,
                onRemoved: onRemoved,
                onChatUpdated: onChatUpdated,
                onChatRemoved: onChatRemoved,
                onChatActivityChanged: onChatActivityChanged
            )
            .id(workspace.revision)
        } else if isLoadingWorkspaces {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.canvas.ignoresSafeArea())
        } else {
            ContentUnavailableView(
                "Workspace unavailable",
                systemImage: "folder",
                description: Text(unavailableMessage)
            )
            .background(palette.canvas.ignoresSafeArea())
        }
    }
}
