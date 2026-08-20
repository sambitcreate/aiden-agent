import SwiftUI

struct ContentView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigationRequest: AidenNavigationRequest?

    var body: some View {
        Group {
            switch coordinator.connectionState {
            case .needsPairing:
                AidenPairingView(coordinator: coordinator)
            case .connecting, .connected, .offline:
                AidenWorkspaceShellView(
                    coordinator: coordinator,
                    navigationRequest: $navigationRequest
                )
            }
        }
        .task { await coordinator.start() }
        .onOpenURL { url in
            guard let request = AidenDeepLink.request(from: url) else {
                coordinator.presentedError = String(localized: "That Aiden link is invalid or no longer supported.")
                return
            }
            Task { await open(request) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                guard coordinator.connectionState != .needsPairing else { return }
                Task {
                    await coordinator.connectActiveInstallation()
                    if let client = try? coordinator.remoteClient() {
                        await AidenRemoteLiveActivityManager.shared.reconcile(client: client)
                    }
                }
            case .background:
                Task { await AidenRemoteLiveActivityManager.shared.markAllStale() }
            default:
                break
            }
        }
    }

    @MainActor
    private func open(_ request: AidenNavigationRequest) async {
        if let requestedInstance = request.instanceId {
            guard coordinator.installationStore.installations.contains(where: { $0.id == requestedInstance }) else {
                coordinator.presentedError = String(localized: "This Aiden installation is no longer paired. Pair it again to continue.")
                return
            }
            if coordinator.activeInstanceId != requestedInstance {
                await coordinator.switchInstallation(to: requestedInstance)
            }
        } else if coordinator.connectionState != .connected {
            await coordinator.connectActiveInstallation()
        }

        guard coordinator.connectionState == .connected else {
            coordinator.presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return
        }
        navigationRequest = request
    }
}

#Preview {
    let appearance = AidenAppearanceStore()
    AidenAppearanceRoot(appearance: appearance) {
        ContentView(coordinator: AidenRemoteCoordinator())
    }
    .environment(appearance)
}
