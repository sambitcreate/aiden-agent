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
    /// False stops late answers from landing, as a moved selection always has.
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
    func hostConnectionWasRevoked(_ connection: AidenHostConnection) async
}

/// One paired machine's live connection: its state, its client, and the
/// generations that make late answers and old request contexts go stale.
@MainActor
@Observable
final class AidenHostConnection {
    private struct ActiveClientKey: Equatable {
        let instanceId: String
        let deviceId: String
        let credentialScope: String
        let generation: Int
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
    @ObservationIgnored weak var delegate: (any AidenHostConnectionDelegate)?

    private let loadCredential: () throws -> String
    private let clientFactory: AidenRemoteCoordinator.ClientFactory
    private var cachedClient: (key: ActiveClientKey, client: AidenRemoteClient)?

    init(
        installation: AidenInstallation,
        credential: @escaping () throws -> String,
        clientFactory: @escaping AidenRemoteCoordinator.ClientFactory,
        generation: Int = 0,
        hostGeneration: Int = 0,
        connectionGeneration: Int = 0
    ) {
        instanceId = installation.id
        self.installation = installation
        loadCredential = credential
        self.clientFactory = clientFactory
        self.generation = generation
        self.hostGeneration = hostGeneration
        self.connectionGeneration = connectionGeneration
    }

    func connect() async {
        guard !isRevoked else { return }
        connectionGeneration &+= 1
        let attempt = connectionGeneration
        connectionState = .connecting
        connectionIssue = nil
        delegate?.hostConnectionWillConnect(self)
        await seedSavedWorkspaces(attempt: attempt)
        do {
            try await load(credential: nonEmptyCredential(), attempt: attempt)
        } catch {
            guard isCurrent(attempt: attempt) else { return }
            await handleConnectionError(error)
        }
    }

    /// Ends this connection's lease: contexts and answers from before this
    /// call go stale. The state returns to where a new connection starts.
    func disconnect() {
        generation &+= 1
        hostGeneration &+= 1
        connectionGeneration &+= 1
        cachedClient = nil
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

    func handleConnectionError(_ error: Error) async {
        guard isSelected else { return }
        if let clientError = error as? AidenRemoteClientError, clientError.isCredentialRevoked {
            if let delegate {
                await delegate.hostConnectionWasRevoked(self)
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
        delegate?.hostConnection(self, didFailWith: error)
    }

    func applyWorkspaceSnapshot(_ workspaces: [AidenWorkspace]) {
        guard isSelected else { return }
        self.workspaces = workspaces
        delegate?.hostConnectionDidApplyWorkspaceSnapshot(self)
    }

    /// Existing pairings predate the progress opt-in field. Upgrade them only
    /// after the authenticated server advertises the matching feature. A
    /// failed additive negotiation is non-fatal and leaves progress hidden.
    func negotiateProgressCapabilitiesIfNeeded(
        server: AidenServer,
        client: AidenRemoteClient,
        attempt: Int
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
            await handleRevocationDuringNegotiation(error, attempt: attempt)
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

    // MARK: Private

    private var isSelected: Bool {
        delegate?.hostConnectionIsSelected(self) ?? true
    }

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

    private func isCurrent(attempt: Int) -> Bool {
        isSelected && connectionGeneration == attempt
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
        cachedClient = (key, client)
        return client
    }

    private func load(credential: String, attempt: Int) async throws {
        let client = try client(credential: credential)
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
        await negotiateProgressCapabilitiesIfNeeded(server: server, client: client, attempt: attempt)
        for capabilities in Self.capabilitiesAskedForAlone {
            await negotiateCapabilityAloneIfNeeded(capabilities, client: client, attempt: attempt)
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
    /// `attachments:raw` (revision 50), then `chat:new-worktree` (revision 53).
    static let capabilitiesAskedForAlone: [[AidenRemoteCapability]] = [
        [.botHandoffs, .botHandoffNotes, .botHandoffOnMac],
        [.scheduleCards],
        [.botImages],
        [.botIssues],
        [.chatJobs],
        [.attachmentsRaw],
        [.chatNewWorktree],
        [.botMessaging],
        [.botAccessRequests],
        [.botPlans],
        [.botAllowed],
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
        attempt: Int
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
            await handleRevocationDuringNegotiation(error, attempt: attempt)
        }
    }

    private func handleRevocationDuringNegotiation(_ error: Error, attempt: Int) async {
        guard isCurrent(attempt: attempt),
              let clientError = error as? AidenRemoteClientError,
              clientError.isCredentialRevoked else { return }
        await handleConnectionError(error)
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
