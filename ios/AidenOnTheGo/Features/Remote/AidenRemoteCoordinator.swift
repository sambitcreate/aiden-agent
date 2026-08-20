import Foundation
import Observation
import UIKit

enum AidenRemoteConnectionState: Equatable {
    case needsPairing
    case connecting
    case connected
    case offline(message: String)
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
    private(set) var isMutating = false
    var presentedError: String?
    private var pendingManagedWorktreeDeletionKeys: [String: UUID] = [:]

    init() {
        let installationStore = AidenInstallationStore()
        self.installationStore = installationStore
        clientFactory = { try AidenRemoteClient(installation: $0, credential: $1) }
        connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
    }

    init(
        installationStore: AidenInstallationStore,
        clientFactory: @escaping ClientFactory = { try AidenRemoteClient(installation: $0, credential: $1) }
    ) {
        self.installationStore = installationStore
        self.clientFactory = clientFactory
        connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
    }

    func start() async {
        guard installationStore.activeInstallation != nil else {
            connectionState = .needsPairing
            updateIntentCatalog(for: nil)
            return
        }
        await connectActiveInstallation()
    }

    func pair(qrPayload: String) async {
        guard !isMutating else { return }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }

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
            let temporaryName = payload.bootstrap.endpoint.host ?? String(localized: "Aiden Agent")
            let installation = try installationStore.savePairing(
                exchange,
                trust: payload.trust,
                name: temporaryName
            )
            try await load(installation: installation, credential: exchange.credential)
        } catch {
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : .offline(message: error.localizedDescription)
            presentedError = error.localizedDescription
        }
    }

    func connectActiveInstallation() async {
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
            try await load(installation: installation, credential: credential)
        } catch {
            await handleConnectionError(error, installationId: installation.id)
        }
    }

    func switchInstallation(to installationId: String) async {
        do {
            try installationStore.setActive(installationId)
            server = nil
            workspaces = []
            updateIntentCatalog(for: nil)
            await connectActiveInstallation()
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func removeInstallation(_ installationId: String) async {
        do {
            await AidenRemoteLiveActivityManager.shared.endAll(forInstanceID: installationId)
            try installationStore.remove(installationId)
            server = nil
            workspaces = []
            updateIntentCatalog(for: installationId)
            await start()
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func refreshWorkspaces() async {
        guard let client = try? activeClient() else {
            connectionState = .needsPairing
            return
        }
        do {
            workspaces = try await client.workspaces()
            connectionState = .connected
            updateIntentCatalog(for: activeInstanceId)
        } catch {
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
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

        var optimistic = workspace
        if let name { optimistic.name = name }
        if let permission { optimistic.permission = permission }
        upsert(optimistic)

        do {
            let updated = try await activeClient().updateWorkspace(
                id: workspace.id,
                revision: workspace.revision,
                patch: AidenWorkspacePatch(name: name, permission: permission)
            )
            upsert(updated)
            return updated
        } catch {
            upsert(workspace)
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
            return nil
        }
    }

    func removeWorkspace(_ workspace: AidenWorkspace) async -> Bool {
        guard !isMutating else { return false }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        workspaces.removeAll { $0.id == workspace.id }
        updateIntentCatalog(for: activeInstanceId)
        do {
            let client = try activeClient()
            try await client.removeWorkspace(id: workspace.id, revision: workspace.revision)
            return true
        } catch {
            upsert(workspace)
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
            return false
        }
    }

    func removeManagedWorktree(_ workspace: AidenWorkspace) async -> Bool {
        guard workspace.isManagedWorktree, !isMutating else { return false }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        let scope = "\(installationStore.activeInstallationId ?? ""):\(workspace.id)"
        let key = pendingManagedWorktreeDeletionKeys[scope] ?? UUID()
        pendingManagedWorktreeDeletionKeys[scope] = key
        workspaces.removeAll { $0.id == workspace.id }
        updateIntentCatalog(for: activeInstanceId)
        do {
            let client = try activeClient()
            _ = try await client.deleteManagedGitWorktree(
                workspaceId: workspace.id,
                revision: workspace.revision,
                idempotencyKey: key
            )
            pendingManagedWorktreeDeletionKeys[scope] = nil
            return true
        } catch {
            upsert(workspace)
            if !Self.isAmbiguousMutationError(error) {
                pendingManagedWorktreeDeletionKeys[scope] = nil
            }
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
            return false
        }
    }

    func browserRoots() async throws -> [AidenBrowserRoot] {
        try await activeClient().browserRoots()
    }

    func browserChildren(location: String, cursor: String? = nil) async throws -> AidenBrowserPage {
        try await activeClient().browserChildren(location: location, cursor: cursor)
    }

    func createSelectedFolderWorkspace(location: String, name: String?) async -> AidenWorkspace? {
        guard !isMutating else { return nil }
        isMutating = true
        presentedError = nil
        defer { isMutating = false }
        do {
            let client = try activeClient()
            let selection = try await client.createWorkspaceSelection(location: location)
            guard selection.expiresAt > Date() else {
                throw AidenRemoteClientError.invalidResponse
            }
            let workspace = try await client.createWorkspace(
                .selectedFolder(selection: selection.selection, name: name)
            )
            upsert(workspace)
            return workspace
        } catch {
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
            return nil
        }
    }

    var activeInstanceId: String? {
        installationStore.activeInstallationId
    }

    func remoteClient() throws -> AidenRemoteClient {
        try activeClient()
    }

    private func load(installation: AidenInstallation, credential: String) async throws {
        let client = try clientFactory(installation, credential)
        async let serverRequest = client.server()
        async let workspaceRequest = client.workspaces()
        let (server, workspaces) = try await (serverRequest, workspaceRequest)
        guard server.instanceId == installation.instanceId else {
            throw AidenRemoteContractError.invalidPairingExchange
        }
        try installationStore.updateServer(server)
        self.server = server
        self.workspaces = workspaces
        connectionState = .connected
        updateIntentCatalog(for: installation.id)
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
        do {
            let workspace = try await operation(activeClient())
            upsert(workspace)
            return workspace
        } catch {
            await handleConnectionError(error, installationId: installationStore.activeInstallationId)
            return nil
        }
    }

    private func upsert(_ workspace: AidenWorkspace) {
        workspaces.removeAll { $0.id == workspace.id }
        workspaces.append(workspace)
        workspaces.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        updateIntentCatalog(for: activeInstanceId)
    }

    private func handleConnectionError(_ error: Error, installationId: String?) async {
        if let clientError = error as? AidenRemoteClientError,
           clientError.isCredentialRevoked,
           let installationId {
            let revocationMessage = String(localized: "This device was revoked. Pair it with Aiden Agent again.")
            await AidenRemoteLiveActivityManager.shared.endAll(forInstanceID: installationId)
            try? installationStore.remove(installationId)
            server = nil
            workspaces = []
            updateIntentCatalog(for: installationId)
            connectionState = installationStore.activeInstallation == nil ? .needsPairing : .connecting
            if installationStore.activeInstallation != nil {
                await connectActiveInstallation()
            }
            presentedError = revocationMessage
            return
        }
        connectionState = .offline(message: error.localizedDescription)
        presentedError = error.localizedDescription
    }

    private func updateIntentCatalog(for instanceId: String?) {
        let installations = installationStore.installations.map {
            AidenIntentInstallationRecord(id: $0.id, name: $0.name)
        }
        let cachedWorkspaces: [AidenIntentWorkspaceRecord]
        if let instanceId, instanceId == activeInstanceId {
            cachedWorkspaces = workspaces.map {
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
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration:
            return false
        }
    }
}
