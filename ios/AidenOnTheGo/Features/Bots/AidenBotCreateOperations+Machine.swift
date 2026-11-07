import Foundation

extension AidenBotCreateOperations {
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
