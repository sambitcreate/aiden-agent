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
        private var summaryAuthority: [String: UInt64] = [:]
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

        func reserveSummary(instanceId: String) -> UInt64 {
            lock.lock()
            defer { lock.unlock() }
            value += 1
            summaryAuthority[instanceId] = value
            return value
        }

        func admitSummary(_ token: UInt64, instanceId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard token >= (summaryAuthority[instanceId] ?? 0) else { return false }
            summaryAuthority[instanceId] = token
            return true
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
    private struct RenameTitle: Codable {
        let instanceId: String
        let chatId: String
        let title: String
        // Missing on legacy records, where an empty title represented retirement.
        var retired: Bool? = false
    }
    private struct PendingRename {
        let value: RenameTitle
        let origin: UInt64
        let cutoff: UInt64
    }
    private var fetchedChatTokens: [String: [String: UInt64]] = [:]
    private var renameOrigins: [String: [String: UInt64]] = [:]
    private var renameTitles: [String: [String: PendingRename]] = [:]
    private var retiredRenameTitles: [String: Set<String>] = [:]
    private var workspaceFetchedTitles: [String: [String: [String: String]]] = [:]
    private var workspaceFetchTokens: [String: [String: UInt64]] = [:]
    private var admittedWorkspaceLists: [String: [String: [AidenChat]]] = [:]
    private var admittedChats: [String: [String: AidenChat]] = [:]
    private var removedChatIDs: [String: Set<String>] = [:]
    private var chatPurgeGenerations: [String: UInt64] = [:]

    nonisolated func reserveSummaryWrite(instanceId: String) -> UInt64 {
        chatWriteClock.reserveSummary(instanceId: instanceId)
    }

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
    private var admittedSummaries: [String: SummarySnapshot] = [:]
    private var summaryFullTokens: [String: UInt64] = [:]
    private var summaryRowTokens: [String: [String: UInt64]] = [:]

    private func summaryRowAuthority(instanceId: String, chatId: String) -> UInt64 {
        max(summaryFullTokens[instanceId] ?? 0, summaryRowTokens[instanceId]?[chatId] ?? 0)
    }
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

    // The last admitted list as written, without merging newer detail owners.
    private func admittedWorkspaceListRows(instanceId: String, workspaceId: String) -> [AidenChat]? {
        guard !chatWriteClock.isPending(instanceId: instanceId, chatId: "") else { return nil }
        if let admitted = admittedWorkspaceLists[instanceId]?[workspaceId] {
            return admitted.filter { !isChatHidden(instanceId: instanceId, chatId: $0.id) }
        }
        guard chatPurgeGenerations[instanceId] == nil else { return nil }
        return loadChats(instanceId: instanceId, workspaceId: workspaceId)
    }

    // Read the admitted list, including newer detail owners, even when disk IO failed.
    func admittedWorkspaceChats(instanceId: String, workspaceId: String) -> [AidenChat]? {
        guard let rows = admittedWorkspaceListRows(instanceId: instanceId, workspaceId: workspaceId) else { return nil }
        return mergingWorkspaceDetails(rows, instanceId: instanceId, workspaceId: workspaceId,
                                       writeToken: workspaceWriteTokens[instanceId]?[workspaceId] ?? 0)
    }

    func presentedWorkspaceChat(instanceId: String, workspaceId: String, chatId: String) -> AidenChat? {
        guard let row = admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId)?.first(where: { $0.id == chatId }) else { return nil }
        let listToken = workspaceWriteTokens[instanceId]?[workspaceId] ?? 0
        if let pending = pendingRename(instanceId: instanceId, chatId: chatId),
           (workspaceFetchTokens[instanceId]?[workspaceId] ?? 0) > pending.cutoff, listToken > (chatWriteGenerations[instanceId]?[chatId] ?? 0) {
            return row
        }
        return presenting(row, instanceId: instanceId)
    }

    private func mergingWorkspaceDetails(_ rows: [AidenChat], instanceId: String, workspaceId: String, writeToken: UInt64) -> [AidenChat] {
        var byID = Dictionary(rows.filter {
            !isChatHidden(instanceId: instanceId, chatId: $0.id)
        }.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        for (id, chat) in admittedChats[instanceId] ?? [:] {
            guard chat.workspaceId == workspaceId, !chat.isBotChat,
                  (chatWriteGenerations[instanceId]?[id] ?? 0) > writeToken,
                  // A list reserved before this chat's removal cannot carry
                  // its later detail-only re-admission into the list.
                  isChatWriteRetained(writeToken, instanceId: instanceId, chatId: id),
                  !isChatHidden(instanceId: instanceId, chatId: id),
                  let current = admittedChat(instanceId: instanceId, chatId: id) else { continue }
            byID[id] = current
        }
        return byID.values.sorted {
            $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
        }
    }

    @discardableResult
    func saveChats(_ chats: [AidenChat], instanceId: String, workspaceId: String, writeToken: UInt64, isAuthoritativeFetch: Bool = false) async throws -> Bool {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId) else { return false }
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
            guard ownsRow,
                  isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chatId) else { continue }
            retained.removeAll { $0.id == chatId }
            if let current = loadChat(instanceId: instanceId, chatId: chatId),
               current.workspaceId == workspaceId, !current.isBotChat {
                retained.append(current)
            }
        }
        if partial {
            // Extend the last admitted list itself, not its merged memory view:
            // a detail whose disk write failed must not become a durable row.
            let ids = Set(retained.map(\.id))
            retained += (admittedWorkspaceListRows(instanceId: instanceId, workspaceId: workspaceId) ?? []).filter { !ids.contains($0.id) }
        }
        retained = Dictionary(retained.filter {
            !isChatHidden(instanceId: instanceId, chatId: $0.id)
        }.map { row -> (String, AidenChat) in
            var canonical = row
            canonical.localTitleOverride = nil
            return (row.id, canonical)
        }, uniquingKeysWith: { _, latest in latest }).values.sorted {
            $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
        }
        admittedWorkspaceLists[instanceId, default: [:]][workspaceId] = retained
        if isAuthoritativeFetch, !isOlderList {
            workspaceFetchTokens[instanceId, default: [:]][workspaceId] = writeToken
            let retainedIDs = Set(retained.map(\.id))
            workspaceFetchedTitles[instanceId, default: [:]][workspaceId] = Dictionary(chats.filter { retainedIDs.contains($0.id) }.map { ($0.id, $0.title) }, uniquingKeysWith: { _, latest in latest })
        }
        defer {
            // A list row supersedes the old receipt title even if list IO fails.
            // Keep the new title separate until a coherent detail read catches
            // up; generic detail hydration may still have an older canonical row.
            for row in chats where isAuthoritativeFetch && !isOlderList {
                if retained.contains(where: { $0.id == row.id }),
                   let pending = pendingRename(instanceId: instanceId, chatId: row.id), writeToken > pending.cutoff,
                   (fetchedChatTokens[instanceId]?[row.id] ?? 0) <= writeToken {
                    let value = RenameTitle(instanceId: instanceId, chatId: row.id, title: row.title)
                    renameTitles[instanceId, default: [:]][row.id] = PendingRename(value: value, origin: pending.origin, cutoff: writeToken)
                    retiredRenameTitles[instanceId]?.remove(row.id)
                    try? save(value, to: fileURL(kind: "rename-titles", instanceId, row.id))
                }
            }
        }
        workspaceWriteTokens[instanceId, default: [:]][workspaceId] = max(writeToken, latestListToken)
        try save(
            ChatListEnvelope(instanceId: instanceId, workspaceId: workspaceId, chats: retained),
            to: fileURL(kind: "lists", instanceId, workspaceId)
        )
        return true
    }

    /// Keeps a successfully created chat in the durable workspace list when a
    /// list admitted while the create's detail write was suspended omitted it.
    /// The POST response is newer than any list that could not have seen it,
    /// so only the created row is added; the list token is not advanced, and
    /// removal, purge, and newer detail owners still win.
    @discardableResult
    func admitCreatedWorkspaceChat(chatId: String, instanceId: String, workspaceId: String, writeToken: UInt64) async -> Bool {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId),
              isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chatId),
              !isChatHidden(instanceId: instanceId, chatId: chatId),
              chatWriteGenerations[instanceId]?[chatId] == writeToken,
              var current = admittedChat(instanceId: instanceId, chatId: chatId),
              current.workspaceId == workspaceId, !current.isBotChat else { return false }
        current.localTitleOverride = nil
        var rows = admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId) ?? []
        rows.removeAll { $0.id == chatId }
        rows.append(current)
        rows.sort { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
        admittedWorkspaceLists[instanceId, default: [:]][workspaceId] = rows
        try? save(ChatListEnvelope(instanceId: instanceId, workspaceId: workspaceId, chats: rows), to: fileURL(kind: "lists", instanceId, workspaceId))
        return true
    }

    @discardableResult
    func reconcileWorkspaceChat(_ chat: AidenChat, instanceId: String, authority: UInt64, cutoff: UInt64) async -> Bool {
        await beforeMetadataWrite?()
        guard isChatWriteRetained(authority, instanceId: instanceId, chatId: chat.id),
              !isChatHidden(instanceId: instanceId, chatId: chat.id),
              let current = admittedChat(instanceId: instanceId, chatId: chat.id) else { return false }
        // Read after suspension, and never revive a row omitted by a list that
        // was requested after this receipt arrived.
        var rows = admittedWorkspaceChats(instanceId: instanceId, workspaceId: chat.workspaceId) ?? []
        let listToken = workspaceWriteTokens[instanceId]?[chat.workspaceId] ?? 0
        let mayPublish = listToken <= cutoff || rows.contains { $0.id == chat.id }
        if mayPublish {
            if listToken <= cutoff || (chatWriteGenerations[instanceId]?[chat.id] ?? 0) >= listToken {
                rows.removeAll { $0.id == chat.id }
                rows.append(current)
                admittedWorkspaceLists[instanceId, default: [:]][chat.workspaceId] = rows
                workspaceWriteTokens[instanceId, default: [:]][chat.workspaceId] = max(authority, listToken)
                try? save(ChatListEnvelope(instanceId: instanceId, workspaceId: chat.workspaceId, chats: rows), to: fileURL(kind: "lists", instanceId, chat.workspaceId))
            }
        }
        let cached = loadChatSummaries(instanceId: instanceId)
        let summaryToken = summaryRowAuthority(instanceId: instanceId, chatId: chat.id)
        let existing = cached?.summaries.first { $0.id == chat.id }
        let winnerToken = max(listToken, chatWriteGenerations[instanceId]?[chat.id] ?? 0)
        if let winner = presentedWorkspaceChat(instanceId: instanceId, workspaceId: chat.workspaceId, chatId: chat.id),
           summaryToken <= cutoff || (existing != nil && ((summaryFullTokens[instanceId] ?? 0) <= cutoff || winnerToken >= summaryToken)) {
            let summaries = AidenChatSummaryPage.merged(current: cached?.summaries ?? [], appending: [AidenChatSummary(chat: winner, preservingActivity: existing?.activity ?? .idle)])
            try? persistChatSummaries(SummarySnapshot(summaries: summaries, nextCursor: cached?.nextCursor), instanceId: instanceId, writeToken: max(cutoff, max(summaryToken, winnerToken)), updatedRows: [chat.id: max(summaryToken, max(cutoff, winnerToken))])
        }
        return mayPublish
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

    func admittedChat(instanceId: String, chatId: String) -> AidenChat? {
        guard !chatWriteClock.isPending(instanceId: instanceId, chatId: chatId) else { return nil }
        if let token = chatWriteGenerations[instanceId]?[chatId] {
            guard isChatWriteRetained(token, instanceId: instanceId, chatId: chatId) else { return nil }
            return admittedChats[instanceId]?[chatId]
        }
        guard chatPurgeGenerations[instanceId] == nil else { return nil }
        return loadChat(instanceId: instanceId, chatId: chatId)
    }

    private func pendingRename(instanceId: String, chatId: String) -> PendingRename? {
        guard !isChatHidden(instanceId: instanceId, chatId: chatId),
              !chatWriteClock.isPending(instanceId: instanceId, chatId: chatId) else { return nil }
        if let pending = renameTitles[instanceId]?[chatId] { return pending }
        guard chatPurgeGenerations[instanceId] == nil,
              retiredRenameTitles[instanceId]?.contains(chatId) != true,
              let value: RenameTitle = load(RenameTitle.self, from: fileURL(kind: "rename-titles", instanceId, chatId)),
              value.instanceId == instanceId, value.chatId == chatId,
              !(value.retired ?? value.title.isEmpty), value.title.unicodeScalars.count <= 1_024 else { return nil }
        let pending = PendingRename(value: value, origin: 0, cutoff: 0)
        renameTitles[instanceId, default: [:]][chatId] = pending
        return pending
    }

    func needsRenameRefresh(instanceId: String, chatId: String) -> Bool {
        pendingRename(instanceId: instanceId, chatId: chatId) != nil
    }

    func presenting(_ chat: AidenChat, instanceId: String) -> AidenChat {
        var result = chat
        result.localTitleOverride = pendingRename(instanceId: instanceId, chatId: chat.id)?.value.title
        return result
    }

    // A successful PATCH owns its title field, not another owner's full transcript/revision.
    func acceptRename(_ receipt: AidenChat, instanceId: String, origin: UInt64, cutoff: UInt64) async -> AidenChat? {
        guard isChatWriteRetained(origin, instanceId: instanceId, chatId: receipt.id),
              !chatWriteClock.isPending(instanceId: instanceId, chatId: receipt.id) else { return nil }
        // Install receipt authority before the cache-write suspension so a later
        // requested GET can retire it while that write is queued.
        let newestReceipt = origin > (renameOrigins[instanceId]?[receipt.id] ?? 0)
        if newestReceipt { renameOrigins[instanceId, default: [:]][receipt.id] = origin }
        let listToken = workspaceFetchTokens[instanceId]?[receipt.workspaceId] ?? 0
        let newerListTitle = listToken > cutoff ? workspaceFetchedTitles[instanceId]?[receipt.workspaceId]?[receipt.id] : nil
        let titleCutoff = newerListTitle == nil ? cutoff : listToken
        if newestReceipt, (fetchedChatTokens[instanceId]?[receipt.id] ?? 0) <= titleCutoff {
            let value = RenameTitle(instanceId: instanceId, chatId: receipt.id, title: newerListTitle ?? receipt.title)
            renameTitles[instanceId, default: [:]][receipt.id] = PendingRename(value: value, origin: origin, cutoff: titleCutoff)
            retiredRenameTitles[instanceId]?.remove(receipt.id)
            try? save(value, to: fileURL(kind: "rename-titles", instanceId, receipt.id))
        }
        _ = try? await saveChat(receipt, instanceId: instanceId, writeToken: origin)
        guard isChatWriteRetained(origin, instanceId: instanceId, chatId: receipt.id),
              !chatWriteClock.isPending(instanceId: instanceId, chatId: receipt.id),
              let canonical = admittedChat(instanceId: instanceId, chatId: receipt.id) else { return nil }
        return presenting(canonical, instanceId: instanceId)
    }

    @discardableResult
    func saveFetchedChat(_ chat: AidenChat, instanceId: String, writeToken: UInt64) async throws -> Bool {
        // Check receipt authority after the write as well: an overlay can be
        // installed while this actor is suspended at the IO boundary.
        let accepted: Bool
        do { accepted = try await saveChat(chat, instanceId: instanceId, writeToken: writeToken) }
        catch {
            if chatWriteGenerations[instanceId]?[chat.id] == writeToken {
                fetchedChatTokens[instanceId, default: [:]][chat.id] = max(writeToken, fetchedChatTokens[instanceId]?[chat.id] ?? 0)
            }
            retireRenameAfterFetch(instanceId: instanceId, chatId: chat.id, writeToken: writeToken, pending: pendingRename(instanceId: instanceId, chatId: chat.id), persisted: false)
            throw error
        }
        if accepted {
            fetchedChatTokens[instanceId, default: [:]][chat.id] = max(writeToken, fetchedChatTokens[instanceId]?[chat.id] ?? 0)
            retireRenameAfterFetch(instanceId: instanceId, chatId: chat.id, writeToken: writeToken, pending: pendingRename(instanceId: instanceId, chatId: chat.id))
        }
        return accepted
    }

    private func retireRenameAfterFetch(instanceId: String, chatId: String, writeToken: UInt64, pending: PendingRename?, persisted: Bool = true) {
        guard let pending, writeToken > pending.cutoff,
              chatWriteGenerations[instanceId]?[chatId] == writeToken,
              renameTitles[instanceId]?[chatId]?.cutoff == pending.cutoff else { return }
        renameTitles[instanceId]?.removeValue(forKey: chatId)
        retiredRenameTitles[instanceId, default: []].insert(chatId)
        if persisted {
            // Persist retirement atomically; a failed unlink cannot resurrect
            // an older receipt when a new cache actor opens the directory.
            try? save(RenameTitle(instanceId: instanceId, chatId: chatId, title: "", retired: true), to: fileURL(kind: "rename-titles", instanceId, chatId))
        } else if let canonical = admittedChats[instanceId]?[chatId] {
            // Keep a separate durable title for restart if the canonical file
            // could not be updated, without hiding the current memory winner.
            try? save(RenameTitle(instanceId: instanceId, chatId: chatId, title: canonical.title), to: fileURL(kind: "rename-titles", instanceId, chatId))
        }
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
        var canonical = chat
        canonical.localTitleOverride = nil
        admittedChats[instanceId, default: [:]][chat.id] = canonical
        if !canonical.isBotChat, writeToken >= summaryRowAuthority(instanceId: instanceId, chatId: chat.id) {
            let cached = loadChatSummaries(instanceId: instanceId)
            let activity = cached?.summaries.first(where: { $0.id == chat.id })?.activity ?? .idle
            let rows = AidenChatSummaryPage.merged(current: cached?.summaries ?? [], appending: [AidenChatSummary(chat: presenting(canonical, instanceId: instanceId), preservingActivity: activity)])
            try? persistChatSummaries(.init(summaries: rows, nextCursor: cached?.nextCursor), instanceId: instanceId, writeToken: writeToken, updatedRows: [chat.id: writeToken])
        }
        try save(
            ChatEnvelope(instanceId: instanceId, chat: canonical),
            to: fileURL(kind: "chats", instanceId, chat.id)
        )
        committedChatWrites[instanceId, default: [:]][chat.id] = (
            writeToken, workspaceWriteTokens[instanceId]?[chat.workspaceId] ?? 0
        )
        removedChatIDs[instanceId]?.remove(chat.id)
        return true
    }

    func loadChatSummaries(instanceId: String, includingRemoved: Bool = false) -> SummarySnapshot? {
        if let snapshot = admittedSummaries[instanceId] {
            return .init(summaries: includingRemoved ? snapshot.summaries : snapshot.summaries.filter { !isChatHidden(instanceId: instanceId, chatId: $0.id) }, nextCursor: snapshot.nextCursor)
        }
        guard (chatPurgeGenerations[instanceId] ?? 0) == 0 else { return nil }
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

    func summaryState(instanceId: String) -> (snapshot: SummarySnapshot?, fullToken: UInt64, rowTokens: [String: UInt64]) {
        (loadChatSummaries(instanceId: instanceId), summaryFullTokens[instanceId] ?? 0, summaryRowTokens[instanceId] ?? [:])
    }

    @discardableResult
    func saveChatSummaries(
        _ snapshot: SummarySnapshot,
        instanceId: String,
        generation: UInt64? = nil,
        writeToken: UInt64,
        preservingCursor: Bool = false,
        changedIDs: Set<String>? = nil,
        editTokens: [String: UInt64]? = nil,
        activityOnlyIDs: Set<String> = []
    ) async throws -> Bool {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId) else { return false }
        var retained = snapshot.summaries.filter {
            !isChatHidden(instanceId: instanceId, chatId: $0.id) && isChatWriteRetained(writeToken, instanceId: instanceId, chatId: $0.id)
        }
        var updatedRows: [String: UInt64]?
        if let changedIDs {
            let changedIDs = changedIDs.filter { (editTokens?[$0] ?? writeToken) >= summaryRowAuthority(instanceId: instanceId, chatId: $0) }
            updatedRows = Dictionary(uniqueKeysWithValues: changedIDs.map { ($0, editTokens?[$0] ?? writeToken) })
            let existing = loadChatSummaries(instanceId: instanceId)?.summaries ?? []
            let changes = retained.filter { changedIDs.contains($0.id) }.compactMap { row -> AidenChatSummary? in
                guard activityOnlyIDs.contains(row.id) else { return row }
                guard var current = existing.first(where: { $0.id == row.id }) else { return nil }
                current.activity = row.activity
                return current
            }
            retained = AidenChatSummaryPage.merged(current: existing.filter { !changedIDs.contains($0.id) }, appending: changes)
        }
        var nextCursor = preservingCursor ? (loadChatSummaries(instanceId: instanceId).map(\.nextCursor) ?? snapshot.nextCursor) : snapshot.nextCursor
        let partial = metadataWriteIsPartial(writeToken, instanceId: instanceId)
        if partial {
            // A cleanup-era page only upserts rows it still owns onto the
            // current snapshot, so it is admitted as row updates: a newer
            // detail projection of another row neither loses to it nor
            // rejects its unrelated rows.
            let cached = loadChatSummaries(instanceId: instanceId)
            if updatedRows == nil {
                retained = retained.filter { writeToken >= summaryRowAuthority(instanceId: instanceId, chatId: $0.id) }
                updatedRows = Dictionary(retained.map { ($0.id, writeToken) }, uniquingKeysWith: { first, _ in first })
            }
            retained = AidenChatSummaryPage.merged(current: cached?.summaries ?? [], appending: retained)
            if let cached { nextCursor = cached.nextCursor }
        }
        if updatedRows?.isEmpty == true { return true }
        let acceptedSnapshot = SummarySnapshot(summaries: retained, nextCursor: nextCursor)
        do {
            return try persistChatSummaries(acceptedSnapshot, instanceId: instanceId, generation: partial ? nil : generation, writeToken: writeToken, updatedRows: updatedRows)
        } catch {
            // A validated, admitted page remains usable when only disk IO fails.
            if admittedSummaries[instanceId] == acceptedSnapshot, updatedRows != nil || summaryWriteTokens[instanceId] == writeToken { return true }
            throw error
        }
    }

    @discardableResult
    private func persistChatSummaries(_ snapshot: SummarySnapshot, instanceId: String, generation: UInt64? = nil, writeToken: UInt64, isRemoval: Bool = false, updatedRows: [String: UInt64]? = nil) throws -> Bool {
        guard updatedRows != nil || writeToken >= (summaryWriteTokens[instanceId] ?? 0) else { return false }
        guard snapshot.summaries.count <= maxSummaryCacheItems else {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        guard snapshot.summaries.allSatisfy(AidenChatSummary.isValidCachedProjection) else {
            throw AidenRemoteContractError.invalidJSON
        }
        let envelope = ChatSummaryEnvelope(instanceId: instanceId, snapshot: CachedSummarySnapshot(snapshot))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard try encoder.encode(envelope).count <= maxSummaryCacheFileBytes else {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        // Model-local generations cannot arbitrate between different Home owners.
        // Removal runs synchronously on this actor. A concurrently reserved
        // HTTP request cannot suppress its durable rewrite before cleanup ends.
        if updatedRows == nil, !isRemoval {
            guard chatWriteClock.admitSummary(writeToken, instanceId: instanceId) else { return false }
        } else { _ = chatWriteClock.admitSummary(writeToken, instanceId: instanceId) }
        if let updatedRows {
            for (id, token) in updatedRows { summaryRowTokens[instanceId, default: [:]][id] = max(token, summaryRowTokens[instanceId]?[id] ?? 0) }
        } else { summaryFullTokens[instanceId] = writeToken }
        summaryWriteTokens[instanceId] = max(writeToken, summaryWriteTokens[instanceId] ?? 0)
        admittedSummaries[instanceId] = snapshot
        try save(envelope, to: fileURL(kind: "summaries", instanceId), maximumBytes: maxSummaryCacheFileBytes)
        return true
    }

    func reconcileChatSummary(_ chat: AidenChat, instanceId: String, writeToken: UInt64) async throws {
        await beforeMetadataWrite?()
        guard metadataWriteIsRetained(writeToken, instanceId: instanceId),
              !isChatHidden(instanceId: instanceId, chatId: chat.id),
              isChatWriteRetained(writeToken, instanceId: instanceId, chatId: chat.id), !chat.isBotChat,
              writeToken >= summaryRowAuthority(instanceId: instanceId, chatId: chat.id) else { return }
        let cached = loadChatSummaries(instanceId: instanceId)
        let existingActivity = cached?.summaries.first(where: { $0.id == chat.id })?.activity ?? .idle
        let summaries = AidenChatSummaryPage.merged(
            current: cached?.summaries ?? [],
            appending: [AidenChatSummary(chat: chat, preservingActivity: existingActivity)]
        )
        try persistChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached?.nextCursor),
            instanceId: instanceId, writeToken: writeToken, updatedRows: [chat.id: writeToken]
        )
    }

    func removeChatSummary(instanceId: String, chatId: String, writeToken: UInt64? = nil, beforeWrite: (@Sendable () -> Void)? = nil) throws {
        // Chat removal keeps its deletion-origin authority: minting a later
        // summary token would reject valid partial Home writes for unrelated
        // rows reserved while cleanup was held. The removal itself persists
        // regardless of newer reservations (isRemoval), and the removed row is
        // already fenced from those writes by its per-chat removal floor.
        let removalToken = writeToken ?? reserveSummaryWrite(instanceId: instanceId)
        guard let cached = loadChatSummaries(instanceId: instanceId, includingRemoved: true) else { return }
        let summaries = cached.summaries.filter { $0.id != chatId }
        guard summaries.count != cached.summaries.count else { return }
        beforeWrite?()
        try persistChatSummaries(
            SummarySnapshot(summaries: summaries, nextCursor: cached.nextCursor),
            instanceId: instanceId, writeToken: removalToken, isRemoval: true, updatedRows: [chatId: removalToken]
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
        admittedChats[instanceId]?.removeValue(forKey: chatId)
        renameTitles[instanceId]?.removeValue(forKey: chatId)
        retiredRenameTitles[instanceId, default: []].insert(chatId)
        try? fileManager.removeItem(at: fileURL(kind: "rename-titles", instanceId, chatId))
        for workspace in Array(admittedWorkspaceLists[instanceId]?.keys ?? Dictionary<String, [AidenChat]>().keys) {
            admittedWorkspaceLists[instanceId]?[workspace]?.removeAll { $0.id == chatId }
            workspaceFetchedTitles[instanceId]?[workspace]?.removeValue(forKey: chatId)
        }
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
        workspaceFetchTokens.removeValue(forKey: instanceId)
        workspaceFetchedTitles.removeValue(forKey: instanceId)
        admittedWorkspaceLists.removeValue(forKey: instanceId)
        summaryWriteTokens.removeValue(forKey: instanceId)
        admittedSummaries.removeValue(forKey: instanceId)
        summaryFullTokens.removeValue(forKey: instanceId)
        summaryRowTokens.removeValue(forKey: instanceId)
        chatWriteGenerations.removeValue(forKey: instanceId)
        committedChatWrites.removeValue(forKey: instanceId)
        admittedChats.removeValue(forKey: instanceId)
        renameTitles.removeValue(forKey: instanceId)
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
        purgeFiles(root: cacheRoot, kind: "rename-titles", instanceId: instanceId, as: RenameTitle.self) { $0.instanceId }
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
            // remove them without touching another desktop's cache.
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
