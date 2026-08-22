import Foundation
import Observation
import UIKit

struct AidenClientDeviceIdentity {
    static func displayName(
        userAssignedName: String,
        hostName: String,
        deviceType: AidenDeviceType,
        vendorIdentifier: UUID?
    ) -> String {
        if let name = usableName(userAssignedName, stripsLocalSuffix: false) {
            return name
        }
        if let name = usableName(hostName, stripsLocalSuffix: true) {
            return name
        }

        let kind = deviceType == .ipad ? "iPad" : "iPhone"
        if let vendorIdentifier {
            let suffix = vendorIdentifier.uuidString
                .filter { $0.isHexDigit }
                .prefix(6)
                .uppercased()
            if !suffix.isEmpty {
                return "\(kind) · \(suffix)"
            }
        }
        return "\(kind) for Aiden"
    }

    private static func usableName(
        _ value: String,
        stripsLocalSuffix: Bool
    ) -> String? {
        var normalized = value
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        if stripsLocalSuffix {
            normalized = normalized.replacingOccurrences(
                of: #"\.local\.?$"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              !normalized.unicodeScalars.contains(where: { scalar in
                  scalar.properties.generalCategory == .control
                      || scalar.properties.generalCategory == .format
              }) else { return nil }

        let genericKey = normalized.lowercased().filter { $0.isLetter || $0.isNumber }
        guard ![
            "iphone", "ipad", "aidenonthego", "localhost", "localhostlocaldomain"
        ].contains(genericKey), UUID(uuidString: normalized) == nil else { return nil }
        return String(normalized.prefix(80))
    }
}

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

enum AidenRemoteMutationOutcome<Value> {
    case success(Value)
    case failure
    case cancelled
    case stale
    case busy

    var value: Value? {
        guard case .success(let value) = self else { return nil }
        return value
    }

    var isDefinitiveFailure: Bool {
        if case .failure = self { return true }
        return false
    }
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

    private struct ActiveClientKey: Equatable {
        let instanceId: String
        let deviceId: String
        let credentialScope: String
        let activationGeneration: Int
    }

    let installationStore: AidenInstallationStore
    let haptics: any AidenHapticEmitting
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
    private var cachedActiveClient: (key: ActiveClientKey, client: AidenRemoteClient)?

    init(haptics: (any AidenHapticEmitting)? = nil) {
        let installationStore = AidenInstallationStore()
        self.installationStore = installationStore
        self.haptics = haptics ?? AidenHapticCenter()
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
        haptics: (any AidenHapticEmitting)? = nil,
        clientFactory: @escaping ClientFactory = { try AidenRemoteClient(installation: $0, credential: $1) }
    ) {
        self.installationStore = installationStore
        self.haptics = haptics ?? AidenHapticCenter()
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
        } catch let error where aidenIsCancellation(error) {
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
        } catch let error where aidenIsCancellation(error) {
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
            validatedServer: validatedServer,
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
        _ = await switchInstallationOutcome(to: installationId)
    }

    func switchInstallationOutcome(to installationId: String) async -> AidenRemoteMutationOutcome<Void> {
        guard !isMutating else { return .busy }
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
            guard activeInstanceId == installationId else { return .stale }
            guard connectionState == .connected else { return .failure }
            return .success(())
        } catch let error where aidenIsCancellation(error) {
            return .cancelled
        } catch {
            presentedError = error.localizedDescription
            return .failure
        }
    }

    func removeInstallation(_ installationId: String) async {
        _ = await removeInstallationOutcome(installationId)
    }

    func removeInstallationOutcome(_ installationId: String) async -> AidenRemoteMutationOutcome<Void> {
        guard !isMutating else { return .busy }
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
            guard !installationStore.installations.contains(where: { $0.id == installationId }) else {
                return .failure
            }
            return .success(())
        } catch let error where aidenIsCancellation(error) {
            return .cancelled
        } catch {
            presentedError = error.localizedDescription
            return .failure
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
        await createWorkspaceOutcome(create).value
    }

    func createWorkspaceOutcome(_ create: AidenWorkspaceCreate) async -> AidenRemoteMutationOutcome<AidenWorkspace> {
        await mutateOutcome { client in try await client.createWorkspace(create) }
    }

    func updateWorkspace(
        _ workspace: AidenWorkspace,
        name: String? = nil,
        permission: AidenWorkspacePermission? = nil
    ) async -> AidenWorkspace? {
        await updateWorkspaceOutcome(workspace, name: name, permission: permission).value
    }

    func updateWorkspaceOutcome(
        _ workspace: AidenWorkspace,
        name: String? = nil,
        permission: AidenWorkspacePermission? = nil
    ) async -> AidenRemoteMutationOutcome<AidenWorkspace> {
        guard !isMutating else { return .busy }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return .stale }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return aidenIsCancellation(error) ? .cancelled : .failure
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
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            upsert(updated)
            return .success(updated)
        } catch let error where aidenIsCancellation(error) {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            upsert(workspace)
            return .cancelled
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if let reconciled = canonical.first(where: { $0.id == workspace.id }),
                   (name == nil || reconciled.name == name),
                   (permission == nil || reconciled.permission == permission) {
                    return .success(reconciled)
                }
            } else {
                upsert(workspace)
            }
            await handleConnectionError(error, installationId: installationId)
            return .failure
        }
    }

    func removeWorkspace(_ workspace: AidenWorkspace) async -> Bool {
        if case .success = await removeWorkspaceOutcome(workspace) { return true }
        return false
    }

    func removeWorkspaceOutcome(_ workspace: AidenWorkspace) async -> AidenRemoteMutationOutcome<Void> {
        guard !isMutating else { return .busy }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return .stale }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return aidenIsCancellation(error) ? .cancelled : .failure
        }
        workspaces.removeAll { $0.id == workspace.id }
        updateIntentCatalog(for: installationId)
        do {
            try await client.removeWorkspace(id: workspace.id, revision: workspace.revision)
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            // The desktop guarantees at least one registry workspace and may
            // seed a replacement when the last record is removed. Canonicalize
            // after the confirmed delete without rolling the delete back if
            // this follow-up read happens to fail.
            if let canonicalWorkspaces = try? await client.workspaces() {
                guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
                applyWorkspaceSnapshot(canonicalWorkspaces, instanceId: installationId)
            }
            return .success(())
        } catch let error where aidenIsCancellation(error) {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            upsert(workspace)
            return .cancelled
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if !canonical.contains(where: { $0.id == workspace.id }) {
                    return .success(())
                }
            } else {
                upsert(workspace)
            }
            await handleConnectionError(error, installationId: installationId)
            return .failure
        }
    }

    func removeManagedWorktree(_ workspace: AidenWorkspace) async -> Bool {
        if case .success = await removeManagedWorktreeOutcome(workspace) { return true }
        return false
    }

    func removeManagedWorktreeOutcome(_ workspace: AidenWorkspace) async -> AidenRemoteMutationOutcome<Void> {
        guard workspace.isManagedWorktree else { return .failure }
        guard !isMutating else { return .busy }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

        guard let installationId = activeInstanceId else { return .stale }
        let generation = connectionGeneration
        let client: AidenRemoteClient
        do {
            client = try activeClient()
        } catch {
            await handleConnectionError(error, installationId: installationId)
            return aidenIsCancellation(error) ? .cancelled : .failure
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
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            pendingManagedWorktreeDeletionKeys[scope] = nil
            return .success(())
        } catch let error where aidenIsCancellation(error) {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            upsert(workspace)
            return .cancelled
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            if let canonical = try? await client.workspaces(),
               isCurrentContext(installationId: installationId, generation: generation) {
                applyWorkspaceSnapshot(canonical, instanceId: installationId)
                if !canonical.contains(where: { $0.id == workspace.id }) {
                    pendingManagedWorktreeDeletionKeys[scope] = nil
                    return .success(())
                }
            } else {
                upsert(workspace)
            }
            if !Self.isAmbiguousMutationError(error) {
                pendingManagedWorktreeDeletionKeys[scope] = nil
            }
            await handleConnectionError(error, installationId: installationId)
            return .failure
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
        await createSelectedFolderWorkspaceOutcome(
            context: context,
            location: location,
            name: name
        ).value
    }

    func createSelectedFolderWorkspaceOutcome(
        context: AidenRemoteRequestContext,
        location: String,
        name: String?
    ) async -> AidenRemoteMutationOutcome<AidenWorkspace> {
        guard !isMutating else { return .busy }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        guard isCurrent(context) else { return .stale }
        let installationId = context.instanceId
        do {
            let client = try remoteClient(for: context)
            let selection = try await client.createWorkspaceSelection(location: location)
            guard isCurrent(context) else { return .stale }
            guard selection.expiresAt > Date() else {
                throw AidenRemoteClientError.invalidResponse
            }
            let workspace = try await client.createWorkspace(
                .selectedFolder(selection: selection.selection, name: name)
            )
            guard isCurrent(context) else { return .stale }
            upsert(workspace)
            return .success(workspace)
        } catch let error where aidenIsCancellation(error) {
            guard isCurrent(context) else { return .stale }
            return .cancelled
        } catch {
            guard isCurrent(context) else { return .stale }
            await handleConnectionError(error, installationId: installationId)
            return .failure
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

    /// Bot feature calls use the remote client directly so their DTO state can
    /// stay feature-local. This keeps credential revocation on the same
    /// immediate purge path as coordinator-owned Workspace operations.
    func handleCredentialRevocation(
        _ error: Error,
        context: AidenRemoteRequestContext
    ) async -> Bool {
        guard isCurrent(context),
              let clientError = error as? AidenRemoteClientError,
              clientError.isCredentialRevoked else { return false }
        await handleConnectionError(error, installationId: context.instanceId)
        return true
    }

    private func load(
        installation: AidenInstallation,
        credential: String,
        generation: Int
    ) async throws {
        let client = try client(
            for: installation,
            credential: credential,
            activationGeneration: activationGeneration
        )
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
        await refreshDeviceIdentity(using: client, currentName: server.deviceName)
    }

    private func refreshDeviceIdentity(
        using client: AidenRemoteClient,
        currentName: String?
    ) async {
        let name = Self.deviceName
        guard let currentName, currentName != name else { return }
        // Older Macs do not expose this additive route. A failed label refresh
        // must never make a valid authenticated connection fail.
        try? await client.updateDeviceIdentity(name: name)
    }

    private func activeClient() throws -> AidenRemoteClient {
        guard let installation = installationStore.activeInstallation else {
            throw AidenRemoteClientError.missingCredential
        }
        guard let credential = try installationStore.credential(for: installation),
              !credential.isEmpty else {
            throw AidenRemoteClientError.missingCredential
        }
        return try client(
            for: installation,
            credential: credential,
            activationGeneration: activationGeneration
        )
    }

    private func client(
        for installation: AidenInstallation,
        credential: String,
        activationGeneration: Int
    ) throws -> AidenRemoteClient {
        let key = ActiveClientKey(
            instanceId: installation.id,
            deviceId: installation.deviceId,
            credentialScope: installation.credentialScope,
            activationGeneration: activationGeneration
        )
        if let cachedActiveClient, cachedActiveClient.key == key {
            return cachedActiveClient.client
        }
        let client = try clientFactory(installation, credential)
        cachedActiveClient = (key, client)
        return client
    }

    private func mutateOutcome(
        operation: (AidenRemoteClient) async throws -> AidenWorkspace
    ) async -> AidenRemoteMutationOutcome<AidenWorkspace> {
        guard !isMutating else { return .busy }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        guard let installationId = activeInstanceId else { return .stale }
        let generation = connectionGeneration
        do {
            let client = try activeClient()
            let workspace = try await operation(client)
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            upsert(workspace)
            return .success(workspace)
        } catch let error where aidenIsCancellation(error) {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            return .cancelled
        } catch {
            guard isCurrentContext(installationId: installationId, generation: generation) else { return .stale }
            await handleConnectionError(error, installationId: installationId)
            return .failure
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
        AidenProductNavigationStore.shared.purge(instanceID: installationId)
        await AidenBotCache.shared.purge(instanceId: installationId)
        await AidenChatDraftStore.shared.purge(instanceId: installationId)
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
        // Future iCloud sync should reconcile this user-visible label through
        // an account-scoped device record. Never reuse that cloud identity for
        // Remote authentication: deviceId and its credential stay Mac-specific.
        AidenClientDeviceIdentity.displayName(
            userAssignedName: UIDevice.current.name,
            hostName: ProcessInfo.processInfo.hostName,
            deviceType: deviceType,
            vendorIdentifier: UIDevice.current.identifierForVendor
        )
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
