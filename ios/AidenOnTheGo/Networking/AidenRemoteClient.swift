import CryptoKit
import Foundation

enum AidenDeviceType: String, Codable, Sendable {
    case iphone
    case ipad
}

enum AidenConnectionMode: String, Codable, Sendable {
    case lan
    case tailscale
    case both
}

struct AidenServer: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let instanceId: String
    let name: String
    let appVersion: String
    let capabilities: [AidenRemoteCapability]
    let connectionMode: AidenConnectionMode
    let minimumClientVersion: String?
    let serverTime: Date
}

enum AidenWorkspacePermission: String, Codable, CaseIterable, Sendable {
    case full
    case ask
    case none
}

struct AidenWorkspaceGitSummary: Codable, Equatable, Sendable {
    let isRepo: Bool
    let branch: String?
    let uncommitted: Int?
}

struct AidenWorkspace: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var permission: AidenWorkspacePermission
    let hasFolder: Bool
    let isManagedWorktree: Bool
    let branchName: String?
    let repositoryName: String?
    let git: AidenWorkspaceGitSummary?
    let createdAt: Date
    let updatedAt: Date
    let revision: String
}

enum AidenWorkspaceCreate: Encodable, Equatable, Sendable {
    case folderless(name: String)
    case scratch
    case selectedFolder(selection: String, name: String?)

    private enum CodingKeys: String, CodingKey {
        case mode, name, selection
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .folderless(let name):
            try container.encode("folderless", forKey: .mode)
            try container.encode(name, forKey: .name)
        case .scratch:
            try container.encode("scratch", forKey: .mode)
        case .selectedFolder(let selection, let name):
            try container.encode("selected-folder", forKey: .mode)
            try container.encode(selection, forKey: .selection)
            try container.encodeIfPresent(name, forKey: .name)
        }
    }
}

struct AidenWorkspacePatch: Encodable, Equatable, Sendable {
    let name: String?
    let permission: AidenWorkspacePermission?
    let confirmedForeground = true

    init(name: String? = nil, permission: AidenWorkspacePermission? = nil) {
        self.name = name
        self.permission = permission
    }
}

struct AidenBrowserRoot: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let location: String
    let policyRevision: String
}

struct AidenBrowserBreadcrumb: Codable, Equatable, Sendable {
    let label: String
    let location: String
}

struct AidenBrowserEntry: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let location: String
}

struct AidenBrowserPage: Codable, Equatable, Sendable {
    let rootId: String
    let label: String
    let breadcrumbs: [AidenBrowserBreadcrumb]
    let entries: [AidenBrowserEntry]
    let nextCursor: String?
}

struct AidenWorkspaceSelection: Codable, Equatable, Sendable {
    let selection: String
    let displayName: String
    let expiresAt: Date
}

enum AidenRemoteClientError: Error, LocalizedError {
    case invalidEndpoint
    case invalidResponse
    case unexpectedStatus(Int)
    case server(statusCode: Int, body: AidenRemoteErrorEnvelope.Body)
    case missingCredential
    case missingTrustConfiguration
    case installationChanged

    var isCredentialRevoked: Bool {
        guard case .server(_, let body) = self else { return false }
        return body.code.rawValue == "credential_revoked"
    }

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "The Aiden Agent address is invalid."
        case .invalidResponse:
            return "Aiden Agent returned an invalid response."
        case .unexpectedStatus(let status):
            return "Aiden Agent returned HTTP status \(status)."
        case .server(_, let body):
            return body.message
        case .missingCredential:
            return "This Aiden installation needs to be paired again."
        case .missingTrustConfiguration:
            return "This Aiden installation must be paired again to establish secure server trust."
        case .installationChanged:
            return "The active Aiden Agent changed. Try again on the selected Mac."
        }
    }
}

struct AidenManualPairingResult {
    let payload: AidenRemoteContractFixture.PairingPayload
    let exchange: AidenRemoteContractFixture.PairingExchange
}

final class AidenRemoteClient: @unchecked Sendable {
    private struct EmptyRequest: Encodable {}

    private struct PairingExchangeRequest: Encodable {
        let secret: String
        let deviceName: String
        let deviceType: AidenDeviceType
        let clientVersion: String
        let acceptsDisplayName: Bool?
    }

    private struct WorkspaceList: Decodable {
        let workspaces: [AidenWorkspace]
    }

    private struct BrowserRootList: Decodable {
        let roots: [AidenBrowserRoot]
    }

    private struct BrowserSelectionRequest: Encodable {
        let location: String
    }

    private struct ChatList: Decodable {
        let chats: [AidenChat]
    }

    private struct ChatCreateRequest: Encodable {
        let workspaceId: String
        let providerId: String?
        let modelId: String?
    }

    private struct ChatUpdateRequest: Encodable {
        let title: String
    }

    private struct ChatMoveRequest: Encodable {
        let workspaceId: String
        let confirmedForeground = true
    }

    private struct ApprovalRequest: Encodable {
        let decision: AidenApprovalDecision
    }

    private struct ScheduledTaskList: Decodable { let tasks: [AidenScheduledTask] }
    private struct ScheduledRunList: Decodable { let runs: [AidenScheduledRun] }
    private struct ScheduledScriptList: Decodable { let scripts: [AidenScheduledScript] }
    private struct ScheduledMcpServerList: Decodable { let servers: [AidenScheduledMcpServer] }
    private struct ScheduledPreviewRequest: Encodable {
        let cron: String
        let timezone: String
        let count: Int
    }

    private let endpoint: URL
    private let credential: String?
    private let session: URLSession

    init(
        installation: AidenInstallation,
        credential: String,
        waitsForConnectivity: Bool = true,
        requestTimeout: TimeInterval = 30
    ) throws {
        guard let pairingTrust = installation.pairingTrust else {
            throw AidenRemoteClientError.missingTrustConfiguration
        }
        endpoint = installation.endpoint
        self.credential = credential
        session = Self.makePinnedSession(
            endpoint: installation.endpoint,
            fingerprint: installation.serverSpkiSha256,
            trustPolicy: try AidenServerTrustPolicy(pairingTrust: pairingTrust),
            waitsForConnectivity: waitsForConnectivity,
            requestTimeout: requestTimeout
        )
    }

    init(endpoint: URL, credential: String?, session: URLSession) {
        self.endpoint = endpoint
        self.credential = credential
        self.session = session
    }

    static func pair(
        payload: AidenRemoteContractFixture.PairingPayload,
        deviceName: String,
        deviceType: AidenDeviceType,
        clientVersion: String,
        session injectedSession: URLSession? = nil,
        now: Date = Date()
    ) async throws -> AidenRemoteContractFixture.PairingExchange {
        let payload = try payload.validated(at: now)
        let bootstrap = payload.bootstrap
        let session: URLSession
        if let injectedSession {
            session = injectedSession
        } else {
            session = makePinnedSession(
                endpoint: bootstrap.endpoint,
                fingerprint: bootstrap.serverSpkiSha256,
                trustPolicy: try AidenServerTrustPolicy(pairingTrust: payload.trust)
            )
        }
        let client = AidenRemoteClient(endpoint: bootstrap.endpoint, credential: nil, session: session)
        let request = PairingExchangeRequest(
            secret: bootstrap.secret,
            deviceName: deviceName,
            deviceType: deviceType,
            clientVersion: clientVersion,
            acceptsDisplayName: true
        )
        let exchange: AidenRemoteContractFixture.PairingExchange
        do {
            exchange = try await client.send(
                method: "POST",
                path: ["pairing", "exchange"],
                body: request,
                authenticated: false,
                acceptedStatus: [200]
            )
        } catch let AidenRemoteClientError.server(statusCode, body)
            where statusCode == 400 && body.code.rawValue == "invalid_request" {
            // Strict early-v1 Macs reject additive request keys before consuming
            // the one-time secret. Retry once with the frozen four-field shape.
            exchange = try await client.send(
                method: "POST",
                path: ["pairing", "exchange"],
                body: PairingExchangeRequest(
                    secret: bootstrap.secret,
                    deviceName: deviceName,
                    deviceType: deviceType,
                    clientVersion: clientVersion,
                    acceptsDisplayName: nil
                ),
                authenticated: false,
                acceptedStatus: [200]
            )
        }
        return try exchange.validated(against: bootstrap)
    }

    static func pair(
        manualCode: String,
        endpoint: URL,
        deviceName: String,
        deviceType: AidenDeviceType,
        clientVersion: String,
        bootstrapSession injectedBootstrapSession: URLSession? = nil,
        pairingSession injectedPairingSession: URLSession? = nil,
        now: Date = Date()
    ) async throws -> AidenManualPairingResult {
        let payload = try await manualPairingPayload(
            code: manualCode,
            endpoint: endpoint,
            session: injectedBootstrapSession,
            now: now
        )
        let exchange = try await pair(
            payload: payload,
            deviceName: deviceName,
            deviceType: deviceType,
            clientVersion: clientVersion,
            session: injectedPairingSession,
            now: now
        )
        return AidenManualPairingResult(payload: payload, exchange: exchange)
    }

    static func manualPairingPayload(
        code: String,
        endpoint: URL,
        session injectedSession: URLSession? = nil,
        now: Date = Date()
    ) async throws -> AidenRemoteContractFixture.PairingPayload {
        let normalizedCode = try normalizeManualPairingCode(code)
        guard isCanonicalAidenEndpoint(endpoint) else {
            throw AidenRemoteClientError.invalidEndpoint
        }
        let session = injectedSession ?? makeSealedBootstrapSession(endpoint: endpoint)
        let client = AidenRemoteClient(endpoint: endpoint, credential: nil, session: session)
        let sealed: AidenRemoteContractFixture.ManualPairingBootstrap = try await client.send(
            method: "POST",
            path: ["pairing", "manual-bootstrap"],
            body: EmptyRequest(),
            authenticated: false,
            acceptedStatus: [200],
            maximumResponseBytes: AidenRemoteProtocol.maxPairingPayloadBytes * 2
        )
        _ = try sealed.validated(at: now)

        let inputKey = SymmetricKey(data: Data(normalizedCode.utf8))
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: inputKey,
            salt: sealed.salt,
            info: sealed.keyDerivationInfo,
            outputByteCount: 32
        )
        let nonce: AES.GCM.Nonce
        let sealedBox: AES.GCM.SealedBox
        do {
            nonce = try AES.GCM.Nonce(data: sealed.nonce)
            sealedBox = try AES.GCM.SealedBox(
                nonce: nonce,
                ciphertext: sealed.ciphertext,
                tag: sealed.tag
            )
        } catch {
            throw AidenManualPairingError.invalidBootstrap
        }
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                sealedBox,
                using: key,
                authenticating: sealed.additionalAuthenticatedData
            )
        } catch {
            throw AidenManualPairingError.decryptionFailed
        }
        guard plaintext.count <= AidenRemoteProtocol.maxPairingPayloadBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        let payload = try AidenRemoteJSONDecoder.decodePairingPayload(from: plaintext)
        _ = try payload.validated(at: now)
        guard payload.bootstrap.endpoint.absoluteString == endpoint.absoluteString,
              payload.bootstrap.expiresAt == sealed.expiresAt else {
            throw AidenManualPairingError.endpointMismatch
        }
        return payload
    }

    static func normalizeManualPairingCode(_ value: String) throws -> String {
        guard value.unicodeScalars.allSatisfy({ scalar in
            scalar.isASCII && (scalar.value == 32 || scalar.value == 45
                || (48...57).contains(scalar.value)
                || (65...90).contains(scalar.value)
                || (97...122).contains(scalar.value))
        }) else {
            throw AidenManualPairingError.invalidCode
        }
        let normalized = value
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .uppercased()
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
        guard normalized.utf8.count == 20,
              normalized.unicodeScalars.allSatisfy({ $0.isASCII }),
              normalized.utf8.allSatisfy(alphabet.contains) else {
            throw AidenManualPairingError.invalidCode
        }
        return normalized
    }

    func server() async throws -> AidenServer {
        let value: AidenServer = try await send(method: "GET", path: ["server"])
        guard value.protocolVersion == AidenRemoteProtocol.version else {
            throw AidenRemoteContractError.invalidProtocolVersion
        }
        return value
    }

    func workspaces() async throws -> [AidenWorkspace] {
        let value: WorkspaceList = try await send(method: "GET", path: ["workspaces"])
        return value.workspaces
    }

    func workspace(id: String) async throws -> AidenWorkspace {
        try await send(method: "GET", path: ["workspaces", id])
    }

    func createWorkspace(
        _ create: AidenWorkspaceCreate,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenWorkspace {
        try await send(
            method: "POST",
            path: ["workspaces"],
            body: create,
            headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [201]
        )
    }

    func updateWorkspace(
        id: String,
        revision: String,
        patch: AidenWorkspacePatch
    ) async throws -> AidenWorkspace {
        guard patch.name != nil || patch.permission != nil else {
            throw AidenRemoteClientError.invalidResponse
        }
        return try await send(
            method: "PATCH",
            path: ["workspaces", id],
            body: patch,
            headers: ["If-Match": revision]
        )
    }

    func removeWorkspace(id: String, revision: String) async throws {
        try await sendWithoutResponse(
            method: "DELETE",
            path: ["workspaces", id],
            headers: ["If-Match": revision],
            acceptedStatus: [204]
        )
    }

    func browserRoots() async throws -> [AidenBrowserRoot] {
        let value: BrowserRootList = try await send(
            method: "GET",
            path: ["workspace-browser", "roots"]
        )
        return value.roots
    }

    func browserChildren(location: String, cursor: String? = nil) async throws -> AidenBrowserPage {
        var query = [URLQueryItem(name: "location", value: location)]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(
            method: "GET",
            path: ["workspace-browser", "children"],
            query: query
        )
    }

    func createWorkspaceSelection(location: String) async throws -> AidenWorkspaceSelection {
        try await send(
            method: "POST",
            path: ["workspace-browser", "selections"],
            body: BrowserSelectionRequest(location: location),
            acceptedStatus: [201]
        )
    }

    func chats(workspaceId: String? = nil) async throws -> [AidenChat] {
        let query = workspaceId.map { [URLQueryItem(name: "workspaceId", value: $0)] } ?? []
        let value: ChatList = try await send(method: "GET", path: ["chats"], query: query)
        return value.chats
    }

    func usage(range: String = "30d") async throws -> AidenUsageSummary {
        guard ["7d", "30d", "90d", "1y", "all"].contains(range) else {
            throw AidenRemoteClientError.invalidResponse
        }
        return try await send(
            method: "GET",
            path: ["usage"],
            query: [URLQueryItem(name: "range", value: range)]
        )
    }

    func chat(id: String) async throws -> AidenChat {
        try await send(method: "GET", path: ["chats", id])
    }

    func createChat(
        workspaceId: String,
        providerId: String? = nil,
        modelId: String? = nil,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenChat {
        try await send(
            method: "POST",
            path: ["chats"],
            body: ChatCreateRequest(
                workspaceId: workspaceId,
                providerId: providerId,
                modelId: modelId
            ),
            headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [201]
        )
    }

    func updateChat(id: String, revision: String, title: String) async throws -> AidenChat {
        try await send(
            method: "PATCH",
            path: ["chats", id],
            body: ChatUpdateRequest(title: title),
            headers: ["If-Match": revision]
        )
    }

    func removeChat(id: String, revision: String) async throws {
        try await sendWithoutResponse(
            method: "DELETE",
            path: ["chats", id],
            headers: ["If-Match": revision],
            acceptedStatus: [204]
        )
    }

    func uploadAttachment(
        chatId: String,
        upload: AidenAttachmentUpload
    ) async throws -> AidenAttachmentReference {
        try await send(
            method: "POST",
            path: ["chats", chatId, "attachments"],
            body: upload,
            acceptedStatus: [201]
        )
    }

    func removeAttachment(chatId: String, attachmentId: String) async throws {
        try await sendWithoutResponse(
            method: "DELETE",
            path: ["chats", chatId, "attachments", attachmentId],
            headers: [:],
            acceptedStatus: [204]
        )
    }

    func moveChat(
        id: String,
        revision: String,
        workspaceId: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenChat {
        try await send(
            method: "POST",
            path: ["chats", id, "move"],
            body: ChatMoveRequest(workspaceId: workspaceId),
            headers: [
                "If-Match": revision,
                "Idempotency-Key": idempotencyKey.uuidString.lowercased(),
            ]
        )
    }

    func modelCatalog() async throws -> AidenModelCatalog {
        try await send(method: "GET", path: ["models"])
    }

    func scheduledTasks() async throws -> [AidenScheduledTask] {
        let value: ScheduledTaskList = try await send(method: "GET", path: ["scheduled-tasks"])
        return try AidenScheduledTaskValidation.tasks(value.tasks)
    }

    func scheduledTask(id: String) async throws -> AidenScheduledTask {
        let value: AidenScheduledTask = try await send(method: "GET", path: ["scheduled-tasks", id])
        return try AidenScheduledTaskValidation.tasks([value])[0]
    }

    func createScheduledTask(
        _ mutation: AidenScheduledTaskMutation,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenScheduledTask {
        try await send(
            method: "POST", path: ["scheduled-tasks"], body: mutation,
            headers: idempotencyHeaders(idempotencyKey), acceptedStatus: [201]
        )
    }

    func updateScheduledTask(
        id: String,
        revision: String,
        mutation: AidenScheduledTaskMutation
    ) async throws -> AidenScheduledTask {
        try await send(
            method: "PATCH", path: ["scheduled-tasks", id], body: mutation,
            headers: ["If-Match": revision]
        )
    }

    func removeScheduledTask(id: String, revision: String) async throws {
        try await sendWithoutResponse(
            method: "DELETE", path: ["scheduled-tasks", id],
            headers: ["If-Match": revision], acceptedStatus: [204]
        )
    }

    func pauseScheduledTask(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenScheduledTask {
        try await send(
            method: "POST", path: ["scheduled-tasks", id, "pause"],
            headers: ["If-Match": revision, "Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [202]
        )
    }

    func resumeScheduledTask(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenScheduledTask {
        try await send(
            method: "POST", path: ["scheduled-tasks", id, "resume"],
            headers: ["If-Match": revision, "Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [202]
        )
    }

    func runScheduledTask(
        id: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenScheduledRunAccepted {
        try await send(
            method: "POST", path: ["scheduled-tasks", id, "run"],
            headers: idempotencyHeaders(idempotencyKey), acceptedStatus: [202]
        )
    }

    func scheduledRuns(taskId: String) async throws -> [AidenScheduledRun] {
        let value: ScheduledRunList = try await send(method: "GET", path: ["scheduled-tasks", taskId, "runs"])
        return try AidenScheduledTaskValidation.runs(value.runs, taskId: taskId)
    }

    func previewSchedule(cron: String, timezone: String, count: Int = 3) async throws -> [Date] {
        let value: AidenScheduledPreview = try await send(
            method: "POST", path: ["scheduled-tasks", "preview"],
            body: ScheduledPreviewRequest(cron: cron, timezone: timezone, count: min(max(count, 1), 20))
        )
        guard value.dates.count <= 20 else { throw AidenRemoteClientError.invalidResponse }
        return value.dates
    }

    func scheduledScripts(workspaceId: String?) async throws -> [AidenScheduledScript] {
        let query = workspaceId.map { [URLQueryItem(name: "workspaceId", value: $0)] } ?? []
        let value: ScheduledScriptList = try await send(
            method: "GET", path: ["scheduled-tasks", "scripts"], query: query
        )
        guard value.scripts.count <= 4_000,
              value.scripts.allSatisfy({ $0.id.hasPrefix("script_") && $0.id.count == 50 && !$0.name.isEmpty }) else {
            throw AidenRemoteClientError.invalidResponse
        }
        return value.scripts
    }

    func scheduledMcpServers() async throws -> [AidenScheduledMcpServer] {
        let value: ScheduledMcpServerList = try await send(
            method: "GET", path: ["scheduled-tasks", "mcp-servers"]
        )
        guard value.servers.count <= 4_000,
              value.servers.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 256 && !$0.name.isEmpty && $0.name.count <= 256 }),
              Set(value.servers.map(\.id)).count == value.servers.count else {
            throw AidenRemoteClientError.invalidResponse
        }
        return value.servers
    }

    func scheduledSettings() async throws -> AidenScheduledSettings {
        try await send(method: "GET", path: ["scheduled-tasks", "settings"])
    }

    func updateScheduledSettings(
        revision: String,
        mutation: AidenScheduledSettingsMutation
    ) async throws -> AidenScheduledSettings {
        try await send(
            method: "PATCH", path: ["scheduled-tasks", "settings"], body: mutation,
            headers: ["If-Match": revision]
        )
    }

    func workspaceFiles(workspaceId: String) async throws -> AidenWorkspaceFileIndex {
        let value: AidenWorkspaceFileIndex = try await send(
            method: "GET",
            path: ["workspaces", workspaceId, "files"]
        )
        return try AidenWorkspaceEnvironmentValidation.validated(value)
    }

    func workspaceFile(workspaceId: String, fileId: String) async throws -> AidenWorkspaceFileDocument {
        guard AidenWorkspaceEnvironmentValidation.opaqueFileID(fileId) else {
            throw AidenRemoteClientError.invalidResponse
        }
        let value: AidenWorkspaceFileDocument = try await send(
            method: "GET",
            path: ["workspaces", workspaceId, "files", fileId],
            maximumResponseBytes: AidenRemoteProtocol.maxFileJSONBodyBytes
        )
        return try AidenWorkspaceEnvironmentValidation.validated(value, expectedID: fileId)
    }

    func writeWorkspaceFile(
        workspaceId: String,
        fileId: String,
        content: String,
        expectedVersion: String
    ) async throws -> AidenWorkspaceFileDocument {
        guard AidenWorkspaceEnvironmentValidation.opaqueFileID(fileId), !expectedVersion.isEmpty else {
            throw AidenRemoteClientError.invalidResponse
        }
        let value: AidenWorkspaceFileDocument = try await send(
            method: "PUT",
            path: ["workspaces", workspaceId, "files", fileId],
            body: AidenWorkspaceFileWriteRequest(content: content, expectedVersion: expectedVersion),
            maximumResponseBytes: AidenRemoteProtocol.maxFileJSONBodyBytes
        )
        return try AidenWorkspaceEnvironmentValidation.validated(value, expectedID: fileId)
    }

    func gitReview(workspaceId: String) async throws -> AidenGitResult {
        try validatedGit(await send(method: "GET", path: ["workspaces", workspaceId, "git", "review"]))
    }

    func gitDiff(workspaceId: String, snapshotId: String, fileId: String) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "diff"],
            body: AidenGitDiffRequest(snapshotId: snapshotId, fileId: fileId)
        ))
    }

    func gitBranches(workspaceId: String) async throws -> AidenGitResult {
        try validatedGit(await send(method: "GET", path: ["workspaces", workspaceId, "git", "branches"]))
    }

    func createGitBranch(
        workspaceId: String,
        name: String,
        startPoint: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "branches"],
            body: AidenGitCreateBranchRequest(name: name, startPoint: startPoint),
            headers: idempotencyHeaders(idempotencyKey),
            acceptedStatus: [202]
        ))
    }

    func checkoutGitBranch(
        workspaceId: String,
        branch: String,
        snapshotId: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "checkout"],
            body: AidenGitCheckoutRequest(branch: branch, snapshotId: snapshotId),
            headers: idempotencyHeaders(idempotencyKey),
            acceptedStatus: [202]
        ))
    }

    func commitGit(
        workspaceId: String,
        snapshotId: String,
        message: String,
        stagedOnly: Bool,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "commit"],
            body: AidenGitCommitRequest(
                snapshotId: snapshotId,
                message: message,
                scope: stagedOnly ? "staged-reviewed" : "all-reviewed"
            ),
            headers: idempotencyHeaders(idempotencyKey),
            acceptedStatus: [202]
        ))
    }

    func gitPushCapability(workspaceId: String) async throws -> AidenGitResult {
        try validatedGit(await send(method: "GET", path: ["workspaces", workspaceId, "git", "push-capability"]))
    }

    func pushGit(
        workspaceId: String,
        snapshotId: String,
        remote: String,
        branch: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "push"],
            body: AidenGitPushRequest(snapshotId: snapshotId, remote: remote, branch: branch),
            headers: idempotencyHeaders(idempotencyKey),
            acceptedStatus: [202]
        ))
    }

    func compareGit(workspaceId: String, baseRef: String) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "compare"],
            body: AidenGitCompareRequest(baseRef: baseRef)
        ))
    }

    func gitComparisonDiff(workspaceId: String, comparisonId: String, fileId: String) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "comparison-diff"],
            body: AidenGitComparisonDiffRequest(comparisonId: comparisonId, fileId: fileId)
        ))
    }

    func gitWorktrees(workspaceId: String) async throws -> AidenGitResult {
        try validatedGit(await send(method: "GET", path: ["workspaces", workspaceId, "git", "worktrees"]))
    }

    func createGitWorktree(
        workspaceId: String,
        branch: String,
        name: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "POST",
            path: ["workspaces", workspaceId, "git", "worktrees"],
            body: AidenGitCreateWorktreeRequest(branch: branch, name: name),
            headers: idempotencyHeaders(idempotencyKey),
            acceptedStatus: [202]
        ))
    }

    func deleteManagedGitWorktree(
        workspaceId: String,
        revision: String,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenGitResult {
        try validatedGit(await send(
            method: "DELETE",
            path: ["workspaces", workspaceId, "git", "managed-worktree"],
            body: AidenForegroundConfirmation(),
            headers: [
                "If-Match": revision,
                "Idempotency-Key": idempotencyKey.uuidString.lowercased(),
            ],
            acceptedStatus: [202]
        ))
    }

    func startTurn(
        chatId: String,
        request: AidenTurnStart,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenTurnStartResponse {
        try await send(
            method: "POST",
            path: ["chats", chatId, "turns"],
            body: request,
            headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [202]
        )
    }

    func streamStatus(id: String) async throws -> AidenStreamStatus {
        try await send(method: "GET", path: ["streams", id])
    }

    func cancelStream(id: String, idempotencyKey: UUID = UUID()) async throws -> AidenStreamStatus {
        try await send(
            method: "POST",
            path: ["streams", id, "cancel"],
            headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()],
            acceptedStatus: [202]
        )
    }

    func respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        idempotencyKey: UUID = UUID()
    ) async throws -> AidenApprovalResponse {
        try await send(
            method: "POST",
            path: ["approvals", id, "respond"],
            body: ApprovalRequest(decision: decision),
            headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()]
        )
    }

    func streamEvents(
        id: String,
        after sequence: Int
    ) -> AsyncThrowingStream<AidenRemoteStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let query = sequence > 0
                        ? [URLQueryItem(name: "after", value: String(sequence))]
                        : []
                    var request = try makeRequest(
                        method: "GET",
                        path: ["streams", id, "events"],
                        query: query,
                        body: nil,
                        headers: sequence > 0 ? ["Last-Event-ID": String(sequence)] : [:],
                        authenticated: true
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw AidenRemoteClientError.invalidResponse
                    }
                    guard httpResponse.statusCode == 200 else {
                        var body = Data()
                        for try await byte in bytes {
                            guard body.count < AidenRemoteProtocol.maxJSONBodyBytes else {
                                throw AidenRemoteContractError.payloadTooLarge
                            }
                            body.append(byte)
                        }
                        try validate(response: response, data: body, acceptedStatus: [200])
                        throw AidenRemoteClientError.unexpectedStatus(httpResponse.statusCode)
                    }

                    var parser = AidenSSEParser()
                    var lineBytes: [UInt8] = []
                    lineBytes.reserveCapacity(512)
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if byte == 0x0A {
                            if lineBytes.last == 0x0D { lineBytes.removeLast() }
                            guard let line = String(bytes: lineBytes, encoding: .utf8) else {
                                throw AidenRemoteClientError.invalidResponse
                            }
                            lineBytes.removeAll(keepingCapacity: true)
                            if let event = try parser.consume(line: line) {
                                continuation.yield(event)
                            }
                        } else {
                            lineBytes.append(byte)
                            guard lineBytes.count <= AidenRemoteProtocol.maxSSEFrameBytes else {
                                throw AidenSSEParserError.frameTooLarge
                            }
                        }
                    }
                    if !lineBytes.isEmpty {
                        if lineBytes.last == 0x0D { lineBytes.removeLast() }
                        guard let line = String(bytes: lineBytes, encoding: .utf8) else {
                            throw AidenRemoteClientError.invalidResponse
                        }
                        if let event = try parser.consume(line: line) {
                            continuation.yield(event)
                        }
                    }
                    if let event = try parser.finish() {
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    private static func makePinnedSession(
        endpoint: URL,
        fingerprint: String,
        trustPolicy: AidenServerTrustPolicy,
        waitsForConnectivity: Bool = true,
        requestTimeout: TimeInterval = 30
    ) -> URLSession {
        let delegate = AidenPinnedServerSessionDelegate(
            expectedHost: endpoint.host ?? "",
            expectedPort: endpoint.port,
            expectedFingerprint: fingerprint,
            trustPolicy: trustPolicy
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = waitsForConnectivity
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    private static func makeSealedBootstrapSession(endpoint: URL) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(
            configuration: configuration,
            delegate: AidenSealedBootstrapSessionDelegate(endpoint: endpoint),
            delegateQueue: nil
        )
    }

    private func send<Response: Decodable>(
        method: String,
        path: [String],
        query: [URLQueryItem] = [],
        headers: [String: String] = [:],
        authenticated: Bool = true,
        acceptedStatus: Set<Int> = [200],
        maximumResponseBytes: Int = AidenRemoteProtocol.maxJSONBodyBytes
    ) async throws -> Response {
        let request = try makeRequest(
            method: method,
            path: path,
            query: query,
            body: nil,
            headers: headers,
            authenticated: authenticated
        )
        let (data, response) = try await boundedData(
            for: request,
            maximumBytes: maximumResponseBytes
        )
        try validate(response: response, data: data, acceptedStatus: acceptedStatus)
        do {
            return try AidenRemoteJSONDecoder.decode(Response.self, from: data, maximumBytes: maximumResponseBytes)
        } catch {
            throw AidenRemoteClientError.invalidResponse
        }
    }

    private func send<Response: Decodable, Body: Encodable>(
        method: String,
        path: [String],
        query: [URLQueryItem] = [],
        body: Body,
        headers: [String: String] = [:],
        authenticated: Bool = true,
        acceptedStatus: Set<Int> = [200],
        maximumResponseBytes: Int = AidenRemoteProtocol.maxJSONBodyBytes
    ) async throws -> Response {
        let encodedBody = try JSONEncoder().encode(body)
        let request = try makeRequest(
            method: method,
            path: path,
            query: query,
            body: encodedBody,
            headers: headers,
            authenticated: authenticated
        )
        let (data, response) = try await boundedData(
            for: request,
            maximumBytes: maximumResponseBytes
        )
        try validate(response: response, data: data, acceptedStatus: acceptedStatus)
        do {
            return try AidenRemoteJSONDecoder.decode(Response.self, from: data, maximumBytes: maximumResponseBytes)
        } catch {
            throw AidenRemoteClientError.invalidResponse
        }
    }

    private func sendWithoutResponse(
        method: String,
        path: [String],
        headers: [String: String],
        acceptedStatus: Set<Int>
    ) async throws {
        let request = try makeRequest(
            method: method,
            path: path,
            query: [],
            body: nil,
            headers: headers,
            authenticated: true
        )
        let (data, response) = try await boundedData(
            for: request,
            maximumBytes: AidenRemoteProtocol.maxJSONBodyBytes
        )
        try validate(response: response, data: data, acceptedStatus: acceptedStatus)
    }

    private func makeRequest(
        method: String,
        path: [String],
        query: [URLQueryItem],
        body: Data?,
        headers: [String: String],
        authenticated: Bool
    ) throws -> URLRequest {
        var url = endpoint
        for component in path {
            url.append(path: component)
        }
        if !query.isEmpty {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                throw AidenRemoteClientError.invalidEndpoint
            }
            components.queryItems = query
            guard let queryURL = components.url else { throw AidenRemoteClientError.invalidEndpoint }
            url = queryURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(String(AidenRemoteProtocol.version), forHTTPHeaderField: "Aiden-Protocol-Version")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated {
            guard let credential, !credential.isEmpty else {
                throw AidenRemoteClientError.missingCredential
            }
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    private func boundedData(
        for request: URLRequest,
        maximumBytes: Int
    ) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        if response.expectedContentLength > Int64(maximumBytes) {
            throw AidenRemoteContractError.payloadTooLarge
        }
        var data = Data()
        if response.expectedContentLength > 0 {
            data.reserveCapacity(min(Int(response.expectedContentLength), maximumBytes))
        }
        for try await byte in bytes {
            guard data.count < maximumBytes else {
                throw AidenRemoteContractError.payloadTooLarge
            }
            data.append(byte)
        }
        return (data, response)
    }

    private func idempotencyHeaders(_ key: UUID) -> [String: String] {
        ["Idempotency-Key": key.uuidString.lowercased()]
    }

    private func validatedGit(_ result: AidenGitResult) throws -> AidenGitResult {
        try AidenWorkspaceEnvironmentValidation.validated(result)
    }

    private func validate(
        response: URLResponse,
        data: Data,
        acceptedStatus: Set<Int>
    ) throws {
        guard let response = response as? HTTPURLResponse else {
            throw AidenRemoteClientError.invalidResponse
        }
        guard acceptedStatus.contains(response.statusCode) else {
            if let envelope = try? AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: data) {
                throw AidenRemoteClientError.server(statusCode: response.statusCode, body: envelope.error)
            }
            throw AidenRemoteClientError.unexpectedStatus(response.statusCode)
        }
    }
}
