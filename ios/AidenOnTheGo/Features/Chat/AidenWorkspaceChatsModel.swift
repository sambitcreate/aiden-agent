import Foundation
import Observation

/// One workspace's chats, on the machine that owns it. Workspace ids repeat across
/// machines (`"default"` is on every one), so the owner, not the id, says which.
@MainActor
@Observable
final class AidenWorkspaceChatsModel {
    private var presentationGenerations: [String: UInt64] = [:]
    private let coordinator: AidenRemoteCoordinator
    /// The workspace's machine. Nil follows the selected machine, as the old shell does.
    private let owner: AidenRemoteRequestContext?
    private let workspaceId: String
    private let cache: AidenChatCache
    private let hapticScope: UUID
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    private let onChatRemoved: @MainActor (String) -> Void
    private(set) var chats: [AidenChat] = []
    private(set) var isLoading = false
    private(set) var isMutating = false
    var presentedError: String?

    init(
        coordinator: AidenRemoteCoordinator,
        owner: AidenRemoteRequestContext? = nil,
        workspaceId: String,
        hapticScope: UUID = UUID(),
        cache: AidenChatCache = .shared,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        self.owner = owner
        self.workspaceId = workspaceId
        self.hapticScope = hapticScope
        self.cache = cache
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
    }

    var isConnected: Bool {
        guard let owner else { return coordinator.connectionState == .connected }
        return coordinator.hosts.connection(for: owner.instanceId)?.connectionState == .connected
    }

    /// The owner's context while it's live, else the selected machine's.
    private func requestContext() throws -> AidenRemoteRequestContext {
        guard let owner else { return try coordinator.requestContext() }
        guard coordinator.isLive(owner) else { throw AidenRemoteClientError.installationChanged }
        return owner
    }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func accept(_ chat: AidenChat) {
        guard chat.workspaceId == workspaceId, !chat.isBotChat else { return }
        upsert(chat)
    }

    func load() async {
        guard let context = try? requestContext() else { return }
        let instanceId = context.instanceId
        let metadataWriteToken = cache.reserveChatWrite()
        if chats.isEmpty, let cached = await cache.admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId) {
            guard coordinator.holds(context) else { return }
            var presented: [AidenChat] = []
            for row in AidenChat.regularWorkspaceChats(from: cached) {
                if let current = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: row.id) { presented.append(current) }
            }
            guard coordinator.holds(context) else { return }
            chats = Self.sorted(presented)
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let remote = try await coordinator.remoteClient(for: context).chats(workspaceId: workspaceId)
            guard coordinator.holds(context) else { return }
            // Commit before publishing: a held list response may have lost to a
            // detail owner, another list, or removal while HTTP was in flight.
            do {
                try await cache.saveChats(AidenChat.regularWorkspaceChats(from: remote), instanceId: instanceId, workspaceId: workspaceId, writeToken: metadataWriteToken, isAuthoritativeFetch: true)
            } catch {
                // Admission precedes IO; preserve the in-memory winner on disk failure.
            }
            let admitted = await cache.admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId)
            guard coordinator.holds(context) else { return }
            var presented: [AidenChat] = []
            for row in AidenChat.regularWorkspaceChats(from: admitted ?? []) {
                if let current = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: row.id) { presented.append(current) }
            }
            guard coordinator.holds(context) else { return }
            chats = Self.sorted(presented)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.holds(context) else { return }
            if chats.isEmpty { presentedError = error.localizedDescription }
        }
    }

    func create() async -> AidenChat? {
        guard !isMutating, let context = try? requestContext() else { return nil }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        do {
            let chat = try await coordinator.remoteClient(for: context).createChat(workspaceId: workspaceId)
            guard coordinator.holds(context) else { return nil }
            guard !chat.isBotChat else {
                presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                return nil
            }
            guard let admitted = await persist(chat: chat, instanceId: instanceId, context: context), coordinator.holds(context) else { return nil }
            onChatUpdated(admitted)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-create:\(chat.id):\(chat.revision)")
            return admitted
        } catch let error where aidenIsCancellation(error) {
            return nil
        } catch {
            guard coordinator.holds(context) else { return nil }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            return nil
        }
    }

    private func refreshRenameSnapshot(chatId: String, context: AidenRemoteRequestContext) async throws -> AidenChat {
        let token = cache.reserveChatWrite()
        let remote = try await coordinator.remoteClient(for: context).chat(id: chatId)
        guard coordinator.holds(context), remote.id == chatId, remote.workspaceId == workspaceId, !remote.isBotChat else { throw CancellationError() }
        guard try await cache.saveFetchedChat(remote, instanceId: context.instanceId, writeToken: token) else { throw CancellationError() }
        guard coordinator.holds(context),
              let current = await cache.admittedChat(instanceId: context.instanceId, chatId: chatId),
              !(await cache.needsRenameRefresh(instanceId: context.instanceId, chatId: chatId)) else { throw CancellationError() }
        return current
    }

    func rename(_ chat: AidenChat, to title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !isMutating, let context = try? requestContext() else { return }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        // The new title shows in this list at once, as a local override the
        // admitted receipt replaces; Recents and the open chat take the receipt,
        // since only an admitted write may be published. A failed PATCH puts the
        // stored row back unless another owner published since.
        var optimistic = chat
        optimistic.localTitleOverride = cleaned
        upsert(optimistic)
        let optimisticGeneration = presentationGenerations[chat.id] ?? 0
        let rollBackTitle = { [self] in
            guard coordinator.holds(context), optimisticGeneration == (presentationGenerations[chat.id] ?? 0) else { return }
            upsert(chat)
        }
        do {
            let canonical: AidenChat
            let pendingRename = await cache.needsRenameRefresh(instanceId: instanceId, chatId: chat.id)
            if pendingRename || chat.localTitleOverride != nil {
                canonical = try await refreshRenameSnapshot(chatId: chat.id, context: context)
            } else { canonical = chat }
            guard coordinator.holds(context) else { return }
            let origin = cache.reserveChatWrite()
            let generation = presentationGenerations[chat.id] ?? 0
            let updated = try await coordinator.remoteClient(for: context).updateChat(
                id: chat.id, revision: canonical.revision, title: cleaned
            )
            guard coordinator.holds(context) else { return }
            guard updated.id == chat.id, updated.workspaceId == workspaceId, !updated.isBotChat else {
                rollBackTitle()
                return
            }
            let receiptCutoff = cache.reserveChatWrite()
            guard let admitted = await cache.acceptRename(updated, instanceId: instanceId, origin: origin, cutoff: receiptCutoff) else {
                if coordinator.holds(context), generation == (presentationGenerations[chat.id] ?? 0) {
                    chats.removeAll { $0.id == chat.id }
                    presentationGenerations[chat.id, default: 0] &+= 1
                    onChatRemoved(chat.id)
                }
                return
            }
            guard coordinator.holds(context) else { return }
            guard await cache.reconcileWorkspaceChat(admitted, instanceId: instanceId, authority: origin, cutoff: receiptCutoff) else { return }
            let publicationGeneration = presentationGenerations[chat.id] ?? 0
            guard let presentation = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: chat.id) else { return }
            guard coordinator.holds(context), publicationGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
            upsert(presentation)
            onChatUpdated(presentation)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-rename:\(updated.id):\(updated.revision)")
            // A failed read must not roll back a successful mutation or replay PATCH.
            let refreshGeneration = presentationGenerations[chat.id] ?? 0
            do {
                let refreshed = try await refreshRenameSnapshot(chatId: chat.id, context: context)
                guard coordinator.holds(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0) else { return }
                guard await cache.reconcileWorkspaceChat(refreshed, instanceId: instanceId, authority: origin, cutoff: receiptCutoff) else { return }
                guard coordinator.holds(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
                guard let presentation = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: chat.id) else { return }
                guard coordinator.holds(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
                upsert(presentation)
                onChatUpdated(presentation)
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
            }
        } catch let error where aidenIsCancellation(error) {
            rollBackTitle()
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.holds(context) else { return }
            rollBackTitle()
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    func remove(_ chat: AidenChat) async {
        guard !isMutating, let context = try? requestContext() else { return }
        let instanceId = context.instanceId
        let metadataWriteToken = cache.reserveChatWrite()
        isMutating = true
        defer { isMutating = false }
        presentationGenerations[chat.id, default: 0] &+= 1
        chats.removeAll { $0.id == chat.id }
        // The row leaves this list and Recents at once; a failed DELETE puts it back.
        onChatRemoved(chat.id)
        do {
            let canonical: AidenChat
            let pendingRename = await cache.needsRenameRefresh(instanceId: instanceId, chatId: chat.id)
            if pendingRename || chat.localTitleOverride != nil {
                canonical = try await refreshRenameSnapshot(chatId: chat.id, context: context)
            } else { canonical = chat }
            guard coordinator.holds(context) else { return }
            try await coordinator.remoteClient(for: context).removeChat(id: chat.id, revision: canonical.revision)
            guard coordinator.holds(context) else { return }
            await cache.removeChat(instanceId: instanceId, chatId: chat.id)
            await AidenChatDraftStore.shared.remove(instanceId: instanceId, chatId: chat.id)
            try? await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId, writeToken: metadataWriteToken)
            onChatRemoved(chat.id)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-remove:\(chat.id):\(chat.revision)")
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.holds(context) else { return }
            upsert(chat)
            onChatUpdated(chat)
        } catch {
            guard coordinator.holds(context) else { return }
            upsert(chat)
            onChatUpdated(chat)
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
        }
    }

    private func upsert(_ chat: AidenChat) {
        guard !chat.isBotChat else { return }
        presentationGenerations[chat.id, default: 0] &+= 1
        chats.removeAll { $0.id == chat.id }
        chats.append(chat)
        chats = Self.sorted(chats)
    }

    private func persist(chat: AidenChat, instanceId: String, context: AidenRemoteRequestContext) async -> AidenChat? {
        let generation = presentationGenerations[chat.id] ?? 0
        let writeToken = cache.reserveChatWrite()
        do {
            guard try await cache.saveChat(chat, instanceId: instanceId, writeToken: writeToken) else {
                // The winner is admitted in memory even if its disk write failed.
                guard let current = await cache.admittedChat(instanceId: instanceId, chatId: chat.id),
                      current.workspaceId == workspaceId, !current.isBotChat else {
                    if coordinator.holds(context), generation == (presentationGenerations[chat.id] ?? 0) {
                        presentationGenerations[chat.id, default: 0] &+= 1
                        chats.removeAll { $0.id == chat.id }
                        onChatRemoved(chat.id)
                    }
                    return nil
                }
                // The winner may be detail-only (or its file write failed), so
                // keep the created row in the durable list for a cold reopen.
                await cache.admitCreatedWorkspaceChat(chatId: chat.id, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
                guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
                upsert(current)
                return current
            }
        } catch {
            // Disk failure remains best-effort; a normal fence rejection above
            // instead means another owner invalidated this snapshot. The detail
            // was admitted in memory, so still keep its list row durable.
            await cache.admitCreatedWorkspaceChat(chatId: chat.id, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
            guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
            upsert(chat)
            return chat
        }
        guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
        upsert(chat)
        let publicationGeneration = presentationGenerations[chat.id] ?? 0
        do {
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
            try await cache.reconcileChatSummary(chat, instanceId: instanceId, writeToken: writeToken)
        } catch {}
        if publicationGeneration == (presentationGenerations[chat.id] ?? 0) {
            upsert(chat)
            return chat
        }
        return chats.first { $0.id == chat.id }
    }

    private static func sorted(_ chats: [AidenChat]) -> [AidenChat] {
        chats.sorted {
            if $0.updatedAt == $1.updatedAt { return $0.id < $1.id }
            return $0.updatedAt > $1.updatedAt
        }
    }
}
