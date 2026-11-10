import SwiftUI

/// What the Workspaces list needs from its tab.
struct AidenWorkspacesTabChrome {
    let route: (AidenWorkspace) -> AidenAppRoute
    let newChat: AidenNewChatFlow
    /// Set with more than one machine shown: every shown machine's workspaces.
    var machines: AidenWorkspacesTabMachines? = nil
}

/// Every shown machine's workspaces, under the Inbox's machine filter.
struct AidenWorkspacesTabMachines {
    let roster: AidenMachineRoster
    let filter: Binding<AidenMachineFilter>
    let sections: [AidenMachineSection<AidenMachineWorkspaceRow>]
    /// Reads every shown machine's list again.
    let refresh: () async -> Void
}

/// The workspace list as a tab root. With more than one machine it lists every
/// machine's workspaces, by machine under All.
struct AidenWorkspacesTabView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let store: AidenUnifiedInboxStore
    let newChat: AidenNewChatFlow

    private func route(_ workspace: AidenWorkspace) -> AidenAppRoute {
        let installation = coordinator.installationStore.activeInstallation
        return .workspace(AidenHostObjectID(
            instanceId: installation?.id ?? "",
            deviceId: installation?.deviceId ?? "",
            objectId: workspace.id
        ))
    }

    private var machines: AidenWorkspacesTabMachines? {
        guard store.roster.showsTabStrip else { return nil }
        let archive = coordinator.workspaceArchiveStore
        let shown = store.roster.tabMachines.map(\.instanceId)
        return AidenWorkspacesTabMachines(
            roster: store.roster,
            filter: Binding(get: { store.filter }, set: { store.filter = $0 }),
            sections: store.workspaceSections { archive.isArchived(workspaceID: $1, instanceID: $0) },
            refresh: { [coordinator] in
                await coordinator.refreshWorkspaces()
                for instanceId in shown where instanceId != coordinator.defaultInstanceId {
                    try? await coordinator.hosts.connection(for: instanceId)?.refreshWorkspacesForPoll()
                }
            }
        )
    }

    var body: some View {
        let machines = machines
        AidenWorkspacesDirectoryView(
            coordinator: coordinator,
            archiveStore: coordinator.workspaceArchiveStore,
            tabChrome: AidenWorkspacesTabChrome(route: route, newChat: newChat, machines: machines)
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            // Grouped, each machine says its own state under its name.
            if machines == nil {
                AidenConnectionNotice(coordinator: coordinator)
            }
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
    /// The workspace a route points at, on its own machine. Machines can share
    /// workspace IDs, so it's looked up on that machine's list and never the
    /// selected one's. An older pairing of the machine finds nothing.
    @MainActor
    static func workspace(for id: AidenHostObjectID, coordinator: AidenRemoteCoordinator) -> AidenWorkspace? {
        guard let connection = coordinator.hosts.connection(for: id.instanceId),
              connection.installation.deviceId == id.deviceId,
              !coordinator.workspaceArchiveStore.isArchived(workspaceID: id.objectId, instanceID: id.instanceId) else {
            return nil
        }
        // A hidden home has no page of its own (no chat list, settings or Remove).
        return connection.workspaces.first { $0.id == id.objectId && !$0.noWorkspace }
    }
}

/// A pushed workspace page, on the workspace's own machine whichever is selected.
struct AidenWorkspaceRouteView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let id: AidenHostObjectID
    let onRemoved: () -> Void
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void

    @Environment(\.aidenPalette) private var palette

    private var connection: AidenHostConnection? {
        coordinator.hosts.connection(for: id.instanceId)
    }

    private var isLoadingWorkspaces: Bool {
        guard let connection else { return false }
        return connection.connectionState == .connecting && connection.workspaces.isEmpty
    }

    private var unavailableMessage: String {
        guard let connection, connection.installation.deviceId == id.deviceId else {
            return String(localized: "This machine is no longer paired. Pair it again to open this workspace.")
        }
        return String(localized: "This workspace is no longer available on \(connection.installation.name).")
    }

    var body: some View {
        if let workspace = AidenWorkspaceRoute.workspace(for: id, coordinator: coordinator),
           let owner = try? connection?.requestContext(scope: .owner) {
            AidenWorkspaceDetailView(
                coordinator: coordinator,
                workspace: workspace,
                owner: owner,
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

/// A quiet one-line connection status in place of a modal overlay.
struct AidenConnectingHint: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let installationName: String?
    @State private var dimmed = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(palette.accent)
                .frame(width: 7, height: 7)
                .opacity(dimmed ? 0.35 : 1)
            Text(installationName.map { "Connecting to \($0)…" } ?? String(localized: "Connecting to Aiden Agent…"))
                .lineLimit(1)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity, minHeight: 28)
        .accessibilityElement(children: .combine)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dimmed = true }
        }
    }
}
