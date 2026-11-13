import Foundation

// MARK: - Contract revision 24: foreign runs

/// Observation and control of a run this phone did not start (on the Mac, in
/// Telegram or from the scheduler). The phone attaches when the chat loads and
/// the Mac advertises `phone-run-control-v1`. Events are reduced by the pure
/// `AidenForeignRunProjection` and mirrored into the same published state an
/// owned stream uses, so the transcript, approval card, question card, Stop
/// control and Live Activity render unchanged.
extension AidenChatViewModel {
    /// Frames retained from an already finished run arrive back to back.
    /// Publishing waits for this quiet period so opening a chat never replays
    /// a finished run as if it were live.
    static let foreignRunSettleInterval: Duration = .milliseconds(400)
    static let foreignRunMaxReconnects = 3
    static let foreignRunMaxReconcileAttempts = 6
    /// A run the roster announced may not be registered on the Mac yet when
    /// the phone first asks for it; one retry after this long covers that.
    static let announcedRunRetryDelay: Duration = .milliseconds(400)

    /// Why the phone is looking for a run it did not start.
    enum ForeignRunAttachReason: Sendable {
        /// The chat opened or reloaded; its transcript was just read.
        case load
        /// The agent roster reported a new turn.
        case announcedTurn
        /// The first roster this chat received named a turn. It is usually the
        /// last finished one, so a missing run is not looked for again.
        case firstRosterTurn
        /// A foreground check on a device that cannot read the agent roster.
        case probe
    }

    /// Delay before the foreground probe's next check, after `idleProbes`
    /// consecutive checks that found nothing live: 5s, 10s, 20s, then 30s.
    static func foreignRunProbeDelay(afterIdleProbes idleProbes: Int) -> Duration {
        .seconds(min(30, 5 << min(max(idleProbes, 0), 3)))
    }

    var isObservingForeignRun: Bool { foreignRun != nil && foreignRunIsLive }

    /// Whether a lookup for, or observation of, a foreign run is in flight.
    var isLookingForForeignRun: Bool { foreignRunTask != nil }

    func startForeignRunObservationIfNeeded(
        context: AidenRemoteRequestContext,
        reason: ForeignRunAttachReason = .load
    ) {
        guard !isReadOnlyFixture, !isRemoved, foreignRunTask == nil,
              activeStreamID == nil, !isStarting, coordinator.isLive(context),
              ownerServer?.canObserveForeignRuns == true,
              let installation = ownerInstallation,
              installation.instanceId == instanceId,
              installation.hasNegotiatedAccess(to: .runsObserve),
              installation.deviceCapabilities.contains(.chatRead),
              chat.botId == nil || installation.hasNegotiatedAccess(to: .botRead) else { return }
        foreignRunGeneration &+= 1
        let generation = foreignRunGeneration
        foreignRunLookupIsProbes = reason == .probe
        foreignRunTask = Task { [weak self] in
            await self?.observeForeignRun(context: context, generation: generation, reason: reason)
            self?.attachToTurnAnnouncedDuringObservation()
        }
    }

    /// The roster reported a new turn: attach to its run unless a reply is
    /// already live here. A lookup still in flight may have been answered
    /// before this turn's run registered, so the turn waits for it to end and
    /// is looked up then. A run that lookup already showed or read is
    /// recognised by `foreignRunAccountedRunId` and not replayed or read again.
    /// The turn also waits while this phone restores its own stream, which
    /// may be the announced turn's run.
    func attachToAnnouncedTurn(reason: ForeignRunAttachReason) {
        guard !isReadOnlyFixture, !isRemoved, activeStreamID == nil, !isStarting,
              let context = liveOwner else { return }
        if foreignRunTask != nil || isRestoringStream {
            // A newer announced turn keeps the not-found retry.
            if turnAwaitingLookup != .announcedTurn { turnAwaitingLookup = reason }
            return
        }
        startForeignRunObservationIfNeeded(context: context, reason: reason)
    }

    func attachToTurnAnnouncedDuringObservation() {
        guard let reason = turnAwaitingLookup, foreignRunTask == nil, !Task.isCancelled else { return }
        turnAwaitingLookup = nil
        attachToAnnouncedTurn(reason: reason)
    }

    /// Starts the foreground check for runs started elsewhere on a device
    /// that cannot read the agent roster. It stops with progress observation,
    /// which the chat ends when it leaves the screen or the app the foreground.
    func startForeignRunProbeIfNeeded() {
        guard !isReadOnlyFixture, !isRemoved, foreignRunProbeTask == nil, !canReadAgentRoster,
              ownerServer?.canObserveForeignRuns == true else { return }
        foreignRunProbeGeneration &+= 1
        let generation = foreignRunProbeGeneration
        foreignRunProbeTask = Task { [weak self] in
            await self?.probeForForeignRuns(generation: generation)
            guard let self, generation == self.foreignRunProbeGeneration else { return }
            self.foreignRunProbeTask = nil
        }
    }

    func stopForeignRunProbe() {
        foreignRunProbeGeneration &+= 1
        foreignRunProbeTask?.cancel()
        foreignRunProbeTask = nil
        // Its lookup goes too, or it asks the machine again after the chat has
        // left. A run it found stays on, as any live run does.
        guard foreignRunLookupIsProbes, foreignRunTask != nil, foreignRun == nil else { return }
        foreignRunTask?.cancel()
        endForeignRunObservation(preservingRecovery: true)
    }

    var isProbingForForeignRuns: Bool { foreignRunProbeTask != nil }

    private func probeForForeignRuns(generation: UInt64) async {
        var idleProbes = 0
        while generation == foreignRunProbeGeneration, !Task.isCancelled {
            do {
                try await foreignRunProbeSleep(Self.foreignRunProbeDelay(afterIdleProbes: idleProbes))
            } catch {
                return
            }
            guard generation == foreignRunProbeGeneration, !Task.isCancelled,
                  !isRemoved, !canReadAgentRoster,
                  let context = liveOwner else { return }
            if activeStreamID != nil || isStarting || isRestoringStream || foreignRunTask != nil {
                // A reply is already live here; check again soon after it ends.
                idleProbes = 0
                continue
            }
            let shownLive = foreignRunsShownLive
            startForeignRunObservationIfNeeded(context: context, reason: .probe)
            // The device or Mac no longer allows observing runs.
            guard let attach = foreignRunTask else { return }
            await attach.value
            idleProbes = foreignRunsShownLive == shownLive ? idleProbes + 1 : 0
        }
    }

    /// Stops observing, and drops a turn announced during the stopped lookup.
    func stopForeignRunObservation() {
        turnAwaitingLookup = nil
        foreignRunTask?.cancel()
        endForeignRunObservation(preservingRecovery: false)
    }

    /// Ends observation from within the lookup itself, so a turn announced
    /// while it ran is still looked up once it returns. `preservingRecovery`
    /// keeps a finished run's response, still awaiting its transcript, on
    /// screen while a later attach finds nothing live.
    private func endForeignRunObservation(preservingRecovery: Bool) {
        foreignRunGeneration &+= 1
        foreignRunTask = nil
        foreignRunSettleTask?.cancel()
        foreignRunSettleTask = nil
        // An ended run still awaiting its transcript is presented too.
        var wasLive = foreignRunIsLive
        if !preservingRecovery, let recovery = foreignRunReconcileTask {
            recovery.cancel()
            foreignRunReconcileTask = nil
            wasLive = true
        }
        foreignRun = nil
        foreignRunIsLive = false
        if wasLive, activeStreamID == nil {
            replaceLiveText("")
            reasoning = ""
            tools = []
            activityTimeline = nil
            pendingApproval = nil
            pendingQuestion = nil
        }
    }

    private func isCurrentForeignRun(_ generation: UInt64, context: AidenRemoteRequestContext) -> Bool {
        !Task.isCancelled && !isRemoved && generation == foreignRunGeneration
            && coordinator.isLive(context) && activeStreamID == nil && !isStarting
    }

    private func observeForeignRun(
        context: AidenRemoteRequestContext,
        generation: UInt64,
        reason: ForeignRunAttachReason
    ) async {
        defer {
            if generation == foreignRunGeneration { foreignRunTask = nil }
        }
        var reconnects = 0
        var retriedAnnouncedRun = false
        /// Waits once for an announced run the Mac has not registered yet.
        func retryAnnouncedRun() async -> Bool {
            guard reason == .announcedTurn, !retriedAnnouncedRun else { return false }
            retriedAnnouncedRun = true
            try? await announcedRunRetrySleep(Self.announcedRunRetryDelay)
            return true
        }
        attach: while isCurrentForeignRun(generation, context: context) {
            let client: AidenRemoteClient
            do {
                client = try coordinator.remoteClient(for: context)
            } catch {
                return
            }
            let events = foreignRun.map { client.runEvents(runId: $0.runId, after: $0.lastSequence) }
                ?? client.currentRunEvents(chatId: chat.id)
            do {
                for try await event in events {
                    guard isCurrentForeignRun(generation, context: context) else { return }
                    reconnects = 0
                    switch await applyForeignRunEvent(event, context: context, generation: generation) {
                    case .keepObserving:
                        continue
                    case .stop:
                        return
                    case let .endedBeforeAttach(runId):
                        let isNewRun = runId != foreignRunAccountedRunId
                        if !isNewRun {
                            // The newest retained run is one already accounted
                            // for: an announced run may not be registered yet.
                            discardUnsettledForeignRun()
                            if await retryAnnouncedRun() { continue attach }
                        }
                        // The load may have read the transcript before the Mac
                        // committed the reply. Terminal replay settles that read
                        // even though historical activity stays off screen.
                        guard isCurrentForeignRun(generation, context: context) else { return }
                        foreignRunAccountedRunId = runId
                        await endForeignRunQuietly(context: context, reconcile: isNewRun)
                        return
                    }
                }
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) {
                    stopForeignRunObservation()
                    return
                }
                guard isCurrentForeignRun(generation, context: context) else { return }
                if case let .server(statusCode, _)? = error as? AidenRemoteClientError,
                   statusCode < 500 {
                    // No retained run (run_gone), or this device may not see it.
                    let neverFound = foreignRun == nil
                    if statusCode == 404, neverFound, await retryAnnouncedRun() { continue attach }
                    if statusCode == 404, neverFound, reason == .announcedTurn {
                        // The announced run cannot be observed; its outcome
                        // still reaches the transcript.
                        await reconcileChat(context: context)
                        guard generation == foreignRunGeneration else { return }
                    }
                    await endForeignRunQuietly(context: context, reconcile: foreignRunIsLive)
                    return
                }
            }
            reconnects += 1
            guard reconnects <= Self.foreignRunMaxReconnects,
                  isCurrentForeignRun(generation, context: context) else { break }
            try? await Task.sleep(for: .seconds(reconnects))
        }
        guard generation == foreignRunGeneration, !isRemoved else { return }
        if foreignRunIsLive, let runId = foreignRun?.runId {
            streamState = .reconciling
            await liveActivities.markStale(instanceID: instanceId, streamID: runId)
            await endForeignRunQuietly(context: context, reconcile: true)
        } else {
            endForeignRunObservation(preservingRecovery: true)
        }
    }

    private enum ForeignRunStep {
        case keepObserving
        case stop
        /// A finished run replayed on attach: nothing to show live.
        case endedBeforeAttach(runId: String)
    }

    private func applyForeignRunEvent(
        _ event: AidenRemoteRunEvent,
        context: AidenRemoteRequestContext,
        generation: UInt64
    ) async -> ForeignRunStep {
        if foreignRun == nil {
            foreignRun = AidenForeignRunProjection(runId: event.runId)
            scheduleForeignRunSettle(context: context, generation: generation)
        }
        guard var projection = foreignRun else { return .stop }
        let effects = projection.apply(event)
        foreignRun = projection
        guard foreignRunIsLive else {
            return projection.isEnded ? .endedBeforeAttach(runId: projection.runId) : .keepObserving
        }
        var flushesText = true
        if case let .content(content) = event.kind {
            flushesText = content.type != .textDelta && content.type != .heartbeat
        }
        publishForeignRun(context: context, flushingText: flushesText)
        for effect in effects {
            guard isCurrentForeignRun(generation, context: context) else { return .stop }
            if await performForeignRunEffect(effect, runId: projection.runId, context: context) { return .stop }
        }
        return .keepObserving
    }

    /// Drops a replay that never went live so the next attach starts afresh.
    private func discardUnsettledForeignRun() {
        guard !foreignRunIsLive else { return }
        foreignRunSettleTask?.cancel()
        foreignRunSettleTask = nil
        foreignRun = nil
    }

    private func scheduleForeignRunSettle(context: AidenRemoteRequestContext, generation: UInt64) {
        foreignRunSettleTask?.cancel()
        foreignRunSettleTask = Task { [weak self] in
            try? await Task.sleep(for: Self.foreignRunSettleInterval)
            guard !Task.isCancelled, let self,
                  self.isCurrentForeignRun(generation, context: context),
                  let projection = self.foreignRun, !projection.isEnded else { return }
            await self.goLiveWithForeignRun(projection, context: context)
        }
    }

    private func goLiveWithForeignRun(
        _ projection: AidenForeignRunProjection,
        context: AidenRemoteRequestContext
    ) async {
        // A newly live run owns the live output from here on.
        foreignRunReconcileTask?.cancel()
        foreignRunReconcileTask = nil
        foreignRunIsLive = true
        foreignRunAccountedRunId = projection.runId
        foreignRunsShownLive += 1
        // The retained replay lands at once: text it holds before a tool,
        // approval or other structural state shows before that state.
        let carriesStructure = !projection.tools.isEmpty || !projection.reasoning.isEmpty
            || projection.pendingApproval != nil || projection.pendingQuestion != nil || projection.timeline != nil
        publishForeignRun(context: context, flushingText: carriesStructure)
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

    private func publishForeignRun(context: AidenRemoteRequestContext, flushingText: Bool = false) {
        guard let projection = foreignRun, foreignRunIsLive, activeStreamID == nil else { return }
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

    /// Returns true when observation should stop.
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
            await endForeignRunQuietly(context: context, reconcile: true)
            return true
        }
        return false
    }

    private func endForeignRunQuietly(context: AidenRemoteRequestContext, reconcile: Bool) async {
        if foreignRunIsLive, activeStreamID == nil { flushPendingStreamingContent() }
        let generation = foreignRunGeneration
        var reconciled = true
        if reconcile {
            reconciled = await reconcileChat(context: context)
        }
        guard isCurrentForeignRun(generation, context: context) else { return }
        foreignRunGeneration &+= 1
        foreignRunSettleTask?.cancel()
        foreignRunSettleTask = nil
        foreignRunTask = nil
        let wasLive = foreignRunIsLive
        let finalState = foreignRun?.endState
        foreignRun = nil
        foreignRunIsLive = false
        guard activeStreamID == nil else { return }
        if !wasLive {
            if !reconciled { scheduleForeignRunReconciliation(context: context) }
            return
        }
        pendingApproval = nil
        pendingQuestion = nil
        if finalState == nil, streamState?.isTerminal != true { streamState = nil }
        if reconciled {
            clearForeignLiveOutput()
        } else {
            // Keep the response the user was watching until the transcript that
            // holds it is accepted. Only the chat is re-read; nothing is resent.
            scheduleForeignRunReconciliation(context: context)
        }
    }

    private func clearForeignLiveOutput() {
        replaceLiveText("")
        reasoning = ""
        tools = []
        activityTimeline = nil
    }

    private func scheduleForeignRunReconciliation(context: AidenRemoteRequestContext) {
        guard foreignRunReconcileTask == nil else { return }
        foreignRunReconcileTask = Task { [weak self] in
            for attempt in 0..<Self.foreignRunMaxReconcileAttempts {
                let delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt: attempt)
                do {
                    try await Task.sleep(for: .milliseconds(delay))
                } catch {
                    return
                }
                guard let self, !self.isForeignRunRecoveryFenced(context: context) else { return }
                self.transcriptGeneration &+= 1
                if await self.reconcileChat(context: context) {
                    guard !self.isForeignRunRecoveryFenced(context: context) else { return }
                    self.foreignRunReconcileTask = nil
                    self.clearForeignLiveOutput()
                    return
                }
            }
            self?.foreignRunReconcileTask = nil
        }
    }

    /// A send, this phone's own stream, a newly live foreign run or a removed
    /// pairing owns the live state from then on.
    private func isForeignRunRecoveryFenced(context: AidenRemoteRequestContext) -> Bool {
        Task.isCancelled || isRemoved || !coordinator.isLive(context) || activeStreamID != nil
            || isStarting || foreignRunIsLive
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
                String(localized: "This paired device can't answer requests from runs it didn't start. Answer it on your machine.")
            case .scheduleWriteRequired:
                String(localized: "Schedule write access was removed from this paired device. The task was not approved.")
            case .hostApprovalRequired:
                String(localized: "This request can only be approved on your paired desktop.")
            }
            return
        }
        let requestedScope: AidenApprovalScope? = decision == .allow && scope != .once
            && approval.scopes.contains(scope) ? scope : nil
        isRespondingToApproval = true
        defer { isRespondingToApproval = false }
        foreignRun?.markAnsweredLocally(approval.id)
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
            foreignRun?.answerUnconfirmed(approval.id)
            if let loser = AidenForeignRunResolution.loser(from: error) {
                showForeignRunNotice(loser.notice)
                return
            }
            presentedError = String(localized: "The approval response was not confirmed. Check the request on your machine.")
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
        foreignRun?.markAnsweredLocally(question.id)
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
            foreignRun?.answerUnconfirmed(question.id)
            if let loser = AidenForeignRunResolution.loser(from: error) {
                showForeignRunNotice(loser.notice)
                return
            }
            presentedError = String(localized: "The question response was not confirmed. Check the prompt on your machine.")
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// "Answered on your machine": the transient composer caption a losing phone shows.
    private func showForeignRunNotice(_ text: String) {
        showRunInputReceipt(text)
    }
}
