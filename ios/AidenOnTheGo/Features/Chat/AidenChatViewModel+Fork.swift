import Foundation

extension AidenChatViewModel {
    // MARK: - Fork (contract revision 21)

    /// Fork actions for the transcript menus; nil hides every action. Forks
    /// are Workspace-only and wait for the current turn to settle.
    var forkAvailability: AidenChatForkAvailability? {
        guard !isReadOnlyPresentation, !isRemoved, !chat.isBotChat, isConnected,
              coordinator.isLive(owner),
              let server = ownerServer, server.supportsChatFork,
              !isForking, !isStarting, !isRestoringStream, activeStreamID == nil, !isStreaming else { return nil }
        return AidenChatForkAvailability(supportsSummary: server.supportsChatForkSummary)
    }

    /// The newest reply a plain fork can keep: what the session sheet forks from.
    var latestForkableMessageID: String? {
        let eligible = AidenChatForkEligibility.actions(for: chat.messages, supportsSummary: false)
        return chat.messages.last { eligible[$0.id]?.contains(.forkHere) == true }?.id
    }

    /// Forks this chat at a settled message and returns the new chat to open.
    /// Edit in fork seeds the fork's composer: the prompt text through the
    /// per-chat draft store, restaged attachments through the prefill handoff.
    func fork(
        messageId: String,
        action: AidenChatForkMenuAction,
        summaryFocus: String = ""
    ) async -> AidenChat? {
        guard let availability = forkAvailability,
              AidenChatForkEligibility.actions(
                  for: chat.messages,
                  supportsSummary: availability.supportsSummary
              )[messageId]?.contains(action) == true,
              let context = liveOwner,
              coordinator.isLive(context) else { return nil }
        isForking = true
        defer { isForking = false }
        let source = chat
        let attempt = AidenChatForkAttempt.retaining(
            forkAttempt,
            context: context,
            request: .init(
                chatId: source.id,
                revision: source.revision,
                messageId: messageId,
                position: action.position,
                summaryFocus: action == .forkWithSummary ? summaryFocus : nil
            )
        )
        forkAttempt = attempt
        do {
            let result = try await coordinator.remoteClient(for: context).forkChat(
                chatId: attempt.request.chatId,
                revision: attempt.request.revision,
                messageId: attempt.request.messageId,
                position: attempt.request.position,
                summaryFocus: attempt.request.summaryFocus,
                idempotencyKey: attempt.idempotencyKey
            )
            // The Mac answered: the next fork is a new request.
            if forkAttempt == attempt { forkAttempt = nil }
            guard !isRemoved, coordinator.isLive(context) else { return nil }
            let forked = result.chat
            guard !forked.isBotChat,
                  forked.forkedFrom?.chatId == source.id,
                  forked.forkedFrom?.messageId == attempt.request.messageId,
                  forked.forkedFrom?.position == attempt.request.position else {
                presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                coordinator.haptics.play(.error, scope: hapticScope)
                return nil
            }
            let writeToken = cache.reserveChatWrite()
            _ = try? await cache.saveChat(forked, instanceId: context.instanceId, writeToken: writeToken)
            await cache.admitCreatedWorkspaceChat(
                chatId: forked.id,
                instanceId: context.instanceId,
                workspaceId: forked.workspaceId,
                writeToken: writeToken
            )
            guard coordinator.isLive(context) else { return nil }
            if let prefill = result.prefill {
                await seedForkComposer(prefill, forkId: forked.id, context: context)
                guard coordinator.isLive(context) else { return nil }
            }
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-fork:\(forked.id)")
            return forked
        } catch let error where aidenIsCancellation(error) {
            // A cancelled request may already have reached the Mac; keep the key.
            return nil
        } catch {
            if forkAttempt == attempt, !AidenChatForkAttempt.outcomeIsUnknown(after: error) {
                forkAttempt = nil
            }
            if await coordinator.handleCredentialRevocation(error, context: context) { return nil }
            guard !isRemoved, coordinator.isLive(context) else { return nil }
            if case AidenRemoteClientError.server(_, let body) = error, body.code.rawValue == "revision_conflict" {
                presentedError = String(localized: "This chat changed on your machine. Try again.")
                _ = await refreshForkChat(context: context)
            } else {
                presentedError = error.localizedDescription
            }
            coordinator.haptics.play(.error, scope: hapticScope)
            return nil
        }
    }

    private func seedForkComposer(
        _ prefill: AidenChatForkPrefill,
        forkId: String,
        context: AidenRemoteRequestContext
    ) async {
        if !prefill.text.isEmpty {
            // Unpairing purges the store and bumps every session generation,
            // so a save racing it is rejected; re-check before and after.
            let session = await draftStore.beginSession(instanceId: context.instanceId, chatId: forkId)
            if coordinator.isLive(context) {
                _ = try? await draftStore.save(prefill.text, session: session)
            }
            if !coordinator.isLive(context) {
                await draftStore.remove(instanceId: context.instanceId, chatId: forkId)
                return
            }
        }
        let attachments = prefill.attachments.filter { $0.isValid() }
        guard !attachments.isEmpty, let client = try? coordinator.remoteClient(for: context) else { return }
        AidenChatForkPrefillHandoff.stage(
            .init(attachments: attachments, context: context, client: client),
            chatId: forkId
        )
    }

    /// Adopts restaged Edit in fork attachments once, as uploads this
    /// composer owns, so removing one also deletes it on the Mac.
    func adoptForkPrefillAttachments(context: AidenRemoteRequestContext) {
        guard let entry = AidenChatForkPrefillHandoff.take(instanceId: context.instanceId, chatId: chat.id),
              entry.context == context, coordinator.isLive(context),
              pendingAttachments.isEmpty, !isUploadingAttachment, !isPreparingAttachments, !isStarting else { return }
        let attachments = entry.attachments.filter { $0.isValid() }
        for reference in attachments {
            ownedUploadReferences[reference.id] = (reference, entry.context, entry.client)
        }
        pendingAttachments = attachments
    }

    /// Try a failed fork summary again with the same focus.
    func retryForkSummary() async {
        await settleForkSummary(dedupeKey: "retry") { client, chatId in
            try await client.retryForkSummary(chatId: chatId)
        }
    }

    /// Continue without the summary; the fork becomes a plain fork.
    func skipForkSummary() async {
        await settleForkSummary(dedupeKey: "skip") { client, chatId in
            try await client.skipForkSummary(chatId: chatId)
        }
    }

    /// Stop a running summary. It becomes failed, so reread the chat.
    func cancelForkSummary() async {
        guard canSettleForkSummary,
              let context = liveOwner,
              coordinator.isLive(context) else { return }
        isSettlingForkSummary = true
        defer { isSettlingForkSummary = false }
        do {
            _ = try await coordinator.remoteClient(for: context).cancelForkSummary(chatId: chat.id)
            guard !isRemoved, coordinator.isLive(context) else { return }
            _ = await refreshForkChat(context: context)
        } catch {
            await handleForkSummaryError(error, context: context)
        }
    }

    /// Whether the summary card offers Cancel, Retry, and Continue without summary.
    var canSettleForkSummary: Bool {
        !isSettlingForkSummary && !isReadOnlyPresentation && !isRemoved && !chat.isBotChat
            && chat.forkedFrom?.summary != nil
            && ownerServer?.supportsChatForkSummary == true
    }

    private func settleForkSummary(
        dedupeKey: String,
        _ action: (AidenRemoteClient, String) async throws -> AidenChat
    ) async {
        guard canSettleForkSummary,
              let context = liveOwner,
              coordinator.isLive(context) else { return }
        isSettlingForkSummary = true
        defer { isSettlingForkSummary = false }
        let writeToken = cache.reserveChatWrite()
        do {
            let updated = try await action(coordinator.remoteClient(for: context), chat.id)
            guard !isRemoved, coordinator.isLive(context) else { return }
            await acceptRemoteChat(updated, context: context, writeToken: writeToken, scheduleTitleRefresh: false)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "fork-summary-\(dedupeKey):\(updated.revision)")
        } catch {
            await handleForkSummaryError(error, context: context)
        }
    }

    private func handleForkSummaryError(_ error: Error, context: AidenRemoteRequestContext) async {
        if aidenIsCancellation(error) { return }
        if await coordinator.handleCredentialRevocation(error, context: context) { return }
        guard !isRemoved, coordinator.isLive(context) else { return }
        if case AidenRemoteClientError.server(_, let body) = error,
           ["not_found", "revision_conflict", "operation_in_progress"].contains(body.code.rawValue) {
            // The summary moved on elsewhere (finished, retried, or skipped).
            if await refreshForkChat(context: context) { return }
        }
        presentedError = error.localizedDescription
        coordinator.haptics.play(.error, scope: hapticScope)
    }

    /// Rereads the chat while its fork summary is pending so the card
    /// settles without a manual refresh. Ends once the state changes.
    func observePendingForkSummary() async {
        guard !isReadOnlyFixture else { return }
        while chat.forkedFrom?.summary?.state == .pending, !isRemoved {
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                return
            }
            guard let context = liveOwner,
                  coordinator.isLive(context) else { return }
            if isStarting || isLoading || isSettlingForkSummary { continue }
            _ = await refreshForkChat(context: context)
        }
    }

    /// A quiet reread: failures stay silent, unlike `reconcileChat`.
    private func refreshForkChat(context: AidenRemoteRequestContext) async -> Bool {
        guard !isStarting else { return false }
        let generation = transcriptGeneration
        let writeToken = cache.reserveChatWrite()
        do {
            let remote = try await coordinator.remoteClient(for: context).chat(id: chat.id)
            guard !isRemoved, coordinator.isLive(context), generation == transcriptGeneration else { return false }
            return await acceptRemoteChat(remote, context: context, writeToken: writeToken, scheduleTitleRefresh: false)
        } catch {
            _ = await coordinator.handleCredentialRevocation(error, context: context)
            return false
        }
    }

    /// Resolves the source chat's title for the "Forked from" row. A source
    /// the Mac no longer has reads as deleted; any other failure hides the row.
    func resolveForkSource() async {
        guard !isReadOnlyFixture, let lineage = chat.forkedFrom,
              let context = liveOwner,
              coordinator.isLive(context) else { return }
        let sourceId = lineage.chatId
        var title: String?
        if let cached = await cache.admittedChat(instanceId: context.instanceId, chatId: sourceId) {
            title = cached.displayTitle
        } else if let summary = await cache.loadChatSummaries(instanceId: context.instanceId)?
            .summaries.first(where: { $0.id == sourceId }) {
            title = summary.title
        }
        guard coordinator.isLive(context), chat.forkedFrom?.chatId == sourceId else { return }
        if let title {
            forkSource = .titled(title)
            return
        }
        do {
            let source = try await coordinator.remoteClient(for: context).chat(id: sourceId)
            guard coordinator.isLive(context), chat.forkedFrom?.chatId == sourceId else { return }
            forkSource = .titled(source.displayTitle)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context), chat.forkedFrom?.chatId == sourceId else { return }
            if case AidenRemoteClientError.server(_, let body) = error, body.code.rawValue == "not_found" {
                forkSource = .deleted
            }
        }
    }
}
