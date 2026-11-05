import SwiftUI

@MainActor
@Observable
final class AidenHomeModel {
    private struct LoadAttempt: Equatable {
        let id = UUID()
        let context: AidenRemoteRequestContext
    }

    enum ChatListLoadState: Equatable {
        case unresolved
        case loading
        case loaded
        case failed(String)
    }

    enum PaginationState: Equatable {
        case idle
        case loading
        case failed(String)
    }

    var chats: [AidenChatSummary] = []
    var scheduledTasks: [AidenScheduledTask] = []
    var usage: AidenUsageSummary?
    /// The last Usage read failed with nothing saved to show.
    var usageLoadFailed = false
    var modelCatalog: AidenModelCatalog?
    var isLoading = false
    var errorMessage: String?
    var chatListLoadState: ChatListLoadState = .unresolved
    var paginationState: PaginationState = .idle
    private(set) var nextChatCursor: String?
    private var contentContext: AidenRemoteRequestContext?
    private var loadingAttempt: LoadAttempt?
    private let chatCache: AidenChatCache
    private var summaryCacheGeneration: UInt64 = 0
    private var latestSummaryRequestToken: UInt64 = 0
    private var persistedLocalGeneration: UInt64 = 0
    /// Rows changed here and not yet on a page. `readThrough` is set for a
    /// Mark read: the newest reply it covers. A page row with a newer reply
    /// is not covered by it, so that page row is shown instead.
    private var localSummaryEdits: [String: (generation: UInt64, token: UInt64, summary: AidenChatSummary?, activityOnly: Bool, readThrough: AidenChatInboxSignals?, triageOnly: Bool, wholeGeneration: UInt64)] = [:]
    private var prefetchTask: Task<Void, Never>?
    /// Changes each time a chat is viewed: a chat viewed while a swipe's
    /// write was out has been read, so a refusal never brings its dot back.
    private var viewStamps: [String: UInt64] = [:]
    private var viewClock: UInt64 = 0

    init(chatCache: AidenChatCache = .shared) {
        self.chatCache = chatCache
    }

    var chatLoadErrorMessage: String? {
        guard case .failed(let message) = chatListLoadState else { return nil }
        return message
    }

    /// Accepts a chat the user is viewing, so its row is read by definition.
    func accept(_ chat: AidenChat) {
        guard !chat.isBotChat else { return }
        stampViewed(chat.id)
        let existing = chats.first(where: { $0.id == chat.id })
        chats.removeAll { $0.id == chat.id }
        var summary = AidenChatSummary(chat: chat, preservingActivity: existing?.activity ?? .idle)
        summary.rowState = existing?.rowState
        summary.unread = false
        summary.lastRunFailed = existing?.lastRunFailed ?? false
        if let existing { summary.inbox = existing.inbox.admitting(chat) }
        chats.append(summary)
        chats.sort(by: AidenChatSummaryPage.areInCanonicalOrder)
        persistCurrentSummaries(changedID: chat.id)
    }

    func setActivity(_ activity: AidenChatSummaryActivity, forChatID chatID: String) {
        guard let index = chats.firstIndex(where: { $0.id == chatID }),
              chats[index].activity != activity else { return }
        chats[index].activity = activity
        persistCurrentSummaries(changedID: chatID, activityOnly: true)
    }

    /// Clear a row's unread marker as soon as the user opens it.
    func markViewed(chatID: String) {
        stampViewed(chatID)
        guard let index = chats.firstIndex(where: { $0.id == chatID }),
              chats[index].unread else { return }
        chats[index].unread = false
        persistCurrentSummaries(changedID: chatID)
    }

    private func stampViewed(_ chatID: String) {
        viewClock &+= 1
        viewStamps[chatID] = viewClock
    }

    private func viewStamp(_ chatID: String) -> UInt64 { viewStamps[chatID] ?? 0 }

    /// The Inbox banner after a swipe action: a rollback explanation, or
    /// a confirmation that can undo the change.
    var inboxNotice: AidenInboxNotice?

    /// The banner VoiceOver last heard, so one shown again (the overlay
    /// rebuilt after navigating back) is not announced twice.
    var announcedInboxNoticeID: UUID?

    /// Mark read from a swipe. The dot clears at once and comes back with a
    /// banner if the Mac refuses. A Mac without read markers gets no write.
    func markRead(chatID: String, coordinator: AidenRemoteCoordinator) async {
        guard coordinator.server?.supportsChatReadState == true,
              let index = chats.firstIndex(where: { $0.id == chatID }), chats[index].unread,
              let context = try? coordinator.requestContext() else { return }
        let before = chats[index]
        let supportsMessagesWindow = coordinator.server?.features.contains(AidenServer.chatMessagesWindowFeature) == true
        let viewed = viewStamp(chatID)
        chats[index].unread = false
        chats[index].inbox.invalidateHostPlacement()
        let optimistic = chats[index]
        persistCurrentSummaries(changedID: chatID, readThrough: optimistic.inbox)
        do {
            try await coordinator.remoteClient(for: context).markInboxRead(through: before, supportsMessagesWindow: supportsMessagesWindow)
        } catch {
            await rollBack(chatID: chatID, optimistic: optimistic, before: before, viewed: viewed, context: context, coordinator: coordinator)
            guard coordinator.isCurrent(context) else { return }
            inboxNotice = AidenInboxNotice(message: String(localized: "Couldn’t mark that chat read. Try again once your Mac is reachable."))
            return
        }
        settleRead(chatID: chatID, readThrough: optimistic, context: context, coordinator: coordinator)
    }

    /// The Mac took a read: record it again as a new edit, so a list page
    /// requested while the read was out (which still says unread) doesn't
    /// bring the dot back, whether that page landed already or is still on
    /// its way. A row with output newer than `readThrough` keeps its dot:
    /// the read didn't cover it.
    private func settleRead(
        chatID: String,
        readThrough: AidenChatSummary,
        settledTriage: ((AidenChatSummary) -> AidenChatSummary)? = nil,
        context: AidenRemoteRequestContext,
        coordinator: AidenRemoteCoordinator
    ) {
        guard coordinator.isCurrent(context), contentContext == context,
              let index = chats.firstIndex(where: { $0.id == chatID }) else { return }
        if let settledTriage { chats[index] = settledTriage(chats[index]) }
        if readThrough.inbox.coversReply(in: chats[index].inbox), chats[index].unread {
            chats[index].unread = false
            chats[index].inbox.invalidateHostPlacement()
        }
        let boundary = readThrough.inbox
        if loadingAttempt == nil {
            persistCurrentSummaries(changedID: chatID, readThrough: boundary)
        } else {
            // A list page is on its way. Saving now would take the cache's
            // authority from that page and lose its other rows, so the read
            // is only recorded here and `load` lays it over the page's row.
            localSummaryEdits[chatID] = (nextSummaryCacheGeneration(), localSummaryEdits[chatID]?.token ?? 0, chats[index], false, boundary, localSummaryEdits[chatID]?.triageOnly ?? false, localSummaryEdits[chatID]?.wholeGeneration ?? 0)
        }
    }

    /// Done, Snooze or their undo. The row moves at once; a refusal puts back
    /// what the write changed with a banner, and a stale revision is sent
    /// once more from the host's revision before it counts as a refusal. A
    /// write that landed on that retry offers no Undo, since `before` may no
    /// longer be what the host held (the desktop never retries). Undo passes
    /// `undoRevision`, the revision its swipe's write left
    /// (`AidenInboxNotice.revision`), and is sent against that rather than
    /// the row's current revision, which a reload may have moved on. It is
    /// never retried: a conflict means another device changed the chat
    /// since, and Undo leaves it as it is, as on the desktop. Done or
    /// Snooze on unseen failed output also reads it, as on the desktop, so a
    /// Mac without read markers is sent neither; the read marker is sent even
    /// when the answer arrives after a switch to another Mac.
    @discardableResult
    func setTriage(
        _ change: AidenChatTriageChange,
        chatID: String,
        coordinator: AidenRemoteCoordinator,
        isOpen: Bool = false,
        now: Date = Date(),
        undoRevision: Int? = nil
    ) async -> Bool {
        let offersUndo = undoRevision == nil
        guard let index = chats.firstIndex(where: { $0.id == chatID }),
              let context = try? coordinator.requestContext() else { return false }
        let before = chats[index]
        let supportsMessagesWindow = coordinator.server?.features.contains(AidenServer.chatMessagesWindowFeature) == true
        let viewed = viewStamp(chatID)
        let alsoMarkRead = change.hidesRow && AidenInbox.alsoMarksRead(before, isOpen: isOpen)
        if alsoMarkRead, coordinator.server?.supportsChatReadState != true { return false }
        let optimistic = AidenInbox.applyingOptimisticTriage(change, to: before, now: now, alsoMarkRead: alsoMarkRead)
        chats[index] = optimistic
        persistCurrentSummaries(changedID: chatID, triageOnly: true, readThrough: alsoMarkRead ? before.inbox : nil)
        inboxNotice = nil
        let client: AidenRemoteClient
        let result: AidenChatTriageResult
        let retried: Bool
        do {
            client = try coordinator.remoteClient(for: context)
            (result, retried) = try await sendTriage(
                change,
                chatID: chatID,
                ifRevision: undoRevision ?? before.inbox.triageRevision ?? 0,
                retriesConflict: offersUndo,
                client: client,
                context: context,
                coordinator: coordinator
            )
        } catch {
            await rollBack(chatID: chatID, optimistic: optimistic, before: before, viewed: viewed, triageOnly: true, context: context, coordinator: coordinator)
            guard coordinator.isCurrent(context) else { return false }
            let conflict = (error as? AidenRemoteClientError)?.isRevisionConflict == true
            inboxNotice = AidenInboxNotice(message: !conflict
                ? String(localized: "Couldn’t update that chat. It’s back where it was.")
                : offersUndo
                ? String(localized: "That chat changed on another device. The Inbox is up to date now.")
                : String(localized: "That chat changed since, so Undo left it as it is."))
            if conflict { await load(coordinator: coordinator) }
            return false
        }
        func isShown() -> Bool { coordinator.isCurrent(context) && contentContext == context }
        let settled: @Sendable (AidenChatSummary) -> AidenChatSummary = { row in
            var row = row
            guard (row.inbox.triageRevision ?? 0) < result.revision else { return row }
            row.inbox.pinnedAt = result.pinnedAt
            row.inbox.doneAt = result.doneAt
            row.inbox.snoozedUntil = result.snoozedUntil
            row.inbox.triageRevision = result.revision > 0 ? result.revision : nil
            // A bucket the host reported before this write no longer describes the row.
            row.inbox.invalidateHostPlacement()
            return row
        }
        if isShown() {
            if let index = chats.firstIndex(where: { $0.id == chatID }) {
                chats[index] = settled(chats[index])
                persistCurrentSummaries(changedID: chatID, triageOnly: true, readThrough: alsoMarkRead ? before.inbox : nil)
                if offersUndo, !retried, let undo = AidenInbox.undo(of: change, before: before, now: now) {
                    inboxNotice = AidenInboxNotice(message: change.confirmation, undo: undo, chatID: chatID, revision: result.revision)
                }
            }
        } else {
            // The Mac it was sent to is no longer shown: its saved row takes
            // the answer, so it doesn't keep the old revision.
            await updateSavedRow(chatID: chatID, instanceId: context.instanceId, settled)
        }
        if alsoMarkRead {
            // Sent with the write's own client: the Mac took Done, so it
            // should also take the read, whichever Mac is shown now.
            do {
                try await client.markInboxRead(through: before, supportsMessagesWindow: supportsMessagesWindow)
                settleRead(chatID: chatID, readThrough: optimistic, settledTriage: settled, context: context, coordinator: coordinator)
            } catch {
                if viewStamp(chatID) == viewed {
                    let wasUnread = before.unread
                    if !isShown() {
                        await updateSavedRow(chatID: chatID, instanceId: context.instanceId) { row in
                            var row = row
                            if !row.unread { row.unread = wasUnread }
                            return row
                        }
                    } else if let index = chats.firstIndex(where: { $0.id == chatID }), !chats[index].unread {
                        chats[index].unread = wasUnread
                        persistCurrentSummaries(changedID: chatID)
                    }
                }
            }
        }
        return true
    }

    /// One triage write, sent once more from the host's revision when another
    /// device changed the chat's triage first (unless `retriesConflict` is
    /// false, as for Undo), as the desktop's rename does.
    private func sendTriage(
        _ change: AidenChatTriageChange,
        chatID: String,
        ifRevision: Int,
        retriesConflict: Bool,
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext,
        coordinator: AidenRemoteCoordinator
    ) async throws -> (AidenChatTriageResult, retried: Bool) {
        do {
            return (try await client.setChatTriage(chatId: chatID, change: change, ifRevision: ifRevision), false)
        } catch let error as AidenRemoteClientError {
            guard retriesConflict, let current = error.conflictingRevision, coordinator.isCurrent(context) else { throw error }
            return (try await client.setChatTriage(chatId: chatID, change: change, ifRevision: current, idempotencyKey: UUID()), true)
        }
    }

    /// Puts back what a refused write changed. After a switch to another Mac
    /// the old Mac's saved row is put back instead, so it isn't left showing
    /// a write that never landed. A chat viewed since the write began keeps
    /// its dot off.
    private func rollBack(
        chatID: String,
        optimistic: AidenChatSummary,
        before: AidenChatSummary,
        viewed: UInt64,
        triageOnly: Bool = false,
        context: AidenRemoteRequestContext,
        coordinator: AidenRemoteCoordinator
    ) async {
        let restoresUnread = viewStamp(chatID) == viewed
        if coordinator.isCurrent(context), contentContext == context {
            guard let index = chats.firstIndex(where: { $0.id == chatID }) else { return }
            let restored = AidenInbox.rollingBack(chats[index], optimistic: optimistic, before: before, restoresUnread: restoresUnread)
            guard restored != chats[index] else { return }
            chats[index] = restored
            persistCurrentSummaries(changedID: chatID, triageOnly: triageOnly)
            return
        }
        await updateSavedRow(chatID: chatID, instanceId: context.instanceId) {
            AidenInbox.rollingBack($0, optimistic: optimistic, before: before, restoresUnread: restoresUnread)
        }
    }

    /// Changes a Mac's saved row while another Mac is shown.
    private func updateSavedRow(
        chatID: String,
        instanceId: String,
        _ update: @escaping @Sendable (AidenChatSummary) -> AidenChatSummary
    ) async {
        let writeToken = chatCache.reserveSummaryWrite(instanceId: instanceId)
        try? await chatCache.updateChatSummary(id: chatID, instanceId: instanceId, writeToken: writeToken, update)
    }

    func removeChat(id: String) {
        guard chats.contains(where: { $0.id == id }) else { return }
        chats.removeAll { $0.id == id }
        persistCurrentSummaries(changedID: id)
    }

    private func persistCurrentSummaries(changedID: String, activityOnly: Bool = false, triageOnly: Bool = false, readThrough: AidenChatInboxSignals? = nil) {
        guard let context = contentContext else { return }
        let snapshot = AidenChatCache.SummarySnapshot(summaries: chats, nextCursor: nextChatCursor)
        let generation = nextSummaryCacheGeneration()
        let writeToken = chatCache.reserveSummaryWrite(instanceId: context.instanceId)
        let pending = localSummaryEdits[changedID]
        let onlyActivity = activityOnly && !(pending.map { $0.generation > persistedLocalGeneration && !$0.activityOnly } ?? false)
        localSummaryEdits[changedID] = (generation, writeToken, chats.first(where: { $0.id == changedID }), onlyActivity, readThrough, triageOnly, !activityOnly && !triageOnly && readThrough == nil ? generation : pending?.wholeGeneration ?? 0)
        let editTokens = localSummaryEdits.filter { $0.value.generation > persistedLocalGeneration }.mapValues(\.token)
        let changedIDs = Set(editTokens.keys)
        let activityOnlyIDs = Set(localSummaryEdits.filter { $0.value.activityOnly && changedIDs.contains($0.key) }.keys)
        Task {
            let accepted = try? await chatCache.saveChatSummaries(
                snapshot,
                instanceId: context.instanceId,
                generation: generation, writeToken: writeToken, preservingCursor: true, changedIDs: changedIDs, editTokens: editTokens, activityOnlyIDs: activityOnlyIDs
            )
            if accepted == true, contentContext == context {
                persistedLocalGeneration = max(persistedLocalGeneration, generation)
            }
        }
    }

    private func nextSummaryCacheGeneration() -> UInt64 {
        summaryCacheGeneration &+= 1
        return summaryCacheGeneration
    }

    func acceptInitialChatSummaryPage(_ page: AidenChatSummaryPage) {
        chats = page.summaries
        nextChatCursor = page.nextCursor
        paginationState = .idle
    }

    func acceptChatSummaryContinuation(
        _ page: AidenChatSummaryPage,
        requestedCursor: String,
        instanceId: String,
        writeToken: UInt64,
        isCurrent: @MainActor () -> Bool = { true }
    ) async throws {
        guard nextChatCursor == requestedCursor, isCurrent() else { throw CancellationError() }
        let admitted = await chatCache.loadChatSummaries(instanceId: instanceId)
        guard isCurrent(), nextChatCursor == requestedCursor else { throw CancellationError() }
        if let admitted, admitted.nextCursor != requestedCursor { throw CancellationError() }
        let validated: [AidenChatSummary]
        do {
            validated = try AidenChatSummaryPage.validatedContinuation(
                current: admitted?.summaries ?? chats,
                requestedCursor: requestedCursor,
                page: page
            )
        } catch {
            paginationState = .failed(error.localizedDescription)
            throw error
        }
        let snapshot = AidenChatCache.SummarySnapshot(
            summaries: validated,
            nextCursor: page.nextCursor
        )
        let generation = nextSummaryCacheGeneration()
        do {
            guard try await chatCache.saveChatSummaries(
                snapshot,
                instanceId: instanceId,
                generation: generation, writeToken: writeToken
            ) else { throw CancellationError() }
        } catch {
            paginationState = .failed(error.localizedDescription)
            throw error
        }
        let state = await chatCache.summaryState(instanceId: instanceId)
        guard isCurrent() else { throw CancellationError() }
        // Publish the actual admitted page, including partial-deletion filtering
        // and any newer cross-owner detail updates that followed admission.
        chats = state.snapshot?.summaries ?? []
        for (id, edit) in localSummaryEdits where edit.token > max(state.fullToken, state.rowTokens[id] ?? 0) {
            if edit.triageOnly, let index = chats.firstIndex(where: { $0.id == id }), let row = edit.summary {
                if (row.inbox.triageRevision ?? 0) >= (chats[index].inbox.triageRevision ?? 0) {
                    chats[index].inbox.pinnedAt = row.inbox.pinnedAt
                    chats[index].inbox.doneAt = row.inbox.doneAt
                    chats[index].inbox.snoozedUntil = row.inbox.snoozedUntil
                    chats[index].inbox.triageRevision = row.inbox.triageRevision
                    chats[index].inbox.invalidateHostPlacement()
                }
                if let boundary = edit.readThrough, boundary.coversReply(in: chats[index].inbox) { chats[index].unread = false }
            } else if edit.activityOnly {
                if let index = chats.firstIndex(where: { $0.id == id }), let row = edit.summary { chats[index].activity = row.activity }
            } else {
                chats.removeAll { $0.id == id }
                if let row = edit.summary { chats.append(row) }
            }
        }
        chats.sort(by: AidenChatSummaryPage.areInCanonicalOrder)
        nextChatCursor = state.snapshot?.nextCursor
        paginationState = .idle
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        // Saved Recents are read whatever the connection state, so a cold
        // launch shows them while the Mac is still being reached.
        guard let context = try? coordinator.requestContext() else { return }
        let isConnected = coordinator.connectionState == .connected
        let requestEditGeneration = summaryCacheGeneration
        let plan = AidenHomeLoadPlan(installation: coordinator.installationStore.activeInstallation)
        let writeToken = isConnected && plan.loadsChats
            ? chatCache.reserveSummaryWrite(instanceId: context.instanceId)
            : 0
        if isConnected && plan.loadsChats { latestSummaryRequestToken = writeToken }
        let hydrationToken = latestSummaryRequestToken
        let attempt = LoadAttempt(context: context)
        if contentContext != context {
            contentContext = context
            summaryCacheGeneration &+= 1
            localSummaryEdits = [:]
            // A banner and its Undo belong to the Mac they came from.
            inboxNotice = nil
            persistedLocalGeneration = 0
            chats = []
            nextChatCursor = nil
            paginationState = .idle
            chatListLoadState = .unresolved
            errorMessage = nil
            scheduledTasks = []
            usage = nil
            usageLoadFailed = false
            modelCatalog = nil
            if plan.loadsChats,
               let cached = await chatCache.loadChatSummaries(instanceId: context.instanceId),
               coordinator.isCurrent(context), contentContext == context,
               latestSummaryRequestToken == hydrationToken {
                chats = cached.summaries
                nextChatCursor = cached.nextCursor
            }
        }
        if !plan.loadsChats {
            chats = []
            nextChatCursor = nil
            paginationState = .idle
            modelCatalog = nil
            chatListLoadState = .loaded
        }
        if !plan.loadsScheduledTasks { scheduledTasks = [] }
        if !plan.loadsUsage { usage = nil; usageLoadFailed = false }
        guard isConnected else { return }
        guard !plan.loadsChats || latestSummaryRequestToken == writeToken else { return }
        loadingAttempt = attempt
        isLoading = true
        errorMessage = nil
        usageLoadFailed = false
        if plan.loadsChats { chatListLoadState = .loading }
        defer {
            if loadingAttempt == attempt {
                loadingAttempt = nil
                isLoading = false
            }
        }
        do {
            let client = try coordinator.remoteClient(for: context)
            let advertisesChatSummaries = coordinator.server?.supportsChatSummaries == true
            async let chatsRequest = aidenLoadHomeSegment(enabled: plan.loadsChats) {
                try await client.preferredChatSummaries(
                    advertised: advertisesChatSummaries
                )
            }
            async let tasksRequest = aidenLoadHomeSegment(enabled: plan.loadsScheduledTasks) {
                try await client.scheduledTasks()
            }
            async let catalogRequest = aidenLoadHomeSegment(enabled: plan.loadsModelCatalog) {
                try await client.modelCatalog()
            }
            async let usageRequest = aidenLoadHomeSegment(enabled: plan.loadsUsage) {
                try await client.usage()
            }
            let (chatsResult, tasksResult, catalogResult, usageResult) = try await (
                chatsRequest,
                tasksRequest,
                catalogRequest,
                usageRequest
            )
            guard loadingAttempt == attempt, coordinator.isCurrent(context) else { return }
            var failures: [Error] = []
            switch chatsResult {
            case .success(let loadedPage):
                if let loadedPage {
                    let snapshot = AidenChatCache.SummarySnapshot(
                        summaries: loadedPage.summaries,
                        nextCursor: loadedPage.nextCursor
                    )
                    let generation = nextSummaryCacheGeneration()
                    do {
                        _ = try await chatCache.saveChatSummaries(
                            snapshot,
                            instanceId: context.instanceId,
                            generation: generation, writeToken: writeToken
                        )
                        let state = await chatCache.summaryState(instanceId: context.instanceId)
                        let admitted = state.snapshot

                        guard loadingAttempt == attempt,
                              coordinator.isCurrent(context) else { return }
                        chats = admitted?.summaries ?? []
                        nextChatCursor = admitted?.nextCursor
                        paginationState = .idle
                        // A Mark read made since this page was asked for clears the
                        // page row's dot only for the reply it read through: a
                        // newer reply on the page keeps its dot and the rest of
                        // the page row.
                        var readOverPage: [String] = []
                        for (id, edit) in localSummaryEdits where edit.generation > requestEditGeneration {
                            let editIsNewer = edit.token > max(state.fullToken, state.rowTokens[id] ?? 0)
                            if edit.triageOnly || edit.readThrough != nil {
                                guard var pageRow = loadedPage.summaries.first(where: { $0.id == id }),
                                      let index = chats.firstIndex(where: { $0.id == id }) else { continue }
                                // Keep a newer detail or a write from another home model.
                                if max(state.fullToken, state.rowTokens[id] ?? 0) > max(writeToken, edit.token) {
                                    pageRow = chats[index]
                                }
                                // A detail/view admitted after the request owns its row.
                                // Triage keeps that admission's provenance, but a distinct
                                // reply at the same millisecond is outside its read boundary.
                                if edit.wholeGeneration > requestEditGeneration, let admitted = edit.summary,
                                   admitted.inbox.coversReply(in: pageRow.inbox) {
                                    pageRow = admitted
                                }
                                // A triage or read edit owns its fields. Keep the
                                // page's reply and unrelated metadata.
                                if let local = edit.summary, (local.inbox.triageRevision ?? 0) >= (pageRow.inbox.triageRevision ?? 0) {
                                    pageRow.inbox.pinnedAt = local.inbox.pinnedAt
                                    pageRow.inbox.doneAt = local.inbox.doneAt
                                    pageRow.inbox.snoozedUntil = local.inbox.snoozedUntil
                                    pageRow.inbox.triageRevision = local.inbox.triageRevision
                                    pageRow.inbox.invalidateHostPlacement()
                                }
                                if let readThrough = edit.readThrough, readThrough.coversReply(in: pageRow.inbox), pageRow.unread {
                                    pageRow.unread = false
                                    pageRow.inbox.invalidateHostPlacement()
                                }
                                if chats[index] != pageRow {
                                    chats[index] = pageRow
                                    readOverPage.append(id)
                                }
                                continue
                            }
                            guard editIsNewer else { continue }
                            if edit.activityOnly {
                                if let index = chats.firstIndex(where: { $0.id == id }), let row = edit.summary { chats[index].activity = row.activity }
                            } else {
                                chats.removeAll { $0.id == id }
                                if let row = edit.summary { chats.append(row) }
                            }
                        }
                        chats.sort(by: AidenChatSummaryPage.areInCanonicalOrder)
                        for id in readOverPage {
                            let readThrough = localSummaryEdits[id]?.readThrough
                            persistCurrentSummaries(changedID: id, triageOnly: localSummaryEdits[id]?.triageOnly ?? false, readThrough: readThrough)
                        }
                        chatListLoadState = .loaded
                        prefetchRecentTranscripts(client: client, context: context, coordinator: coordinator)
                    } catch {
                        failures.append(error)
                        chatListLoadState = .failed(error.localizedDescription)
                    }
                }
            case .failure(let error):
                failures.append(error)
                chatListLoadState = .failed(error.localizedDescription)
            }
            switch tasksResult {
            case .success(let loadedTasks):
                if let loadedTasks {
                    scheduledTasks = loadedTasks.sorted {
                        ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture)
                    }
                }
            case .failure(let error): failures.append(error)
            }
            switch catalogResult {
            case .success(let catalog):
                if let catalog { modelCatalog = catalog }
            case .failure(let error): failures.append(error)
            }
            switch usageResult {
            case .success(let loadedUsage):
                if let loadedUsage { usage = loadedUsage }
            case .failure(let error):
                failures.append(error)
                usageLoadFailed = usage == nil
            }
            errorMessage = failures.first?.localizedDescription
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            if loadingAttempt == attempt, coordinator.isCurrent(context) {
                errorMessage = error.localizedDescription
                if plan.loadsChats { chatListLoadState = .failed(error.localizedDescription) }
            }
        }
    }

    static let recentTranscriptPrefetchLimit = 5

    /// A saved transcript for a Recents row, so opening it is immediate.
    func cachedWorkspaceChat(id: String, workspaceId: String, instanceId: String) async -> AidenChat? {
        guard let cached = await chatCache.loadChat(instanceId: instanceId, chatId: id),
              !cached.isBotChat,
              cached.workspaceId == workspaceId else { return nil }
        return await chatCache.presenting(cached, instanceId: instanceId)
    }

    /// Saves the newest few transcripts after Recents refresh, one at a time,
    /// skipping ones already current and doing nothing in Low Data Mode.
    private func prefetchRecentTranscripts(
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext,
        coordinator: AidenRemoteCoordinator
    ) {
        prefetchTask?.cancel()
        guard !AidenNetworkPathMonitor.shared.availability.isConstrained else { return }
        let candidates = Array(chats.prefix(Self.recentTranscriptPrefetchLimit))
        let cache = chatCache
        prefetchTask = Task {
            for summary in candidates {
                guard !Task.isCancelled, coordinator.isCurrent(context) else { return }
                // Revisions compare exactly; saved dates lose sub-second precision.
                if let cached = await cache.loadChat(instanceId: context.instanceId, chatId: summary.id),
                   cached.revision == summary.revision { continue }
                let writeToken = cache.reserveChatWrite()
                guard let chat = try? await client.chat(id: summary.id),
                      chat.id == summary.id, !chat.isBotChat,
                      !Task.isCancelled, coordinator.isCurrent(context) else { continue }
                // The list row stays as the Mac sent it: a prefetch is not a
                // view, so unread and attention state must survive.
                _ = try? await cache.saveFetchedChat(chat, instanceId: context.instanceId, writeToken: writeToken, updatesSummary: false)
            }
        }
    }

    func loadMoreChats(coordinator: AidenRemoteCoordinator) async {
        guard case .loaded = chatListLoadState,
              paginationState != .loading,
              let cursor = nextChatCursor,
              let context = contentContext,
              coordinator.isCurrent(context) else { return }
        let writeToken = chatCache.reserveSummaryWrite(instanceId: context.instanceId)
        latestSummaryRequestToken = writeToken
        paginationState = .loading
        do {
            let page = try await coordinator.remoteClient(for: context).chatSummaries(cursor: cursor)
            guard coordinator.isCurrent(context), contentContext == context else { return }
            try await acceptChatSummaryContinuation(
                page,
                requestedCursor: cursor,
                instanceId: context.instanceId,
                writeToken: writeToken,
                isCurrent: {
                    coordinator.isCurrent(context) && self.contentContext == context && self.latestSummaryRequestToken == writeToken
                }
            )
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context), contentContext == context else { return }
            paginationState = .idle
        } catch {
            guard coordinator.isCurrent(context), contentContext == context else { return }
            paginationState = .failed(error.localizedDescription)
        }
    }
}

struct AidenHomeLoadPlan: Equatable {
    let loadsChats: Bool
    let loadsScheduledTasks: Bool
    let loadsModelCatalog: Bool
    let loadsUsage: Bool

    init(installation: AidenInstallation?) {
        loadsChats = installation?.hasNegotiatedAccess(to: .chatRead) == true
        loadsScheduledTasks = installation?.hasNegotiatedAccess(to: .scheduleRead) == true
        loadsModelCatalog = loadsChats
        loadsUsage = installation?.hasNegotiatedAccess(to: .serverRead) == true
    }
}

/// What a cache-first list shows. Saved rows always win, so a refresh or a
/// failed refresh never replaces them; a skeleton stands in only for a first
/// read; "empty" appears only once the Mac has answered.
enum AidenReadPresentation: Equatable {
    case content
    case skeleton
    case empty
    case failed

    static func of(hasContent: Bool, hasSettled: Bool, failed: Bool) -> Self {
        if hasContent { return .content }
        if failed { return .failed }
        return hasSettled ? .empty : .skeleton
    }
}

/// Home's Recents list. Connecting and a first read are unsettled, offline
/// with nothing saved is a failure, and only a completed read can be empty.
func aidenHomeChatListPresentation(
    hasRows: Bool,
    connectionState: AidenRemoteConnectionState,
    loadState: AidenHomeModel.ChatListLoadState
) -> AidenReadPresentation {
    let loadFailed: Bool
    if case .failed = loadState { loadFailed = true } else { loadFailed = false }
    let isOffline: Bool
    if case .offline = connectionState { isOffline = true } else { isOffline = false }
    return .of(
        hasContent: hasRows,
        hasSettled: loadState == .loaded || connectionState == .needsPairing,
        failed: loadFailed || (isOffline && loadState != .loaded)
    )
}

/// Home's workspace sections. The workspace list is settled only by a live
/// answer; saved workspaces render while connecting.
func aidenHomeWorkspaceListPresentation(
    hasWorkspaces: Bool,
    connectionState: AidenRemoteConnectionState
) -> AidenReadPresentation {
    switch connectionState {
    case .connected, .needsPairing:
        .of(hasContent: hasWorkspaces, hasSettled: true, failed: false)
    case .connecting:
        .of(hasContent: hasWorkspaces, hasSettled: false, failed: false)
    case .offline:
        .of(hasContent: hasWorkspaces, hasSettled: false, failed: true)
    }
}

private func aidenLoadHomeSegment<Value: Sendable>(
    enabled: Bool,
    operation: @escaping @Sendable () async throws -> Value
) async throws -> Result<Value?, Error> {
    try Task.checkCancellation()
    guard enabled else { return .success(nil) }
    do {
        let value = try await operation()
        try Task.checkCancellation()
        return .success(value)
    } catch let error where aidenIsCancellation(error) {
        throw CancellationError()
    } catch {
        return .failure(error)
    }
}
