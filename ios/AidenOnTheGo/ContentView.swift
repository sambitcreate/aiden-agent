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

/// Links. Each one goes to the machine it names and leaves the selection where
/// it is, so whatever is open on the selected machine stays open.
extension AidenRemoteCoordinator {
    /// False, with the reason on screen, for a machine that can't answer a link:
    /// one that isn't paired, or that has revoked this phone.
    func acceptLink(_ request: AidenNavigationRequest) -> Bool {
        let instanceId = request.instanceId ?? defaultInstanceId
        guard installationStore.installations.contains(where: { $0.id == instanceId }),
              let instanceId,
              hosts.connection(for: instanceId)?.isRevoked != true else {
            presentedError = noLongerPairedMessage(for: instanceId)
            return false
        }
        return true
    }

    /// Nothing on screen says which machine a link was for, so the message names
    /// it as the Inbox does, suffix included when two machines share a name, or
    /// says "That machine" when the phone doesn't know it.
    func noLongerPairedMessage(for instanceId: String?) -> String {
        let labels = AidenMachineLabel.labels(connections: hosts.ordered, preferences: machinePreferences)
        guard let name = instanceId.flatMap({ labels[$0]?.name }) else {
            return String(localized: "That machine is no longer paired. Pair it again to continue.")
        }
        return String(localized: "\(name) is no longer paired. Pair it again to continue.")
    }

    /// Whether a link for this machine can go ahead: that machine is connected.
    /// A link that names none asks the selected one.
    func isConnected(forLink instanceID: String?) -> Bool {
        guard let instanceID else { return connectionState == .connected }
        return hosts.connection(for: instanceID)?.connectionState == .connected
    }

    /// What a new-chat prompt offers for this request, or nil with the reason on
    /// screen. Nothing is created until the person agrees to the result.
    func newChatTarget(
        for request: AidenNavigationRequest,
        startsVoice: Bool
    ) -> AidenNewChatLinkConsent.Target? {
        guard let instanceID = request.instanceId ?? defaultInstanceId,
              isConnected(forLink: instanceID),
              let installation = installationStore.installations.first(where: { $0.id == instanceID }) else {
            presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return nil
        }
        let archived = workspaceArchiveStore.archivedWorkspaceIDs(for: instanceID)
        let candidates: [AidenIntentWorkspaceRecord]
        // Nil sends the link to the saved catalog.
        let listed = hosts.connection(for: instanceID)?.workspaces
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
    var inboxStore: AidenUnifiedInboxStore
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

    @ViewBuilder
    private var connectionRecovery: some View {
        if case .offline = coordinator.connectionState, let issue = coordinator.connectionIssue {
            AidenConnectionRecoveryView(coordinator: coordinator, issue: issue) {
                connectionRecoveryDestination = .installations
            }
        }
    }

    private var connectedMachines: [String] {
        coordinator.hosts.ordered.filter { $0.connectionState == .connected }.map(\.instanceId)
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
            } else {
                // Above the shell, not an inset on it: an inset leaves the
                // navigation bars behind the banner, Back included.
                VStack(spacing: 0) {
                    connectionRecovery
                    AidenAppShellView(coordinator: coordinator, inboxStore: inboxStore, navigationRequest: $navigationRequest)
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
            inboxStore.connectScheduler = scheduler
            if scenePhase == .active { inboxStore.start() }
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
                open(request)
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
            // One still waiting gets its answer when its minute is up, even if
            // nothing else changes by then.
            guard let wait = foregroundIntents.timeUntilNextExpiry() else { return }
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
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
            foregroundIntents.dropUnopenable(on: coordinator)
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
        // A link can wait on a machine other than the selected one.
        .onChange(of: waitingLinkConnectionState) { _, _ in
            consumeExternalNewChatIfReady()
        }
        .onChange(of: coordinator.defaultInstanceId) { _, _ in
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
                inboxStore.start()
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
                    await AidenRemoteLiveActivityManager.shared.reconcileConnectedMachines(of: coordinator)
                }
                Task { await connectScheduler?.foregrounded() }
            case .suspend:
                inboxStore.stop()
                connectScheduler?.backgrounded()
                externalNewChats.invalidate()
                newChatConsent.invalidate()
                showsNewChatConsent = false
                // An intent that hasn't started stays queued: its minute still
                // runs out, and nothing is made until the app is back in front.
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
        guard let instanceID = externalNewChats.waiting?.instanceID else { return nil }
        return coordinator.hosts.connection(for: instanceID)?.connectionState
    }

    @MainActor
    private func receiveExternalNewChat(_ request: AidenNavigationRequest) {
        guard coordinator.acceptLink(request) else { return }
        guard coordinator.connectionState != .needsPairing,
              let instanceID = request.instanceId ?? coordinator.defaultInstanceId,
              let installation = coordinator.installationStore.installations.first(where: { $0.id == instanceID }),
              let origin = try? coordinator.requestContext() else {
            coordinator.presentedError = String(localized: "Connect to Aiden Agent before opening this link.")
            return
        }
        externalNewChats.receive(.init(request: request, origin: origin, instanceID: instanceID,
            deviceID: installation.deviceId, pairedAt: installation.createdAt))
        consumeExternalNewChatIfReady()
        if externalNewChats.waiting != nil { connectScheduler?.connect(instanceId: instanceID) }
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
        proposeNewChat(.init(destination: .newChat, instanceId: entry.instanceID,
            workspaceId: entry.request.workspaceId, startsVoice: false))
    }

    @MainActor
    private func consumeForegroundIntentIfReady() async {
        guard scenePhase == .active else { return }
        // Each intent waits on its own machine, so the selected machine's
        // reconnect holds up nobody else.
        // Its own task: taking an action restarts the `.task(id:)` this may be
        // running in, and a chat being created must not be cancelled with it.
        Task {
            await foregroundIntents.openWaitingChats(coordinator: coordinator, connect: {
                connectScheduler?.connect(instanceId: $0)
            })
        }
    }

    @MainActor
    private func proposeNewChat(_ request: AidenNavigationRequest) {
        guard let target = coordinator.newChatTarget(for: request, startsVoice: false) else { return }
        guard newChatConsent.propose(target) else { return }
        showsNewChatConsent = true
    }

    @MainActor
    private func createNewChat(_ target: AidenNewChatLinkConsent.Target) async {
        do {
            let request: AidenNavigationRequest? = try await newChatConsent.perform(id: target.id, isValid: {
                scenePhase == .active && target.origin.map(coordinator.isCurrent) == true
                    && retainedNewChatTarget(target)
            }) { target in
                guard newChatConsent.active?.id == target.id, scenePhase == .active else { return nil }
                return try await coordinator.createChat(agreedTo: target, isForeground: { scenePhase == .active })
            }
            if let request { navigationRequest = request }
        } catch {
            // A mutation is never retried after an uncertain result.
            if retainedNewChatTarget(target) {
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
    private func open(_ request: AidenNavigationRequest) {
        guard coordinator.acceptLink(request) else { return }
        // The route waits for its machine and loads once it answers.
        if let instanceId = request.instanceId ?? coordinator.defaultInstanceId {
            connectScheduler?.connect(instanceId: instanceId)
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

    @Environment(\.aidenPalette) private var palette

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
        // Glass and material are for the bars, so this is a plain surface.
        .background(palette.raised)
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
        let coordinator = AidenRemoteCoordinator(haptics: haptics)
        ContentView(coordinator: coordinator, inboxStore: AidenUnifiedInboxStore(coordinator: coordinator))
    }
    .environment(appearance)
    .environment(haptics)
    .aidenHapticHost(haptics)
}
