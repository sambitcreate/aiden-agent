import Foundation

extension AidenBotCreateOperations {
    /// The context a New Bot goes out on: a picked machine's own, or the selected
    /// one's when none was picked. A picked machine that left throws, because the Bot
    /// must never land on the default instead.
    @MainActor
    static func context(for target: AidenNewWorkTarget?, coordinator: AidenRemoteCoordinator) throws -> AidenRemoteRequestContext {
        guard let target else { return try coordinator.requestContext() }
        return try coordinator.ownerContext(for: target.instanceId)
    }

    /// A create on the context's machine. An owner context stays good when the
    /// default moves; a selected one ends with the selection.
    @MainActor
    static func make(coordinator: AidenRemoteCoordinator, context: AidenRemoteRequestContext) -> AidenBotCreateOperations {
        AidenBotCreateOperations(
            instanceId: context.instanceId,
            deviceId: context.deviceId,
            usesDurableSession: AidenBotHostFeature.isAdvertised(
                AidenBotHostFeature.durableSession,
                by: coordinator.knownServerFeatures(of: context.instanceId)
            ),
            waitForConnection: { hold in
                switch context.scope {
                case .selected: await aidenBotWaitForConnection(coordinator, hold: hold)
                case .owner: await aidenBotWaitForConnection(coordinator, on: context.instanceId, hold: hold)
                }
            },
            catalog: { try await coordinator.remoteClient(for: context).botCapabilityCatalog() },
            create: { request, key in try await coordinator.remoteClient(for: context).createBot(request, idempotencyKey: key) },
            createChat: { botID, request, key in
                _ = try await coordinator.remoteClient(for: context).createBotChat(botId: botID, request: request, idempotencyKey: key)
            },
            readBot: { botID in try await coordinator.remoteClient(for: context).bot(id: botID) },
            isCurrent: { coordinator.holds(context) },
            handleRevocation: { error in await coordinator.handleCredentialRevocation(error, context: context) }
        )
    }
}

extension AidenBotCreateFlow {
    /// The pairings a create could wait on, in pairing order. A revoked machine,
    /// or one that has to be paired again, keeps nothing that could go out.
    private func pairings(_ coordinator: AidenRemoteCoordinator) -> [AidenRemoteRequestContext] {
        coordinator.hosts.ordered.compactMap { connection in
            guard !connection.isRevoked, connection.connectionState != .needsPairing else { return nil }
            return try? connection.requestContext(scope: .owner)
        }
    }

    /// Changes as machines are paired, so Bots home looks again.
    func parkedAskScopes(coordinator: AidenRemoteCoordinator) -> [String] {
        pairings(coordinator).map { Self.scope(instanceId: $0.instanceId, deviceId: $0.deviceId) }
    }

    /// Brings back what an earlier launch left on any machine, since a new pick of
    /// one has to find its ask rather than land on it.
    func restoreEveryMachine(coordinator: AidenRemoteCoordinator) async {
        for context in pairings(coordinator) {
            await restore(instanceId: context.instanceId, deviceId: context.deviceId) {
                coordinator.isRetained(context)
            }
        }
    }

    /// The failed create Bots home shows, whichever machine it's for.
    func failureToShow(coordinator: AidenRemoteCoordinator) -> Failure? {
        guard pending == nil else { return nil }
        return pairings(coordinator).lazy
            .compactMap { self.failure(instanceId: $0.instanceId, deviceId: $0.deviceId) }
            .first
    }

    /// New Bot opens at once, connected or not (R15), and says inside why a machine
    /// can't take the Bot. It waits only for what earlier launches left.
    func canOpenNewBot(coordinator: AidenRemoteCoordinator) -> Bool {
        pending == nil
            && !AidenNewWorkPicker(coordinator: coordinator, kind: .bot).machines.isEmpty
            && pairings(coordinator).allSatisfy { hasLooked(instanceId: $0.instanceId, deviceId: $0.deviceId) }
    }

    /// Whether Bots home's New Bot is enabled. Listing one machine, it follows
    /// that machine (`defaultCanCreate`). Listing several, it opens while any of
    /// them has the Bot grant, whatever the default's, and the picker inside
    /// offers that machine; one that's only offline still opens it, to say why.
    static func canTapNewBot(
        groupsMachines: Bool,
        defaultCanCreate: Bool,
        canOpen: Bool,
        coordinator: AidenRemoteCoordinator
    ) -> Bool {
        guard groupsMachines else { return defaultCanCreate }
        return canOpen && AidenNewWorkPicker(coordinator: coordinator, kind: .bot).someMachineAllowsTheWork
    }

    /// The Bot on its way that Bots home shows, and its machine when that isn't the
    /// default.
    func shownPending(coordinator: AidenRemoteCoordinator) -> (pending: Pending, machine: String?)? {
        guard let pending else { return nil }
        let isElsewhere = pending.instanceId != coordinator.defaultInstanceId
        return (pending, isElsewhere ? coordinator.machineName(of: pending.instanceId) : nil)
    }
}

extension AidenBotCreateFlow.Failure {
    /// The pairing Try Again answers for: the failure's own, while this phone is
    /// still paired to it.
    @MainActor
    func retryPairing(coordinator: AidenRemoteCoordinator) -> (instanceId: String, deviceId: String)? {
        guard let installation = coordinator.hosts.connection(for: instanceId)?.installation,
              installation.deviceId == deviceId else { return nil }
        return (installation.id, installation.deviceId)
    }

    /// The alert's words, naming the machine when it isn't the default.
    @MainActor
    func shownMessage(coordinator: AidenRemoteCoordinator) -> String {
        guard instanceId != coordinator.defaultInstanceId, let name = coordinator.machineName(of: instanceId) else { return message }
        return "\(name): \(message)"
    }
}

/// The machine a Bot page reads and writes. A page opened on a Bot names the
/// Bot's machine, so it keeps talking to it whatever the default does. Nil is the
/// default machine.
extension AidenRemoteCoordinator {
    /// An owner context for a named machine, so the page outlives a move of the
    /// default. A named machine that left throws rather than fall back.
    func botContext(on instanceId: String?) throws -> AidenRemoteRequestContext {
        guard let instanceId else { return try requestContext() }
        return try ownerContext(for: instanceId)
    }

    func botInstallation(on instanceId: String?) -> AidenInstallation? {
        guard let instanceId else { return installationStore.activeInstallation }
        return hosts.connection(for: instanceId)?.installation
    }

    func botServer(on instanceId: String?) -> AidenServer? {
        guard let instanceId else { return server }
        return hosts.connection(for: instanceId)?.server
    }

    /// A machine that isn't paired reads as one that needs pairing.
    func botConnectionState(on instanceId: String?) -> AidenRemoteConnectionState {
        guard let instanceId else { return connectionState }
        return hosts.connection(for: instanceId)?.connectionState ?? .needsPairing
    }

    /// The live `/server` features, or the pairing's saved ones while connecting.
    func botFeatures(on instanceId: String?) -> [String]? {
        guard let instanceId else { return knownServerFeatures }
        return knownServerFeatures(of: instanceId)
    }

    /// The machine a context is for: an owner context's own, else the selection.
    static func botMachine(of context: AidenRemoteRequestContext) -> String? {
        context.scope == .owner ? context.instanceId : nil
    }

    /// Holds until the page's machine is connected (`aidenBotWaitForConnection`).
    func waitForBotConnection(on instanceId: String?, hold: Duration) async -> Bool {
        guard let instanceId else { return await aidenBotWaitForConnection(self, hold: hold) }
        return await aidenBotWaitForConnection(self, on: instanceId, hold: hold)
    }
}
