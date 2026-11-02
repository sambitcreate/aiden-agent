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

/// One navigation request can wait for a connection, without granting mutation authority.
@MainActor @Observable
final class AidenExternalNewChatQueue {
    struct Entry: Equatable {
        let request: AidenNavigationRequest
        let origin: AidenRemoteRequestContext?
        let instanceID: String
        let deviceID: String
        let pairedAt: Date
    }
    private(set) var waiting: Entry?
    func receive(_ entry: Entry) { waiting = entry }
    func invalidate() { waiting = nil }
    func takeIfReady(_ ready: Bool, isValid: (Entry) -> Bool) -> Entry? {
        guard let entry = waiting else { return nil }
        guard isValid(entry) else { waiting = nil; return nil }
        guard ready else { return nil }
        waiting = nil
        return entry
    }
}

struct ContentView: View {
    private enum ConnectionRecoveryDestination: String, Identifiable {
        case installations, pairing
        var id: Self { self }
    }

    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("aiden.mobileOnboarding.v1.complete") private var hasCompletedMobileOnboarding = false
    @State private var newChatConsent = AidenNewChatLinkConsent()
    @State private var externalNewChats = AidenExternalNewChatQueue()
    @State private var lastExternalNewChat: AidenNavigationRequest?
    @State private var foregroundIntents = AidenForegroundIntentRouter.shared
    @State private var showsNewChatConsent = false
    @State private var navigationRequest: AidenNavigationRequest?
    @State private var sceneConnectionRefreshInProgress = false
    @State private var sceneRefreshGate = AidenSceneRefreshGate(refreshOnFirstActivation: true)
    @State private var connectionRecoveryDestination: ConnectionRecoveryDestination?

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
                AidenConnectionRecoveryView(coordinator: coordinator, issue: issue) {
                    connectionRecoveryDestination = .installations
                }
            }
        }
        // Keep the sheet on the stable root so a foreground reconnect cannot
        // remove connection management while the person is using it.
        .sheet(item: $connectionRecoveryDestination) { destination in
            switch destination {
            case .installations:
                AidenInstallationsView(coordinator: coordinator, addInstallation: {
                    connectionRecoveryDestination = .pairing
                })
            case .pairing:
                AidenPairingView(coordinator: coordinator, onPaired: { connectionRecoveryDestination = nil })
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
                if request == lastExternalNewChat,
                   externalNewChats.waiting != nil || newChatConsent.pending != nil || newChatConsent.active != nil { return }
                externalNewChats.invalidate()
                newChatConsent.invalidate()
                showsNewChatConsent = false
                lastExternalNewChat = request
                receiveExternalNewChat(request)
            } else {
                externalNewChats.invalidate()
                lastExternalNewChat = nil
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
            // A newer native intent supersedes a link still waiting for readiness.
            if foregroundIntents.pending != nil {
                externalNewChats.invalidate()
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
            await consumeForegroundIntentIfReady()
        }
        .onDisappear {
            externalNewChats.invalidate()
            newChatConsent.invalidate()
            _ = foregroundIntents.take()
        }
        .onChange(of: coordinator.connectionState) { _, state in
            if state == .needsPairing {
                externalNewChats.invalidate()
                connectionRecoveryDestination = nil
            }
            if state == .connected {
                consumeExternalNewChatIfReady()
                Task { await consumeForegroundIntentIfReady() }
            } else if newChatConsent.active == nil {
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            consumeExternalNewChatIfReady()
            if newChatConsent.active == nil {
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch sceneRefreshGate.transition(to: phase) {
            case .refresh:
                guard coordinator.connectionState != .needsPairing else { return }
                sceneConnectionRefreshInProgress = true
                Task {
                    await coordinator.connectActiveInstallation()
                    sceneConnectionRefreshInProgress = false
                    consumeExternalNewChatIfReady()
                    await consumeForegroundIntentIfReady()
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
                externalNewChats.invalidate()
                newChatConsent.invalidate()
                showsNewChatConsent = false
                _ = foregroundIntents.take()
                Task { await AidenRemoteLiveActivityManager.shared.markAllStale() }
            case .resume, .none:
                if phase == .active {
                    consumeExternalNewChatIfReady()
                    Task { await consumeForegroundIntentIfReady() }
                }
                // Returning from a transient `.inactive` (Control Center,
                // app switcher, system prompts) keeps the live connection.
                break
            }
        }
    }

    @MainActor
    private func receiveExternalNewChat(_ request: AidenNavigationRequest) {
        guard coordinator.connectionState != .needsPairing,
              let instanceID = request.instanceId ?? coordinator.activeInstanceId,
              let installation = coordinator.installationStore.installations.first(where: { $0.id == instanceID }),
              let origin = try? coordinator.requestContext() else {
            coordinator.presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return
        }
        externalNewChats.receive(.init(request: request, origin: origin, instanceID: instanceID,
            deviceID: installation.deviceId, pairedAt: installation.createdAt))
        consumeExternalNewChatIfReady()
        if case .offline = coordinator.connectionState {
            Task { await coordinator.connectActiveInstallation() }
        }
    }

    @MainActor
    private func consumeExternalNewChatIfReady() {
        if foregroundIntents.pending != nil { externalNewChats.invalidate(); return }
        if coordinator.connectionState == .needsPairing { externalNewChats.invalidate(); return }
        let ready = coordinator.connectionState == .connected && scenePhase == .active && !sceneConnectionRefreshInProgress
        guard let entry = externalNewChats.takeIfReady(ready, isValid: { entry in
            entry.origin.map(coordinator.isCurrent) == true && coordinator.installationStore.installations.contains {
                $0.id == entry.instanceID && $0.deviceId == entry.deviceID && $0.createdAt == entry.pairedAt
            }
        }) else { return }
        prepareNewChat(.init(destination: .newChat, instanceId: entry.instanceID,
            workspaceId: entry.request.workspaceId, startsVoice: false), startsVoice: false, requiresConfirmation: true)
    }

    @MainActor
    private func consumeForegroundIntentIfReady() async {
        guard scenePhase == .active, !sceneConnectionRefreshInProgress, coordinator.connectionState == .connected,
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
            candidates = AidenNoWorkspace.grouped(coordinator.workspaces).map {
                .init(id: $0.id, instanceId: instanceID, name: $0.name)
            }
        } else {
            candidates = AidenIntentCatalogStore.shared.load().workspaces.filter { $0.instanceId == instanceID }
        }
        let available = candidates.filter { !archived.contains($0.id) }
        // A chat's own hidden folder is listed under the Chats home, so match against that.
        let selected = (request.workspaceId ?? AidenProductNavigationStore.shared.selectedWorkspace(for: instanceID))
            .map { AidenNoWorkspace.groupID(for: $0, in: coordinator.workspaces) }
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
                // A chat started under Chats can land in a fresh hidden workspace of its own.
                let startsUnderChats = coordinator.workspaces.contains { $0.id == target.workspaceID && $0.noWorkspace }
                let chat = try await coordinator.remoteClient(for: context)
                    .createChat(workspaceId: target.workspaceID, noWorkspace: startsUnderChats)
                guard coordinator.isCurrent(context), scenePhase == .active, !chat.isBotChat,
                      chat.workspaceId == target.workspaceID || startsUnderChats else { return nil }
                if !coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) {
                    await coordinator.refreshWorkspaces()
                    guard coordinator.isCurrent(context) else { return nil }
                    guard coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                        coordinator.presentedError = AidenNoWorkspace.startedButUnlistedMessage
                        return nil
                    }
                }
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

/// Connection management must remain reachable without a successful connection,
/// including failures where retry is unsafe, such as a changed certificate.
struct AidenConnectionRecoveryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let issue: AidenConnectionIssue
    let switchConnection: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(issue.title).font(.subheadline.weight(.semibold))
            if let installation = coordinator.installationStore.activeInstallation {
                Text(installation.name).font(.caption.weight(.medium))
                if let last = installation.lastConnectedAt {
                    Text("Last connected \(last.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(issue.message).font(.caption).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack {
                    recoveryActions
                }
                VStack(alignment: .leading) {
                    recoveryActions
                }
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.regularMaterial)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var recoveryActions: some View {
        if issue.canRetry {
            Button("Retry connection") { Task { await coordinator.connectActiveInstallation() } }
        }
        Button("Switch connection", action: switchConnection)
            .accessibilityHint("Choose a paired computer or pair another Aiden Agent.")
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
