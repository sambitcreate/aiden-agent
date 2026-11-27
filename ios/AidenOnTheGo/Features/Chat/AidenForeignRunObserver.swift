import Foundation

/// Owns foreign-run discovery, foreground probing, attach/reconnect looping,
/// settle debouncing, and bounded transcript recovery for a chat.
///
/// Extracted from `AidenChatViewModel+ForeignRuns.swift` so the 6-condition
/// currency fence, generation counters, probe backoff, and attach loop can be
/// reasoned about and unit-tested independently of the full chat screen model.
@MainActor
final class AidenForeignRunObserver {
    /// Frames retained from an already finished run arrive back to back.
    /// Publishing waits for this quiet period so opening a chat never replays
    /// a finished run as if it were live.
    static let settleInterval: Duration = .milliseconds(400)
    static let maxReconnects = 3
    static let maxReconcileAttempts = 6
    /// A run the roster announced may not be registered on the Mac yet when
    /// the phone first asks for it; one retry after this long covers that.
    static let announcedRunRetryDelay: Duration = .milliseconds(400)

    /// Why the phone is looking for a run it did not start.
    enum AttachReason: Equatable, Sendable {
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

    /// The five external inputs combined with `generation` to form the
    /// 6-condition `isCurrentForeignRun` invariant.
    struct CurrencyInputs: Equatable, Sendable {
        let isTaskCancelled: Bool
        let isRemoved: Bool
        let isContextLive: Bool
        let hasActiveStream: Bool
        let isStarting: Bool
    }

    enum ProbeStep: Equatable, Sendable {
        case stop
        case deferWhileBusy
        case attach(AidenRemoteRequestContext)
    }

    enum Phase: Equatable, Sendable {
        case idle
        case attaching(generation: UInt64, isProbeLookup: Bool)
        case settling(generation: UInt64, runId: String, isProbeLookup: Bool)
        case live(generation: UInt64, runId: String)
    }

    /// Host callbacks connecting the observer to the chat model (or a test harness).
    struct Host {
        var currencyInputs: @MainActor (AidenRemoteRequestContext) -> CurrencyInputs
        var isRemoved: @MainActor () -> Bool
        var hasActiveStream: @MainActor () -> Bool
        var openEventStream: @MainActor (AidenRemoteRequestContext, AidenForeignRunProjection?) throws -> AsyncThrowingStream<AidenRemoteRunEvent, Error>
        var handleCredentialRevocation: @MainActor (Error, AidenRemoteRequestContext) async -> Bool
        var reconcileChat: @MainActor (AidenRemoteRequestContext) async -> Bool
        var bumpTranscriptGeneration: @MainActor () -> Void
        var onGoLive: @MainActor (AidenForeignRunProjection, AidenRemoteRequestContext) async -> Void
        var onPublishUpdate: @MainActor (AidenForeignRunProjection, Bool, AidenRemoteRequestContext) -> Void
        var onPerformEffect: @MainActor (AidenForeignRunProjection.Effect, String, AidenRemoteRequestContext) async -> Bool
        var onReconnectExhaustedLive: @MainActor (String, AidenRemoteRequestContext) async -> Void
        var onFlushBeforeQuietEnd: @MainActor () -> Void
        var onEndedQuietlyLive: @MainActor (AidenRemoteRunEndState?, Bool) -> Void
        var onClearLiveOutput: @MainActor () -> Void
        var onClearLiveOutputAndPrompts: @MainActor () -> Void
        var onObservationFinished: @MainActor () -> Void
    }

    /// Delay before the foreground probe's next check, after `idleProbes`
    /// consecutive checks that found nothing live: 5s, 10s, 20s, then 30s.
    static func probeDelay(afterIdleProbes idleProbes: Int) -> Duration {
        .seconds(min(30, 5 << min(max(idleProbes, 0), 3)))
    }

    private(set) var projection: AidenForeignRunProjection?
    private(set) var isLive = false
    private(set) var attachTask: Task<Void, Never>?
    private(set) var lookupIsProbes = false
    private(set) var settleTask: Task<Void, Never>?
    private(set) var generation: UInt64 = 0
    /// Bounded transcript recovery after a foreign run ended but its re-read failed.
    private(set) var reconcileTask: Task<Void, Never>?
    /// The last run this chat showed live or found already finished, so a
    /// later attach can tell a new run from one the transcript already holds.
    var accountedRunId: String?
    /// How many foreign runs went live; the probe resets its backoff on one.
    private(set) var shownLiveCount = 0
    /// A turn the roster announced while another lookup was in flight, or
    /// while this phone restored its own stream.
    private(set) var turnAwaitingLookup: AttachReason?
    private(set) var probeTask: Task<Void, Never>?
    private(set) var probeGeneration: UInt64 = 0

    /// Waits between foreground probes for a foreign run; tests shorten it.
    var probeSleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// Waits before looking again for an announced run; tests shorten it.
    var announcedRunRetrySleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// Waits before reconnecting an interrupted attach; tests shorten it.
    var reconnectSleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// Quiet period before promoting a replay to live; tests shorten it.
    var settleSleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// Waits between bounded recovery transcript re-reads; tests shorten it.
    var reconcileSleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }

    deinit {
        attachTask?.cancel()
        settleTask?.cancel()
        reconcileTask?.cancel()
        probeTask?.cancel()
    }

    var isObservingLive: Bool { projection != nil && isLive }
    var isLookingForRun: Bool { attachTask != nil }
    var isProbing: Bool { probeTask != nil }

    var phase: Phase {
        if let projection, isLive {
            return .live(generation: generation, runId: projection.runId)
        }
        if let projection {
            return .settling(generation: generation, runId: projection.runId, isProbeLookup: lookupIsProbes)
        }
        if attachTask != nil {
            return .attaching(generation: generation, isProbeLookup: lookupIsProbes)
        }
        return .idle
    }

    /// The 6-condition currency fence: task active, chat not removed, generation
    /// matches, owner context live, no owned active stream, and not starting a send.
    func isCurrent(generation: UInt64, inputs: CurrencyInputs) -> Bool {
        !inputs.isTaskCancelled
            && !inputs.isRemoved
            && generation == self.generation
            && inputs.isContextLive
            && !inputs.hasActiveStream
            && !inputs.isStarting
    }

    /// A send, this phone's own stream, a newly live foreign run or a removed
    /// pairing owns the live state from then on.
    func isRecoveryFenced(inputs: CurrencyInputs) -> Bool {
        inputs.isTaskCancelled
            || inputs.isRemoved
            || !inputs.isContextLive
            || inputs.hasActiveStream
            || inputs.isStarting
            || isLive
    }

    /// Queues an announced turn while an attach or stream restoration is in flight.
    /// A newer `.announcedTurn` keeps precedence over `.firstRosterTurn`.
    func queueAnnouncedTurn(reason: AttachReason) {
        if turnAwaitingLookup != .announcedTurn {
            turnAwaitingLookup = reason
        }
    }

    /// Consumes a queued announced turn when no lookup is in flight.
    func consumeQueuedAnnouncedTurn() -> AttachReason? {
        guard let reason = turnAwaitingLookup, attachTask == nil, !Task.isCancelled else { return nil }
        turnAwaitingLookup = nil
        return reason
    }

    func markAnsweredLocally(_ promptId: String) {
        projection?.markAnsweredLocally(promptId)
    }

    func answerUnconfirmed(_ promptId: String) {
        projection?.answerUnconfirmed(promptId)
    }

    /// Starts one observation task if none is in flight. Returns the task so a
    /// probe loop or test can await it.
    @discardableResult
    func startObservation(
        context: AidenRemoteRequestContext,
        reason: AttachReason,
        host: Host
    ) -> Task<Void, Never>? {
        guard attachTask == nil else { return nil }
        generation &+= 1
        let activeGeneration = generation
        lookupIsProbes = reason == .probe
        let task = Task { [weak self] in
            guard let self else { return }
            await self.observe(
                context: context,
                generation: activeGeneration,
                reason: reason,
                host: host
            )
            host.onObservationFinished()
        }
        attachTask = task
        return task
    }

    /// Starts the foreground check for runs started elsewhere on a device that
    /// cannot read the agent roster.
    func startProbeIfNeeded(
        canStart: Bool,
        nextStep: @escaping @MainActor () -> ProbeStep,
        startAttach: @escaping @MainActor (AidenRemoteRequestContext, AttachReason) -> Task<Void, Never>?
    ) {
        guard canStart, probeTask == nil else { return }
        probeGeneration &+= 1
        let activeGeneration = probeGeneration
        probeTask = Task { [weak self] in
            guard let self else { return }
            await self.probeForForeignRuns(
                generation: activeGeneration,
                nextStep: nextStep,
                startAttach: startAttach
            )
            guard activeGeneration == self.probeGeneration else { return }
            self.probeTask = nil
        }
    }

    /// Stops foreground probing and cancels a still-unsettled probe lookup.
    /// Returns true if live output should be cleared.
    func stopProbe(hasActiveStream: Bool, onClearLiveOutputAndPrompts: () -> Void) {
        probeGeneration &+= 1
        probeTask?.cancel()
        probeTask = nil
        // Its lookup goes too, or it asks the machine again after the chat has
        // left. A run it found stays on, as any live run does.
        guard lookupIsProbes, attachTask != nil, projection == nil else { return }
        attachTask?.cancel()
        endObservation(
            preservingRecovery: true,
            hasActiveStream: hasActiveStream,
            onClearLiveOutputAndPrompts: onClearLiveOutputAndPrompts
        )
    }

    /// Stops observing, and drops a turn announced during the stopped lookup.
    func stopObservation(hasActiveStream: Bool, onClearLiveOutputAndPrompts: () -> Void) {
        turnAwaitingLookup = nil
        attachTask?.cancel()
        endObservation(
            preservingRecovery: false,
            hasActiveStream: hasActiveStream,
            onClearLiveOutputAndPrompts: onClearLiveOutputAndPrompts
        )
    }

    /// Ends observation from within the lookup itself, so a turn announced
    /// while it ran is still looked up once it returns. `preservingRecovery`
    /// keeps a finished run's response, still awaiting its transcript, on
    /// screen while a later attach finds nothing live.
    func endObservation(
        preservingRecovery: Bool,
        hasActiveStream: Bool,
        onClearLiveOutputAndPrompts: () -> Void
    ) {
        generation &+= 1
        attachTask = nil
        settleTask?.cancel()
        settleTask = nil
        // An ended run still awaiting its transcript is presented too.
        var wasLive = isLive
        if !preservingRecovery, let recovery = reconcileTask {
            recovery.cancel()
            reconcileTask = nil
            wasLive = true
        }
        projection = nil
        isLive = false
        if wasLive, !hasActiveStream {
            onClearLiveOutputAndPrompts()
        }
    }

    // MARK: - Probe loop

    private func probeForForeignRuns(
        generation activeGeneration: UInt64,
        nextStep: @MainActor () -> ProbeStep,
        startAttach: @MainActor (AidenRemoteRequestContext, AttachReason) -> Task<Void, Never>?
    ) async {
        var idleProbes = 0
        while activeGeneration == probeGeneration, !Task.isCancelled {
            do {
                try await probeSleep(Self.probeDelay(afterIdleProbes: idleProbes))
            } catch {
                return
            }
            guard activeGeneration == probeGeneration, !Task.isCancelled else { return }
            switch nextStep() {
            case .stop:
                return
            case .deferWhileBusy:
                // A reply is already live here; check again soon after it ends.
                idleProbes = 0
                continue
            case let .attach(context):
                if attachTask != nil {
                    idleProbes = 0
                    continue
                }
                let shownLive = shownLiveCount
                guard let attach = startAttach(context, .probe) else { return }
                await attach.value
                idleProbes = shownLiveCount == shownLive ? idleProbes + 1 : 0
            }
        }
    }

    // MARK: - Attach loop

    private enum ForeignRunStep {
        case keepObserving
        case stop
        /// A finished run replayed on attach: nothing to show live.
        case endedBeforeAttach(runId: String)
    }

    private func isCurrent(
        generation activeGeneration: UInt64,
        context: AidenRemoteRequestContext,
        host: Host
    ) -> Bool {
        isCurrent(generation: activeGeneration, inputs: host.currencyInputs(context))
    }

    private func observe(
        context: AidenRemoteRequestContext,
        generation activeGeneration: UInt64,
        reason: AttachReason,
        host: Host
    ) async {
        defer {
            if activeGeneration == generation { attachTask = nil }
        }
        var reconnects = 0
        var retriedAnnouncedRun = false
        let announcedRetrySleep = announcedRunRetrySleep
        func retryAnnouncedRun() async -> Bool {
            guard reason == .announcedTurn, !retriedAnnouncedRun else { return false }
            retriedAnnouncedRun = true
            try? await announcedRetrySleep(Self.announcedRunRetryDelay)
            return true
        }
        attach: while isCurrent(generation: activeGeneration, context: context, host: host) {
            let events: AsyncThrowingStream<AidenRemoteRunEvent, Error>
            do {
                events = try host.openEventStream(context, projection)
            } catch {
                return
            }
            do {
                for try await event in events {
                    guard isCurrent(generation: activeGeneration, context: context, host: host) else { return }
                    reconnects = 0
                    switch await applyEvent(event, context: context, generation: activeGeneration, host: host) {
                    case .keepObserving:
                        continue
                    case .stop:
                        return
                    case let .endedBeforeAttach(runId):
                        let isNewRun = runId != accountedRunId
                        if !isNewRun {
                            // The newest retained run is one already accounted
                            // for: an announced run may not be registered yet.
                            discardUnsettledProjection()
                            if await retryAnnouncedRun() { continue attach }
                        }
                        // The load may have read the transcript before the Mac
                        // committed the reply. Terminal replay settles that read
                        // even though historical activity stays off screen.
                        guard isCurrent(generation: activeGeneration, context: context, host: host) else { return }
                        accountedRunId = runId
                        await endQuietly(context: context, reconcile: isNewRun, host: host)
                        return
                    }
                }
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                if await host.handleCredentialRevocation(error, context) {
                    stopObservation(
                        hasActiveStream: host.hasActiveStream(),
                        onClearLiveOutputAndPrompts: host.onClearLiveOutputAndPrompts
                    )
                    return
                }
                guard isCurrent(generation: activeGeneration, context: context, host: host) else { return }
                if case let .server(statusCode, _)? = error as? AidenRemoteClientError,
                   statusCode < 500 {
                    // No retained run (run_gone), or this device may not see it.
                    let neverFound = projection == nil
                    if statusCode == 404, neverFound, await retryAnnouncedRun() { continue attach }
                    if statusCode == 404, neverFound, reason == .announcedTurn {
                        // The announced run cannot be observed; its outcome
                        // still reaches the transcript.
                        _ = await host.reconcileChat(context)
                        guard activeGeneration == generation else { return }
                    }
                    await endQuietly(context: context, reconcile: isLive, host: host)
                    return
                }
            }
            reconnects += 1
            guard reconnects <= Self.maxReconnects,
                  isCurrent(generation: activeGeneration, context: context, host: host) else { break }
            try? await reconnectSleep(.seconds(reconnects))
        }
        guard activeGeneration == generation, !host.isRemoved() else { return }
        if isLive, let runId = projection?.runId {
            await host.onReconnectExhaustedLive(runId, context)
            await endQuietly(context: context, reconcile: true, host: host)
        } else {
            endObservation(
                preservingRecovery: true,
                hasActiveStream: host.hasActiveStream(),
                onClearLiveOutputAndPrompts: host.onClearLiveOutputAndPrompts
            )
        }
    }

    private func applyEvent(
        _ event: AidenRemoteRunEvent,
        context: AidenRemoteRequestContext,
        generation activeGeneration: UInt64,
        host: Host
    ) async -> ForeignRunStep {
        if projection == nil {
            projection = AidenForeignRunProjection(runId: event.runId)
            scheduleSettle(context: context, generation: activeGeneration, host: host)
        }
        guard var current = projection else { return .stop }
        let effects = current.apply(event)
        projection = current
        guard isLive else {
            return current.isEnded ? .endedBeforeAttach(runId: current.runId) : .keepObserving
        }
        var flushesText = true
        if case let .content(content) = event.kind {
            flushesText = content.type != .textDelta && content.type != .heartbeat
        }
        host.onPublishUpdate(current, flushesText, context)
        for effect in effects {
            guard isCurrent(generation: activeGeneration, context: context, host: host) else { return .stop }
            if await host.onPerformEffect(effect, current.runId, context) {
                await endQuietly(context: context, reconcile: true, host: host)
                return .stop
            }
        }
        return .keepObserving
    }

    private func discardUnsettledProjection() {
        guard !isLive else { return }
        settleTask?.cancel()
        settleTask = nil
        projection = nil
    }

    private func scheduleSettle(
        context: AidenRemoteRequestContext,
        generation activeGeneration: UInt64,
        host: Host
    ) {
        settleTask?.cancel()
        let sleep = settleSleep
        settleTask = Task { [weak self] in
            try? await sleep(Self.settleInterval)
            guard !Task.isCancelled, let self,
                  self.isCurrent(generation: activeGeneration, context: context, host: host),
                  let current = self.projection, !current.isEnded else { return }
            await self.goLive(current, context: context, host: host)
        }
    }

    private func goLive(
        _ current: AidenForeignRunProjection,
        context: AidenRemoteRequestContext,
        host: Host
    ) async {
        // A newly live run owns the live output from here on.
        reconcileTask?.cancel()
        reconcileTask = nil
        isLive = true
        accountedRunId = current.runId
        shownLiveCount += 1
        await host.onGoLive(current, context)
    }

    private func endQuietly(
        context: AidenRemoteRequestContext,
        reconcile: Bool,
        host: Host
    ) async {
        if isLive, !host.hasActiveStream() {
            host.onFlushBeforeQuietEnd()
        }
        let activeGeneration = generation
        var reconciled = true
        if reconcile {
            reconciled = await host.reconcileChat(context)
        }
        guard isCurrent(generation: activeGeneration, context: context, host: host) else { return }
        generation &+= 1
        settleTask?.cancel()
        settleTask = nil
        attachTask = nil
        let wasLive = isLive
        let finalState = projection?.endState
        projection = nil
        isLive = false
        guard !host.hasActiveStream() else { return }
        if !wasLive {
            if !reconciled {
                scheduleReconciliation(context: context, host: host)
            }
            return
        }
        host.onEndedQuietlyLive(finalState, reconciled)
        if !reconciled {
            scheduleReconciliation(context: context, host: host)
        }
    }

    private func scheduleReconciliation(
        context: AidenRemoteRequestContext,
        host: Host
    ) {
        guard reconcileTask == nil else { return }
        let sleep = reconcileSleep
        reconcileTask = Task { [weak self] in
            for attempt in 0..<Self.maxReconcileAttempts {
                let delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt: attempt)
                do {
                    try await sleep(.milliseconds(delay))
                } catch {
                    return
                }
                guard let self,
                      !self.isRecoveryFenced(inputs: host.currencyInputs(context)) else { return }
                host.bumpTranscriptGeneration()
                if await host.reconcileChat(context) {
                    guard !self.isRecoveryFenced(inputs: host.currencyInputs(context)) else { return }
                    self.reconcileTask = nil
                    host.onClearLiveOutput()
                    return
                }
            }
            self?.reconcileTask = nil
        }
    }
}
