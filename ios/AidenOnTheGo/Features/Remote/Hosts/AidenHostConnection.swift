import Foundation
import Observation

/// An opaque lease on one paired machine. `generation` prevents an A -> B -> A
/// switch from making work started during the first A activation current
/// again. `hostGeneration` says whether the machine's pairing is still the one
/// this context was issued under, whatever the selection did since.
struct AidenRemoteRequestContext: Equatable, Hashable, Sendable {
    /// What may use the context. `selected` work stops once the selection
    /// moves. `owner` work belongs to its machine and carries on until that
    /// machine's lease ends.
    enum Scope: Sendable {
        case selected
        case owner
    }

    let instanceId: String
    let deviceId: String
    let generation: Int
    let hostGeneration: Int
    let scope: Scope

    init(
        instanceId: String,
        deviceId: String,
        generation: Int,
        hostGeneration: Int = 0,
        scope: Scope = .selected
    ) {
        self.instanceId = instanceId
        self.deviceId = deviceId
        self.generation = generation
        self.hostGeneration = hostGeneration
        self.scope = scope
    }
}

extension AidenRemoteRequestContext {
    /// The owner of a model with no machine: a read-only fixture, or a screen
    /// opened with nothing paired. It is never live.
    static let noMachine = AidenRemoteRequestContext(
        instanceId: "",
        deviceId: "",
        generation: 0,
        scope: .owner
    )
}

/// What a connection asks of whoever owns it: the saved pairing, the caches,
/// and the app-wide error. A connection with no delegate is on its own, so it
/// counts as selected, keeps its installation in memory, and has nothing to
/// persist.
@MainActor
protocol AidenHostConnectionDelegate: AnyObject {
    /// False keeps this connection's results out of app-wide state. They still
    /// land on the connection itself.
    func hostConnectionIsSelected(_ connection: AidenHostConnection) -> Bool
    /// The saved record for this connection, or nil once it was forgotten.
    func hostConnectionSavedInstallation(_ connection: AidenHostConnection) -> AidenInstallation?
    func hostConnectionSavedWorkspaces(_ connection: AidenHostConnection) async -> [AidenWorkspace]?
    func hostConnectionWillConnect(_ connection: AidenHostConnection)
    func hostConnection(_ connection: AidenHostConnection, didReceive server: AidenServer) throws
    func hostConnection(
        _ connection: AidenHostConnection,
        didNegotiate capabilities: [AidenRemoteCapability],
        confirmedBy server: AidenServer
    ) throws
    func hostConnectionDidApplyWorkspaceSnapshot(_ connection: AidenHostConnection)
    func hostConnection(_ connection: AidenHostConnection, didFailWith error: Error)
    /// The selected machine's credential was revoked. `route` is the attempt that
    /// found out: only a probe holds a scheduler slot, so only there must the
    /// next machine's connect stay out of the attempt.
    func hostConnectionWasRevoked(_ connection: AidenHostConnection, over route: AidenHostConnection.ConnectRoute) async
    /// A machine other than the selected one had its credential revoked. Its
    /// cached data stays while a view is on screen showing it. A view under a
    /// full-screen cover counts as gone, because `.onDisappear` fires for it.
    func hostConnectionWasRevokedInBackground(_ connection: AidenHostConnection) async
    /// The machine can't go on without being paired again.
    func hostConnectionNeedsPairing(_ connection: AidenHostConnection)
}

/// One paired machine's live connection: its state, its client, and the
/// generations that make late answers and old request contexts go stale.
@MainActor
@Observable
final class AidenHostConnection {
    /// How an attempt reaches the machine. A person waits on `interactive`, and
    /// its failure is theirs to see. `probe` is a background check: it gives up
    /// rather than waits, and it never touches the app-wide error.
    enum ConnectRoute {
        case interactive
        case probe
    }

    private struct ActiveClientKey: Equatable {
        let instanceId: String
        let deviceId: String
        let credentialScope: String
        let generation: Int
    }

    private struct CachedClient {
        let key: ActiveClientKey
        let client: AidenRemoteClient
    }

    private struct ConnectInFlight {
        let attempt: Int
        let route: ConnectRoute
        let work: Task<Void, Never>
    }

    /// Where the machine stood before an attempt, so stopping that attempt
    /// doesn't leave it saying "Connecting".
    private struct SettledState {
        let connectionState: AidenRemoteConnectionState
        let connectionIssue: AidenConnectionIssue?
    }

    let instanceId: String
    private(set) var installation: AidenInstallation
    private(set) var connectionState: AidenRemoteConnectionState = .connecting
    private(set) var connectionIssue: AidenConnectionIssue?
    private(set) var server: AidenServer?
    private(set) var workspaces: [AidenWorkspace] = []
    /// The activation lease every request context carries. A reconnect leaves
    /// it alone, so contexts survive a dropped network. Each arrival of the
    /// selection moves it, so A -> B -> A can't make an old context current
    /// again.
    private(set) var generation: Int
    /// The machine's own lease, which `isLive` compares. Only a re-pairing,
    /// `disconnect()`, or a revocation moves it. The selection never does, so
    /// owner work survives the selection leaving and coming back.
    private(set) var hostGeneration: Int
    /// Moves on every connect attempt, so a late answer from an earlier attempt
    /// is dropped.
    private(set) var connectionGeneration: Int
    private(set) var isRevoked = false
    /// Revoked with its cached data still in place, because a view is showing
    /// it. `completeRevokedPurge(instanceId:)` ends this.
    private(set) var isPurgePending = false
    @ObservationIgnored weak var delegate: (any AidenHostConnectionDelegate)?

    private let loadCredential: () throws -> String
    private let clientFactory: AidenRemoteCoordinator.ClientFactory
    private let probeClientFactory: AidenRemoteCoordinator.ClientFactory
    private var cachedClient: CachedClient?
    private var cachedProbeClient: CachedClient?
    private var connectInFlight: ConnectInFlight?
    private var settledState: SettledState?

    /// `probeClientFactory` defaults to `clientFactory`, so a test's one fake
    /// transport carries both.
    init(
        installation: AidenInstallation,
        credential: @escaping () throws -> String,
        clientFactory: @escaping AidenRemoteCoordinator.ClientFactory,
        probeClientFactory: AidenRemoteCoordinator.ClientFactory? = nil,
        generation: Int = 0,
        hostGeneration: Int = 0,
        connectionGeneration: Int = 0
    ) {
        instanceId = installation.id
        self.installation = installation
        loadCredential = credential
        self.clientFactory = clientFactory
        self.probeClientFactory = probeClientFactory ?? clientFactory
        self.generation = generation
        self.hostGeneration = hostGeneration
        self.connectionGeneration = connectionGeneration
    }

    /// `timeout` bounds the whole attempt. Past it, a machine that hasn't
    /// answered goes offline and whatever is still running stops.
    func connect(over route: ConnectRoute = .interactive, timeout: TimeInterval? = nil) async {
        guard !isRevoked else { return }
        connectionGeneration &+= 1
        let attempt = connectionGeneration
        if connectionState != .connecting {
            settledState = SettledState(connectionState: connectionState, connectionIssue: connectionIssue)
        }
        connectionState = .connecting
        connectionIssue = nil
        if route == .interactive {
            delegate?.hostConnectionWillConnect(self)
        }
        let work = Task { await run(attempt: attempt, over: route) }
        connectInFlight = ConnectInFlight(attempt: attempt, route: route, work: work)
        let deadline = timeout.map { timeout in
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                // An attempt that ended can still be running, such as a revocation
                // finishing its purge.
                guard !Task.isCancelled, isCurrent(attempt: attempt) else { return }
                await expire(attempt: attempt, over: route)
                work.cancel()
            }
        }
        await withTaskCancellationHandler {
            await work.value
        } onCancel: {
            work.cancel()
        }
        deadline?.cancel()
        if connectInFlight?.attempt == attempt {
            connectInFlight = nil
        }
    }

    /// Offline, or checking again after being offline. Each probe passes through
    /// `.connecting`, and that isn't news of the machine coming back.
    var isKnownOffline: Bool {
        switch connectionState {
        case .offline: true
        case .connecting:
            if case .offline = settledState?.connectionState { true } else { false }
        default: false
        }
    }

    /// Connected, or checking again after being connected. A machine that
    /// hasn't answered since launch isn't known online, whatever its saved rows
    /// say.
    var isKnownOnline: Bool {
        switch connectionState {
        case .connected: true
        case .connecting: settledState?.connectionState == .connected
        default: false
        }
    }

    /// True while the newest attempt is running. `connectionState` can't say:
    /// it starts at `.connecting`, and `disconnect()` returns it there, with
    /// nothing in flight either time.
    var isConnectInFlight: Bool {
        connectInFlight?.attempt == connectionGeneration
    }

    /// Stops the attempt in flight and puts the machine back where it stood
    /// before it. Only `connectionGeneration` moves, so every live context stays
    /// live. A machine that had never settled stays at `.connecting`, with
    /// `isConnectInFlight` false, until something connects it again. One that
    /// already answered stays `.connected`: only negotiation was left to stop.
    ///
    /// With `route`, only an attempt over that route stops. The scheduler passes
    /// `.probe`, so an interactive connect that took over from its probe isn't
    /// cut short by the app leaving the foreground.
    func cancelConnect(over route: ConnectRoute? = nil) {
        guard isConnectInFlight else { return }
        if let route, connectInFlight?.route != route { return }
        connectInFlight?.work.cancel()
        connectInFlight = nil
        connectionGeneration &+= 1
        if connectionState == .connecting, let settledState {
            connectionState = settledState.connectionState
            connectionIssue = settledState.connectionIssue
        }
    }

    /// Ends this connection's lease: contexts and answers from before this
    /// call go stale. The state returns to where a new connection starts.
    func disconnect() {
        generation &+= 1
        hostGeneration &+= 1
        connectionGeneration &+= 1
        cachedClient = nil
        cachedProbeClient = nil
        settledState = nil
        server = nil
        workspaces = []
        connectionIssue = nil
        connectionState = .connecting
    }

    func requestContext(
        scope: AidenRemoteRequestContext.Scope = .selected
    ) throws -> AidenRemoteRequestContext {
        guard !isRevoked else { throw AidenRemoteClientError.installationChanged }
        return AidenRemoteRequestContext(
            instanceId: instanceId,
            deviceId: installation.deviceId,
            generation: generation,
            hostGeneration: hostGeneration,
            scope: scope
        )
    }

    /// True while `context` is this machine's and its lease hasn't ended.
    func isLive(_ context: AidenRemoteRequestContext) -> Bool {
        !isRevoked
            && context.instanceId == instanceId
            && context.deviceId == installation.deviceId
            && context.hostGeneration == hostGeneration
    }

    func client() throws -> AidenRemoteClient {
        guard !isRevoked else { throw AidenRemoteClientError.missingCredential }
        // The cache key changes whenever the installation's device identity,
        // its credential scope, or the generation does, so a hit never needs
        // the Keychain read below.
        if let cachedClient, cachedClient.key == clientKey {
            return cachedClient.client
        }
        return try client(credential: nonEmptyCredential())
    }

    /// For connect checks and Inbox polling. It fails fast rather than waits
    /// for a network, so one unreachable machine can't hold a connect slot. The
    /// client from `client()` keeps the interactive policy.
    func probeClient() throws -> AidenRemoteClient {
        guard !isRevoked else { throw AidenRemoteClientError.missingCredential }
        if let cachedProbeClient, cachedProbeClient.key == clientKey {
            return cachedProbeClient.client
        }
        return try probeClient(credential: nonEmptyCredential())
    }

    func handleConnectionError(_ error: Error) async {
        await record(error, over: .interactive)
    }

    /// What a failed Inbox poll says about the machine. It counts as a probe: a
    /// transport failure takes a machine that said it was connected offline, and
    /// nothing reaches the app-wide error, because nobody was waiting on it.
    /// `connectionGeneration` is where it stood when the poll began. A connect
    /// since then, or one under way, knows better than a poll that was already
    /// out, so the failure is dropped. Revocation always counts. False when
    /// dropped.
    func handlePollError(_ error: Error, sinceConnect generation: Int) async -> Bool {
        let isRevocation = (error as? AidenRemoteClientError)?.isCredentialRevoked == true
        guard isRevocation || (connectionGeneration == generation && !isConnectInFlight) else { return false }
        await record(error, over: .probe)
        return true
    }

    /// Reads the workspace list again for a poll that found a chat outside it.
    /// A connect that ran meanwhile has answered with a newer list. A failure
    /// after the lease ended is the old pairing's, so it surfaces as cancellation.
    func refreshWorkspacesForPoll() async throws {
        let context = try requestContext(scope: .owner)
        let generation = connectionGeneration
        let workspaces: [AidenWorkspace]
        do {
            workspaces = try await probeClient().workspaces()
        } catch {
            guard isLive(context) else { throw CancellationError() }
            throw error
        }
        try Task.checkCancellation()
        guard isLive(context), connectionGeneration == generation else { return }
        applyWorkspaceSnapshot(workspaces)
    }

    func applyWorkspaceSnapshot(_ workspaces: [AidenWorkspace]) {
        self.workspaces = workspaces
        delegate?.hostConnectionDidApplyWorkspaceSnapshot(self)
    }

    /// Existing pairings predate the progress opt-in field. Upgrade them only
    /// after the authenticated server advertises the matching feature. A
    /// failed additive negotiation is non-fatal and leaves progress hidden.
    func negotiateProgressCapabilitiesIfNeeded(
        server: AidenServer,
        client: AidenRemoteClient,
        attempt: Int,
        over route: ConnectRoute = .interactive
    ) async {
        guard isCurrent(attempt: attempt) else { return }
        var requested: [AidenRemoteCapability] = []
        if server.supportsChatTasks { requested.append(.tasksRead) }
        if server.supportsChatAgents { requested.append(.agentsRead) }
        if server.supportsQuestionPrompts { requested.append(.questionsRespond) }
        if server.supportsChatSkills { requested.append(.skillsInvoke) }
        if server.supportsPhoneRunControl { requested += [.runsObserve, .runsControl] }
        if server.supportsMobileSimulators { requested.append(.simulatorsMobile) }
        if server.supportsBotCards { requested.append(.botCards) }
        if server.offersBotActivity { requested.append(.botActivity) }
        if server.features.contains("chat-ui-panels-enabled-v1") { requested.append(contentsOf: [.appControlsRead, .appControlsRespond]) }
        guard !requested.isEmpty, let installation = savedInstallation else { return }
        let missing = requested.filter {
            !installation.deviceCapabilities.contains($0)
                || installation.serverCapabilities?.contains($0) != true
        }
        guard !missing.isEmpty else { return }
        do {
            let negotiatedCapabilities = try await client.updateDeviceCapabilities(accepts: missing)
            guard isCurrent(attempt: attempt) else { return }
            let refreshedServer = try await client.server()
            guard isCurrent(attempt: attempt), refreshedServer.instanceId == instanceId else { return }
            try delegate?.hostConnection(self, didNegotiate: negotiatedCapabilities, confirmedBy: refreshedServer)
            self.server = refreshedServer
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            // Feature discovery and the device-capability update are additive;
            // older Macs remain connected with the existing feature set.
            await handleRevocationDuringNegotiation(error, attempt: attempt, over: route)
        }
    }

    // MARK: Writes from the owner

    /// Picks up a re-pairing or a saved change to this machine's record.
    func adopt(installation: AidenInstallation) {
        guard installation.id == instanceId, installation != self.installation else { return }
        self.installation = installation
    }

    func adopt(connectionState: AidenRemoteConnectionState) {
        self.connectionState = connectionState
        settledState = nil
        if connectionState == .needsPairing {
            delegate?.hostConnectionNeedsPairing(self)
        }
    }

    func adopt(connectionIssue: AidenConnectionIssue?) {
        self.connectionIssue = connectionIssue
    }

    func adopt(server: AidenServer?) {
        self.server = server
    }

    func adopt(workspaces: [AidenWorkspace]) {
        self.workspaces = workspaces
    }

    func advanceGeneration() {
        generation &+= 1
    }

    /// A new pairing replaced the one earlier contexts were issued under.
    func advanceHostGeneration() {
        hostGeneration &+= 1
    }

    func advanceConnectionGeneration() {
        connectionGeneration &+= 1
    }

    /// A revoked connection stays revoked: its credential is gone for good, so
    /// it issues no context or client and never connects again.
    func markRevoked() {
        isRevoked = true
        hostGeneration &+= 1
    }

    /// Revoked, with the purge held back until the views showing this machine
    /// have gone. Nothing here reconnects it, so it stops at `.needsPairing`.
    func markRevokedWithPurgePending() {
        markRevoked()
        isPurgePending = true
        connectionIssue = nil
        adopt(connectionState: .needsPairing)
    }

    func purgeStarted() {
        isPurgePending = false
    }

    var isSelected: Bool {
        delegate?.hostConnectionIsSelected(self) ?? true
    }

    // MARK: Private

    private var savedInstallation: AidenInstallation? {
        guard let delegate else { return installation }
        return delegate.hostConnectionSavedInstallation(self)
    }

    private var clientKey: ActiveClientKey {
        ActiveClientKey(
            instanceId: instanceId,
            deviceId: installation.deviceId,
            credentialScope: installation.credentialScope,
            generation: generation
        )
    }

    /// Every attempt lands on this machine's own connection, selected or not.
    /// The selection leaving stops a running attempt through `cancelConnect()`.
    private func isCurrent(attempt: Int) -> Bool {
        connectionGeneration == attempt
    }

    private func run(attempt: Int, over route: ConnectRoute) async {
        await seedSavedWorkspaces(attempt: attempt)
        do {
            let credential = try nonEmptyCredential()
            let client = route == .probe
                ? try probeClient(credential: credential)
                : try client(credential: credential)
            try await load(using: client, attempt: attempt, over: route)
        } catch {
            guard isCurrent(attempt: attempt) else { return }
            await record(error, over: route)
        }
    }

    private func expire(attempt: Int, over route: ConnectRoute) async {
        guard isCurrent(attempt: attempt), connectionState == .connecting else { return }
        connectionGeneration &+= 1
        await record(URLError(.timedOut), over: route)
    }

    private func record(_ error: Error, over route: ConnectRoute) async {
        if let clientError = error as? AidenRemoteClientError, clientError.isCredentialRevoked {
            if let delegate {
                if isSelected {
                    await delegate.hostConnectionWasRevoked(self, over: route)
                } else {
                    await delegate.hostConnectionWasRevokedInBackground(self)
                }
            } else {
                markRevoked()
                disconnect()
                connectionState = .needsPairing
            }
            return
        }
        if let clientError = error as? AidenRemoteClientError,
           case .server = clientError, connectionState != .connecting {
            connectionIssue = nil
            connectionState = .connected
        } else {
            let issue = AidenConnectionIssue.classify(error)
            connectionIssue = issue
            connectionState = .offline(message: issue.message)
        }
        if route == .interactive {
            delegate?.hostConnection(self, didFailWith: error)
        }
    }

    private func nonEmptyCredential() throws -> String {
        let credential = try loadCredential()
        guard !credential.isEmpty else { throw AidenRemoteClientError.missingCredential }
        return credential
    }

    private func client(credential: String) throws -> AidenRemoteClient {
        let key = clientKey
        if let cachedClient, cachedClient.key == key {
            return cachedClient.client
        }
        let client = try clientFactory(installation, credential)
        cachedClient = CachedClient(key: key, client: client)
        return client
    }

    private func probeClient(credential: String) throws -> AidenRemoteClient {
        let key = clientKey
        if let cachedProbeClient, cachedProbeClient.key == key {
            return cachedProbeClient.client
        }
        let client = try probeClientFactory(installation, credential)
        cachedProbeClient = CachedClient(key: key, client: client)
        return client
    }

    private func load(using client: AidenRemoteClient, attempt: Int, over route: ConnectRoute) async throws {
        async let serverRequest = client.server()
        async let workspaceRequest = client.workspaces()
        let (server, workspaces) = try await (serverRequest, workspaceRequest)
        guard server.instanceId == instanceId else {
            throw AidenRemoteContractError.invalidPairingExchange
        }
        guard isCurrent(attempt: attempt) else { return }
        try delegate?.hostConnection(self, didReceive: server)
        self.server = server
        applyWorkspaceSnapshot(workspaces)
        connectionIssue = nil
        connectionState = .connected
        await refreshDeviceIdentity(using: client, currentName: server.deviceName)
        await negotiateProgressCapabilitiesIfNeeded(server: server, client: client, attempt: attempt, over: route)
        for capabilities in Self.capabilitiesAskedForAlone {
            await negotiateCapabilityAloneIfNeeded(capabilities, client: client, attempt: attempt, over: route)
        }
    }

    /// Shows the last saved workspace list while the connection comes up, so
    /// Home can project saved Recents instead of an empty state. A live answer
    /// that arrived first always wins.
    private func seedSavedWorkspaces(attempt: Int) async {
        guard workspaces.isEmpty,
              let saved = await delegate?.hostConnectionSavedWorkspaces(self),
              isCurrent(attempt: attempt),
              workspaces.isEmpty else { return }
        // Not a live snapshot, so the workspace revision stays put and archive
        // pruning waits for the Mac's own answer.
        workspaces = saved
    }

    /// Opt-ins a Mac older than their revision refuses by name, in the order
    /// they are asked for after the progress batch: `bot:handoffs` (revision
    /// 37), with `bot:handoff-notes` (revision 40) and `bot:handoff-on-mac`
    /// (revision 43) in the same call when the Mac offers them, then
    /// `schedule:cards` (revision 39), then `bot:images` (revision 45), then
    /// `bot:issues` (revision 42), then `chat:jobs` (revision 49), then
    /// `attachments:raw` (revision 50), then `chat:new-worktree` (revision 53),
    /// then continuity watches, Open work, routine models and peers (revision 59),
    /// followed by messaging, access requests, plans and allowed lists (revisions 54–57),
    /// then the five revision-61 Bot UX opt-ins, one call each.
    static let capabilitiesAskedForAlone: [[AidenRemoteCapability]] = [
        [.botHandoffs, .botHandoffNotes, .botHandoffOnMac],
        [.scheduleCards],
        [.botImages],
        [.botIssues],
        [.chatJobs],
        [.attachmentsRaw],
        [.chatNewWorktree],
        [.botWatches],
        [.botOpenWork],
        [.botRoutineModels],
        [.botPeers],
        [.botMessaging],
        [.botAccessRequests],
        [.botPlans],
        [.botAllowed],
        [.approvalCards],
        [.approvalsSettings],
        [.botSettingsChanges],
        [.botSuggestions],
        [.botTemplates],
    ]

    /// Contract revisions 37 and 39: `bot:handoffs` and `schedule:cards` are
    /// each asked for in a call of their own, after the progress batch, and
    /// only while the Mac lists them in `serverCapabilities`. A Mac that does
    /// not know a name refuses the whole request with a 400, so naming it in
    /// the batch could cost the device every other opt-in. A refusal leaves the
    /// earlier grants as they are. Revision 40: the rest of a group, such as
    /// `bot:handoff-notes`, joins its first opt-in's call only while the Mac
    /// offers that first one and lists the member too, so a Mac on an earlier
    /// revision still grants `bot:handoffs`, and a device that holds it asks
    /// for the notes alone once its Mac updates.
    private func negotiateCapabilityAloneIfNeeded(
        _ capabilities: [AidenRemoteCapability],
        client: AidenRemoteClient,
        attempt: Int,
        over route: ConnectRoute
    ) async {
        guard isCurrent(attempt: attempt),
              let server = self.server, server.instanceId == instanceId,
              let first = capabilities.first, server.serverCapabilities?.contains(first) == true,
              let installation = savedInstallation else {
            return
        }
        let missing = capabilities.filter {
            server.serverCapabilities?.contains($0) == true && !installation.hasNegotiatedAccess(to: $0)
        }
        guard !missing.isEmpty else { return }
        do {
            let negotiatedCapabilities = try await client.updateDeviceCapabilities(accepts: missing)
            guard isCurrent(attempt: attempt) else { return }
            let refreshedServer = try await client.server()
            guard isCurrent(attempt: attempt), refreshedServer.instanceId == instanceId else { return }
            try delegate?.hostConnection(self, didNegotiate: negotiatedCapabilities, confirmedBy: refreshedServer)
            self.server = refreshedServer
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            // A Mac without the route, or a refusal (400 or 404), keeps the
            // grants the device already has: hand-offs stay on the Mac, and
            // scheduled-task approvals keep the summary card.
            await handleRevocationDuringNegotiation(error, attempt: attempt, over: route)
        }
    }

    private func handleRevocationDuringNegotiation(_ error: Error, attempt: Int, over route: ConnectRoute) async {
        guard isCurrent(attempt: attempt),
              let clientError = error as? AidenRemoteClientError,
              clientError.isCredentialRevoked else { return }
        await record(error, over: route)
    }

    private func refreshDeviceIdentity(
        using client: AidenRemoteClient,
        currentName: String?
    ) async {
        let name = AidenRemoteCoordinator.deviceName
        guard let currentName, currentName != name else { return }
        // Older Macs do not expose this additive route. A failed label refresh
        // must never make a valid authenticated connection fail.
        try? await client.updateDeviceIdentity(name: name)
    }
}
