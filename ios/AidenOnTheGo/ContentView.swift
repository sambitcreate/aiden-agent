import SwiftUI

/// Consent is single-use and belongs to one frozen pairing/workspace, never to a URL flag.
@MainActor @Observable
final class AidenNewChatLinkConsent {
    struct Target: Equatable, Identifiable {
        let id = UUID()
        let instanceID: String
        let deviceID: String
        let pairedAt: Date
        let installationName: String
        let workspaceID: String
        let workspaceName: String
        let origin: AidenRemoteRequestContext?
        let startsVoice: Bool
        let createdAt: Date
    }
    private(set) var pending: Target?
    private(set) var active: Target?

    @discardableResult func propose(_ target: Target) -> Bool {
        guard pending == nil, active == nil else { return false }
        pending = target
        return true
    }

    func invalidate() { pending = nil; active = nil }

    func perform<Result>(id: UUID, now: Date = Date(), isValid: () -> Bool,
                         operation: (Target) async throws -> Result?) async rethrows -> Result? {
        guard let target = pending, target.id == id, active == nil,
              (0..<60).contains(now.timeIntervalSince(target.createdAt)), isValid() else {
            if pending?.id == id { pending = nil }
            return nil
        }
        pending = nil
        active = target
        defer { if active?.id == id { active = nil } }
        let result = try await operation(target)
        guard active?.id == id, !Task.isCancelled else { return nil }
        return result
    }
}

struct ContentView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("aiden.mobileOnboarding.v1.complete") private var hasCompletedMobileOnboarding = false
    @State private var newChatConsent = AidenNewChatLinkConsent()
    @State private var foregroundIntents = AidenForegroundIntentRouter.shared
    @State private var showsNewChatConsent = false
    @State private var navigationRequest: AidenNavigationRequest?
    @State private var sceneRefreshGate = AidenSceneRefreshGate(refreshOnFirstActivation: true)

    var body: some View {
        Group {
            switch coordinator.connectionState {
            case .needsPairing:
                AidenPairingView(
                    coordinator: coordinator,
                    showsIntroduction: !hasCompletedMobileOnboarding,
                    onIntroductionComplete: {
                        hasCompletedMobileOnboarding = true
                    }
                )
            case .connecting, .connected, .offline:
                AidenProductShellView(
                    coordinator: coordinator,
                    navigationRequest: $navigationRequest
                )
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if case .offline = coordinator.connectionState, let issue = coordinator.connectionIssue {
                VStack(alignment: .leading, spacing: 6) {
                    Text(issue.title).font(.subheadline.weight(.semibold))
                    if let installation = coordinator.installationStore.activeInstallation {
                        Text(installation.name).font(.caption.weight(.medium))
                        if let last = installation.lastConnectedAt {
                            Text("Last connected \(last.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text(issue.message).font(.caption).foregroundStyle(.secondary)
                    if issue.canRetry {
                        Button("Retry connection") { Task { await coordinator.connectActiveInstallation() } }
                            .buttonStyle(.bordered)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(.regularMaterial)
                .accessibilityElement(children: .contain)
            }
        }
        .task { await coordinator.start() }
        .onOpenURL { url in
            _ = foregroundIntents.take()
            guard let request = AidenDeepLink.request(from: url) else {
                coordinator.presentedError = String(localized: "That Aiden link is invalid or no longer supported.")
                return
            }
            if request.destination == .newChat {
                prepareNewChat(request, startsVoice: false, requiresConfirmation: true)
            } else {
                newChatConsent.invalidate()
                showsNewChatConsent = false
                Task { await open(request) }
            }
        }
        .alert("Create a new chat?", isPresented: $showsNewChatConsent, presenting: newChatConsent.pending) { target in
            Button("Create Chat") { Task { await createNewChat(target) } }
            Button("Cancel", role: .cancel) { newChatConsent.invalidate() }
        } message: { target in
            Text("Create a chat in \(target.workspaceName) on \(target.installationName)? Use the microphone button when you are ready to dictate.")
        }
        .task(id: foregroundIntents.pending?.id) {
            // A cold App Intent may arrive before this view or the connection is ready.
            await consumeForegroundIntentIfReady()
        }
        .onDisappear {
            newChatConsent.invalidate()
            _ = foregroundIntents.take()
        }
        .onChange(of: coordinator.connectionState) { _, state in
            if state == .connected { Task { await consumeForegroundIntentIfReady() } }
            else if newChatConsent.active == nil {
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            if newChatConsent.active == nil {
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await consumeForegroundIntentIfReady() } }
            switch sceneRefreshGate.transition(to: phase) {
            case .refresh:
                guard coordinator.connectionState != .needsPairing else { return }
                Task {
                    await coordinator.connectActiveInstallation()
                    // Bot routine results land as local notifications when
                    // the app comes to the foreground (there is no push).
                    Task { await AidenBotRoutineNotifier.shared.deliverIfSupported(coordinator: coordinator) }
                    if let context = try? coordinator.requestContext(),
                       let client = try? coordinator.remoteClient(for: context) {
                        await AidenRemoteLiveActivityManager.shared.reconcile(
                            instanceID: context.instanceId,
                            client: client,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
            case .suspend:
                newChatConsent.invalidate()
                showsNewChatConsent = false
                _ = foregroundIntents.take()
                Task { await AidenRemoteLiveActivityManager.shared.markAllStale() }
            case .resume, .none:
                // Returning from a transient `.inactive` (Control Center,
                // app switcher, system prompts) keeps the live connection.
                break
            }
        }
    }

    @MainActor
    private func consumeForegroundIntentIfReady() async {
        guard scenePhase == .active, coordinator.connectionState == .connected,
              let action = foregroundIntents.take() else { return }
        prepareNewChat(AidenNavigationRequest(destination: .newChat, instanceId: action.instanceID,
            workspaceId: action.workspaceID, startsVoice: false), startsVoice: action.startsVoice, requiresConfirmation: false)
    }

    @MainActor
    private func prepareNewChat(_ request: AidenNavigationRequest, startsVoice: Bool, requiresConfirmation: Bool) {
        guard coordinator.connectionState == .connected,
              let instanceID = request.instanceId ?? coordinator.activeInstanceId,
              let installation = coordinator.installationStore.installations.first(where: { $0.id == instanceID }) else {
            coordinator.presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return
        }
        let archived = AidenWorkspaceArchiveStore().archivedWorkspaceIDs(for: instanceID)
        let candidates: [AidenIntentWorkspaceRecord]
        if coordinator.activeInstanceId == instanceID {
            candidates = coordinator.workspaces.map { .init(id: $0.id, instanceId: instanceID, name: $0.name) }
        } else {
            candidates = AidenIntentCatalogStore.shared.load().workspaces.filter { $0.instanceId == instanceID }
        }
        let available = candidates.filter { !archived.contains($0.id) }
        let selected = request.workspaceId ?? AidenProductNavigationStore.shared.selectedWorkspace(for: instanceID)
        guard let workspace = selected.flatMap({ id in available.first { $0.id == id } })
                ?? (request.workspaceId == nil ? available.first : nil) else {
            coordinator.presentedError = String(localized: "Open this installation and choose an available workspace before starting a chat.")
            return
        }
        let target = AidenNewChatLinkConsent.Target(instanceID: instanceID, deviceID: installation.deviceId,
            pairedAt: installation.createdAt, installationName: installation.name, workspaceID: workspace.id,
            workspaceName: workspace.name, origin: try? coordinator.requestContext(), startsVoice: startsVoice, createdAt: Date())
        guard newChatConsent.propose(target) else { return }
        if requiresConfirmation { showsNewChatConsent = true }
        else { Task { await createNewChat(target) } }
    }

    @MainActor
    private func createNewChat(_ target: AidenNewChatLinkConsent.Target) async {
        do {
            let request: AidenNavigationRequest? = try await newChatConsent.perform(id: target.id, isValid: {
                scenePhase == .active && target.origin.map(coordinator.isCurrent) == true
                    && retainedNewChatTarget(target)
            }) { target in
                if coordinator.activeInstanceId != target.instanceID {
                    await coordinator.switchInstallation(to: target.instanceID)
                }
                guard newChatConsent.active?.id == target.id, retainedNewChatTarget(target),
                      scenePhase == .active, coordinator.connectionState == .connected,
                      let context = try? coordinator.requestContext(for: target.instanceID),
                      coordinator.workspaces.contains(where: { $0.id == target.workspaceID }),
                      !AidenWorkspaceArchiveStore().isArchived(workspaceID: target.workspaceID, instanceID: target.instanceID),
                      coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .chatWrite) == true else { return nil }
                let chat = try await coordinator.remoteClient(for: context).createChat(workspaceId: target.workspaceID)
                guard coordinator.isCurrent(context), scenePhase == .active,
                      !chat.isBotChat, chat.workspaceId == target.workspaceID else { return nil }
                return AidenNavigationRequest(destination: .chat(chat.id), instanceId: target.instanceID,
                    workspaceId: nil, startsVoice: target.startsVoice)
            }
            if let request { navigationRequest = request }
        } catch {
            // A mutation is never retried after an uncertain result.
            if retainedNewChatTarget(target), coordinator.activeInstanceId == target.instanceID {
                coordinator.presentedError = error.localizedDescription
            }
        }
    }

    private func retainedNewChatTarget(_ target: AidenNewChatLinkConsent.Target) -> Bool {
        coordinator.installationStore.installations.contains {
            $0.id == target.instanceID && $0.deviceId == target.deviceID && $0.createdAt == target.pairedAt
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
    let haptics = AidenHapticCenter()
    AidenAppearanceRoot(appearance: appearance) {
        ContentView(coordinator: AidenRemoteCoordinator(haptics: haptics))
    }
    .environment(appearance)
    .environment(haptics)
    .aidenHapticHost(haptics)
}
