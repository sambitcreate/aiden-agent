import CryptoKit
import Foundation

actor AidenChatCache {
    static let shared = AidenChatCache()

    struct ActiveStream: Codable, Equatable, Sendable {
        let deviceId: String
        let streamId: String
        let turnId: String
        var lastSequence: Int
    }

    private struct ChatListEnvelope: Codable {
        let instanceId: String
        let workspaceId: String
        let chats: [AidenChat]
    }

    private struct ChatEnvelope: Codable {
        let instanceId: String
        let chat: AidenChat
    }

    private struct StreamEnvelope: Codable {
        let instanceId: String
        let chatId: String
        let stream: ActiveStream
    }

    private let root: URL
    private let fileManager: FileManager
    private let maxCacheFileBytes = 10 * 1_024 * 1_024

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
                .appending(path: "RemoteChatCache-v1", directoryHint: .isDirectory)
        }
    }

    func loadChats(instanceId: String, workspaceId: String) -> [AidenChat]? {
        guard let envelope: ChatListEnvelope = load(
            ChatListEnvelope.self,
            from: fileURL(kind: "lists", instanceId, workspaceId)
        ), envelope.instanceId == instanceId, envelope.workspaceId == workspaceId else {
            return nil
        }
        return envelope.chats
    }

    func saveChats(_ chats: [AidenChat], instanceId: String, workspaceId: String) throws {
        try save(
            ChatListEnvelope(instanceId: instanceId, workspaceId: workspaceId, chats: chats),
            to: fileURL(kind: "lists", instanceId, workspaceId)
        )
    }

    func loadChat(instanceId: String, chatId: String) -> AidenChat? {
        guard let envelope: ChatEnvelope = load(
            ChatEnvelope.self,
            from: fileURL(kind: "chats", instanceId, chatId)
        ), envelope.instanceId == instanceId, envelope.chat.id == chatId else {
            return nil
        }
        return envelope.chat
    }

    func saveChat(_ chat: AidenChat, instanceId: String) throws {
        try save(
            ChatEnvelope(instanceId: instanceId, chat: chat),
            to: fileURL(kind: "chats", instanceId, chat.id)
        )
    }

    func loadActiveStream(instanceId: String, chatId: String) -> ActiveStream? {
        guard let envelope: StreamEnvelope = load(
            StreamEnvelope.self,
            from: fileURL(kind: "streams", instanceId, chatId)
        ), envelope.instanceId == instanceId, envelope.chatId == chatId else {
            return nil
        }
        return envelope.stream
    }

    func saveActiveStream(_ stream: ActiveStream, instanceId: String, chatId: String) throws {
        try save(
            StreamEnvelope(instanceId: instanceId, chatId: chatId, stream: stream),
            to: fileURL(kind: "streams", instanceId, chatId)
        )
    }

    func removeActiveStream(instanceId: String, chatId: String) {
        try? fileManager.removeItem(at: fileURL(kind: "streams", instanceId, chatId))
    }

    func removeChat(instanceId: String, chatId: String) {
        try? fileManager.removeItem(at: fileURL(kind: "chats", instanceId, chatId))
        removeActiveStream(instanceId: instanceId, chatId: chatId)
    }

    func purge(instanceId: String) {
        purgeFiles(kind: "lists", instanceId: instanceId, as: ChatListEnvelope.self) { $0.instanceId }
        purgeFiles(kind: "chats", instanceId: instanceId, as: ChatEnvelope.self) { $0.instanceId }
        purgeFiles(kind: "streams", instanceId: instanceId, as: StreamEnvelope.self) { $0.instanceId }
    }

    func removeActiveStreams(instanceId: String) {
        purgeFiles(kind: "streams", instanceId: instanceId, as: StreamEnvelope.self) { $0.instanceId }
    }

    private func fileURL(kind: String, _ parts: String...) -> URL {
        let digest = SHA256.hash(data: Data(parts.joined(separator: "\u{1f}").utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return root
            .appending(path: kind, directoryHint: .isDirectory)
            .appending(path: "\(name).json")
    }

    private func load<Value: Decodable>(_ type: Value.Type, from url: URL) -> Value? {
        guard let data = try? Data(contentsOf: url),
              data.count <= maxCacheFileBytes else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func purgeFiles<Value: Decodable>(
        kind: String,
        instanceId: String,
        as type: Value.Type,
        instance: (Value) -> String
    ) {
        let directory = root.appending(path: kind, directoryHint: .isDirectory)
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in urls {
            if let envelope: Value = load(type, from: url), instance(envelope) == instanceId {
                try? fileManager.removeItem(at: url)
                continue
            }
            // Older active-stream records did not contain deviceId and cannot
            // decode with the current schema. Their outer envelope still has
            // an exact installation identity, so explicit forget/re-pair can
            // remove them without touching another Mac's cache.
            guard let data = try? Data(contentsOf: url),
                  data.count <= maxCacheFileBytes,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["instanceId"] as? String == instanceId else { continue }
            try? fileManager.removeItem(at: url)
        }
    }

    private func save<Value: Encodable>(_ value: Value, to url: URL) throws {
        let data = try JSONEncoder().encode(value)
        guard data.count <= maxCacheFileBytes else {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
