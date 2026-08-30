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

    static let shared = AidenChatDraftStore()

    private struct Envelope: Codable {
        let version: Int
        let instanceId: String
        let chatId: String
        let text: String
    }

    private let root: URL
    private let fileManager: FileManager
    private let maximumDraftScalars = 100_000
    private let maximumDraftBytes = 400_000
    private var generations: [String: UInt64] = [:]

    init(root: URL? = nil, fileManager: FileManager = .default) {
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
    func save(_ text: String, session: Session) throws -> Bool {
        guard isCurrent(session), isBounded(text) else { return false }
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
        guard isCurrent(session) else { return false }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
    }

    func remove(instanceId: String, chatId: String) {
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
