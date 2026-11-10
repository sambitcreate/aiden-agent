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
    /// Chats with a swipe's write still out. No page knows of that write yet,
    /// however late the page was asked for, so each one goes under these edits.
    private var writesOut: [String: Int] = [:]
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
        await markRead(chatID: chatID, host: coordinator)
    }

    func markRead(chatID: String, host: any AidenHomeHost) async {
        guard host.server?.supportsChatReadState == true,
              let index = chats.firstIndex(where: { $0.id == chatID }), chats[index].unread,
              let context = try? host.homeContext() else { return }
        let before = chats[index]
        let supportsMessagesWindow = host.server?.features.contains(AidenServer.chatMessagesWindowFeature) == true
        let viewed = viewStamp(chatID)
        beginWrite(chatID)
        defer { endWrite(chatID) }
        chats[index].unread = false
        chats[index].inbox.invalidateHostPlacement()
        let optimistic = chats[index]
        persistCurrentSummaries(changedID: chatID, readThrough: optimistic.inbox)
        do {
            try await host.homeClient(for: context).markInboxRead(through: before, supportsMessagesWindow: supportsMessagesWindow)
        } catch {
            await rollBack(chatID: chatID, optimistic: optimistic, before: before, viewed: viewed, context: context, host: host)
            guard host.holdsHomeContext(context) else { return }
            inboxNotice = AidenInboxNotice(message: String(localized: "Couldn’t mark that chat read. Try again once your machine is reachable."))
            return
        }
        settleRead(chatID: chatID, readThrough: optimistic, context: context, host: host)
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
        host: any AidenHomeHost
    ) {
        guard host.holdsHomeContext(context), contentContext == context,
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
        await setTriage(change, chatID: chatID, host: coordinator, isOpen: isOpen, now: now, undoRevision: undoRevision)
    }

    @discardableResult
    func setTriage(
        _ change: AidenChatTriageChange,
        chatID: String,
        host: any AidenHomeHost,
        isOpen: Bool = false,
        now: Date = Date(),
        undoRevision: Int? = nil
    ) async -> Bool {
        let offersUndo = undoRevision == nil
        guard let index = chats.firstIndex(where: { $0.id == chatID }),
              let context = try? host.homeContext() else { return false }
        let before = chats[index]
        let supportsMessagesWindow = host.server?.features.contains(AidenServer.chatMessagesWindowFeature) == true
        let viewed = viewStamp(chatID)
        let alsoMarkRead = change.hidesRow && AidenInbox.alsoMarksRead(before, isOpen: isOpen)
        if alsoMarkRead, host.server?.supportsChatReadState != true { return false }
        let optimistic = AidenInbox.applyingOptimisticTriage(change, to: before, now: now, alsoMarkRead: alsoMarkRead)
        beginWrite(chatID)
        chats[index] = optimistic
        persistCurrentSummaries(changedID: chatID, triageOnly: true, readThrough: alsoMarkRead ? before.inbox : nil)
        inboxNotice = nil
        let client: AidenRemoteClient
        let result: AidenChatTriageResult
        let retried: Bool
        do {
            client = try host.homeClient(for: context)
            (result, retried) = try await sendTriage(
                change,
                chatID: chatID,
                ifRevision: undoRevision ?? before.inbox.triageRevision ?? 0,
                retriesConflict: offersUndo,
                client: client,
                context: context,
                host: host
            )
        } catch {
            endWrite(chatID)
            await rollBack(chatID: chatID, optimistic: optimistic, before: before, viewed: viewed, triageOnly: true, context: context, host: host)
            guard host.holdsHomeContext(context) else { return false }
            let conflict = (error as? AidenRemoteClientError)?.isRevisionConflict == true
            inboxNotice = AidenInboxNotice(message: !conflict
                ? String(localized: "Couldn’t update that chat. It’s back where it was.")
                : offersUndo
                ? String(localized: "That chat changed on another device. The Inbox is up to date now.")
                : String(localized: "That chat changed since, so Undo left it as it is."))
            if conflict { await load(host: host) }
            return false
        }
        defer { endWrite(chatID) }
        func isShown() -> Bool { host.holdsHomeContext(context) && contentContext == context }
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
                settleRead(chatID: chatID, readThrough: optimistic, settledTriage: settled, context: context, host: host)
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

    private func beginWrite(_ chatID: String) {
        writesOut[chatID, default: 0] += 1
    }

    private func endWrite(_ chatID: String) {
        let left = (writesOut[chatID] ?? 0) - 1
        writesOut[chatID] = left > 0 ? left : nil
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
        host: any AidenHomeHost
    ) async throws -> (AidenChatTriageResult, retried: Bool) {
        do {
            return (try await client.setChatTriage(chatId: chatID, change: change, ifRevision: ifRevision), false)
        } catch let error as AidenRemoteClientError {
            guard retriesConflict, let current = error.conflictingRevision, host.holdsHomeContext(context) else { throw error }
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
        host: any AidenHomeHost
    ) async {
        let restoresUnread = viewStamp(chatID) == viewed
        if host.holdsHomeContext(context), contentContext == context {
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

    /// Puts back a row `removeChat` took, where it was. Nothing else here can:
    /// a list read needs the machine, and the saved row went with the list's.
    func restoreChat(_ chat: AidenChatSummary, at index: Int) {
        guard !chats.contains(where: { $0.id == chat.id }) else { return }
        chats.insert(chat, at: min(index, chats.count))
        persistCurrentSummaries(changedID: chat.id)
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
        for (id, edit) in localSummaryEdits where edit.token > max(state.fullToken, state.rowTokens[id] ?? 0) || writesOut[id] != nil {
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
        await load(host: coordinator)
    }

    func load(host: any AidenHomeHost) async {
        // Saved Recents are read whatever the connection state, so a cold
        // launch shows them while the Mac is still being reached.
        guard let context = try? host.homeContext() else { return }
        let isConnected = host.connectionState == .connected
        let requestEditGeneration = summaryCacheGeneration
        let plan = AidenHomeLoadPlan(installation: host.homeInstallation)
        let writeToken = isConnected && plan.loadsChats
            ? chatCache.reserveSummaryWrite(instanceId: context.instanceId)
            : 0
        if isConnected && plan.loadsChats { latestSummaryRequestToken = writeToken }
        let attempt = LoadAttempt(context: context)
        await enter(context, loadsChats: plan.loadsChats, host: host)
        if !plan.loadsChats { clearChatList() }
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
            let client = try host.homeClient(for: context)
            let advertisesChatSummaries = host.server?.supportsChatSummaries == true
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
            guard loadingAttempt == attempt, host.holdsHomeContext(context) else { return }
            var failures: [Error] = []
            switch chatsResult {
            case .success(let loadedPage):
                if let loadedPage {
                    do {
                        guard try await admitFirstPage(
                            AidenChatCache.SummarySnapshot(summaries: loadedPage.summaries, nextCursor: loadedPage.nextCursor),
                            context: context,
                            writeToken: writeToken,
                            requestEditGeneration: requestEditGeneration,
                            isWanted: { self.loadingAttempt == attempt && host.holdsHomeContext(context) }
                        ) != .stale else { return }
                        chatListLoadState = .loaded
                        prefetchRecentTranscripts(client: client, context: context, host: host)
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
            if loadingAttempt == attempt, host.holdsHomeContext(context) {
                errorMessage = error.localizedDescription
                if plan.loadsChats { chatListLoadState = .failed(error.localizedDescription) }
            }
        }
    }

    /// Shows `host`'s saved rows, whatever its connection state, without asking
    /// the machine anything.
    func showSavedChats(host: any AidenHomeHost) async {
        guard let context = try? host.homeContext() else { return }
        await enter(context, loadsChats: AidenHomeLoadPlan.readsChatList(host.homeInstallation), host: host)
    }

    /// One Inbox poll: the chat list and nothing else, over the client that gives
    /// up rather than waits, and quietly, so no spinner comes and goes with it.
    /// `walkingPages` is a cold start's read of up to
    /// `AidenInboxPollPolicy.coldStartPageLimit` pages, saved as one answer so a
    /// walk that fails can't cost the rows past where it stopped. Without it the
    /// rows a walk found past the first page stay, because one page can't speak
    /// for them. A cancelled poll writes nothing from then on.
    func pollChats(host: AidenHostConnection, walkingPages: Bool, now: Date) async -> AidenHomePollResult {
        guard let context = try? host.homeContext() else { return .abandoned }
        guard AidenHomeLoadPlan.readsChatList(host.homeInstallation) else {
            await enter(context, loadsChats: false, host: host)
            clearChatList()
            return .loaded
        }
        let requestEditGeneration = summaryCacheGeneration
        let writeToken = chatCache.reserveSummaryWrite(instanceId: context.instanceId)
        latestSummaryRequestToken = writeToken
        let attempt = LoadAttempt(context: context)
        await enter(context, loadsChats: true, host: host)
        guard latestSummaryRequestToken == writeToken else { return .abandoned }
        loadingAttempt = attempt
        defer {
            if loadingAttempt == attempt {
                loadingAttempt = nil
                isLoading = false
            }
        }
        func isWanted() -> Bool {
            !Task.isCancelled && loadingAttempt == attempt && host.holdsHomeContext(context)
        }
        do {
            let client = try host.probeClient()
            let first = try await client.preferredChatSummaries(advertised: host.server?.supportsChatSummaries == true)
            var page = AidenChatCache.SummarySnapshot(summaries: first.summaries, nextCursor: first.nextCursor)
            var walkFailure: Error?
            if walkingPages {
                (page, walkFailure) = await walkPages(after: first, client: client, now: now)
                if let walkFailure, aidenIsCancellation(walkFailure) { return .abandoned }
            }
            guard isWanted() else { return .abandoned }
            let admission: PageAdmission
            do {
                admission = try await admitFirstPage(
                    page,
                    context: context,
                    keepingWalkedRows: !walkingPages || walkFailure != nil,
                    writeToken: writeToken,
                    requestEditGeneration: requestEditGeneration,
                    isWanted: isWanted
                )
            } catch {
                // The machine answered. Failing to save that says nothing about it.
                if chatListLoadState != .loaded { chatListLoadState = .failed(error.localizedDescription) }
                return walkFailure.map { .failed($0) } ?? .abandoned
            }
            guard admission != .stale else { return .abandoned }
            chatListLoadState = .loaded
            if let walkFailure { return .failed(walkFailure) }
            return walkingPages && admission == .turnedAway ? .abandoned : .loaded
        } catch let error where aidenIsCancellation(error) {
            return .abandoned
        } catch {
            guard isWanted() else { return .abandoned }
            if chatListLoadState != .loaded { chatListLoadState = .failed(error.localizedDescription) }
            return .failed(error)
        }
    }

    /// Reads on from `first` while a page holds something that needs the person,
    /// and returns everything read together, which can be more rows than one
    /// page may hold. A page that can't be read, or doesn't follow on, ends the
    /// walk with what came before it.
    private func walkPages(
        after first: AidenChatSummaryPage,
        client: AidenRemoteClient,
        now: Date
    ) async -> (rows: AidenChatCache.SummarySnapshot, failure: Error?) {
        func needsThePerson(_ page: AidenChatSummaryPage) -> Bool {
            page.summaries.contains { AidenInbox.placement(for: $0, isOpen: false, now: now).section == .needsYou }
        }
        var walked = AidenChatCache.SummarySnapshot(summaries: first.summaries, nextCursor: first.nextCursor)
        var latest = first
        var pagesRead = 1
        while pagesRead < AidenInboxPollPolicy.coldStartPageLimit, needsThePerson(latest), let cursor = latest.nextCursor {
            do {
                let next = try await client.chatSummaries(cursor: cursor)
                walked = AidenChatCache.SummarySnapshot(
                    summaries: try AidenChatSummaryPage.validatedContinuation(
                        current: walked.summaries,
                        requestedCursor: cursor,
                        page: next
                    ),
                    nextCursor: next.nextCursor
                )
                latest = next
                pagesRead += 1
            } catch {
                return (walked, error)
            }
        }
        return (walked, nil)
    }

    /// What a machine this device can't read the chats of shows.
    private func clearChatList() {
        chats = []
        nextChatCursor = nil
        paginationState = .idle
        modelCatalog = nil
        chatListLoadState = .loaded
    }

    /// Moves the model to `context`'s machine and shows what it last saved.
    private func enter(
        _ context: AidenRemoteRequestContext,
        loadsChats: Bool,
        host: any AidenHomeHost
    ) async {
        guard contentContext != context else { return }
        let hydrationToken = latestSummaryRequestToken
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
        if loadsChats,
           let cached = await chatCache.loadChatSummaries(instanceId: context.instanceId),
           host.holdsHomeContext(context), contentContext == context,
           latestSummaryRequestToken == hydrationToken {
            chats = cached.summaries
            nextChatCursor = cached.nextCursor
        }
    }

    /// Saves a first page and lays this model's own edits over it.
    private func admitFirstPage(
        _ loadedPage: AidenChatCache.SummarySnapshot,
        context: AidenRemoteRequestContext,
        keepingWalkedRows: Bool = false,
        writeToken: UInt64,
        requestEditGeneration: UInt64,
        isWanted: @MainActor () -> Bool
    ) async throws -> PageAdmission {
        let walked = keepingWalkedRows ? rowsPast(loadedPage) : []
        let snapshot = AidenChatCache.SummarySnapshot(
            summaries: loadedPage.summaries + walked,
            nextCursor: walked.isEmpty ? loadedPage.nextCursor : nextChatCursor
        )
        let generation = nextSummaryCacheGeneration()
        let saved = try await chatCache.saveChatSummaries(
            snapshot,
            instanceId: context.instanceId,
            generation: generation, writeToken: writeToken
        )
        let state = await chatCache.summaryState(instanceId: context.instanceId)
        let admitted = state.snapshot

        guard isWanted() else { return .stale }
        chats = admitted?.summaries ?? []
        nextChatCursor = admitted?.nextCursor
        // Load more is still out, and ends this itself.
        if paginationState != .loading { paginationState = .idle }
        // A Mark read made since this page was asked for clears the
        // page row's dot only for the reply it read through: a
        // newer reply on the page keeps its dot and the rest of
        // the page row.
        var readOverPage: [String] = []
        for (id, edit) in localSummaryEdits where edit.generation > requestEditGeneration || writesOut[id] != nil {
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
        return saved ? .saved : .turnedAway
    }

    /// Rows past the end of a first page. A row the page ran past and doesn't
    /// list has gone from the machine, so it isn't one of these.
    private func rowsPast(_ page: AidenChatCache.SummarySnapshot) -> [AidenChatSummary] {
        guard page.nextCursor != nil, let end = page.summaries.last else { return [] }
        let listed = Set(page.summaries.map(\.id))
        return chats.filter { !listed.contains($0.id) && AidenChatSummaryPage.areInCanonicalOrder(end, $0) }
    }

    static let recentTranscriptPrefetchLimit = 5
    /// Reads of one Load more, for a list that keeps moving under them.
    static let loadMoreAttempts = 3

    /// A saved transcript for a Recents row, so opening it is immediate.
    func cachedWorkspaceChat(id: String, workspaceId: String, instanceId: String) async -> AidenChat? {
        guard let cached = await chatCache.loadChat(instanceId: instanceId, chatId: id),
              !cached.isBotChat,
              cached.workspaceId == workspaceId else { return nil }
        return await chatCache.presenting(cached, instanceId: instanceId)
    }

    /// For the Inbox, whose reads are polls rather than a `load`.
    func prefetchRecentTranscripts(host: any AidenHomeHost) {
        guard let context = contentContext, host.holdsHomeContext(context),
              let client = try? host.homeClient(for: context) else { return }
        prefetchRecentTranscripts(client: client, context: context, host: host)
    }

    func cancelTranscriptPrefetch() {
        prefetchTask?.cancel()
    }

    /// Saves the newest few transcripts after Recents refresh, one at a time,
    /// skipping ones already current and doing nothing in Low Data Mode.
    private func prefetchRecentTranscripts(
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext,
        host: any AidenHomeHost
    ) {
        prefetchTask?.cancel()
        guard !AidenNetworkPathMonitor.shared.availability.isConstrained else { return }
        let candidates = Array(chats.prefix(Self.recentTranscriptPrefetchLimit))
        let cache = chatCache
        prefetchTask = Task {
            for summary in candidates {
                guard !Task.isCancelled, host.holdsHomeContext(context) else { return }
                // Revisions compare exactly; saved dates lose sub-second precision.
                if let cached = await cache.loadChat(instanceId: context.instanceId, chatId: summary.id),
                   cached.revision == summary.revision { continue }
                let writeToken = cache.reserveChatWrite()
                guard let chat = try? await client.chat(id: summary.id),
                      chat.id == summary.id, !chat.isBotChat,
                      !Task.isCancelled, host.holdsHomeContext(context) else { continue }
                // The list row stays as the Mac sent it: a prefetch is not a
                // view, so unread and attention state must survive.
                _ = try? await cache.saveFetchedChat(chat, instanceId: context.instanceId, writeToken: writeToken, updatesSummary: false)
            }
        }
    }

    func loadMoreChats(coordinator: AidenRemoteCoordinator) async {
        await loadMoreChats(host: coordinator)
    }

    func loadMoreChats(host: any AidenHomeHost) async {
        guard case .loaded = chatListLoadState,
              paginationState != .loading,
              nextChatCursor != nil,
              let context = contentContext,
              host.holdsHomeContext(context) else { return }
        func isCurrent() -> Bool { host.holdsHomeContext(context) && contentContext == context }
        paginationState = .loading
        // A page read from under the list can't be saved over it. A poll landing
        // meanwhile leaves that, or moves the cursor, so the read starts again
        // from where the list is now and the page isn't lost.
        for _ in 0..<Self.loadMoreAttempts {
            guard let cursor = nextChatCursor else {
                paginationState = .idle
                return
            }
            let writeToken = chatCache.reserveSummaryWrite(instanceId: context.instanceId)
            latestSummaryRequestToken = writeToken
            do {
                let page = try await host.homeClient(for: context).chatSummaries(cursor: cursor)
                guard isCurrent() else { return }
                try await acceptChatSummaryContinuation(
                    page,
                    requestedCursor: cursor,
                    instanceId: context.instanceId,
                    writeToken: writeToken,
                    isCurrent: isCurrent
                )
                return
            } catch let error where aidenIsCancellation(error) {
                guard isCurrent() else { return }
                if Task.isCancelled {
                    paginationState = .idle
                    return
                }
            } catch {
                guard isCurrent() else { return }
                paginationState = .failed(error.localizedDescription)
                return
            }
        }
        paginationState = .failed(String(localized: "Couldn’t load more chats. Try again."))
    }
}

/// The machine a Home model reads and writes. The coordinator is the default
/// machine. A connection is one machine, default or not, for as long as its
/// pairing lasts.
@MainActor
protocol AidenHomeHost: AnyObject {
    var server: AidenServer? { get }
    var connectionState: AidenRemoteConnectionState { get }
    var homeInstallation: AidenInstallation? { get }
    func homeContext() throws -> AidenRemoteRequestContext
    func homeClient(for context: AidenRemoteRequestContext) throws -> AidenRemoteClient
    /// False once work under `context` must stop writing here.
    func holdsHomeContext(_ context: AidenRemoteRequestContext) -> Bool
}

extension AidenRemoteCoordinator: AidenHomeHost {
    var homeInstallation: AidenInstallation? { installationStore.activeInstallation }
    func homeContext() throws -> AidenRemoteRequestContext { try requestContext() }
    func homeClient(for context: AidenRemoteRequestContext) throws -> AidenRemoteClient { try remoteClient(for: context) }
    func holdsHomeContext(_ context: AidenRemoteRequestContext) -> Bool { isCurrent(context) }
}

extension AidenHostConnection: AidenHomeHost {
    var homeInstallation: AidenInstallation? { installation }

    /// `generation` is left out: the selection moves it, and a Home model that
    /// took a new context for that would reset under its own rows.
    func homeContext() throws -> AidenRemoteRequestContext {
        let context = try requestContext(scope: .owner)
        return AidenRemoteRequestContext(
            instanceId: context.instanceId,
            deviceId: context.deviceId,
            generation: 0,
            hostGeneration: context.hostGeneration,
            scope: .owner
        )
    }

    func homeClient(for context: AidenRemoteRequestContext) throws -> AidenRemoteClient {
        guard isLive(context) else { throw AidenRemoteClientError.installationChanged }
        return try client()
    }

    func holdsHomeContext(_ context: AidenRemoteRequestContext) -> Bool { isLive(context) }
}

/// What became of a first page.
private enum PageAdmission {
    /// The answer stopped counting on the way.
    case stale
    /// The cache already holds a newer write. The model shows that.
    case turnedAway
    case saved
}

enum AidenHomePollResult {
    case loaded
    /// Cancelled, its machine moved on, or a cold walk the cache turned away, so
    /// the walk is still to do. It says nothing about the machine.
    case abandoned
    case failed(Error)
}

struct AidenHomeLoadPlan: Equatable {
    let loadsChats: Bool
    let loadsScheduledTasks: Bool
    let loadsModelCatalog: Bool
    let loadsUsage: Bool

    /// Whether the Inbox can list this machine's chats. An old Mac keeps no
    /// server inventory, so its device grant is all there is to go on.
    static func readsChatList(_ installation: AidenInstallation?) -> Bool {
        guard let installation else { return false }
        return installation.deviceCapabilities.contains(.chatRead)
            && installation.serverCapabilities?.contains(.chatRead) != false
    }

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
