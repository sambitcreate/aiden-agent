import Foundation
import Observation
import UIKit

actor AidenInstallationDataGate {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !held {
            held = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            held = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

enum AidenRemoteConnectionState: Equatable {
    case needsPairing
    case connecting
    case connected
    case offline(message: String)
}

enum AidenPairingAttemptResult: Equatable {
    case succeeded
    case cancelled
    case failed
}

/// An opaque activation lease for one selected Aiden installation. The
/// generation prevents an A -> B -> A switch from making work started during
/// the first A activation current again.
struct AidenRemoteRequestContext: Equatable, Hashable, Sendable {
    let instanceId: String
    let deviceId: String
    fileprivate let generation: Int
}

@MainActor
@Observable
final class AidenRemoteCoordinator {
    typealias ClientFactory = (AidenInstallation, String) throws -> AidenRemoteClient

    let installationStore: AidenInstallationStore
    private let clientFactory: ClientFactory
    private(set) var connectionState: AidenRemoteConnectionState
    private(set) var server: AidenServer?
    private(set) var workspaces: [AidenWorkspace] = []
    private(set) var workspaceSnapshotRevision = 0
    private(set) var isMutating = false
    var presentedError: String?
    let workspaceArchiveStore: AidenWorkspaceArchiveStore
    private let chatCache: AidenChatCache
    private let scheduledTaskCache: AidenScheduledTaskCache
    private let workspaceEnvironmentCache: AidenWorkspaceEnvironmentCache
    private let installationDataGate = AidenInstallationDataGate()
    private var pendingManagedWorktreeDeletionKeys: [String: UUID] = [:]
    private var connectionGeneration = 0
    private var activationGeneration = 0

    init() {
        let installationStore = AidenInstallationStore()
        self.installationStore = installationStore
        workspaceArchiveStore = AidenWorkspaceArchiveStore()
        chatCache = .shared
        scheduledTaskCache = .shared
        workspaceEnvironmentCache = .shared
        clientFactory = { try AidenRemoteClient(installation: $0, credential: $1) }
        connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
    }

    init(
        installationStore: AidenInstallationStore,
        workspaceArchiveStore: AidenWorkspaceArchiveStore? = nil,
        chatCache: AidenChatCache = .shared,
        scheduledTaskCache: AidenScheduledTaskCache = .shared,
        workspaceEnvironmentCache: AidenWorkspaceEnvironmentCache = .shared,
        clientFactory: @escaping ClientFactory = { try AidenRemoteClient(installation: $0, credential: $1) }
    ) {
        self.installationStore = installationStore
        self.workspaceArchiveStore = workspaceArchiveStore ?? AidenWorkspaceArchiveStore()
        self.chatCache = chatCache
        self.scheduledTaskCache = scheduledTaskCache
        self.workspaceEnvironmentCache = workspaceEnvironmentCache
        self.clientFactory = clientFactory
        connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
    }

    func start() async {
        guard installationStore.activeInstallation != nil else {
            connectionGeneration &+= 1
            connectionState = .needsPairing
            updateIntentCatalog(for: nil)
            return
        }
        await connectActiveInstallation()
    }

    func pair(qrPayload: String) async -> AidenPairingAttemptResult {
        guard !isMutating else { return .failed }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        let previousConnectionState = connectionState
        var credentialIssued = false
        do {
            guard let data = qrPayload.data(using: .utf8) else {
                throw AidenRemoteClientError.invalidResponse
            }
            let payload = try AidenRemoteJSONDecoder.decodePairingPayload(from: data)
            let exchange = try await AidenRemoteClient.pair(
                payload: payload,
                deviceName: Self.deviceName,
                deviceType: Self.deviceType,
                clientVersion: Self.clientVersion
            )
            credentialIssued = true
            try await activatePairing(payload: payload, exchange: exchange)
            return .succeeded
        } catch is CancellationError {
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : previousConnectionState
            if credentialIssued {
                presentedError = Self.pendingCredentialRecoveryMessage
            }
            return .cancelled
        } catch {
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : previousConnectionState
            presentedError = credentialIssued
                ? Self.pendingCredentialRecoveryMessage
                : error.localizedDescription
            return .failed
        }
    }

    func pair(manualCode: String, endpoint: URL) async -> AidenPairingAttemptResult {
        guard !isMutating else { return .failed }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        let previousConnectionState = connectionState
        var credentialIssued = false
        do {
            let result = try await AidenRemoteClient.pair(
                manualCode: manualCode,
                endpoint: endpoint,
                deviceName: Self.deviceName,
                deviceType: Self.deviceType,
                clientVersion: Self.clientVersion
            )
            credentialIssued = true
            try await activatePairing(payload: result.payload, exchange: result.exchange)
            return .succeeded
        } catch is CancellationError {
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : previousConnectionState
            if credentialIssued {
                presentedError = Self.pendingCredentialRecoveryMessage
            }
            return .cancelled
        } catch {
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : previousConnectionState
            presentedError = credentialIssued
                ? Self.pendingCredentialRecoveryMessage
                : error.localizedDescription
            return .failed
        }
    }

    func activatePairing(
        payload: AidenRemoteContractFixture.PairingPayload,
        exchange: AidenRemoteContractFixture.PairingExchange
    ) async throws {
        let temporaryName = exchange.displayName
            ?? payload.bootstrap.endpoint.host
            ?? String(localized: "Aiden Agent")
        let stagedInstallation = AidenInstallation(
            exchange: exchange,
            pairingTrust: payload.trust,
            name: temporaryName
        )
        let stagedClient = try clientFactory(stagedInstallation, exchange.credential)
        async let serverRequest = stagedClient.server()
        async let workspaceRequest = stagedClient.workspaces()
        let (validatedServer, validatedWorkspaces) = try await (serverRequest, workspaceRequest)
        guard validatedServer.instanceId == exchange.instanceId else {
            throw AidenRemoteContractError.invalidPairingExchange
        }
        try Task.checkCancellation()
        let previousDeviceId = installationStore.installations.first {
            $0.id == exchange.instanceId
        }?.deviceId
        let knownWorkspaceIds = activeInstanceId == exchange.instanceId
            ? Set(workspaces.map(\.id))
            : []
        let installation = try installationStore.savePairing(
            exchange,
            trust: payload.trust,
            name: validatedServer.name,
            connectedAt: Date()
        )
        activationGeneration &+= 1
        connectionGeneration &+= 1
        if let previousDeviceId, previousDeviceId != installation.deviceId {
            await purgeInstallationData(installation.id, knownWorkspaceIds: knownWorkspaceIds)
        }
        self.server = validatedServer
        applyWorkspaceSnapshot(validatedWorkspaces, instanceId: installation.id)
        connectionState = .connected
    }

    private static let pendingCredentialRecoveryMessage = String(localized:
        "Aiden created a pending device credential, but this iPhone could not finish saving it. Revoke the pending device in Aiden Agent, then create a new pairing code."
    )

    func connectActiveInstallation() async {
        connectionGeneration &+= 1
        let generation = connectionGeneration
        guard let installation = installationStore.activeInstallation else {
            connectionState = .needsPairing
            server = nil
            workspaces = []
            updateIntentCatalog(for: nil)
            return
        }
        connectionState = .connecting
        presentedError = nil
        do {
            guard let credential = try installationStore.credential(for: installation),
                  !credential.isEmpty else {
                throw AidenRemoteClientError.missingCredential
            }
            try await load(installation: installation, credential: credential, generation: generation)
        } catch {
            guard isCurrentContext(installationId: installation.id, generation: generation) else { return }
            await handleConnectionError(error, installationId: installation.id)
        }
    }

    func switchInstallation(to installationId: String) async {
        guard !isMutating else { return }
        do {
            let previousInstallationId = activeInstanceId
            try installationStore.setActive(installationId)
            if previousInstallationId != activeInstanceId {
                activationGeneration &+= 1
            }
            server = nil
            workspaces = []
            updateIntentCatalog(for: nil)
            await connectActiveInstallation()
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func removeInstallation(_ installationId: String) async {
        guard !isMutating else { return }
        do {
            let previousInstallationId = activeInstanceId
            let knownWorkspaceIds = previousInstallationId == installationId
                ? Set(workspaces.map(\.id))
                : []
            try installationStore.remove(installationId)
            if previousInstallationId != activeInstanceId {
                activationGeneration &+= 1
            }
            connectionGeneration &+= 1
            server = nil
            workspaces = []
            await purgeInstallationData(installationId, knownWorkspaceIds: knownWorkspaceIds)
            updateIntentCatalog(for: installationId)
            await start()
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func refreshWorkspaces() async {
        guard let installationId = activeInstanceId,
              let client = try? activeClient() else {
            connectionState = .needsPairing
            return
        }
        let generation = connectionGeneration
        do {
            let refreshed = try await client.workspaces()
            guard isCurrentContext(installationId: installationId, generation: generation) else { return }
            applyWorkspaceSnapshot(refreshed, instanceId: installationId)
            connectionState = .connected
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return }
            await handleConnectionError(error, installationId: installationId)
        }
    }

    func createWorkspace(_ create: AidenWorkspaceCreate) async -> AidenWorkspace? {
        await mutate { client in try await client.createWorkspace(create) }
    }

    func updateWorkspace(
        _ workspace: AidenWorkspace,
        name: String? = nil,
        permission: AidenWorkspacePermission? = nil
    ) async -> AidenWorkspace? {
        guard !isMutating else { return nil }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return nil }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return nil
        }

        var optimistic = workspace
        if let name { optimistic.name = name }
        if let permission { optimistic.permission = permission }
        upsert(optimistic)

        do {
            let updated = try await client.updateWorkspace(
                id: workspace.id,
                revision: workspace.revision,
                patch: AidenWorkspacePatch(name: name, permission: permission)
            )
            guard isCurrentContext(installationId: installationId, generation: generation) else { return nil }
            upsert(updated)
            return updated
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return nil }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if let reconciled = canonical.first(where: { $0.id == workspace.id }),
                   (name == nil || reconciled.name == name),
                   (permission == nil || reconciled.permission == permission) {
                    return reconciled
                }
            } else {
                upsert(workspace)
            }
            await handleConnectionError(error, installationId: installationId)
            return nil
        }
    }

    func removeWorkspace(_ workspace: AidenWorkspace) async -> Bool {
        guard !isMutating else { return false }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return false }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return false
        }
        workspaces.removeAll { $0.id == workspace.id }
        updateIntentCatalog(for: installationId)
        do {
            try await client.removeWorkspace(id: workspace.id, revision: workspace.revision)
            guard isCurrentContext(installationId: installationId, generation: generation) else { return false }
            // The desktop guarantees at least one registry workspace and may
            // seed a replacement when the last record is removed. Canonicalize
            // after the confirmed delete without rolling the delete back if
            // this follow-up read happens to fail.
            if let canonicalWorkspaces = try? await client.workspaces() {
                guard isCurrentContext(installationId: installationId, generation: generation) else { return false }
                applyWorkspaceSnapshot(canonicalWorkspaces, instanceId: installationId)
            }
            return true
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return false }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if !canonical.contains(where: { $0.id == workspace.id }) {
                    return true
                }
            } else {
                upsert(workspace)
            }
            await handleConnectionError(error, installationId: installationId)
            return false
        }
    }

    func removeManagedWorktree(_ workspace: AidenWorkspace) async -> Bool {
        guard workspace.isManagedWorktree, !isMutating else { return false }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return false }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return false
        }
        let scope = "\(installationId):\(workspace.id)"
        let key = pendingManagedWorktreeDeletionKeys[scope] ?? UUID()
        pendingManagedWorktreeDeletionKeys[scope] = key
        workspaces.removeAll { $0.id == workspace.id }
        updateIntentCatalog(for: activeInstanceId)
        do {
            _ = try await client.deleteManagedGitWorktree(
                workspaceId: workspace.id,
                revision: workspace.revision,
                idempotencyKey: key
            )
            guard isCurrentContext(installationId: installationId, generation: generation) else { return false }
            pendingManagedWorktreeDeletionKeys[scope] = nil
            return true
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return false }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if !canonical.contains(where: { $0.id == workspace.id }) {
                    pendingManagedWorktreeDeletionKeys[scope] = nil
                    return true
                }
            } else {
                upsert(workspace)
            }
            if !Self.isAmbiguousMutationError(error) {
                pendingManagedWorktreeDeletionKeys[scope] = nil
            }
            await handleConnectionError(error, installationId: installationId)
            return false
        }
    }

    func browserRoots(context: AidenRemoteRequestContext) async throws -> [AidenBrowserRoot] {
        try await remoteClient(for: context).browserRoots()
    }

    func browserChildren(
        context: AidenRemoteRequestContext,
        location: String,
        cursor: String? = nil
    ) async throws -> AidenBrowserPage {
        try await remoteClient(for: context).browserChildren(location: location, cursor: cursor)
    }

    func createSelectedFolderWorkspace(
        context: AidenRemoteRequestContext,
        location: String,
        name: String?
    ) async -> AidenWorkspace? {
        guard !isMutating else { return nil }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        guard isCurrent(context) else { return nil }
        let installationId = context.instanceId
        do {
            let client = try remoteClient(for: context)
            let selection = try await client.createWorkspaceSelection(location: location)
            guard isCurrent(context) else { return nil }
            guard selection.expiresAt > Date() else {
                throw AidenRemoteClientError.invalidResponse
            }
            let workspace = try await client.createWorkspace(
                .selectedFolder(selection: selection.selection, name: name)
            )
            guard isCurrent(context) else { return nil }
            upsert(workspace)
            return workspace
        } catch {
            guard isCurrent(context) else { return nil }
            await handleConnectionError(error, installationId: installationId)
            return nil
        }
    }

    var activeInstanceId: String? {
        installationStore.activeInstallationId
    }

    func setDeviceArchivedWorkspaceIDs(_ workspaceIDs: Set<String>, for instanceId: String?) {
        guard let instanceId, !instanceId.isEmpty else { return }
        _ = workspaceIDs
        updateIntentCatalog(for: instanceId)
    }

    func remoteClient() throws -> AidenRemoteClient {
        try activeClient()
    }

    func requestContext(for instanceId: String? = nil) throws -> AidenRemoteRequestContext {
        guard let activeInstallation = installationStore.activeInstallation,
              let activeInstanceId,
              instanceId == nil || instanceId == activeInstanceId else {
            throw AidenRemoteClientError.installationChanged
        }
        return AidenRemoteRequestContext(
            instanceId: activeInstanceId,
            deviceId: activeInstallation.deviceId,
            generation: activationGeneration
        )
    }

    func remoteClient(for context: AidenRemoteRequestContext) throws -> AidenRemoteClient {
        guard isCurrent(context) else {
            throw AidenRemoteClientError.installationChanged
        }
        return try activeClient()
    }

    func isCurrent(_ context: AidenRemoteRequestContext) -> Bool {
        activeInstanceId == context.instanceId
            && activationGeneration == context.generation
            && isRetained(context)
    }

    func isRetained(_ context: AidenRemoteRequestContext) -> Bool {
        installationStore.installations.contains {
            $0.id == context.instanceId && $0.deviceId == context.deviceId
        }
    }

    func withRetainedInstallationData(
        for context: AidenRemoteRequestContext,
        operation: @MainActor () async -> Void
    ) async -> Bool {
        await installationDataGate.acquire()
        guard isRetained(context) else {
            await installationDataGate.release()
            return false
        }
        await operation()
        let retained = isRetained(context)
        if !retained {
            await purgeInstallationDataUnlocked(context.instanceId)
        }
        await installationDataGate.release()
        return retained
    }

    private func load(
        installation: AidenInstallation,
        credential: String,
        generation: Int
    ) async throws {
        let client = try clientFactory(installation, credential)
        async let serverRequest = client.server()
        async let workspaceRequest = client.workspaces()
        let (server, workspaces) = try await (serverRequest, workspaceRequest)
        guard server.instanceId == installation.instanceId else {
            throw AidenRemoteContractError.invalidPairingExchange
        }
        guard isCurrentContext(installationId: installation.id, generation: generation) else { return }
        try installationStore.updateServer(server)
        self.server = server
        applyWorkspaceSnapshot(workspaces, instanceId: installation.id)
        connectionState = .connected
    }

    private func activeClient() throws -> AidenRemoteClient {
        guard let installation = installationStore.activeInstallation else {
            throw AidenRemoteClientError.missingCredential
        }
        guard let credential = try installationStore.credential(for: installation),
              !credential.isEmpty else {
            throw AidenRemoteClientError.missingCredential
        }
        return try clientFactory(installation, credential)
    }

    private func mutate(
        operation: (AidenRemoteClient) async throws -> AidenWorkspace
    ) async -> AidenWorkspace? {
        guard !isMutating else { return nil }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        guard let installationId = activeInstanceId else { return nil }
        let generation = connectionGeneration
        do {
            let client = try activeClient()
            let workspace = try await operation(client)
            guard isCurrentContext(installationId: installationId, generation: generation) else { return nil }
            upsert(workspace)
            return workspace
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return nil }
            await handleConnectionError(error, installationId: installationId)
            return nil
        }
    }

    private func applyWorkspaceSnapshot(_ workspaces: [AidenWorkspace], instanceId: String) {
        guard activeInstanceId == instanceId else { return }
        self.workspaces = workspaces
        workspaceArchiveStore.prune(
            instanceID: instanceId,
            validWorkspaceIDs: Set(workspaces.map(\.id))
        )
        workspaceSnapshotRevision &+= 1
        updateIntentCatalog(for: instanceId)
    }

    private func isCurrentContext(installationId: String, generation: Int) -> Bool {
        activeInstanceId == installationId && connectionGeneration == generation
    }

    private func upsert(_ workspace: AidenWorkspace) {
        workspaces.removeAll { $0.id == workspace.id }
        workspaces.append(workspace)
        workspaces.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        updateIntentCatalog(for: activeInstanceId)
    }

    private func handleConnectionError(_ error: Error, installationId: String?) async {
        guard installationId == nil || installationId == activeInstanceId else { return }
        if let clientError = error as? AidenRemoteClientError,
           clientError.isCredentialRevoked,
           let installationId {
            let revocationMessage = String(localized: "This device was revoked. Pair it with Aiden Agent again.")
            let previousInstallationId = activeInstanceId
            let knownWorkspaceIds = previousInstallationId == installationId
                ? Set(workspaces.map(\.id))
                : []
            try? installationStore.remove(installationId)
            if previousInstallationId != activeInstanceId {
                activationGeneration &+= 1
            }
            connectionGeneration &+= 1
            server = nil
            workspaces = []
            await purgeInstallationData(installationId, knownWorkspaceIds: knownWorkspaceIds)
            updateIntentCatalog(for: installationId)
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
            if installationStore.activeInstallation != nil {
                await connectActiveInstallation()
            }
            presentedError = revocationMessage
            return
        }
        if let clientError = error as? AidenRemoteClientError,
           case .server = clientError {
            connectionState = .connected
        } else {
            connectionState = .offline(message: error.localizedDescription)
        }
        presentedError = error.localizedDescription
    }

    private func purgeInstallationData(
        _ installationId: String,
        knownWorkspaceIds: Set<String> = []
    ) async {
        await installationDataGate.acquire()
        await purgeInstallationDataUnlocked(
            installationId,
            knownWorkspaceIds: knownWorkspaceIds
        )
        await installationDataGate.release()
    }

    private func purgeInstallationDataUnlocked(
        _ installationId: String,
        knownWorkspaceIds: Set<String> = []
    ) async {
        workspaceArchiveStore.purge(instanceID: installationId)
        await chatCache.purge(instanceId: installationId)
        await scheduledTaskCache.purge(instanceId: installationId)
        await workspaceEnvironmentCache.purge(
            instanceId: installationId,
            knownWorkspaceIds: knownWorkspaceIds
        )
        await AidenRemoteLiveActivityManager.shared.endAll(forInstanceID: installationId)
    }

    private func updateIntentCatalog(for instanceId: String?) {
        let installations = installationStore.installations.map {
            AidenIntentInstallationRecord(id: $0.id, name: $0.name)
        }
        let cachedWorkspaces: [AidenIntentWorkspaceRecord]
        if let instanceId, instanceId == activeInstanceId {
            let archivedWorkspaceIDs = workspaceArchiveStore.archivedWorkspaceIDs(for: instanceId)
            cachedWorkspaces = workspaces.filter { !archivedWorkspaceIDs.contains($0.id) }.map {
                AidenIntentWorkspaceRecord(id: $0.id, instanceId: instanceId, name: $0.name)
            }
        } else {
            cachedWorkspaces = []
        }
        try? AidenIntentCatalogStore.shared.update(
            installations: installations,
            activeInstallationId: activeInstanceId,
            workspaces: cachedWorkspaces,
            for: instanceId
        )
    }

    private static var deviceType: AidenDeviceType {
        UIDevice.current.userInterfaceIdiom == .pad ? .ipad : .iphone
    }

    private static var deviceName: String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((name.isEmpty ? "Aiden On The Go" : name).prefix(80))
    }

    private static var clientVersion: String {
        let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return String((value ?? "1.0").prefix(40))
    }

    private static func isAmbiguousMutationError(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let clientError = error as? AidenRemoteClientError else { return false }
        switch clientError {
        case .invalidResponse, .unexpectedStatus:
            return true
        case .server(_, let body):
            return body.code.rawValue == "idempotency_in_flight" || body.code.rawValue == "internal_error"
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
            return false
        }
    }
}
