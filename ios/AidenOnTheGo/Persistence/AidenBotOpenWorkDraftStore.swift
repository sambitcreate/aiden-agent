import CryptoKit
import Foundation

/// Protected device-only drafts and exact unresolved commands. The scope is
/// the host, paired device and Bot, never a display name or connector identity.
@MainActor
final class AidenBotOpenWorkDraftStore {
    struct Scope: Codable, Equatable {
        let instanceID: String
        let deviceID: String
        let botID: String
    }
    struct State: Codable {
        var draft: AidenOpenWorkDraft?
        var baseline: AidenOpenWorkItem?
        var draftRevision: String?
        var attempt: AidenOpenWorkAttempt?
    }
    private struct Envelope: Codable {
        let version: Int
        let scope: Scope
        let state: State
    }

    static let shared = AidenBotOpenWorkDraftStore()
    let root: URL
    private let fileManager: FileManager
    private let maximumBytes = 128 * 1024

    init(root: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.root = root ?? (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory).appending(path: "AidenOnTheGo/OpenWorkDrafts-v1", directoryHint: .isDirectory)
        prepareExistingStorage()
    }

    /// Called on every launch, even if no Open work page opens.
    func prepareExistingStorage() {
        guard fileManager.fileExists(atPath: root.path) else { return }
        do { try prepareDirectory(root) }
        catch { AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown) }
    }

    func load(_ scope: Scope) throws -> State? {
        let url = fileURL(scope)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard let bytes = attributes[.size] as? NSNumber, bytes.intValue <= maximumBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
        guard envelope.version == 1, envelope.scope == scope,
              (envelope.state.draft == nil) == (envelope.state.draftRevision == nil) else {
            throw AidenRemoteClientError.invalidResponse
        }
        if let revision = envelope.state.draftRevision { try AidenOpenWorkWire.id(revision) }
        if let attempt = envelope.state.attempt {
            try attempt.mutation.validate()
            if let itemID = attempt.itemID { try AidenOpenWorkWire.id(itemID) }
            guard attempt.mutation.id == nil || attempt.mutation.id == attempt.itemID else { throw AidenRemoteClientError.invalidResponse }
        }
        return envelope.state
    }

    func save(_ state: State, scope: Scope, settling mutationID: UUID? = nil) throws {
        if let existing = try load(scope)?.attempt, existing != state.attempt,
           existing.mutation.mutationId != mutationID {
            // A second window cannot overwrite another window’s unresolved command.
            throw AidenRemoteClientError.invalidResponse
        }
        let url = fileURL(scope)
        if state.draft == nil, state.attempt == nil {
            if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
            return
        }
        let data = try JSONEncoder().encode(Envelope(version: 1, scope: scope, state: state))
        guard data.count <= maximumBytes else { throw AidenRemoteContractError.payloadTooLarge }
        try prepareDirectory(root)
        try prepareDirectory(url.deletingLastPathComponent())
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func purge(instanceID: String) {
        try? fileManager.removeItem(at: root.appending(path: digest(instanceID), directoryHint: .isDirectory))
    }

    func fileURL(_ scope: Scope) -> URL {
        root.appending(path: digest(scope.instanceID), directoryHint: .isDirectory)
            .appending(path: "\(digest(scope.deviceID + "|" + scope.botID)).json")
    }
    private func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }

    private func prepareDirectory(_ url: URL) throws {
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true, attributes: protection)
        try fileManager.setAttributes(protection, ofItemAtPath: url.path)
        var excluded = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }
}
