import Foundation

// MARK: - Contract revision 24: foreign runs

/// Observation and control of a run this phone did not start (on the Mac, in
/// Telegram or from the scheduler). Lifecycle, probing, attach/reconnect, and
/// recovery live in `AidenForeignRunObserver`; this extension binds them to
/// `AidenChatViewModel`'s published transcript, Live Activities, and control
/// actions.
extension AidenChatViewModel {
    static let foreignRunSettleInterval: Duration = AidenForeignRunObserver.settleInterval
    static let foreignRunMaxReconnects = AidenForeignRunObserver.maxReconnects
    static let foreignRunMaxReconcileAttempts = AidenForeignRunObserver.maxReconcileAttempts
    static let announcedRunRetryDelay: Duration = AidenForeignRunObserver.announcedRunRetryDelay

    typealias ForeignRunAttachReason = AidenForeignRunObserver.AttachReason

    /// Delay before the foreground probe's next check, after `idleProbes`
    /// consecutive checks that found nothing live: 5s, 10s, 20s, then 30s.
    static func foreignRunProbeDelay(afterIdleProbes idleProbes: Int) -> Duration {
        AidenForeignRunObserver.probeDelay(afterIdleProbes: idleProbes)
    }

    var isObservingForeignRun: Bool { foreignRunObserver.isObservingLive }

    /// Whether a lookup for, or observation of, a foreign run is in flight.
    var isLookingForForeignRun: Bool { foreignRunObserver.isLookingForRun }

    var isProbingForForeignRuns: Bool { foreignRunObserver.isProbing }

    func startForeignRunObservationIfNeeded(
        context: AidenRemoteRequestContext,
        reason: ForeignRunAttachReason = .load
    ) {
        guard !isReadOnlyFixture, !isRemoved, !foreignRunObserver.isLookingForRun,
              activeStreamID == nil, !isStarting, coordinator.isLive(context),
              ownerServer?.canObserveForeignRuns == true,
              let installation = ownerInstallation,
              installation.instanceId == instanceId,
              installation.hasNegotiatedAccess(to: .runsObserve),
              installation.deviceCapabilities.contains(.chatRead),
              chat.botId == nil || installation.hasNegotiatedAccess(to: .botRead) else { return }
        foreignRunObserver.startObservation(
            context: context,
            reason: reason,
            host: makeForeignRunObserverHost()
        )
    }

    /// The roster reported a new turn: attach to its run unless a reply is
    /// already live here. A lookup still in flight may have been answered
    /// before this turn's run registered, so the turn waits for it to end and
    /// is looked up then. A run that lookup already showed or read is
    /// recognised by `foreignRunObserver.accountedRunId` and not replayed or
    /// read again. The turn also waits while this phone restores its own
    /// stream, which may be the announced turn's run.
    func attachToAnnouncedTurn(reason: ForeignRunAttachReason) {
        guard !isReadOnlyFixture, !isRemoved, activeStreamID == nil, !isStarting,
              let context = liveOwner else { return }
        if foreignRunObserver.isLookingForRun || isRestoringStream {
            foreignRunObserver.queueAnnouncedTurn(reason: reason)
            return
        }
        startForeignRunObservationIfNeeded(context: context, reason: reason)
    }

    func attachToTurnAnnouncedDuringObservation() {
        guard let reason = foreignRunObserver.consumeQueuedAnnouncedTurn() else { return }
        attachToAnnouncedTurn(reason: reason)
    }

    /// Starts the foreground check for runs started elsewhere on a device
    /// that cannot read the agent roster. It stops with progress observation,
    /// which the chat ends when it leaves the screen or the app the foreground.
    func startForeignRunProbeIfNeeded() {
        let canStart = !isReadOnlyFixture && !isRemoved && !canReadAgentRoster
            && ownerServer?.canObserveForeignRuns == true
        foreignRunObserver.startProbeIfNeeded(
            canStart: canStart,
            nextStep: { [weak self] in
                guard let self, !self.isRemoved, !self.canReadAgentRoster,
                      let context = self.liveOwner else { return .stop }
                if self.activeStreamID != nil || self.isStarting || self.isRestoringStream
                    || self.foreignRunObserver.isLookingForRun {
                    return .deferWhileBusy
                }
                return .attach(context)
            },
            startAttach: { [weak self] context, reason in
                guard let self else { return nil }
                self.startForeignRunObservationIfNeeded(context: context, reason: reason)
                return self.foreignRunObserver.attachTask
            }
        )
    }

    func stopForeignRunProbe() {
        foreignRunObserver.stopProbe(hasActiveStream: activeStreamID != nil) { [weak self] in
            self?.clearForeignLiveOutputAndPrompts()
        }
    }

    /// Stops observing, and drops a turn announced during the stopped lookup.
    func stopForeignRunObservation() {
        foreignRunObserver.stopObservation(hasActiveStream: activeStreamID != nil) { [weak self] in
            self?.clearForeignLiveOutputAndPrompts()
        }
    }

    private func makeForeignRunObserverHost() -> AidenForeignRunObserver.Host {
        AidenForeignRunObserver.Host(
            currencyInputs: { [weak self] context in
                guard let self else {
                    return AidenForeignRunObserver.CurrencyInputs(
                        isTaskCancelled: true,
                        isRemoved: true,
                        isContextLive: false,
                        hasActiveStream: false,
                        isStarting: false
                    )
                }
                return AidenForeignRunObserver.CurrencyInputs(
                    isTaskCancelled: Task.isCancelled,
                    isRemoved: self.isRemoved,
                    isContextLive: self.coordinator.isLive(context),
                    hasActiveStream: self.activeStreamID != nil,
                    isStarting: self.isStarting
                )
            },
            isRemoved: { [weak self] in self?.isRemoved ?? true },
            hasActiveStream: { [weak self] in self?.activeStreamID != nil },
            openEventStream: { [weak self] context, currentProjection in
                guard let self else { throw CancellationError() }
                let client = try self.coordinator.remoteClient(for: context)
                return currentProjection.map { client.runEvents(runId: $0.runId, after: $0.lastSequence) }
                    ?? client.currentRunEvents(chatId: self.chat.id)
            },
            handleCredentialRevocation: { [weak self] error, context in
                guard let self else { return false }
                return await self.coordinator.handleCredentialRevocation(error, context: context)
            },
            reconcileChat: { [weak self] context in
                guard let self else { return false }
                return await self.reconcileChat(context: context)
            },
            bumpTranscriptGeneration: { [weak self] in
                self?.transcriptGeneration &+= 1
            },
            onGoLive: { [weak self] projection, context in
                await self?.handleForeignRunWentLive(projection, context: context)
            },
            onPublishUpdate: { [weak self] projection, flushingText, context in
                self?.publishForeignRun(projection, context: context, flushingText: flushingText)
            },
            onPerformEffect: { [weak self] effect, runId, context in
                guard let self else { return true }
                return await self.performForeignRunEffect(effect, runId: runId, context: context)
            },
            onReconnectExhaustedLive: { [weak self] runId, _ in
                guard let self else { return }
                self.streamState = .reconciling
                await self.liveActivities.markStale(instanceID: self.instanceId, streamID: runId)
            },
            onFlushBeforeQuietEnd: { [weak self] in
                self?.flushPendingStreamingContent()
            },
            onEndedQuietlyLive: { [weak self] finalState, reconciled in
                guard let self else { return }
                self.pendingApproval = nil
                self.pendingQuestion = nil
                if finalState == nil, self.streamState?.isTerminal != true { self.streamState = nil }
                if reconciled {
                    self.clearForeignLiveOutput()
                }
            },
            onClearLiveOutput: { [weak self] in
                self?.clearForeignLiveOutput()
            },
            onClearLiveOutputAndPrompts: { [weak self] in
                self?.clearForeignLiveOutputAndPrompts()
            },
            onObservationFinished: { [weak self] in
                self?.attachToTurnAnnouncedDuringObservation()
            }
        )
    }

    private func handleForeignRunWentLive(
        _ projection: AidenForeignRunProjection,
        context: AidenRemoteRequestContext
    ) async {
        // The retained replay lands at once: text it holds before a tool,
        // approval or other structural state shows before that state.
        let carriesStructure = !projection.tools.isEmpty || !projection.reasoning.isEmpty
            || projection.pendingApproval != nil || projection.pendingQuestion != nil || projection.timeline != nil
        publishForeignRun(projection, context: context, flushingText: carriesStructure)
        await liveActivities.start(
            instanceID: instanceId,
            deviceID: context.deviceId,
            chatID: chat.id,
            title: chat.displayTitle,
            streamID: projection.runId
        )
        if projection.pendingApproval != nil {
            await liveActivities.approvalRequired(instanceID: instanceId, streamID: projection.runId)
        } else if let state = streamState {
            await publishLiveActivityStatus(streamID: projection.runId, state: state)
        }
    }

    private func publishForeignRun(
        _ projection: AidenForeignRunProjection? = nil,
        context: AidenRemoteRequestContext,
        flushingText: Bool = false
    ) {
        guard let projection = projection ?? foreignRun, foreignRunIsLive, activeStreamID == nil else { return }
        receiveCumulativeLiveText(projection.liveText)
        // As on an owned stream, text received before a tool, approval or
        // other structural event shows before it lands.
        if flushingText { flushPendingStreamingContent() }
        reasoning = projection.reasoning
        tools = projection.tools
        activityTimeline = projection.timeline
        if let timeline = projection.timeline {
            imageArrivalRevealGenerationIDs = AidenImageGenerationPlaceholderState.armedArrivalReveals(
                imageArrivalRevealGenerationIDs, after: timeline
            )
        }
        if streamState != projection.state { streamState = projection.state }
        let approval = projection.pendingApproval.map { foreignPendingApproval($0, context: context) }
        if pendingApproval != approval { pendingApproval = approval }
        let question = projection.pendingQuestion.map {
            AidenPendingQuestion(
                id: $0.promptId,
                questions: $0.questions,
                expiresAt: $0.expiresAt ?? .distantFuture,
                canRespond: canRespondToForeignQuestions(context: context)
            )
        }
        if pendingQuestion != question { pendingQuestion = question }
    }

    /// Run approvals carry no `expiresAt`: the Mac waits for a decision.
    private func foreignPendingApproval(
        _ approval: AidenRemoteRunApproval,
        context: AidenRemoteRequestContext
    ) -> AidenPendingApproval {
        let capabilities = foreignApprovalCapabilities(context: context)
        let kind = AidenApprovalKind(toolName: approval.toolName)
        let hasRequiredWriteCapability = kind != .scheduledTask || capabilities.canWriteSchedules
        let canAllow = approval.canAllow && capabilities.canRespond && hasRequiredWriteCapability
        return AidenPendingApproval(
            id: approval.approvalId,
            summary: approval.summary,
            expiresAt: .distantFuture,
            kind: kind,
            canRespond: capabilities.canRespond,
            hasRequiredWriteCapability: hasRequiredWriteCapability,
            hostCanAllow: approval.canAllow,
            canAllow: canAllow,
            scopes: canAllow && kind == .action
                ? AidenApprovalScope.offered(approval.scopes?.map(\.rawValue))
                : [.once],
            toolName: approval.toolName,
            schedule: AidenApprovalSchedule.card(approval.schedule, toolName: approval.toolName),
            card: approval.card
        )
    }

    private func hasForeignRunControl(context: AidenRemoteRequestContext) -> Bool {
        guard coordinator.isLive(context),
              ownerServer?.canControlForeignRuns == true,
              let installation = ownerInstallation,
              installation.instanceId == context.instanceId,
              installation.deviceId == context.deviceId else { return false }
        return installation.hasNegotiatedAccess(to: .runsControl)
    }

    private func foreignApprovalCapabilities(context: AidenRemoteRequestContext) -> AidenApprovalCapabilities {
        let base = approvalCapabilities(for: context)
        return AidenApprovalCapabilities(
            canRespond: base.canRespond && hasForeignRunControl(context: context),
            canWriteSchedules: base.canWriteSchedules
        )
    }

    private func canRespondToForeignQuestions(context: AidenRemoteRequestContext) -> Bool {
        canRespondToQuestions(for: context) && hasForeignRunControl(context: context)
    }

    var canControlForeignRun: Bool {
        guard isObservingForeignRun, !isReadOnlyPresentation, isConnected, isStreaming,
              let context = liveOwner,
              hasForeignRunControl(context: context),
              let installation = ownerInstallation,
              installation.deviceCapabilities.contains(.chatWrite) else { return false }
        return chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
            && installation.hasNegotiatedAccess(to: .botWrite))
    }

    /// Returns true when observation should stop (the observer then ends quietly).
    private func performForeignRunEffect(
        _ effect: AidenForeignRunProjection.Effect,
        runId: String,
        context: AidenRemoteRequestContext
    ) async -> Bool {
        let ambient = AidenQuietOpenChat.publishesAmbientProgress(isChatForegrounded: isAmbientSurfaceQuiet)
        switch effect {
        case let .textAppended(text):
            if ambient { await liveActivities.appendResponse(text, instanceID: instanceId, streamID: runId) }
        case .reasoning:
            if ambient { await liveActivities.reasoning(instanceID: instanceId, streamID: runId) }
        case let .toolStarted(name):
            if ambient { await liveActivities.toolStarted(name: name, instanceID: instanceId, streamID: runId) }
        case .toolFinished:
            if ambient { await liveActivities.toolFinished(instanceID: instanceId, streamID: runId) }
        case let .approvalRequired(id):
            coordinator.haptics.play(.warning, scope: hapticScope, dedupeKey: "approval-required:\(id)")
            await liveActivities.approvalRequired(instanceID: instanceId, streamID: runId)
        case let .questionRequired(id):
            coordinator.haptics.play(.warning, scope: hapticScope, dedupeKey: "question-required:\(id)")
            await publishLiveActivityStatus(streamID: runId, state: .waitingForApproval)
        case let .answeredElsewhere(resolution):
            showForeignRunNotice(resolution.notice)
            if let state = streamState { await publishLiveActivityStatus(streamID: runId, state: state) }
        case .reconcile:
            await reconcileChat(context: context)
        case let .ended(state):
            switch state {
            case .done:
                await liveActivities.finish(
                    instanceID: instanceId, streamID: runId, status: .complete,
                    message: String(localized: "Response complete")
                )
            case .failed:
                coordinator.haptics.play(.error, scope: hapticScope, dedupeKey: "turn-terminal:\(runId):error")
                await liveActivities.finish(
                    instanceID: instanceId, streamID: runId, status: .failed,
                    message: String(localized: "Response failed")
                )
            case .cancelled:
                await liveActivities.finish(
                    instanceID: instanceId, streamID: runId, status: .cancelled,
                    message: String(localized: "Response cancelled")
                )
            }
            return true
        }
        return false
    }

    private func clearForeignLiveOutput() {
        replaceLiveText("")
        reasoning = ""
        tools = []
        activityTimeline = nil
    }

    private func clearForeignLiveOutputAndPrompts() {
        clearForeignLiveOutput()
        pendingApproval = nil
        pendingQuestion = nil
    }

    func stopForeignRun() async -> Bool {
        guard canControlForeignRun, !isStopping, let runId = foreignRun?.runId,
              let context = liveOwner else { return false }
        isStopping = true
        defer { isStopping = false }
        do {
            let result = try await coordinator.remoteClient(for: context).cancelRun(id: runId)
            guard coordinator.isLive(context), foreignRun?.runId == runId else { return false }
            guard result.chatId == chat.id else {
                presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
                return false
            }
            coordinator.haptics.play(.actionStopped, scope: hapticScope, dedupeKey: "turn-stop:\(runId)")
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard coordinator.isLive(context), foreignRun?.runId == runId else { return false }
            presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
            coordinator.haptics.play(.error, scope: hapticScope)
            return false
        }
    }

    func respondToForeignApproval(
        _ decision: AidenApprovalDecision,
        approval: AidenPendingApproval,
        scope: AidenApprovalScope,
        onSend: (() -> Void)? = nil
    ) async {
        guard let runId = foreignRun?.runId,
              let context = liveOwner else { return }
        let authorization = AidenApprovalResponseAuthorization.resolve(
            approval: approval, decision: decision,
            capabilities: foreignApprovalCapabilities(context: context)
        )
        guard authorization == .allowed else {
            presentedError = switch authorization {
            case .allowed:
                nil
            case .approvalResponseRequired:
                String(localized: "This paired device can't answer requests from runs it didn't start. Answer it on your computer.")
            case .scheduleWriteRequired:
                String(localized: "Schedule write access was removed from this paired device. The task was not approved.")
            case .hostApprovalRequired:
                String(localized: "This request can only be approved on your paired computer.")
            }
            return
        }
        let requestedScope: AidenApprovalScope? = decision == .allow && scope != .once
            && approval.scopes.contains(scope) ? scope : nil
        isRespondingToApproval = true
        defer { isRespondingToApproval = false }
        foreignRunObserver.markAnsweredLocally(approval.id)
        publishForeignRun(context: context)
        onSend?()
        do {
            let result = try await coordinator.remoteClient(for: context).respondToRunApproval(
                runId: runId,
                approvalId: approval.id,
                decision: decision,
                scope: requestedScope
            )
            guard coordinator.isLive(context) else { return }
            if result.decision == decision {
                coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "approval-response:\(approval.id):\(decision.rawValue)")
            } else {
                retractApprovalAnsweredLine()
            }
        } catch let error where aidenIsCancellation(error) {
            retractApprovalAnsweredLine()
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context) else { return }
            retractApprovalAnsweredLine()
            foreignRunObserver.answerUnconfirmed(approval.id)
            if let loser = AidenForeignRunResolution.loser(from: error) {
                showForeignRunNotice(loser.notice)
                return
            }
            presentedError = String(localized: "The approval response was not confirmed. Check the request on your computer.")
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    func respondToForeignQuestion(
        _ request: AidenQuestionRespondRequest,
        question: AidenPendingQuestion,
        idempotencyKey: UUID
    ) async {
        guard let runId = foreignRun?.runId,
              let context = liveOwner,
              canRespondToForeignQuestions(context: context) else { return }
        isRespondingToQuestion = true
        defer { isRespondingToQuestion = false }
        foreignRunObserver.markAnsweredLocally(question.id)
        publishForeignRun(context: context)
        do {
            _ = try await coordinator.remoteClient(for: context).respondToRunQuestion(
                runId: runId,
                promptId: question.id,
                request: request,
                idempotencyKey: idempotencyKey
            )
            guard coordinator.isLive(context) else { return }
            coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "question-response:\(question.id)")
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context) else { return }
            foreignRunObserver.answerUnconfirmed(question.id)
            if let loser = AidenForeignRunResolution.loser(from: error) {
                showForeignRunNotice(loser.notice)
                return
            }
            presentedError = String(localized: "The question response was not confirmed. Check the prompt on your computer.")
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// "Answered on your computer": the transient composer caption a losing phone shows.
    private func showForeignRunNotice(_ text: String) {
        showRunInputReceipt(text)
    }
}
