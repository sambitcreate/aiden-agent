import CryptoKit
import Foundation

actor AidenChatCache {
    static let shared = AidenChatCache()

    struct SummarySnapshot: Codable, Equatable, Sendable {
        let summaries: [AidenChatSummary]
        let nextCursor: String?
    }

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

    private struct CachedChatSummary: Codable {
        let id: String
        let workspaceId: String
        let title: String
        let titlePending: Bool
        let createdAt: Date
        let updatedAt: Date
        let revision: String
        let activity: AidenChatSummaryActivity

        init(_ summary: AidenChatSummary) {
            id = summary.id
            workspaceId = summary.workspaceId
            title = summary.title
            titlePending = summary.titlePending
            createdAt = summary.createdAt
            updatedAt = summary.updatedAt
            revision = summary.revision
            activity = summary.activity
        }

        var summary: AidenChatSummary {
            AidenChatSummary(
                id: id,
                workspaceId: workspaceId,
                title: title,
                titlePending: titlePending,
                createdAt: createdAt,
                updatedAt: updatedAt,
                revision: revision,
                activity: activity
            )
        }
    }

    private struct CachedSummarySnapshot: Codable {
        let summaries: [CachedChatSummary]
        let nextCursor: String?

        init(_ snapshot: SummarySnapshot) {
            summaries = snapshot.summaries.map(CachedChatSummary.init)
            nextCursor = snapshot.nextCursor
        }
    }

    private struct ChatSummaryEnvelope: Codable {
        let instanceId: String
        let snapshot: CachedSummarySnapshot
    }

    private struct StreamEnvelope: Codable {
        let instanceId: String
        let chatId: String
        let stream: ActiveStream
    }

    // Tests can hold an admitted caller while another actor operation wins.
    private let beforeActiveStreamWrite: (@Sendable () async -> Void)?
    private let beforeChatWrite: (@Sendable () async -> Void)?
    private let root: URL
    private let legacyRoots: [URL]
    private let fileManager: FileManager
    private let maxCacheFileBytes = 10 * 1_024 * 1_024
    private let maxSummaryCacheFileBytes: Int
    private let maxSummaryCacheItems = 10_000
    private let maxAttachmentImageCacheBytes = 96 * 1_024 * 1_024
    // Reserve at transcript acceptance, before crossing an actor boundary. A
    // cache-wide clock avoids collisions when a new view model opens a chat.
    private final class ChatWriteClock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: UInt64 = 0
        private var removed: [String: [String: UInt64]] = [:]
        private var purged: [String: UInt64] = [:]

        func invalidate(instanceId: String, chatId: String? = nil) -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            value += 1
            if let chatId { removed[instanceId, default: [:]][chatId] = value }
            else { purged[instanceId] = value; removed.removeValue(forKey: instanceId) }
            return value
        }

        func retains(_ token: UInt64, instanceId: String, chatId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return token > (purged[instanceId] ?? 0) && token > (removed[instanceId]?[chatId] ?? 0)
        }

        func next() -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            value += 1
            return value
        }
    }

    private nonisolated let chatWriteClock = ChatWriteClock()
    private var chatWriteGenerations: [String: [String: UInt64]] = [:]
    private var chatPurgeGenerations: [String: UInt64] = [:]

    nonisolated func reserveChatWrite() -> UInt64 {
        chatWriteClock.next()
    }

    nonisolated func isChatWriteRetained(_ token: UInt64, instanceId: String, chatId: String) -> Bool {
        chatWriteClock.retains(token, instanceId: instanceId, chatId: chatId)
    }

    private var summaryWriteGenerations: [String: UInt64] = [:]

    init(
        root: URL? = nil,
        beforeChatWrite: (@Sendable () async -> Void)? = nil,
        beforeActiveStreamWrite: (@Sendable () async -> Void)? = nil,
        fileManager: FileManager = .default,
        legacyRoots: [URL]? = nil,
        maxSummaryCacheFileBytes: Int = 80 * 1_024 * 1_024
    ) {
        self.beforeActiveStreamWrite = beforeActiveStreamWrite
        self.beforeChatWrite = beforeChatWrite
        self.fileManager = fileManager
        self.maxSummaryCacheFileBytes = maxSummaryCacheFileBytes
        if let root {
            self.root = root
            self.legacyRoots = legacyRoots ?? []
        } else {
            let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? fileManager.temporaryDirectory
            let namespaceRoot = applicationSupport
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
            self.root = namespaceRoot
                // v1 could not distinguish Bot chats from Workspace chats.
                // Use a fresh namespace so ambiguous offline entries are never
                // admitted after the wire gained an authoritative botId.
                .appending(path: "RemoteChatCache-v2", directoryHint: .isDirectory)
            self.legacyRoots = legacyRoots ?? [
                namespaceRoot.appending(path: "RemoteChatCache-v1", directoryHint: .isDirectory),
            ]
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

    @discardableResult
    func saveChat(_ chat: AidenChat, instanceId: String, writeToken: UInt64) async throws -> Bool {
        await beforeChatWrite?()
        guard writeToken > (chatPurgeGenerations[instanceId] ?? 0),
              writeToken > (chatWriteGenerations[instanceId]?[chat.id] ?? 0) else { return false }
        // Advance even if persistence fails: an older queued snapshot must not
        // become authoritative merely because the newest disk write failed.
        chatWriteGenerations[instanceId, default: [:]][chat.id] = writeToken
        try save(
            ChatEnvelope(instanceId: instanceId, chat: chat),
            to: fileURL(kind: "chats", instanceId, chat.id)
        )
        return true
    }

    func loadChatSummaries(instanceId: String) -> SummarySnapshot? {
        guard let envelope: ChatSummaryEnvelope = load(
            ChatSummaryEnvelope.self,
            from: fileURL(kind: "summaries", instanceId),
            maximumBytes: maxSummaryCacheFileBytes
        ), envelope.instanceId == instanceId else {
            return nil
        }
        let summaries = envelope.snapshot.summaries.map(\.summary)
        guard summaries.count <= maxSummaryCacheItems,
              summaries.allSatisfy(AidenChatSummary.isValidCachedProjection),
              Set(summaries.map(\.id)).count == summaries.count,
              zip(summaries, summaries.dropFirst()).allSatisfy({ pair in
                  AidenChatSummaryPage.areInCanonicalOrder(pair.0, pair.1)
              }),
              envelope.snapshot.nextCursor.map(AidenChatSummaryPage.isValidCursor) ?? true else {
            return nil
        }
        return SummarySnapshot(summaries: summaries, nextCursor: envelope.snapshot.nextCursor)
    }

    func saveChatSummaries(
        _ snapshot: SummarySnapshot,
        instanceId: String,
        generation: UInt64? = nil
    ) throws {
        guard snapshot.summaries.count <= maxSummaryCacheItems else {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        guard snapshot.summaries.allSatisfy(AidenChatSummary.isValidCachedProjection) else {
            throw AidenRemoteContractError.invalidJSON
        }
        if let generation {
            guard generation >= (summaryWriteGenerations[instanceId] ?? 0) else { return }
            summaryWriteGenerations[instanceId] = generation
        }
        try save(
            ChatSummaryEnvelope(instanceId: instanceId, snapshot: CachedSummarySnapshot(snapshot)),
            to: fileURL(kind: "summaries", instanceId),
            maximumBytes: maxSummaryCacheFileBytes
        )
    }

    func reconcileChatSummary(_ chat: AidenChat, instanceId: String) throws {
        guard !chat.isBotChat else { return }
        let cached = loadChatSummaries(instanceId: instanceId)
        let existingActivity = cached?.summaries.first(where: { $0.id == chat.id })?.activity ?? .idle
        let summaries = AidenChatSummaryPage.merged(
            current: cached?.summaries ?? [],
            appending: [AidenChatSummary(chat: chat, preservingActivity: existingActivity)]
        )
        try saveChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached?.nextCursor),
            instanceId: instanceId
        )
    }

    func removeChatSummary(instanceId: String, chatId: String) throws {
        guard let cached = loadChatSummaries(instanceId: instanceId) else { return }
        let summaries = cached.summaries.filter { $0.id != chatId }
        guard summaries.count != cached.summaries.count else { return }
        try saveChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached.nextCursor),
            instanceId: instanceId
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

    @discardableResult
    func saveActiveStream(_ stream: ActiveStream, instanceId: String, chatId: String, chatWriteToken: UInt64? = nil) async throws -> Bool {
        await beforeActiveStreamWrite?()
        if let chatWriteToken, !isChatWriteRetained(chatWriteToken, instanceId: instanceId, chatId: chatId) { return false }
        try save(
            StreamEnvelope(instanceId: instanceId, chatId: chatId, stream: stream),
            to: fileURL(kind: "streams", instanceId, chatId)
        )
        return true
    }

    func removeActiveStream(instanceId: String, chatId: String) {
        try? fileManager.removeItem(at: fileURL(kind: "streams", instanceId, chatId))
    }

    @discardableResult
    func removeActiveStream(instanceId: String, chatId: String, ifStreamId streamId: String) -> Bool {
        guard loadActiveStream(instanceId: instanceId, chatId: chatId)?.streamId == streamId else {
            return false
        }
        removeActiveStream(instanceId: instanceId, chatId: chatId)
        return true
    }

    func removeChat(instanceId: String, chatId: String) {
        chatWriteGenerations[instanceId, default: [:]][chatId] = chatWriteClock.invalidate(instanceId: instanceId, chatId: chatId)
        try? fileManager.removeItem(at: fileURL(kind: "chats", instanceId, chatId))
        try? removeChatSummary(instanceId: instanceId, chatId: chatId)
        removeActiveStream(instanceId: instanceId, chatId: chatId)
        try? fileManager.removeItem(at: attachmentChatDirectory(instanceId: instanceId, chatId: chatId))
    }

    func purge(instanceId: String) {
        chatPurgeGenerations[instanceId] = chatWriteClock.invalidate(instanceId: instanceId)
        chatWriteGenerations.removeValue(forKey: instanceId)
        summaryWriteGenerations.removeValue(forKey: instanceId)
        purgeNamespace(root, instanceId: instanceId)
        for legacyRoot in legacyRoots where legacyRoot.standardizedFileURL != root.standardizedFileURL {
            purgeNamespace(legacyRoot, instanceId: instanceId)
        }
    }

    func removeActiveStreams(instanceId: String) {
        purgeFiles(root: root, kind: "streams", instanceId: instanceId, as: StreamEnvelope.self) {
            $0.instanceId
        }
    }

    func attachmentImage(
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachment: AidenMessageAttachment
    ) -> Data? {
        guard attachment.kind == .image else { return nil }
        let url = attachmentImageURL(
            instanceId: instanceId,
            deviceId: deviceId,
            chatId: chatId,
            attachmentId: attachment.id
        )
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            if fileManager.fileExists(atPath: url.path) {
                AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .corruptData)
                try? fileManager.removeItem(at: url)
            }
            return nil
        }
        guard let validated = AidenAttachmentImageValidation.validatedData(
            data,
            mimeType: attachment.mimeType,
            declaredSize: attachment.size
        ) else {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .corruptData)
            try? fileManager.removeItem(at: url)
            return nil
        }
        try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return validated
    }

    func saveAttachmentImage(
        _ data: Data,
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachment: AidenMessageAttachment
    ) throws {
        guard attachment.kind == .image,
              AidenAttachmentImageValidation.validatedData(
                  data,
                  mimeType: attachment.mimeType,
                  declaredSize: attachment.size
              ) != nil
        else { throw CocoaError(.fileReadCorruptFile) }
        let url = attachmentImageURL(
            instanceId: instanceId,
            deviceId: deviceId,
            chatId: chatId,
            attachmentId: attachment.id
        )
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        pruneAttachmentImages(instanceId: instanceId, preserving: url)
    }

    func removeAttachmentImage(instanceId: String, deviceId: String, chatId: String, attachmentId: String) {
        try? fileManager.removeItem(at: attachmentImageURL(
            instanceId: instanceId,
            deviceId: deviceId,
            chatId: chatId,
            attachmentId: attachmentId
        ))
    }

    private func fileURL(kind: String, _ parts: String...) -> URL {
        let digest = SHA256.hash(data: Data(parts.joined(separator: "\u{1f}").utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return root
            .appending(path: kind, directoryHint: .isDirectory)
            .appending(path: "\(name).json")
    }

    private func digestName(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func attachmentInstanceDirectory(
        cacheRoot: URL? = nil,
        instanceId: String
    ) -> URL {
        (cacheRoot ?? root)
            .appending(path: "attachment-images", directoryHint: .isDirectory)
            .appending(path: digestName(instanceId), directoryHint: .isDirectory)
    }

    private func attachmentChatDirectory(instanceId: String, chatId: String) -> URL {
        attachmentInstanceDirectory(instanceId: instanceId)
            .appending(path: digestName(chatId), directoryHint: .isDirectory)
    }

    private func attachmentImageURL(
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachmentId: String
    ) -> URL {
        attachmentChatDirectory(instanceId: instanceId, chatId: chatId)
            .appending(path: digestName(deviceId), directoryHint: .isDirectory)
            .appending(path: "\(digestName(attachmentId)).image")
    }

    private func pruneAttachmentImages(instanceId: String, preserving preservedURL: URL) {
        let directory = attachmentInstanceDirectory(instanceId: instanceId)
        guard let enumerator = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let files = enumerator.compactMap { value -> (url: URL, bytes: Int, modified: Date)? in
            guard let url = value as? URL,
                  let values = try? url.resourceValues(forKeys: [
                      .isRegularFileKey,
                      .fileSizeKey,
                      .contentModificationDateKey,
                  ]),
                  values.isRegularFile == true
            else { return nil }
            return (url, max(0, values.fileSize ?? 0), values.contentModificationDate ?? .distantPast)
        }.sorted { lhs, rhs in
            if lhs.url == preservedURL { return true }
            if rhs.url == preservedURL { return false }
            return lhs.modified > rhs.modified
        }
        var retainedBytes = 0
        for file in files {
            if retainedBytes + file.bytes <= maxAttachmentImageCacheBytes {
                retainedBytes += file.bytes
            } else {
                try? fileManager.removeItem(at: file.url)
            }
        }
    }

    private func load<Value: Decodable>(
        _ type: Value.Type,
        from url: URL,
        maximumBytes: Int? = nil
    ) -> Value? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let byteLimit = maximumBytes ?? maxCacheFileBytes
        if let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let fileSize = values.fileSize,
           fileSize > byteLimit {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            return nil
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            return nil
        }
        guard data.count <= byteLimit else {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            return nil
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            return try decoder.decode(type, from: data)
        } catch {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            return nil
        }
    }

    private func purgeNamespace(_ cacheRoot: URL, instanceId: String) {
        purgeFiles(root: cacheRoot, kind: "lists", instanceId: instanceId, as: ChatListEnvelope.self) {
            $0.instanceId
        }
        purgeFiles(root: cacheRoot, kind: "chats", instanceId: instanceId, as: ChatEnvelope.self) {
            $0.instanceId
        }
        purgeFiles(
            root: cacheRoot,
            kind: "summaries",
            instanceId: instanceId,
            as: ChatSummaryEnvelope.self,
            maximumBytes: maxSummaryCacheFileBytes
        ) {
            $0.instanceId
        }
        purgeFiles(root: cacheRoot, kind: "streams", instanceId: instanceId, as: StreamEnvelope.self) {
            $0.instanceId
        }
        try? fileManager.removeItem(at: attachmentInstanceDirectory(
            cacheRoot: cacheRoot,
            instanceId: instanceId
        ))
    }

    private func purgeFiles<Value: Decodable>(
        root cacheRoot: URL,
        kind: String,
        instanceId: String,
        as type: Value.Type,
        maximumBytes: Int? = nil,
        instance: (Value) -> String
    ) {
        let directory = cacheRoot.appending(path: kind, directoryHint: .isDirectory)
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in urls {
            if let envelope: Value = load(type, from: url, maximumBytes: maximumBytes),
               instance(envelope) == instanceId {
                try? fileManager.removeItem(at: url)
                continue
            }
            // Older active-stream records did not contain deviceId and cannot
            // decode with the current schema. Their outer envelope still has
            // an exact installation identity, so explicit forget/re-pair can
            // remove them without touching another Mac's cache.
            guard let data = try? Data(contentsOf: url),
                  data.count <= (maximumBytes ?? maxCacheFileBytes),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["instanceId"] as? String == instanceId else { continue }
            try? fileManager.removeItem(at: url)
        }
    }

    private func save<Value: Encodable>(
        _ value: Value,
        to url: URL,
        maximumBytes: Int? = nil
    ) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(value)
        guard data.count <= (maximumBytes ?? maxCacheFileBytes) else {
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
