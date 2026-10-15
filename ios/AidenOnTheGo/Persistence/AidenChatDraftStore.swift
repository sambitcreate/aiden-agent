import CryptoKit
import Foundation

/// Protected, device-local text drafts shared by Workspace and Bot chats.
/// Attachments and credentials deliberately remain outside this store.
actor AidenChatDraftStore {
    struct Session: Equatable, Hashable, Sendable {
        fileprivate let instanceId: String
        fileprivate let chatId: String
        fileprivate let generation: UInt64
    }

    struct PendingSend: Codable, Equatable, Sendable {
        let deviceId: String
        let request: AidenTurnStart
        let key: UUID
        let createdAt: Date
        let attachments: [AidenAttachmentReference]
        var streamId: String? = nil
        var inputMode: AidenStreamInputMode? = nil
        func canRetry(at now: Date = Date()) -> Bool {
            let age = now.timeIntervalSince(createdAt)
            return age >= 0 && age < 24 * 60 * 60
        }
    }

    func loadPendingSend(session: Session, deviceId: String) throws -> PendingSend? {
        guard isCurrent(session) else { return nil }
        let url = attemptURL(session)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= maximumDraftBytes else { throw AidenRemoteClientError.invalidResponse }
        let data = try Data(contentsOf: url)
        let pending = try JSONDecoder().decode(PendingSend.self, from: data)
        guard (pending.streamId == nil) == (pending.inputMode == nil) else { throw AidenRemoteClientError.invalidResponse }
        return pending.deviceId == deviceId ? pending : nil
    }

    func savePendingSend(_ pending: PendingSend?, session: Session) throws {
        guard isCurrent(session), !Task.isCancelled else { throw CancellationError() }
        let url = attemptURL(session)
        guard let pending else {
            if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
            return
        }
        if let existing = try loadPendingSend(session: session, deviceId: pending.deviceId), existing != pending {
            throw AidenRemoteClientError.invalidResponse
        }
        let data = try JSONEncoder().encode(pending)
        guard data.count <= maximumDraftBytes else { throw AidenRemoteContractError.payloadTooLarge }
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func settlePendingSend(key: UUID, session: Session) {
        let url = attemptURL(session)
        guard let data = try? Data(contentsOf: url), data.count <= maximumDraftBytes,
              let pending = try? JSONDecoder().decode(PendingSend.self, from: data), pending.key == key else { return }
        try? fileManager.removeItem(at: url)
    }

    private func attemptURL(_ session: Session) -> URL {
        instanceDirectory(instanceId: session.instanceId).appending(path: "\(digest(session.chatId)).attempt.json")
    }

    static let shared = AidenChatDraftStore()

    private struct Envelope: Codable {
        let version: Int
        let instanceId: String
        let chatId: String
        let text: String
    }

    private let beforeWrite: (@Sendable () async -> Void)?
    private let root: URL
    private let fileManager: FileManager
    private let maximumDraftScalars = 100_000
    private let maximumDraftBytes = 400_000
    private var generations: [String: UInt64] = [:]

    init(root: URL? = nil, beforeWrite: (@Sendable () async -> Void)? = nil, fileManager: FileManager = .default) {
        self.beforeWrite = beforeWrite
        self.fileManager = fileManager
        if let root {
            self.root = root
        } else {
            let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? fileManager.temporaryDirectory
            self.root = applicationSupport
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
                .appending(path: "ChatDrafts-v1", directoryHint: .isDirectory)
        }
    }

    func beginSession(instanceId: String, chatId: String) -> Session {
        let key = sessionKey(instanceId: instanceId, chatId: chatId)
        let generation = (generations[key] ?? 0) &+ 1
        generations[key] = generation
        return Session(instanceId: instanceId, chatId: chatId, generation: generation)
    }

    func load(session: Session) -> String? {
        guard isCurrent(session) else { return nil }
        let url = fileURL(instanceId: session.instanceId, chatId: session.chatId)
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= maximumDraftBytes,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              data.count <= maximumDraftBytes,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.version == 1,
              envelope.instanceId == session.instanceId,
              envelope.chatId == session.chatId,
              isBounded(envelope.text) else {
            return nil
        }
        return envelope.text
    }

    @discardableResult
    func save(_ text: String, session: Session) async throws -> Bool {
        await beforeWrite?()
        guard !Task.isCancelled, isCurrent(session), isBounded(text) else { return false }
        if text.isEmpty {
            try? fileManager.removeItem(at: fileURL(instanceId: session.instanceId, chatId: session.chatId))
            return true
        }
        let data = try JSONEncoder().encode(Envelope(
            version: 1,
            instanceId: session.instanceId,
            chatId: session.chatId,
            text: text
        ))
        guard data.count <= maximumDraftBytes else { return false }
        let url = fileURL(instanceId: session.instanceId, chatId: session.chatId)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        guard !Task.isCancelled, isCurrent(session) else { return false }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
    }

    func remove(instanceId: String, chatId: String) {
        let session = Session(instanceId: instanceId, chatId: chatId, generation: 0)
        try? fileManager.removeItem(at: attemptURL(session))
        invalidate(instanceId: instanceId, chatId: chatId)
        try? fileManager.removeItem(at: fileURL(instanceId: instanceId, chatId: chatId))
    }

    func purge(instanceId: String) {
        let prefix = "\(instanceId)\u{1f}"
        let matchingKeys = generations.keys.filter { $0.hasPrefix(prefix) }
        for key in matchingKeys {
            generations[key, default: 0] &+= 1
        }
        try? fileManager.removeItem(at: instanceDirectory(instanceId: instanceId))
    }

    private func invalidate(instanceId: String, chatId: String) {
        generations[sessionKey(instanceId: instanceId, chatId: chatId), default: 0] &+= 1
    }

    private func isCurrent(_ session: Session) -> Bool {
        generations[sessionKey(instanceId: session.instanceId, chatId: session.chatId)] == session.generation
    }

    private func isBounded(_ text: String) -> Bool {
        text.unicodeScalars.count <= maximumDraftScalars && text.utf8.count <= maximumDraftBytes
    }

    private func sessionKey(instanceId: String, chatId: String) -> String {
        "\(instanceId)\u{1f}\(chatId)"
    }

    private func fileURL(instanceId: String, chatId: String) -> URL {
        instanceDirectory(instanceId: instanceId).appending(path: "\(digest(chatId)).json")
    }

    private func instanceDirectory(instanceId: String) -> URL {
        root.appending(path: digest(instanceId), directoryHint: .isDirectory)
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
