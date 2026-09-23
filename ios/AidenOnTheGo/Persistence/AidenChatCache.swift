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

    @MainActor final class ChatLifetime {
        let instanceId: String
        let chatId: String
        private(set) var isRemoved = false
        var onRemoval: (() -> Void)?
        var onRemovalCleanup: (@Sendable () async -> Void)?

        init(instanceId: String, chatId: String) {
            self.instanceId = instanceId
            self.chatId = chatId
        }

        @discardableResult
        func remove() -> (@Sendable () async -> Void)? {
            isRemoved = true
            onRemoval?()
            onRemoval = nil
            let cleanup = onRemovalCleanup
            onRemovalCleanup = nil
            return cleanup
        }
    }

    @MainActor private final class Lifetimes {
        private struct Entry { weak var value: ChatLifetime? }
        private var entries: [Entry] = []
        struct Cleanup {
            let id = UUID()
            let instanceId: String
            let chatId: String
            let task: Task<Void, Never>
        }
        private var pendingCleanups: [Cleanup] = []
        nonisolated init() {}

        func register(_ lifetime: ChatLifetime) {
            entries.removeAll { $0.value == nil }
            entries.append(Entry(value: lifetime))
        }

        func remove(instanceId: String, chatId: String? = nil) -> [Cleanup] {
            for entry in entries {
                guard let value = entry.value, value.instanceId == instanceId,
                      chatId == nil || value.chatId == chatId else { continue }
                if let cleanup = value.remove() {
                    pendingCleanups.append(Cleanup(instanceId: value.instanceId, chatId: value.chatId, task: Task { await cleanup() }))
                }
            }
            entries.removeAll { $0.value == nil || $0.value?.isRemoved == true }
            // Overlapping removals must join cleanup already claimed by an
            // earlier removal, even though that lifetime is now invalidated.
            return pendingCleanups.filter { $0.instanceId == instanceId && (chatId == nil || $0.chatId == chatId) }
        }

        func completed(_ cleanups: [Cleanup]) {
            let ids = Set(cleanups.map(\.id))
            pendingCleanups.removeAll { ids.contains($0.id) }
        }
    }

    private nonisolated let lifetimes = Lifetimes()

    @MainActor func registerLifetime(instanceId: String, chatId: String) -> ChatLifetime {
        let lifetime = ChatLifetime(instanceId: instanceId, chatId: chatId)
        if chatWriteClock.isPending(instanceId: instanceId, chatId: chatId) { lifetime.remove() }
        else { lifetimes.register(lifetime) }
        return lifetime
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
    private let beforeMetadataWrite: (@Sendable () async -> Void)?
    private let beforeAttachmentImageWrite: (@Sendable () async -> Void)?
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
        private var metadataRemovalStarts: [String: UInt64] = [:]
        private var pending: [UInt64: (instanceId: String, chatId: String?)] = [:]

        func invalidate(instanceId: String, chatId: String? = nil) -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            value += 1
            pending[value] = (instanceId, chatId)
            metadataRemovalStarts[instanceId] = value
            if let chatId { removed[instanceId, default: [:]][chatId] = value }
            else { purged[instanceId] = value; removed.removeValue(forKey: instanceId) }
            return value
        }

        @discardableResult
        func finish(_ token: UInt64) -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            guard let removal = pending.removeValue(forKey: token) else { return value }
            // Reservations made while cleanup was suspended cannot gain fresh
            // authority merely because the pending marker has disappeared.
            value += 1
            if let chatId = removal.chatId { removed[removal.instanceId, default: [:]][chatId] = value }
            else { purged[removal.instanceId] = value }
            return value
        }

        func isPending(instanceId: String, chatId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return pending.values.contains { $0.instanceId == instanceId && ($0.chatId == nil || $0.chatId == chatId) }
        }

        func metadataRemovalStart(instanceId: String) -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            return metadataRemovalStarts[instanceId] ?? 0
        }

        func hasPendingRemoval(instanceId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return pending.values.contains { $0.instanceId == instanceId }
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
    private var committedChatWrites: [String: [String: (token: UInt64, listToken: UInt64)]] = [:]
    private var removedChatIDs: [String: Set<String>] = [:]
    private var chatPurgeGenerations: [String: UInt64] = [:]

    nonisolated func reserveChatWrite() -> UInt64 {
        chatWriteClock.next()
    }

    nonisolated func isChatWriteRetained(_ token: UInt64, instanceId: String, chatId: String) -> Bool {
        chatWriteClock.retains(token, instanceId: instanceId, chatId: chatId)
    }

    private var metadataDeletionTokens: [String: UInt64] = [:]
    private var metadataCompletionTokens: [String: UInt64] = [:]
    private var workspaceWriteTokens: [String: [String: UInt64]] = [:]
    private var summaryWriteTokens: [String: UInt64] = [:]
    private var summaryWriteGenerations: [String: UInt64] = [:]

    init(
        root: URL? = nil,
        beforeChatWrite: (@Sendable () async -> Void)? = nil,
        beforeActiveStreamWrite: (@Sendable () async -> Void)? = nil,
        beforeAttachmentImageWrite: (@Sendable () async -> Void)? = nil,
        beforeMetadataWrite: (@Sendable () async -> Void)? = nil,
        fileManager: FileManager = .default,
        legacyRoots: [URL]? = nil,
        maxSummaryCacheFileBytes: Int = 80 * 1_024 * 1_024
    ) {
        self.beforeMetadataWrite = beforeMetadataWrite
        self.beforeAttachmentImageWrite = beforeAttachmentImageWrite
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
        return envelope.chats.filter { !isChatHidden(instanceId: instanceId, chatId: $0.id) }
    }

    func saveChats(_ chats: [AidenChat], instanceId: String, workspaceId: String, writeToken: UInt64) async throws {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId) else { return }
        let latestListToken = workspaceWriteTokens[instanceId]?[workspaceId] ?? 0
        let isOlderList = writeToken < latestListToken
        let partial = isOlderList || metadataWriteIsPartial(writeToken, instanceId: instanceId)
        var retained = isOlderList ? [] : chats.filter {
            !isChatHidden(instanceId: instanceId, chatId: $0.id) &&
            isChatWriteRetained(writeToken, instanceId: instanceId, chatId: $0.id)
        }
        // Detail and list delivery can cross in either direction. An older
        // companion may add only a detail committed after the current list;
        // an old replay must not undo a later authoritative list omission.
        for (chatId, commit) in committedChatWrites[instanceId] ?? [:] {
            let ownsRow = isOlderList
                ? commit.token > latestListToken || (commit.token == writeToken && commit.listToken == latestListToken)
                : commit.token >= writeToken
            guard ownsRow else { continue }
            retained.removeAll { $0.id == chatId }
            if let current = loadChat(instanceId: instanceId, chatId: chatId),
               current.workspaceId == workspaceId, !current.isBotChat {
                retained.append(current)
            }
        }
        if partial {
            let ids = Set(retained.map(\.id))
            retained += (loadChats(instanceId: instanceId, workspaceId: workspaceId) ?? []).filter { !ids.contains($0.id) }
        }
        workspaceWriteTokens[instanceId, default: [:]][workspaceId] = max(writeToken, latestListToken)
        try save(
            ChatListEnvelope(instanceId: instanceId, workspaceId: workspaceId, chats: retained),
            to: fileURL(kind: "lists", instanceId, workspaceId)
        )
    }

    private func metadataWriteIsRetained(_ token: UInt64, instanceId: String) -> Bool {
        token > max(metadataDeletionTokens[instanceId] ?? 0, chatWriteClock.metadataRemovalStart(instanceId: instanceId)) &&
        !chatWriteClock.isPending(instanceId: instanceId, chatId: "") &&
        isChatWriteRetained(token, instanceId: instanceId, chatId: "")
    }

    private func metadataWriteIsPartial(_ token: UInt64, instanceId: String) -> Bool {
        chatWriteClock.hasPendingRemoval(instanceId: instanceId) || token <= (metadataCompletionTokens[instanceId] ?? 0)
    }

    private func isChatHidden(instanceId: String, chatId: String) -> Bool {
        chatWriteClock.isPending(instanceId: instanceId, chatId: chatId) || removedChatIDs[instanceId]?.contains(chatId) == true
    }

    func loadChat(instanceId: String, chatId: String) -> AidenChat? {
        guard !isChatHidden(instanceId: instanceId, chatId: chatId) else { return nil }
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
        guard !chatWriteClock.isPending(instanceId: instanceId, chatId: chat.id),
              isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chat.id),
              writeToken > (chatPurgeGenerations[instanceId] ?? 0),
              writeToken > (chatWriteGenerations[instanceId]?[chat.id] ?? 0) else { return false }
        // Advance even if persistence fails: an older queued snapshot must not
        // become authoritative merely because the newest disk write failed.
        chatWriteGenerations[instanceId, default: [:]][chat.id] = writeToken
        try save(
            ChatEnvelope(instanceId: instanceId, chat: chat),
            to: fileURL(kind: "chats", instanceId, chat.id)
        )
        committedChatWrites[instanceId, default: [:]][chat.id] = (
            writeToken, workspaceWriteTokens[instanceId]?[chat.workspaceId] ?? 0
        )
        removedChatIDs[instanceId]?.remove(chat.id)
        return true
    }

    func loadChatSummaries(instanceId: String, includingRemoved: Bool = false) -> SummarySnapshot? {
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
        return SummarySnapshot(summaries: includingRemoved ? summaries : summaries.filter { !isChatHidden(instanceId: instanceId, chatId: $0.id) }, nextCursor: envelope.snapshot.nextCursor)
    }

    func saveChatSummaries(
        _ snapshot: SummarySnapshot,
        instanceId: String,
        generation: UInt64? = nil,
        writeToken: UInt64
    ) async throws {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId) else { return }
        var retained = snapshot.summaries.filter {
            !isChatHidden(instanceId: instanceId, chatId: $0.id) && isChatWriteRetained(writeToken, instanceId: instanceId, chatId: $0.id)
        }
        var nextCursor = snapshot.nextCursor
        let partial = metadataWriteIsPartial(writeToken, instanceId: instanceId)
        if partial {
            let cached = loadChatSummaries(instanceId: instanceId)
            retained = AidenChatSummaryPage.merged(current: cached?.summaries ?? [], appending: retained)
            if let cached { nextCursor = cached.nextCursor }
        }
        try persistChatSummaries(SummarySnapshot(summaries: retained, nextCursor: nextCursor), instanceId: instanceId, generation: partial ? nil : generation, writeToken: writeToken)
    }

    private func persistChatSummaries(_ snapshot: SummarySnapshot, instanceId: String, generation: UInt64? = nil, writeToken: UInt64) throws {
        guard writeToken >= (summaryWriteTokens[instanceId] ?? 0) else { return }
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
        summaryWriteTokens[instanceId] = writeToken
        try save(
            ChatSummaryEnvelope(instanceId: instanceId, snapshot: CachedSummarySnapshot(snapshot)),
            to: fileURL(kind: "summaries", instanceId),
            maximumBytes: maxSummaryCacheFileBytes
        )
    }

    func reconcileChatSummary(_ chat: AidenChat, instanceId: String, writeToken: UInt64) async throws {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId),
              !isChatHidden(instanceId: instanceId, chatId: chat.id),
              isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chat.id), !chat.isBotChat else { return }
        let cached = loadChatSummaries(instanceId: instanceId)
        let existingActivity = cached?.summaries.first(where: { $0.id == chat.id })?.activity ?? .idle
        let summaries = AidenChatSummaryPage.merged(
            current: cached?.summaries ?? [],
            appending: [AidenChatSummary(chat: chat, preservingActivity: existingActivity)]
        )
        try persistChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached?.nextCursor),
            instanceId: instanceId, writeToken: writeToken
        )
    }

    func removeChatSummary(instanceId: String, chatId: String, writeToken: UInt64? = nil) throws {
        guard let cached = loadChatSummaries(instanceId: instanceId, includingRemoved: true) else { return }
        let summaries = cached.summaries.filter { $0.id != chatId }
        guard summaries.count != cached.summaries.count else { return }
        try persistChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached.nextCursor),
            instanceId: instanceId, writeToken: writeToken.map { max($0, summaryWriteTokens[instanceId] ?? 0) } ?? reserveChatWrite()
        )
    }

    func loadActiveStream(instanceId: String, chatId: String) -> ActiveStream? {
        guard !isChatHidden(instanceId: instanceId, chatId: chatId) else { return nil }
        guard let envelope: StreamEnvelope = load(
            StreamEnvelope.self,
            from: fileURL(kind: "streams", instanceId, chatId)
        ), envelope.instanceId == instanceId, envelope.chatId == chatId else {
            return nil
        }
        return envelope.stream
    }

    @discardableResult
    func saveActiveStream(_ stream: ActiveStream, instanceId: String, chatId: String, chatWriteToken: UInt64) async throws -> Bool {
        await beforeActiveStreamWrite?()
        guard !isChatHidden(instanceId: instanceId, chatId: chatId) else { return false }
        if !isChatWriteRetained(chatWriteToken, instanceId: instanceId, chatId: chatId) { return false }
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

    // Deletion and consumer admission share the main actor. Invalidation and
    // cancellation happen without suspension; disk work rejects all writes for
    // this identity until the deletion completes.
    @MainActor func removeChat(instanceId: String, chatId: String) async {
        let token = chatWriteClock.invalidate(instanceId: instanceId, chatId: chatId)
        let cleanups = lifetimes.remove(instanceId: instanceId, chatId: chatId)
        for cleanup in cleanups { await cleanup.task.value }
        lifetimes.completed(cleanups)
        await removeChatFiles(instanceId: instanceId, chatId: chatId, token: token)
    }

    private func removeChatFiles(instanceId: String, chatId: String, token: UInt64) {
        // A suspended metadata writer may target an absent file or omit the
        // deleted row. Fence it independently of the files found during cleanup.
        metadataDeletionTokens[instanceId] = max(token, metadataDeletionTokens[instanceId] ?? 0)
        chatWriteGenerations[instanceId, default: [:]][chatId] = max(token, chatWriteGenerations[instanceId]?[chatId] ?? 0)
        removedChatIDs[instanceId, default: []].insert(chatId)
        committedChatWrites[instanceId]?.removeValue(forKey: chatId)
        let directory = root.appending(path: "lists", directoryHint: .isDirectory)
        for url in (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            guard let envelope = load(ChatListEnvelope.self, from: url), envelope.instanceId == instanceId,
                  envelope.chats.contains(where: { $0.id == chatId }) else { continue }
            workspaceWriteTokens[instanceId, default: [:]][envelope.workspaceId] = max(token, workspaceWriteTokens[instanceId]?[envelope.workspaceId] ?? 0)
            let remaining = envelope.chats.filter { $0.id != chatId }
            do {
                try save(ChatListEnvelope(instanceId: instanceId, workspaceId: envelope.workspaceId, chats: remaining), to: url)
            } catch {
                // A failed rewrite must not retain a known deleted offline row.
                try? fileManager.removeItem(at: url)
            }
        }
        try? fileManager.removeItem(at: fileURL(kind: "chats", instanceId, chatId))
        do { try removeChatSummary(instanceId: instanceId, chatId: chatId, writeToken: token) }
        catch { try? fileManager.removeItem(at: fileURL(kind: "summaries", instanceId)) }
        removeActiveStream(instanceId: instanceId, chatId: chatId)
        try? fileManager.removeItem(at: attachmentChatDirectory(instanceId: instanceId, chatId: chatId))
        metadataCompletionTokens[instanceId] = chatWriteClock.finish(token)
    }

    @MainActor func purge(instanceId: String) async {
        let token = chatWriteClock.invalidate(instanceId: instanceId)
        let cleanups = lifetimes.remove(instanceId: instanceId)
        for cleanup in cleanups { await cleanup.task.value }
        lifetimes.completed(cleanups)
        await purgeFilesForInstance(instanceId: instanceId, token: token)
    }

    private func purgeFilesForInstance(instanceId: String, token: UInt64) {
        chatPurgeGenerations[instanceId] = max(token, chatPurgeGenerations[instanceId] ?? 0)
        removedChatIDs.removeValue(forKey: instanceId)
        workspaceWriteTokens.removeValue(forKey: instanceId)
        summaryWriteTokens.removeValue(forKey: instanceId)
        chatWriteGenerations.removeValue(forKey: instanceId)
        committedChatWrites.removeValue(forKey: instanceId)
        summaryWriteGenerations.removeValue(forKey: instanceId)
        purgeNamespace(root, instanceId: instanceId)
        for legacyRoot in legacyRoots where legacyRoot.standardizedFileURL != root.standardizedFileURL {
            purgeNamespace(legacyRoot, instanceId: instanceId)
        }
        metadataCompletionTokens[instanceId] = chatWriteClock.finish(token)
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
        guard !isChatHidden(instanceId: instanceId, chatId: chatId), attachment.kind == .image else { return nil }
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

    @discardableResult
    func saveAttachmentImage(
        _ data: Data,
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachment: AidenMessageAttachment,
        writeToken: UInt64
    ) async throws -> Bool {
        await beforeAttachmentImageWrite?()
        guard !isChatHidden(instanceId: instanceId, chatId: chatId),
              isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chatId) else { return false }
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
        return true
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
