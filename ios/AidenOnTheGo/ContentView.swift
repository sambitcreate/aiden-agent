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

/// Links in the tab shell. Each one goes to the machine it names and leaves the
/// selection where it is, so whatever is open on the selected machine stays open.
extension AidenRemoteCoordinator {
    /// False, with the reason on screen, for a machine that can't answer a link:
    /// one that isn't paired, or that has revoked this phone.
    func acceptLink(_ request: AidenNavigationRequest) -> Bool {
        let instanceId = request.instanceId ?? activeInstanceId
        guard installationStore.installations.contains(where: { $0.id == instanceId }),
              let instanceId,
              hosts.connection(for: instanceId)?.isRevoked != true else {
            presentedError = String(localized: "This machine is no longer paired. Pair it again to continue.")
            return false
        }
        return true
    }

    /// Whether a link for this machine can go ahead. The tab shell asks that
    /// machine. The old shell switches to it first, so it asks the selected one.
    func isConnected(forLink instanceID: String?, tabShell: Bool = AppConfig.tabShellEnabled) -> Bool {
        guard tabShell, let instanceID else { return connectionState == .connected }
        return hosts.connection(for: instanceID)?.connectionState == .connected
    }

    /// What a new-chat prompt offers for this request, or nil with the reason on
    /// screen. Nothing is created until the person agrees to the result.
    func newChatTarget(
        for request: AidenNavigationRequest,
        startsVoice: Bool,
        tabShell: Bool = AppConfig.tabShellEnabled
    ) -> AidenNewChatLinkConsent.Target? {
        guard let instanceID = request.instanceId ?? activeInstanceId,
              isConnected(forLink: instanceID, tabShell: tabShell),
              let installation = installationStore.installations.first(where: { $0.id == instanceID }) else {
            presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return nil
        }
        let archived = workspaceArchiveStore.archivedWorkspaceIDs(for: instanceID)
        let candidates: [AidenIntentWorkspaceRecord]
        // Nil sends the link to the saved catalog.
        let listed = tabShell
            ? hosts.connection(for: instanceID)?.workspaces
            : activeInstanceId == instanceID ? workspaces : nil
        if let listed {
            candidates = AidenNoWorkspace.grouped(listed).map {
                .init(id: $0.id, instanceId: instanceID, name: $0.name)
            }
        } else {
            candidates = AidenIntentCatalogStore.shared.load().workspaces.filter { $0.instanceId == instanceID }
        }
        let available = candidates.filter { !archived.contains($0.id) }
        // A chat's own hidden folder is listed under the Chats home, so match against that: the
        // machine's workspaces say which ids are hidden, the catalog says so for the others.
        let selected = (request.workspaceId ?? AidenProductNavigationStore.shared.selectedWorkspace(for: instanceID))
            .map { id in
                listed.map { AidenNoWorkspace.groupID(for: id, in: $0) }
                    ?? AidenIntentWorkspaceRecord.listedID(for: id, in: candidates)
            }
        guard let workspace = selected.flatMap({ id in available.first { $0.id == id } })
                ?? (request.workspaceId == nil ? available.first : nil) else {
            presentedError = String(localized: "Open this installation and choose an available workspace before starting a chat.")
            return nil
        }
        return AidenNewChatLinkConsent.Target(instanceID: instanceID, deviceID: installation.deviceId,
            pairedAt: installation.createdAt, installationName: installation.name, workspaceID: workspace.id,
            workspaceName: workspace.name, origin: try? requestContext(), startsVoice: startsVoice, createdAt: Date())
    }

    /// Makes the chat someone agreed to, on the pairing they agreed to, and says
    /// where it is. Nil when what they agreed to no longer holds.
    func createChat(
        agreedTo target: AidenNewChatLinkConsent.Target,
        isForeground: @MainActor () -> Bool = { true }
    ) async throws -> AidenNavigationRequest? {
        guard installationStore.installations.contains(where: {
                  $0.id == target.instanceID && $0.deviceId == target.deviceID && $0.createdAt == target.pairedAt
              }),
              let connection = hosts.connection(for: target.instanceID),
              connection.connectionState == .connected,
              let workspace = connection.workspaces.first(where: { $0.id == target.workspaceID }),
              !workspaceArchiveStore.isArchived(workspaceID: target.workspaceID, instanceID: target.instanceID),
              connection.installation.hasNegotiatedAccess(to: .chatWrite),
              let owner = try? ownerContext(for: target.instanceID) else { return nil }
        do {
            // A chat started under Chats can land in a fresh hidden workspace of its own.
            let chat = try await remoteClient(for: owner)
                .createChat(workspaceId: target.workspaceID, noWorkspace: workspace.noWorkspace)
            guard isLive(owner), isForeground(), !chat.isBotChat,
                  chat.workspaceId == target.workspaceID || workspace.noWorkspace else { return nil }
            if !connection.workspaces.contains(where: { $0.id == chat.workspaceId }) {
                try? await connection.refreshWorkspacesForPoll()
                guard isLive(owner), isForeground() else { return nil }
                guard connection.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                    presentedError = AidenNoWorkspace.startedButUnlistedMessage
                    return nil
                }
            }
            return AidenNavigationRequest(destination: .chat(chat.id), instanceId: target.instanceID,
                workspaceId: nil, startsVoice: target.startsVoice)
        } catch {
            _ = await handleCredentialRevocation(error, context: owner)
            throw error
        }
    }
}

struct ContentView: View {
    private enum ConnectionRecoveryDestination: String, Identifiable {
        case installations, pairing
        var id: Self { self }
    }

    @Bindable var coordinator: AidenRemoteCoordinator
    /// Nil with the tab shell off: the menu shell reads one machine, and nothing polls.
    var inboxStore: AidenUnifiedInboxStore?
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
    @State private var connectScheduler: AidenHostConnectScheduler?

    /// Empty with the flag off, where only the selected machine counts.
    private var connectedMachines: [String] {
        guard AppConfig.tabShellEnabled else { return [] }
        return coordinator.hosts.ordered.filter { $0.connectionState == .connected }.map(\.instanceId)
    }

    var body: some View {
        Group {
            // One branch for the shell, whatever the state: a chat held open on a
            // revoked machine must not lose its view to a change of case.
            if coordinator.connectionState == .needsPairing, !coordinator.isHoldingRevokedChat {
                AidenPairingView(
                    coordinator: coordinator,
                    showsIntroduction: !hasCompletedMobileOnboarding,
                    onIntroductionComplete: {
                        hasCompletedMobileOnboarding = true
                    }
                )
            } else if let inboxStore {
                AidenAppShellView(coordinator: coordinator, inboxStore: inboxStore, navigationRequest: $navigationRequest)
            } else {
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
        .task {
            guard connectScheduler == nil else { return }
            let scheduler = AidenHostConnectScheduler(
                registry: coordinator.hosts,
                pathChanges: AidenNetworkPathMonitor.shared.pathChanges()
            )
            connectScheduler = scheduler
            inboxStore?.connectScheduler = scheduler
            if scenePhase == .active { inboxStore?.start() }
            await scheduler.foregrounded()
        }
        .onOpenURL { url in
            foregroundIntents.discardActions()
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
        .task(id: foregroundIntents.actions.map(\.id)) {
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
            foregroundIntents.discardActions()
        }
        .onChange(of: connectedMachines) { previous, connected in
            // A machine connecting late still owes its intents and activities,
            // which the foreground pass found it too early for.
            Task { await consumeForegroundIntentIfReady() }
            let arrived = Set(connected).subtracting(previous)
            Task { await AidenRemoteLiveActivityManager.shared.reconcileConnectedMachines(of: coordinator, only: arrived) }
        }
        .onChange(of: coordinator.installationStore.installations) {
            if AppConfig.tabShellEnabled { foregroundIntents.dropUnopenable(on: coordinator) }
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
        // Only the tab shell waits on a machine other than the selected one.
        .onChange(of: waitingLinkConnectionState) { _, _ in
            consumeExternalNewChatIfReady()
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            consumeExternalNewChatIfReady()
            if newChatConsent.active == nil {
                newChatConsent.invalidate()
                showsNewChatConsent = false
            }
            // A machine the selection left mid-connect had that attempt stopped.
            if scenePhase == .active {
                Task { await connectScheduler?.foregrounded() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch sceneRefreshGate.transition(to: phase) {
            case .refresh:
                inboxStore?.start()
                // A selected machine that needs pairing still releases the
                // scheduler from its background state.
                guard coordinator.connectionState != .needsPairing else {
                    Task { await connectScheduler?.foregrounded() }
                    return
                }
                sceneConnectionRefreshInProgress = true
                // The interactive connect is queued first, and it marks itself
                // in flight before it first suspends. The scheduler's pass
                // queued after it then skips the selected machine, so a foreground
                // return makes one attempt there, under the interactive policy.
                // The wait stays on the selected machine alone, so no other
                // machine can hold up the links it releases.
                Task {
                    await coordinator.connectActiveInstallation()
                    sceneConnectionRefreshInProgress = false
                    consumeExternalNewChatIfReady()
                    await consumeForegroundIntentIfReady()
                    // Bot routine results land as local notifications when
                    // the app comes to the foreground (there is no push).
                    Task { await AidenBotRoutineNotifier.shared.deliverIfSupported(coordinator: coordinator) }
                    if AppConfig.tabShellEnabled {
                        await AidenRemoteLiveActivityManager.shared.reconcileConnectedMachines(of: coordinator)
                    } else if let context = try? coordinator.requestContext(),
                              let client = try? coordinator.remoteClient(for: context) {
                        await AidenRemoteLiveActivityManager.shared.reconcile(
                            instanceID: context.instanceId,
                            client: client,
                            isCurrent: { coordinator.isCurrent(context) }
                        )
                    }
                }
                Task { await connectScheduler?.foregrounded() }
            case .suspend:
                inboxStore?.stop()
                connectScheduler?.backgrounded()
                externalNewChats.invalidate()
                newChatConsent.invalidate()
                showsNewChatConsent = false
                foregroundIntents.handleSuspend()
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

    private var waitingLinkConnectionState: AidenRemoteConnectionState? {
        guard AppConfig.tabShellEnabled, let instanceID = externalNewChats.waiting?.instanceID else { return nil }
        return coordinator.hosts.connection(for: instanceID)?.connectionState
    }

    @MainActor
    private func receiveExternalNewChat(_ request: AidenNavigationRequest) {
        if AppConfig.tabShellEnabled, !coordinator.acceptLink(request) { return }
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
        if AppConfig.tabShellEnabled {
            if externalNewChats.waiting != nil { connectScheduler?.connect(instanceId: instanceID) }
        } else if case .offline = coordinator.connectionState {
            Task { await coordinator.connectActiveInstallation() }
        }
    }

    @MainActor
    private func consumeExternalNewChatIfReady() {
        if foregroundIntents.pending != nil { externalNewChats.invalidate(); return }
        if coordinator.connectionState == .needsPairing { externalNewChats.invalidate(); return }
        let ready = coordinator.isConnected(forLink: externalNewChats.waiting?.instanceID) && scenePhase == .active && !sceneConnectionRefreshInProgress
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
        guard scenePhase == .active else { return }
        if AppConfig.tabShellEnabled {
            // Each intent waits on its own machine, so the selected machine's
            // reconnect holds up nobody else.
            // Its own task: taking an action restarts the `.task(id:)` this may be
            // running in, and a chat being created must not be cancelled with it.
            Task { await foregroundIntents.openWaitingChats(coordinator: coordinator) }
            return
        }
        guard !sceneConnectionRefreshInProgress, coordinator.connectionState == .connected,
              let action = foregroundIntents.take() else { return }
        prepareNewChat(AidenNavigationRequest(destination: .newChat, instanceId: action.instanceID,
            workspaceId: action.workspaceID, startsVoice: false), startsVoice: action.startsVoice, requiresConfirmation: false)
    }

    @MainActor
    private func prepareNewChat(_ request: AidenNavigationRequest, startsVoice: Bool, requiresConfirmation: Bool) {
        guard let target = coordinator.newChatTarget(for: request, startsVoice: startsVoice) else { return }
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
                if AppConfig.tabShellEnabled {
                    guard newChatConsent.active?.id == target.id, scenePhase == .active else { return nil }
                    return try await coordinator.createChat(agreedTo: target, isForeground: { scenePhase == .active })
                }
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
            if retainedNewChatTarget(target), AppConfig.tabShellEnabled || coordinator.activeInstanceId == target.instanceID {
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
        if AppConfig.tabShellEnabled {
            guard coordinator.acceptLink(request) else { return }
            // The route waits for its machine and loads once it answers.
            if let instanceId = request.instanceId ?? coordinator.activeInstanceId {
                connectScheduler?.connect(instanceId: instanceId)
            }
            navigationRequest = request
            return
        }
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
