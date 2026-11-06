import Observation
import UIKit

@MainActor
@Observable
final class AidenChatViewModel {
    private enum Runtime {
        case live(
            coordinator: AidenRemoteCoordinator,
            cache: AidenChatCache,
            liveActivities: AidenRemoteLiveActivityManager
        )
#if DEBUG
        case readOnlyFixture
#endif
    }

    let readAloud = AidenReadAloudPlayback()
    var readAloudCandidateID: String? {
        guard !isReadOnlyPresentation, !isStarting, streamState?.isTerminal != false,
              ownerServer?.features.contains("tts-v1") == true,
              let last = chat.messages.last, last.role == .assistant,
              last.isReadAloudEligible else { return nil }
        return last.id
    }
    /// Quotes `selection` into the composer draft for a follow-up question.
    /// Returns false when the chat is read-only or the selection is blank.
    @discardableResult
    func askAbout(_ selection: String) -> Bool {
        guard !isReadOnlyPresentation,
              let next = AidenSelectionQuote.draft(quoting: selection, into: draft) else { return false }
        draft = next
        return true
    }

    func toggleReadAloud(_ messageID: String) {
        if readAloud.activeMessageID != nil { readAloud.stop(); return }
        guard let context = liveOwner,
              let client = try? coordinator.remoteClient(for: context) else { return }
        NotificationCenter.default.post(name: .aidenStopDictationForReadAloud, object: nil)
        readAloud.start(client: client, chatID: chat.id, messageID: messageID,
            current: { [weak coordinator] in coordinator?.isLive(context) == true })
    }

    private let runtime: Runtime
    /// The machine this chat belongs to. Every request and cache key goes
    /// through it, so the chat keeps working when the selection moves and a
    /// reply can't land on another machine's chat with the same ID.
    let owner: AidenRemoteRequestContext
    private var allowsMutations: Bool
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    private let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    let draftStore: AidenChatDraftStore
    let visualDocumentCache: AidenVisualDocumentCache
    private let modelPreferenceStore: AidenModelPreferenceStore
    /// Set once the user picks a model in this chat; from then on the
    /// in-session choice wins over the remembered per-host preference.
    @ObservationIgnored private var hasExplicitModelSelection = false
    let hapticScope: UUID
    @ObservationIgnored private var deletionLifetime: AidenChatCache.ChatLifetime?
    // Deterministic test seam immediately before consumer admission.
    @ObservationIgnored var beforeRemovalAttachmentCleanup: (() async -> Void)?
    @ObservationIgnored var beforeConsumerAdmission: (() async -> Void)?
    var isRemoved: Bool { deletionLifetime?.isRemoved == true }
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    /// The view that shows this chat has left the screen.
    @ObservationIgnored private var isViewGone = false
    /// Work a left-behind chat stopped, kept so the view can pick it up again.
    @ObservationIgnored private var leftBehindWork: LeftBehindWork?
    @ObservationIgnored private var progressTask: Task<Void, Never>?
    @ObservationIgnored private var progressObservationGeneration: UInt64 = 0
    @ObservationIgnored private var titleRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var titleRefreshID: UUID?
    @ObservationIgnored private var terminalReconciliationTask: Task<Void, Never>?
    /// Bounded re-reads for a just-settled reply whose visual snapshots the
    /// Mac is still capturing (they land after the reply commits).
    @ObservationIgnored private(set) var visualSnapshotRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var visualSnapshotRefreshID: UUID?
    // Deterministic test seam for the wait between snapshot re-reads.
    @ObservationIgnored var visualSnapshotRefreshSleep: @MainActor (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    var activeStreamID: String? {
        didSet {
            guard let activeStreamID else { return }
            // This device's own run is accounted for, so the roster announcing
            // its turn later never re-reads the transcript for it.
            foreignRunAccountedRunId = activeStreamID
            // An owned stream supersedes observation of a foreign run. Its
            // replay rebuilds the reply, so a live run's copy is dropped.
            if foreignRunTask != nil || foreignRun != nil {
                let replacesLiveRun = foreignRunIsLive
                stopForeignRunObservation()
                if replacesLiveRun {
                    replaceLiveText("")
                    reasoning = ""
                    tools = []
                    activityTimeline = nil
                }
            }
        }
    }
    @ObservationIgnored var foreignRun: AidenForeignRunProjection?
    @ObservationIgnored var foreignRunIsLive = false
    @ObservationIgnored var foreignRunTask: Task<Void, Never>?
    @ObservationIgnored var foreignRunSettleTask: Task<Void, Never>?
    @ObservationIgnored var foreignRunGeneration: UInt64 = 0
    /// Bounded transcript recovery after a foreign run ended but its re-read failed.
    @ObservationIgnored var foreignRunReconcileTask: Task<Void, Never>?
    /// The last run this chat showed live or found already finished, so a
    /// later attach can tell a new run from one the transcript already holds.
    @ObservationIgnored var foreignRunAccountedRunId: String?
    /// How many foreign runs went live; the probe resets its backoff on one.
    @ObservationIgnored var foreignRunsShownLive = 0
    /// The newest turn the agent roster has reported for this chat.
    @ObservationIgnored private var lastRosterTurnId: String?
    /// A turn the roster announced while another lookup was in flight, or
    /// while this phone restored its own stream. That lookup may have been
    /// answered before the turn's run registered, so the turn is looked up
    /// once it, or the restoration, ends.
    @ObservationIgnored var turnAwaitingLookup: ForeignRunAttachReason?
    /// The turn this phone last streamed itself. The roster announcing it,
    /// even after its stream finished, is not another device's run.
    @ObservationIgnored private var lastLocalTurnId: String?
    @ObservationIgnored var foreignRunProbeTask: Task<Void, Never>?
    @ObservationIgnored var foreignRunProbeGeneration: UInt64 = 0
    /// Waits between foreground probes for a foreign run; tests shorten it.
    @ObservationIgnored var foreignRunProbeSleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// Waits before looking again for an announced run; tests shorten it.
    @ObservationIgnored var announcedRunRetrySleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    var isRestoringStream = false {
        didSet {
            // A turn announced while this phone restored its own stream is
            // looked up now; restoration may have shown it is this phone's.
            if oldValue, !isRestoringStream { attachToTurnAnnouncedDuringObservation() }
        }
    }
    @ObservationIgnored var transcriptGeneration: UInt64 = 0
    @ObservationIgnored private var recoveryWarning: String?
    @ObservationIgnored private let networkPath: AidenNetworkPathSource?
    @ObservationIgnored private var turnAttempts = AidenTurnAttemptTracker()
    private(set) var pendingSend: AidenChatDraftStore.PendingSend?
    private(set) var sendRecoveryError: String?
    /// A send the Mac refused with a retryable 429 is sent again on its own
    /// after the server's delay, this many times in a row before Retry is
    /// left to the person.
    static let maxRateLimitedSendRetries = 3
    @ObservationIgnored private var rateLimitedSendRetries = 0
    @ObservationIgnored private var rateLimitedSendRetryTask: Task<Void, Never>?
    /// Waits out a retryable 429 before sending again; tests shorten it.
    @ObservationIgnored var rateLimitedSendRetrySleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }
    /// The Mac was busy and the saved send will go out again on its own.
    private(set) var isWaitingToRetryRateLimitedSend = false
    /// The Mac kept refusing the saved send with a retryable 429 until the
    /// automatic resends ran out. Nothing was appended, so Retry is safe.
    private(set) var isPendingSendRefusedBecauseBusy = false
    var canRetrySend: Bool {
        pendingSend?.canRetry() == true && isConnected && coordinator.isLive(owner) && !isStarting && !isSubmittingRunInput && !isRestoringStream && (pendingSend?.streamId != nil || (activeStreamID == nil && !isStreaming))
    }
    var sendRecoveryMessage: String? {
        if let sendRecoveryError { return sendRecoveryError }
        guard let pendingSend, !isStarting, !isSubmittingRunInput else { return nil }
        if isWaitingToRetryRateLimitedSend {
            return "Aiden Agent is busy. Your message will be sent again in a moment."
        }
        if isPendingSendRefusedBecauseBusy, pendingSend.canRetry() {
            return "Aiden Agent is still busy. Your message wasn’t sent; try again in a moment."
        }
        return pendingSend.canRetry()
            ? "Couldn’t confirm delivery. Retry uses the same saved request within its safe retry window."
            : "Couldn’t confirm delivery. The retry window has ended. Check the conversation on your desktop before sending another message."
    }
    func discardPendingSend() async {
        guard !isStarting, !isSubmittingRunInput, let session = draftSession else { return }
        cancelRateLimitedSendRetry()
        rateLimitedSendRetries = 0
        do {
            try await draftStore.savePendingSend(nil, session: session)
            pendingSend = nil
            sendRecoveryError = nil
            turnAttempts.reset()
        } catch { presentedError = error.localizedDescription }
    }

    private func cancelRateLimitedSendRetry() {
        rateLimitedSendRetryTask?.cancel()
        rateLimitedSendRetryTask = nil
        isWaitingToRetryRateLimitedSend = false
        isPendingSendRefusedBecauseBusy = false
    }

    /// The Mac refused `attempt` with a retryable 429 before running it, and
    /// settled its Idempotency-Key as rejected, so that key cannot be sent
    /// again. The same request is saved again under a fresh key
    /// and sent once the server's delay has passed. Returns `false` when the
    /// fresh attempt could not be saved, leaving the failure terminal.
    private func scheduleRateLimitedSendRetry(
        replacing attempt: AidenChatDraftStore.PendingSend,
        error: AidenRemoteClientError,
        session: AidenChatDraftStore.Session,
        context: AidenRemoteRequestContext
    ) async -> Bool {
        await draftStore.settlePendingSend(key: attempt.key, session: session)
        turnAttempts.reset()
        let fresh = AidenChatDraftStore.PendingSend(
            deviceId: attempt.deviceId,
            request: attempt.request,
            key: turnAttempts.key(for: attempt.request),
            createdAt: Date(),
            attachments: attempt.attachments
        )
        do {
            try await draftStore.savePendingSend(fresh, session: session)
        } catch {
            turnAttempts.reset()
            return false
        }
        pendingSend = fresh
        // The resend belongs to the pairing that authorized this message; a
        // re-pair while the record was being saved leaves Retry to the person.
        guard coordinator.isLive(context), rateLimitedSendRetries < Self.maxRateLimitedSendRetries else {
            isPendingSendRefusedBecauseBusy = true
            return true
        }
        let delay: Duration = error.serverRetryAfterSeconds.map { .seconds($0) }
            ?? .milliseconds(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: rateLimitedSendRetries))
        rateLimitedSendRetries += 1
        rateLimitedSendRetryTask?.cancel()
        isWaitingToRetryRateLimitedSend = true
        let sleep = rateLimitedSendRetrySleep
        let key = fresh.key
        rateLimitedSendRetryTask = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            guard let self, !Task.isCancelled, self.pendingSend?.key == key else { return }
            self.rateLimitedSendRetryTask = nil
            self.isWaitingToRetryRateLimitedSend = false
            await self.send(retry: true, automatic: true, authority: context)
        }
        return true
    }
    /// The fork request whose outcome is still unknown, replayed with the
    /// same Idempotency-Key so a lost response never yields a second fork.
    @ObservationIgnored var forkAttempt: AidenChatForkAttempt?
    @ObservationIgnored private var draftSession: AidenChatDraftStore.Session?
    @ObservationIgnored private var draftPersistenceTask: Task<Void, Never>?
    @ObservationIgnored private var suppressesDraftPersistence = false
    @ObservationIgnored private var draftGeneration: UInt64 = 0
    @ObservationIgnored private var composerGeneration: UInt64 = 0
    @ObservationIgnored private var didConsumeVoiceLaunch = false
    @ObservationIgnored private var uploadTask: Task<Int, Never>?
    @ObservationIgnored var ownedUploadReferences: [String: (AidenAttachmentReference, AidenRemoteRequestContext, AidenRemoteClient)] = [:]
    @ObservationIgnored private var attachmentCleanupTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var uploadRevocation: (AidenRemoteClientError, AidenRemoteRequestContext)?
    @ObservationIgnored private var uploadRevocationTask: Task<Void, Never>?
    @ObservationIgnored private var attachmentPreparationTask: Task<Void, Never>?
    private var attachmentPreparationID: UUID?
    var isPreparingAttachments: Bool { attachmentPreparationID != nil }

    private(set) var chat: AidenChat
    private(set) var catalog: AidenModelCatalog?
    private(set) var isLoading = false
    /// The Mac holds visible messages older than the first one on screen.
    private(set) var hasOlderMessages = false
    private(set) var isLoadingEarlierMessages = false
    /// Set once a newest-transcript read has settled what is on screen, so a
    /// later refresh keeps earlier pages the reader loaded.
    @ObservationIgnored private var hasSettledTranscriptWindow = false
    private(set) var isStarting = false
    /// Revision 53: the first message starts this chat in a new worktree on
    /// the Mac. Shown only while `offersNewWorktree`.
    var startsInNewWorktree = false
    /// The Mac is making the worktree; the message waits above a Cancel.
    private(set) var isSettingUpWorktree = false
    /// What a `git:read` branch list showed for this chat's workspace, if read.
    private(set) var workspaceHasCommits: Bool?
    @ObservationIgnored private var worktreeSetupTask: Task<AidenChatNewWorktree, Error>?
    /// Cancel was pressed during this setup. A task that already finished
    /// ignores `cancel()`, so the press is kept here too.
    @ObservationIgnored private var worktreeSetupCanceled = false
    /// One key per chat and message, so a retry after a lost reply finds the
    /// worktree the Mac already made instead of failing on the moved chat.
    @ObservationIgnored private var worktreeAttempt: (text: String, key: UUID)?
    /// The busy send pill's mode. Resets to Queue when the run ends.
    private(set) var runInputMode: AidenStreamInputMode = .queue
    var streamState: AidenStreamState? {
        didSet {
            let wasActive = oldValue.map { !$0.isTerminal } ?? false
            let isActive = streamState.map { !$0.isTerminal } ?? false
            guard wasActive != isActive else { return }
            if !isActive { runInputMode = .queue }
            if ownerIsSelected { onChatActivityChanged(chat.id, isActive ? .active : .idle) }
        }
    }
    private var networkWaitStreamID: String?
    /// The live stream lost its transport while the device is offline and is
    /// parked until the path returns. No error is shown in this state.
    var isWaitingForNetwork: Bool { networkWaitStreamID != nil && networkWaitStreamID == activeStreamID }
    private(set) var liveText = "" {
        didSet { if liveText != oldValue { scheduleStreamingScrollTrigger() } }
    }
    var reasoning = "" {
        didSet { if reasoning != oldValue { scheduleStreamingScrollTrigger() } }
    }
    var tools: [AidenLiveTool] = [] {
        didSet { if tools != oldValue { scheduleStreamingScrollTrigger() } }
    }
    var activityTimeline: AidenGenerationTimeline? {
        didSet { if activityTimeline != oldValue { scheduleStreamingScrollTrigger() } }
    }
    /// Bumped at most once per 16ms while the live reply grows. Only the
    /// transcript's `AidenStreamingFollowTrigger` leaf reads it, so a bump
    /// re-snaps a following reader without re-running the chat screen.
    private(set) var streamingScrollTrigger = 0
    @ObservationIgnored private var pendingStreamingScrollTriggerTask: Task<Void, Never>?
    /// Bumped when the reader sends, so the transcript jumps to the new turn.
    private(set) var explicitSendCount = 0
    /// Reply text received but not yet revealed. Each reveal tick moves it into
    /// `liveText` through `AidenStreamingRevealGate`, so the transcript grows
    /// in whole words at most once per tick instead of once per token.
    @ObservationIgnored private var pendingLiveText = ""
    /// UTF-8 length of everything received for the live reply, revealed or
    /// not (`liveText` + `pendingLiveText`). Lets a cumulative update append
    /// only its new suffix instead of re-reading the whole reply per event.
    @ObservationIgnored private var receivedLiveTextUTF8Count = 0
    /// Whether the last reveal tick held a trailing fragment back; the next
    /// tick releases it even without new whitespace.
    @ObservationIgnored private var heldStreamingFragmentLastTick = false
    /// Whether reveal ticks pace a burst out. Off under Reduce Motion, where
    /// each tick shows every whole word received.
    @ObservationIgnored private var pacesStreamingReveal = true
    /// The run is done: drain the remaining backlog in a few ticks while the
    /// settled transcript is read.
    @ObservationIgnored private var finishesStreamingReveal = false
    @ObservationIgnored private var pendingStreamingRevealTask: Task<Void, Never>?
    @ObservationIgnored private let streamingRevealTick: @Sendable () async throws -> Void
    /// Generations whose image this phone watched being generated; their
    /// settled image plays the arrival reveal once.
    var imageArrivalRevealGenerationIDs: Set<String> = []
    /// Row identity for messages whose ID changed while on screen: the Mac's
    /// ID for a sent message maps to the local ID its optimistic row was
    /// drawn with, so accepting the turn keeps that row (and its attachment
    /// thumbnails) instead of removing it and inserting a new one.
    private(set) var messageRenderIDs: [String: String] = [:]

    /// The ID the transcript draws a message's row with.
    func renderID(forMessageID id: String) -> String {
        messageRenderIDs[id] ?? id
    }
    private var approvalSnapshotGeneration: UInt64 = 0
    private var approvalSnapshotInFlight: (streamID: String, context: AidenRemoteRequestContext, approval: AidenPendingApproval?, state: AidenStreamState?)?
    private(set) var isRenaming = false
    var pendingApproval: AidenPendingApproval?
    private var questionSnapshotGeneration: UInt64 = 0
    var pendingQuestion: AidenPendingQuestion?
    var isRespondingToQuestion = false
    var isRespondingToApproval = false
    var isStopping = false
    private(set) var isSubmittingRunInput = false
    var isForking = false
    var isSettlingForkSummary = false
    /// The chat this fork came from, once resolved for the lineage row.
    var forkSource: AidenChatForkSource = .unresolved
    private(set) var runInputReceipt: String?
    @ObservationIgnored private var runInputReceiptTask: Task<Void, Never>?
    @ObservationIgnored private var lastRunInputAttempt: AidenRunInputPresentation.Attempt?
    var pendingAttachments: [AidenAttachmentReference] = [] {
        didSet {
            if pendingAttachments != oldValue { composerGeneration &+= 1 }
        }
    }
    private(set) var isUploadingAttachment = false
    /// How far the attachments being uploaded have got; nil while none are.
    private(set) var uploadProgress: AidenUploadProgress?
    @ObservationIgnored private var uploadProgressID: UUID?
    /// Stop on the progress bar keeps the pictures that already reached the Mac.
    @ObservationIgnored private var stopKeepsStagedUploads = false
    let appControlsCache = AidenAppControlCache()
    private(set) var taskProgress: AidenRemoteChatTaskProgress?
    private(set) var agentRoster: AidenRemoteChatAgentRoster?
    private(set) var historicalAgentRosters: [AidenRemoteChatAgentRoster] = []
    private(set) var isTaskProgressStale = false
    private(set) var isAgentRosterStale = false
    /// Public agent IDs with a Stop request in flight, so repeated taps cannot
    /// dispatch twice and the control can show progress.
    private(set) var interruptingAgentIds: Set<String> = []
    var isProgressStale: Bool { isTaskProgressStale || isAgentRosterStale }
    var isProgressObservationRunning: Bool { progressTask != nil }
    var draft = "" {
        didSet {
            guard draft != oldValue else { return }
            draftGeneration &+= 1
            composerGeneration &+= 1
            prefetchComposerSuggestionData()
            guard !suppressesDraftPersistence else { return }
            scheduleDraftPersistence()
        }
    }
    var selectedProviderId: String?
    var selectedModelId: String?
    var selectedThinkingLevel: String?
    var presentedError: String?

    var isReadOnlyFixture: Bool {
#if DEBUG
        if case .readOnlyFixture = runtime { return true }
#endif
        return false
    }

    var isReadOnlyPresentation: Bool { isReadOnlyFixture || !allowsMutations }

    func setAllowsMutations(_ allowed: Bool) {
        guard !isReadOnlyFixture else { return }
        allowsMutations = allowed
        if !allowed {
            draftPersistenceTask?.cancel()
            draftPersistenceTask = nil
            cancelAttachmentPreparation()
        }
    }

    var coordinator: AidenRemoteCoordinator {
        guard case .live(let coordinator, _, _) = runtime else {
            preconditionFailure("Read-only fixture chats have no remote coordinator")
        }
        return coordinator
    }

    var instanceId: String { owner.instanceId }

    /// `owner`, while its machine's lease holds.
    var liveOwner: AidenRemoteRequestContext? {
        guard !isReadOnlyFixture, coordinator.isLive(owner) else { return nil }
        return owner
    }

    /// The shell on screen is showing this chat's machine. `onChatUpdated` and
    /// `onChatActivityChanged` land in the shell's selected-machine state, so a
    /// chat still running after the selection moved stays quiet until it's back.
    private var ownerIsSelected: Bool {
        !isReadOnlyFixture && coordinator.activeInstanceId == owner.instanceId
    }

    /// Nobody is looking at this chat and its machine isn't selected, so
    /// nothing will come back for it if its machine stops answering.
    private var isLeftBehind: Bool { isViewGone && !ownerIsSelected }

    private var ownerConnection: AidenHostConnection? {
        coordinator.hosts.connection(for: owner.instanceId)
    }

    /// The owner's `/server` answer. Nil until that machine has connected,
    /// which a machine that isn't selected may not have done yet.
    var ownerServer: AidenServer? { ownerConnection?.server }

    private var ownerWorkspaces: [AidenWorkspace] { ownerConnection?.workspaces ?? [] }

    /// The owner's saved pairing, while it's the pairing this chat was opened under.
    var ownerInstallation: AidenInstallation? {
        coordinator.installationStore.installations.first {
            $0.id == owner.instanceId && $0.deviceId == owner.deviceId
        }
    }

    var cache: AidenChatCache {
        guard case .live(_, let cache, _) = runtime else {
            preconditionFailure("Read-only fixture chats have no persistent cache")
        }
        return cache
    }

    var liveActivities: AidenRemoteLiveActivityManager {
        guard case .live(_, _, let liveActivities) = runtime else {
            preconditionFailure("Read-only fixture chats have no Live Activity runtime")
        }
        return liveActivities
    }

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        owner: AidenRemoteRequestContext,
        hapticScope: UUID = UUID(),
        cache: AidenChatCache = .shared,
        draftStore: AidenChatDraftStore = .shared,
        modelPreferenceStore: AidenModelPreferenceStore = .shared,
        visualDocumentCache: AidenVisualDocumentCache = .shared,
        liveActivities: AidenRemoteLiveActivityManager? = nil,
        networkPath: AidenNetworkPathSource? = nil,
        allowsMutations: Bool = true,
        streamingRevealTick: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: AidenStreamingRevealGate.tick)
        },
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.streamingRevealTick = streamingRevealTick
        self.owner = owner
        runtime = .live(
            coordinator: coordinator,
            cache: cache,
            liveActivities: liveActivities ?? .shared
        )
        self.networkPath = networkPath ?? AidenNetworkPathMonitor.shared.availability
        self.chat = chat
        self.allowsMutations = allowsMutations
        self.draftStore = draftStore
        self.visualDocumentCache = visualDocumentCache
        self.modelPreferenceStore = modelPreferenceStore
        self.hapticScope = hapticScope
        self.onChatUpdated = onChatUpdated
        self.onChatActivityChanged = onChatActivityChanged
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
        let lifetime = cache.registerLifetime(instanceId: owner.instanceId, chatId: chat.id)
        deletionLifetime = lifetime
        lifetime.onRemoval = { [weak self] in self?.handleRemoval() }
        let draftInstanceId = owner.instanceId
        let draftChatId = chat.id
        lifetime.onRemovalCleanup = { @MainActor [weak self] in
            // The worker never initiates purge itself, so joining it cannot
            // create an upload -> purge -> upload dependency cycle.
            let uploading = self?.uploadTask
            uploading?.cancel()
            _ = await uploading?.value
            await self?.cleanupOwnedAttachmentsForRemoval()
            await draftStore.remove(instanceId: draftInstanceId, chatId: draftChatId)
        }
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        runtime = .readOnlyFixture
        owner = .noMachine
        networkPath = nil
        self.chat = chat
        allowsMutations = false
        draftStore = .shared
        visualDocumentCache = .shared
        modelPreferenceStore = .shared
        hapticScope = UUID()
        onChatUpdated = { _ in }
        onChatActivityChanged = { _, _ in }
        streamingRevealTick = { try await Task.sleep(for: AidenStreamingRevealGate.tick) }
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }
#endif

    deinit {
        pendingStreamingScrollTriggerTask?.cancel()
        pendingStreamingRevealTask?.cancel()
        streamTask?.cancel()
        progressTask?.cancel()
        titleRefreshTask?.cancel()
        visualSnapshotRefreshTask?.cancel()
        terminalReconciliationTask?.cancel()
        draftPersistenceTask?.cancel()
        attachmentPreparationTask?.cancel()
        runInputReceiptTask?.cancel()
        uploadTask?.cancel()
        foreignRunTask?.cancel()
        foreignRunSettleTask?.cancel()
        foreignRunReconcileTask?.cancel()
    }

    private func handleRemoval() {
        // The shell can remain mounted while removal/revocation awaits cleanup.
        // Redact published content synchronously with lifetime invalidation.
        chat.messages = []
        hasOlderMessages = false
        draftPersistenceTask?.cancel()
        draftPersistenceTask = nil
        draftSession = nil
        draftGeneration &+= 1
        composerGeneration &+= 1
        cancelAttachmentPreparation()
        uploadTask?.cancel()
        pendingAttachments = []
        runInputReceiptTask?.cancel()
        runInputReceipt = nil
        transcriptGeneration &+= 1
        streamTask?.cancel()
        terminalReconciliationTask?.cancel()
        titleRefreshTask?.cancel()
        stopVisualSnapshotRefresh()
        stopProgressObservation()
        clearProgressState()
        let removedForeignRunID = foreignRunIsLive ? foreignRun?.runId : nil
        stopForeignRunObservation()
        if let removedForeignRunID {
            Task { await liveActivities.updateStatus(instanceID: instanceId, streamID: removedForeignRunID, state: .cancelled) }
        }
        let removedStreamID = activeStreamID
        activeStreamID = nil
        replaceLiveText("")
        reasoning = ""
        tools = []
        activityTimeline = nil
        pendingApproval = nil
        streamState = nil
        networkWaitStreamID = nil
        clearRecoveryWarning()
        if let removedStreamID {
            Task { await liveActivities.updateStatus(instanceID: instanceId, streamID: removedStreamID, state: .cancelled) }
        }
    }

    private func scheduleStreamingScrollTrigger() {
        guard pendingStreamingScrollTriggerTask == nil else { return }
        pendingStreamingScrollTriggerTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(16))
            guard let self else { return }
            self.pendingStreamingScrollTriggerTask = nil
            self.streamingScrollTrigger &+= 1
        }
    }

    /// Buffers received reply text and schedules a reveal tick.
    private func receiveLiveText(_ text: String) {
        guard !text.isEmpty else { return }
        pendingLiveText += text
        receivedLiveTextUTF8Count += text.utf8.count
        scheduleStreamingReveal()
    }

    /// Mirrors a cumulative reply (a foreign run's projection). Growth that
    /// extends what was already received goes through the reveal gate; any
    /// other change replaces the visible text at once. Each update costs the
    /// length of its new text, not of the whole reply.
    func receiveCumulativeLiveText(_ text: String) {
        switch AidenCumulativeReplyText.update(
            to: text,
            receivedUTF8Count: receivedLiveTextUTF8Count,
            receivedTail: receivedLiveTextTail(byteCount:)
        ) {
        case .append(let suffix): receiveLiveText(suffix)
        case .replace: replaceLiveText(text)
        }
    }

    /// The last `byteCount` UTF-8 bytes received, which may span the revealed
    /// text and the buffer.
    private func receivedLiveTextTail(byteCount: Int) -> [UInt8] {
        let buffered = pendingLiveText.utf8.suffix(byteCount)
        guard buffered.count < byteCount else { return Array(buffered) }
        return Array(liveText.utf8.suffix(byteCount - buffered.count)) + Array(buffered)
    }

    /// Replaces the visible reply and drops anything still buffered.
    func replaceLiveText(_ text: String) {
        cancelPendingStreamingReveal()
        pendingLiveText = ""
        heldStreamingFragmentLastTick = false
        finishesStreamingReveal = false
        receivedLiveTextUTF8Count = text.utf8.count
        liveText = text
    }

    /// Reveals all buffered reply text now, skipping the gate. Terminal,
    /// structural and lost-stream paths call this so nothing received is
    /// ever left hidden.
    func flushPendingStreamingContent() {
        cancelPendingStreamingReveal()
        heldStreamingFragmentLastTick = false
        guard !pendingLiveText.isEmpty else { return }
        let text = pendingLiveText
        pendingLiveText = ""
        liveText += text
    }

    private func scheduleStreamingReveal() {
        guard pendingStreamingRevealTask == nil else { return }
        let tick = streamingRevealTick
        pendingStreamingRevealTask = Task { @MainActor [weak self] in
            try? await tick()
            // A cancelled tick was already replaced or flushed; it must not
            // clear the slot a newer tick owns.
            guard let self, !Task.isCancelled else { return }
            self.pendingStreamingRevealTask = nil
            self.revealStreamingTick()
        }
    }

    /// One reveal tick: shows buffered text through the gate, then
    /// reschedules only while a fragment is held.
    private func revealStreamingTick() {
        let (shown, held) = AidenStreamingRevealGate.cut(
            pendingLiveText,
            heldPreviousTick: heldStreamingFragmentLastTick,
            paced: pacesStreamingReveal,
            finishing: finishesStreamingReveal
        )
        pendingLiveText = held
        heldStreamingFragmentLastTick = !held.isEmpty
        if !shown.isEmpty { liveText += shown }
        if heldStreamingFragmentLastTick { scheduleStreamingReveal() }
    }

    /// Keeps revealing what is buffered, faster, without a final dump.
    private func finishStreamingReveal() {
        guard !pendingLiveText.isEmpty else { return }
        finishesStreamingReveal = true
        // A held fragment is final now; nothing more will complete it.
        heldStreamingFragmentLastTick = true
        scheduleStreamingReveal()
    }

    func setPacesStreamingReveal(_ paces: Bool) {
        pacesStreamingReveal = paces
    }

    private func cancelPendingStreamingReveal() {
        pendingStreamingRevealTask?.cancel()
        pendingStreamingRevealTask = nil
    }

    var isConnected: Bool {
        guard !isReadOnlyFixture else { return false }
        return ownerConnection?.connectionState == .connected
    }
    var isStreaming: Bool { streamState.map { !$0.isTerminal } ?? false }
    /// Whether the transcript draws the live reply. It stays up after the
    /// run ends until the settled transcript replaces it in the same update,
    /// so a reply with only tools or reasoning never blinks out while the
    /// final transcript is read.
    var showsLiveResponse: Bool {
        if isStreaming || !liveText.isEmpty { return true }
        guard activeStreamID != nil || foreignRunIsLive else { return false }
        return !reasoning.isEmpty || !tools.isEmpty || activityTimeline != nil
    }
    /// The live reply has not been replaced by the settled one yet. Its
    /// placeholders, visual cards and streaming Markdown stay as they are
    /// until then, so nothing shrinks between the run ending and the
    /// settled transcript arriving.
    var isLiveReplyUnsettled: Bool {
        isStreaming || activeStreamID != nil || foreignRunIsLive
    }
    var offersNewWorktree: Bool {
        guard !isReadOnlyPresentation, !isRemoved else { return false }
        return AidenNewWorktreeAvailability.isOffered(
            chat: chat,
            workspace: ownerWorkspaces.first { $0.id == chat.workspaceId },
            server: ownerServer,
            hasCommits: workspaceHasCommits
        )
    }

    /// Reads the workspace's branches when this phone holds `git:read`, so New
    /// worktree is hidden for a folder that is not a repository or has no
    /// commits. Without the grant, or when the read fails, the Mac decides.
    func refreshNewWorktreeRepository() async {
        guard !isReadOnlyPresentation, !chat.isBotChat, chat.messages.isEmpty,
              ownerServer?.capabilities.contains(.chatNewWorktree) == true,
              ownerServer?.capabilities.contains(.gitRead) == true,
              let context = liveOwner else { return }
        let workspaceId = chat.workspaceId
        guard let result = try? await coordinator.remoteClient(for: context).gitBranches(workspaceId: workspaceId),
              !isRemoved, coordinator.isLive(context), chat.workspaceId == workspaceId else { return }
        workspaceHasCommits = AidenNewWorktreeAvailability.hasCommits(result)
    }

    /// A workspace chat, connected, with nothing mid-flight to race the new title.
    var canRename: Bool {
        !isReadOnlyPresentation && !isRemoved && !chat.isBotChat && isConnected && coordinator.isLive(owner)
            && !isRenaming && !isStarting && !isStreaming
    }

    /// Renames this chat on its own machine. The new title shows at once; a
    /// refused rename puts the old one back.
    func rename(to title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canRename, !cleaned.isEmpty, cleaned != chat.displayTitle, let context = liveOwner else { return }
        isRenaming = true
        defer { isRenaming = false }
        let previousOverride = chat.localTitleOverride
        chat.localTitleOverride = cleaned
        do {
            let origin = cache.reserveChatWrite()
            let updated = try await coordinator.remoteClient(for: context).updateChat(
                id: chat.id, revision: chat.revision, title: cleaned
            )
            guard !isRemoved, coordinator.isLive(context), updated.id == chat.id else { return }
            let cutoff = cache.reserveChatWrite()
            let admitted = await cache.acceptRename(updated, instanceId: instanceId, origin: origin, cutoff: cutoff)
            guard !isRemoved, coordinator.isLive(context) else { return }
            chat.title = updated.title
            chat.revision = updated.revision
            chat.localTitleOverride = admitted?.localTitleOverride
            if ownerIsSelected { onChatUpdated(chat) }
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-rename:\(updated.id):\(updated.revision)")
        } catch let error where aidenIsCancellation(error) {
            guard !isRemoved, coordinator.isLive(context) else { return }
            chat.localTitleOverride = previousOverride
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context) else { return }
            chat.localTitleOverride = previousOverride
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// Stops waiting for the worktree. The message goes back to the composer.
    /// If the Mac finishes anyway, the chat is in the worktree next time it
    /// loads, still empty.
    func cancelWorktreeSetup() {
        guard worktreeSetupTask != nil else { return }
        worktreeSetupCanceled = true
        worktreeSetupTask?.cancel()
    }

    var canSend: Bool {
        guard !isReadOnlyPresentation, !isRemoved, pendingSend == nil, sendRecoveryError == nil else { return false }
        return (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) &&
        isConnected && coordinator.isLive(owner)
            && !isStarting && !isRestoringStream && activeStreamID == nil && !isPreparingAttachments && !isUploadingAttachment && !isStreaming && hasTurnModelAuthority
    }

    var selectedProvider: AidenProvider? {
        catalog?.providers.first { $0.id == selectedProviderId }
    }

    var selectedModel: AidenModel? {
        selectedProvider?.models.first { $0.id == selectedModelId }
    }

    var visibleProviders: [AidenProvider] { catalog?.visibleProviders ?? [] }
    var usesPersistedBotModelAuthority: Bool { chat.isBotChat }
    var showsComposerModelControl: Bool { !chat.isBotChat }
    private(set) var botPrimarySupportsImages: Bool?
    private(set) var botVisionModelSelection: AidenBotModelSelection?
    var acceptsImageAttachments: Bool {
        if chat.isBotChat {
            return botPrimarySupportsImages == true || botVisionModelSelection != nil
        }
        return selectedModel?.acceptsImageInput ?? true
    }
    var selectedModelDisplayLabel: String { selectedModel?.label ?? selectedModelId ?? "Model unavailable" }
    var macOnlyAgentNotice: String? {
        AidenChatModelAuthority.macOnlyAgentNotice(chat: chat, catalog: catalog, replyModelLabel: selectedModel?.label)
    }

    func transcribeMacSpeech(_ pcm16: Data) async throws -> String {
        guard !isReadOnlyFixture else { throw AidenRemoteClientError.invalidResponse }
        guard !isRemoved, !Task.isCancelled else { throw CancellationError() }
        let context = owner
        let client = try coordinator.remoteClient(for: context)
        let status = try await client.speechStatus()
        guard !isRemoved, !Task.isCancelled, coordinator.isLive(context) else { throw CancellationError() }
        guard status.engine.ready else {
            throw NSError(
                domain: "AidenVoiceInput",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: status.engine.error ?? String(localized: "The desktop speech engine is unavailable.")]
            )
        }
        guard let model = status.models.first(where: { $0.id == status.selectedModelId && $0.installed })
            ?? status.models.first(where: { $0.installed && $0.recommended })
            ?? status.models.first(where: { $0.installed }) else {
            throw NSError(
                domain: "AidenVoiceInput",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: String(localized: "Download a desktop speech model in App Settings before using this option.")]
            )
        }
        if status.selectedModelId != model.id { _ = try await client.selectSpeechModel(model.id) }
        guard !isRemoved, !Task.isCancelled, coordinator.isLive(context) else { throw CancellationError() }
        let result = try await client.transcribeSpeech(pcm16: pcm16, modelId: model.id)
        guard !isRemoved, !Task.isCancelled, coordinator.isLive(context) else { throw CancellationError() }
        return result.text
    }

    private var turnModelSelection: AidenChatModelSelection {
        AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: selectedProviderId,
            selectedModelId: selectedModelId,
            selectedThinkingLevel: selectedThinkingLevel
        )
    }

    private var hasTurnModelAuthority: Bool {
        !chat.isBotChat
            || (turnModelSelection.providerId != nil && turnModelSelection.modelId != nil)
    }

    /// Quiet Open Chat: while this conversation is on screen its ambient
    /// surfaces stay quiet; blocking kinds (approvals, errors) still publish.
    @ObservationIgnored private var isChatForegrounded = false
    @ObservationIgnored private var isSceneActive = false
    @ObservationIgnored private var reportedReadRevision: String?

    var isAmbientSurfaceQuiet: Bool {
        isChatForegrounded && UIApplication.shared.applicationState == .active
    }

    func setChatForegrounded(_ foregrounded: Bool) {
        isChatForegrounded = foregrounded
        // A full-screen viewer also takes the chat off screen; coming back
        // re-arms the wait, which the recent-reply window still bounds.
        if !foregrounded {
            stopVisualSnapshotRefresh()
        } else if !isReadOnlyFixture, !isRemoved, let context = liveOwner {
            scheduleVisualSnapshotRefresh(context: context)
        }
        // Foreground-enter quiets the ambient surface: the Live Activity marks
        // stale (matching Android dismissing its posted notification) and
        // recovers on the next published update.
        if foregrounded, let streamID = activeStreamID {
            Task { await liveActivities.markStale(instanceID: instanceId, streamID: streamID) }
        }
        reportChatViewed(chat)
    }

    func setSceneActive(_ active: Bool) {
        isSceneActive = active
        if active { reportChatViewed(chat) }
    }

    /** Tell the paired Mac which displayed message was last seen. */
    private func reportChatViewed(_ snapshot: AidenChat) {
        guard AidenChatReadAdmission.shouldReportRead(
            isChatVisible: isChatForegrounded,
            sceneIsActive: isSceneActive
        ),
        !snapshot.isBotChat,
        !isReadOnlyPresentation,
        ownerServer?.supportsChatReadState == true,
        reportedReadRevision != snapshot.revision,
        let throughMessageId = snapshot.lastViewedMessageId,
        let context = liveOwner else { return }

        reportedReadRevision = snapshot.revision
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.chat.id == snapshot.id,
                  self.chat.revision == snapshot.revision,
                  AidenChatReadAdmission.shouldReportRead(
                    isChatVisible: self.isChatForegrounded,
                    sceneIsActive: self.isSceneActive
                  ),
                  self.coordinator.isLive(context) else {
                if self.reportedReadRevision == snapshot.revision {
                    self.reportedReadRevision = nil
                }
                return
            }
            do {
                try await self.coordinator.remoteClient(for: context)
                    .markChatRead(id: snapshot.id, throughMessageId: throughMessageId)
            } catch {
                if self.reportedReadRevision == snapshot.revision {
                    self.reportedReadRevision = nil
                }
            }
        }
    }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    /// Local run alert while the user is away; the notifier owns dedupe,
    /// permission timing, and the inactive-only / Quiet Open Chat policy.
    private func alertRun(_ kind: AidenRunAlertKind, id: String) {
        let instanceID = instanceId
        let chatID = chat.id
        let title = chat.title
        let isChatOnScreen = isChatForegrounded
        Task { @MainActor in
            await AidenRunAlertNotifier.shared.notify(
                kind,
                id: id,
                instanceID: instanceID,
                chatID: chatID,
                chatTitle: title,
                isChatOnScreen: isChatOnScreen
            )
        }
    }

    func publishLiveActivityStatus(streamID: String, state: AidenStreamState) async {
        guard AidenQuietOpenChat.publishesStatus(
            state,
            isChatForegrounded: isAmbientSurfaceQuiet
        ) else { return }
        await liveActivities.updateStatus(instanceID: instanceId, streamID: streamID, state: state)
    }

    /// Loads once any earlier load has unwound. A newer load epoch cancels
    /// the old task, but cancellation is cooperative, so a plain `load` would
    /// see `isLoading` and drop the refresh the new epoch asked for.
    func reload(observeProgress: Bool = true) async {
        while isLoading {
            try? await Task.sleep(for: .milliseconds(50))
            if Task.isCancelled { return }
        }
        await load(observeProgress: observeProgress)
    }

    func load(observeProgress: Bool = true) async {
        guard !isReadOnlyFixture else { return }
        guard !isRemoved else { return }
        guard !instanceId.isEmpty, !isLoading, !isStarting else { return }
        // Off the load path, so restoring the transcript never waits on it.
        Task { [weak self] in await self?.refreshSavedVisualDocuments() }
        guard let context = liveOwner else {
            clearProgressState()
            return
        }
        let observationGeneration = progressObservationGeneration
        let restorationGeneration = composerGeneration
        let approvalStreamToRefresh = (pendingApproval != nil || streamState == .waitingForApproval || isRespondingToApproval)
            ? activeStreamID : nil
        isLoading = true
        isRestoringStream = activeStreamID == nil
        defer {
            isLoading = false
            isRestoringStream = false
        }
        // Establish whether recovery is needed before a draft read can suspend.
        // An empty stream cache releases Send without waiting for draft I/O.
        let cachedStream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id)
        let needsStreamRestoration = activeStreamID == nil && cachedStream != nil
        guard !isRemoved, coordinator.isLive(context) else { return }
        isRestoringStream = needsStreamRestoration
        if draftSession == nil {
            let session = await draftStore.beginSession(instanceId: instanceId, chatId: chat.id)
            guard !isRemoved, coordinator.isLive(context) else { return }
            draftSession = session
            isPendingSendRefusedBecauseBusy = false
            do { pendingSend = try await draftStore.loadPendingSend(session: session, deviceId: context.deviceId) }
            catch { sendRecoveryError = "The saved send could not be read. Check the conversation on your desktop before dismissing it and sending again." }
            if draft.isEmpty, pendingAttachments.isEmpty, !isPreparingAttachments, !isUploadingAttachment, !isStarting,
               let savedDraft = await draftStore.load(session: session) {
                guard !isRemoved, coordinator.isLive(context), draftSession == session else { return }
                // Disk access yields the main actor while the composer remains
                // editable. Text edits, uploads, attachment removal and Send
                // must all win over restoring the previous composer's text.
                if composerGeneration == restorationGeneration, draft.isEmpty {
                    draft = savedDraft
                }
            }
        }
        // Edit in fork: its prompt text arrived through the draft store above.
        adoptForkPrefillAttachments(context: context)
        // Reserve Send synchronously, restore local drafts first, then let the
        // status probe run alongside independent transcript/catalog reads.
        async let restoration: Void = restoreStreamIfNeeded(needed: needsStreamRestoration)
        let cacheGeneration = transcriptGeneration
        // Once a network window has settled, the transcript on screen already
        // holds everything the cache does plus earlier pages the reader loaded;
        // presenting the cache again would drop those pages before the merge.
        let keepsSettledWindow = hasSettledTranscriptWindow
            && ownerServer?.supportsChatMessagesWindow == true
        if !keepsSettledWindow,
           let cached = await cache.loadChat(instanceId: instanceId, chatId: chat.id) {
            guard !isRemoved, coordinator.isLive(context) else { return }
            if cacheGeneration == transcriptGeneration, !isStarting {
                let presented = await cache.presenting(cached, instanceId: instanceId)
                guard !isRemoved, coordinator.isLive(context), cacheGeneration == transcriptGeneration, !isStarting else { return }
                chat = presented
                resolveModelSelection()
            }
        }
        let generation = transcriptGeneration
        let writeToken = cache.reserveChatWrite()
        // Catalog latency/failure must not hold a successfully fetched transcript.
        // Keep both reads structured under this load and independently fenced.
        async let catalogRefresh: Void = refreshModelCatalog(context: context)
        do {
            let latest = try await fetchLatestTranscript(context: context)
            guard !isRemoved, coordinator.isLive(context) else { return }
            if generation == transcriptGeneration, !isStarting {
                await acceptLatestTranscript(latest, context: context, writeToken: writeToken)
            }
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context) else { return }
            if generation == transcriptGeneration, !isStarting, chat.messages.isEmpty { presentedError = error.localizedDescription }
        }
        await catalogRefresh
        await restoration
        guard !isRemoved, coordinator.isLive(context) else { return }
        // Refresh current authority on explicit reload without restarting an
        // existing stream owner or discarding its in-memory replay buffers.
        if let approvalStreamToRefresh, activeStreamID == approvalStreamToRefresh {
            await restorePendingApproval(streamID: approvalStreamToRefresh, context: context)
        }
        guard !isRemoved, coordinator.isLive(context) else { return }
        startForeignRunObservationIfNeeded(context: context)
        // Progress observation stopped while this load was suspended (the chat
        // left the foreground) must not have its probe restarted.
        if observeProgress, observationGeneration == progressObservationGeneration, !Task.isCancelled {
            startForeignRunProbeIfNeeded()
        }
        guard observeProgress,
              isCurrentProgressObservation(observationGeneration, context: context) else { return }
        // A running observer already owns a live progress channel whose
        // snapshots supersede a one-off fetch, so a reload does not duplicate it.
        guard progressTask == nil else { return }
        await loadProgressSnapshot(
            context: context,
            observationGeneration: observationGeneration
        )
        guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
        startProgressObservation(initialSnapshotLoaded: true)
    }

    private func refreshModelCatalog(context: AidenRemoteRequestContext) async {
        do {
            let remoteCatalog = try await coordinator.remoteClient(for: context).modelCatalog()
            guard !isRemoved, !Task.isCancelled, coordinator.isLive(context) else { return }
            catalog = remoteCatalog
            // Resolve against the live selection, never the values captured at load.
            resolveModelSelection()
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            // An optional catalog failure must not replace a readable transcript
            // with a load error or discard the last usable model choices.
        }
    }

    var canReadTaskProgress: Bool {
        guard let server = ownerServer,
              server.supportsChatTasks,
              let installation = ownerInstallation else { return false }
        return installation.hasNegotiatedAccess(to: .tasksRead)
    }

    /// Used only to fence an open inspector when the active pairing changes.
    var agentNavigationConnectionIdentity: [String] {
        guard !isReadOnlyPresentation,
              let installation = ownerInstallation else { return [] }
        return [installation.instanceId, installation.deviceId]
    }

    var canReadAgentRoster: Bool {
        guard let server = ownerServer,
              server.supportsChatAgents,
              let installation = ownerInstallation else { return false }
        return installation.hasNegotiatedAccess(to: .agentsRead)
    }

    /// Stopping one delegated agent needs the Mac's chat-agent-interrupt-v1
    /// feature, the negotiated agents:read grant, chat:write, and (for Bot
    /// chats) the same Bot write access as stopping the whole run.
    var canInterruptAgents: Bool {
        guard !isReadOnlyPresentation, canReadAgentRoster,
              ownerServer?.supportsChatAgentInterrupt == true,
              let installation = ownerInstallation,
              installation.instanceId == instanceId,
              installation.deviceCapabilities.contains(.chatWrite) else { return false }
        return chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
            && installation.hasNegotiatedAccess(to: .botWrite))
    }

    /// Only a still-running agent in the current turn can be stopped. Earlier
    /// turns are history, and terminal agents have nothing left to stop.
    func canInterrupt(_ agent: AidenRemoteChatAgent) -> Bool {
        guard canInterruptAgents, !agent.state.isTerminal,
              !interruptingAgentIds.contains(agent.agentId),
              let current = agentRoster,
              current.agents.contains(where: { $0.agentId == agent.agentId }) else { return false }
        return true
    }

    /// Asks the Mac to stop one delegated agent and adopts the refreshed
    /// roster it returns. Returns whether the Mac confirmed the request.
    @discardableResult
    func interruptAgent(_ agent: AidenRemoteChatAgent) async -> Bool {
        guard canInterrupt(agent), !isRemoved,
              let context = liveOwner,
              coordinator.isLive(context) else { return false }
        let agentId = agent.agentId
        interruptingAgentIds.insert(agentId)
        defer { interruptingAgentIds.remove(agentId) }
        do {
            let roster = try await coordinator.remoteClient(for: context).interruptAgent(
                chatId: chat.id,
                agentId: agentId
            )
            guard !isRemoved, coordinator.isLive(context) else { return false }
            acceptAgentRoster(roster)
            coordinator.haptics.play(.actionStopped, scope: hapticScope, dedupeKey: "agent-stop:\(agentId)")
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard !isRemoved, coordinator.isLive(context) else { return false }
            if isProgressAccessDenied(error) {
                presentedError = String(localized: "This device can no longer stop agents on this Mac.")
            } else {
                presentedError = String(localized: "Stop was not confirmed. Check the agent before trying again.")
            }
            coordinator.haptics.play(.error, scope: hapticScope)
            return false
        }
    }

    /// Progress projections are independently negotiated read-only data. A
    /// revoked or switched installation must never leave child state visible
    /// while the parent transcript is being purged or reloaded.
    func clearProgressState() {
        taskProgress = nil
        agentRoster = nil
        historicalAgentRosters = []
        isTaskProgressStale = false
        isAgentRosterStale = false
    }

    private func clearProgressStateIfCredentialRevoked(_ error: Error) {
        guard (error as? AidenRemoteClientError)?.isCredentialRevoked == true else { return }
        clearProgressState()
    }

    private func clearTaskProgressState() {
        taskProgress = nil
        isTaskProgressStale = false
    }

    private func clearAgentProgressState() {
        agentRoster = nil
        historicalAgentRosters = []
        isAgentRosterStale = false
    }

    private func clearProgressStateForLostAccess() {
        if !canReadTaskProgress { clearTaskProgressState() }
        if !canReadAgentRoster { clearAgentProgressState() }
    }

    private func isProgressAccessDenied(_ error: Error) -> Bool {
        guard let clientError = error as? AidenRemoteClientError,
              case .server(_, let body) = clientError else { return false }
        return body.code.rawValue == "capability_denied"
    }

    var currentAgentTurnId: String? { agentRoster?.turnId }

    var availableAgentTurnIds: [String] {
        guard canReadAgentRoster else { return [] }
        var seen = Set<String>()
        let knownRosters = ([agentRoster].compactMap { $0 } + historicalAgentRosters)
        let advertisedTurns = knownRosters.flatMap { $0.previousTurns.map(\.turnId) }
        return ([agentRoster].compactMap { $0?.turnId } + advertisedTurns + historicalAgentRosters.compactMap { $0.turnId })
            .filter { seen.insert($0).inserted }
    }

    func turnLabel(_ turnId: String) -> String {
        if let turn = ([agentRoster].compactMap { $0 } + historicalAgentRosters)
            .flatMap({ $0.previousTurns })
            .first(where: { $0.turnId == turnId }) {
            return turn.startedAt.date.formatted(date: .abbreviated, time: .shortened)
        }
        // Opaque turn IDs never surface in display text. Fall back to the
        // turn's position in the retained list so the label stays stable.
        let earlier = availableAgentTurnIds.filter { $0 != currentAgentTurnId }
        let index = earlier.firstIndex(of: turnId).map { $0 + 1 } ?? earlier.count
        return String(localized: "Earlier turn \(index)")
    }

    func agentRoster(for turnId: String?) -> AidenRemoteChatAgentRoster? {
        guard canReadAgentRoster else { return nil }
        guard let turnId else { return agentRoster }
        if agentRoster?.turnId == turnId { return agentRoster }
        return historicalAgentRosters.first { $0.turnId == turnId }
    }

    /// Starts the single progress owner for this chat. `initialSnapshotLoaded`
    /// lets `load()` hand over the snapshot it just fetched so the observer goes
    /// straight to the live channel instead of fetching the same state again.
    func startProgressObservation(initialSnapshotLoaded: Bool = false) {
        guard !isReadOnlyFixture else { return }
        guard !isRemoved else { return }
        // Without the agent roster nothing announces a run started elsewhere,
        // so the chat checks for one while it is in the foreground.
        startForeignRunProbeIfNeeded()
        clearProgressStateForLostAccess()
        guard progressTask == nil,
              canReadTaskProgress || canReadAgentRoster || canReadAppControls else { return }
        progressObservationGeneration &+= 1
        let generation = progressObservationGeneration
        progressTask = Task { [weak self] in
            await self?.observeProgress(
                generation: generation,
                initialSnapshotLoaded: initialSnapshotLoaded
            )
            self?.finishProgressObservation(generation: generation)
        }
    }

    func stopProgressObservation() {
        stopForeignRunProbe()
        progressObservationGeneration &+= 1
        progressTask?.cancel()
        progressTask = nil
        clearProgressStateForLostAccess()
        isTaskProgressStale = taskProgress != nil
        isAgentRosterStale = agentRoster != nil
    }

    /// Await the current progress observer, if any, without cancelling it or
    /// starting a new one. A finished observer releases its own handle inside
    /// its task body, so this returns only after that release has happened.
    func waitForProgressObservation() async {
        await progressTask?.value
    }

    private func loadProgressSnapshot(
        context: AidenRemoteRequestContext,
        observationGeneration: UInt64? = nil
    ) async {
        guard isCurrentProgressObservation(observationGeneration, context: context),
              canReadTaskProgress || canReadAgentRoster || canReadAppControls else { return }
        var taskFetchFailed = false
        var rosterFetchFailed = false
        do {
            let client = try coordinator.remoteClient(for: context)
            if canReadTaskProgress {
                do {
                    let snapshot = try await client.taskProgress(chatId: chat.id)
                    guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
                    acceptTaskProgress(snapshot)
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    taskFetchFailed = true
                    clearProgressStateIfCredentialRevoked(error)
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    if isProgressAccessDenied(error) { clearTaskProgressState() }
                }
            }
            if canReadAgentRoster {
                do {
                    let snapshot = try await client.agentRoster(chatId: chat.id)
                    guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
                    acceptAgentRoster(snapshot)
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    rosterFetchFailed = true
                    clearProgressStateIfCredentialRevoked(error)
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    if isProgressAccessDenied(error) { clearAgentProgressState() }
                }
            }
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            if isProgressAccessDenied(error) { clearProgressStateForLostAccess() }
        }
        // Each projection owns its freshness. A failed roster refresh must not
        // label a successfully refreshed task snapshot as last-known, or vice
        // versa.
        isTaskProgressStale = taskFetchFailed && taskProgress != nil
        isAgentRosterStale = rosterFetchFailed && agentRoster != nil
    }

    private func observeProgress(generation: UInt64, initialSnapshotLoaded: Bool = false) async {
        var skipsSnapshot = initialSnapshotLoaded
        var cursor = 0
        var cursorEpoch: String?
        var recovery = AidenStreamNetworkRecovery(path: networkPath ?? AidenNetworkAvailability())
        while !Task.isCancelled {
            guard let context = liveOwner else {
                clearProgressState()
                return
            }
            guard isCurrentProgressObservation(generation, context: context),
                  canReadTaskProgress || canReadAgentRoster || canReadAppControls else { return }
            do {
                _ = try await recovery.shouldProbeAfterStreamFailure(onWaiting: { _ in })
            } catch { return }
            guard isCurrentProgressObservation(generation, context: context) else { return }
            if !skipsSnapshot {
                await loadProgressSnapshot(context: context, observationGeneration: generation)
            }
            skipsSnapshot = false
            guard isCurrentProgressObservation(generation, context: context) else { return }
            var serverRequestedDelay = 0
            do {
                let events = try coordinator.remoteClient(for: context).progressEvents(
                    chatId: chat.id,
                    after: cursor,
                    epoch: cursorEpoch,
                    onOpen: { [weak self] resumed in
                        guard let self else { return }
                        await MainActor.run {
                            guard resumed, self.isCurrentProgressObservation(generation, context: context) else { return }
                            self.isTaskProgressStale = false
                            self.isAgentRosterStale = false
                        }
                    }
                )
                for try await event in events {
                    try Task.checkCancellation()
                    guard isCurrentProgressObservation(generation, context: context),
                          event.streamId == chat.id else { return }
                    // A delivered event proves the channel is healthy, so the
                    // next reconnect starts again from the shortest delay.
                    recovery.recordHealthy()
                    applyProgress(event)
                    cursor = event.sequence
                    // An app-control invalidation carries no epoch; keep the
                    // last one so a reconnect never resumes another epoch's cursor.
                    cursorEpoch = event.taskProgress?.epoch ?? event.agentRoster?.epoch ?? cursorEpoch
                }
                if isCurrentProgressObservation(generation, context: context) {
                    // Owner consent can close this stream without an HTTP error.
                    // Until a fresh invalidation arrives, do not show live controls.
                    appControlsCache.clearSnapshots()
                    isTaskProgressStale = taskProgress != nil
                    isAgentRosterStale = agentRoster != nil
                }
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                clearProgressStateIfCredentialRevoked(error)
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard isCurrentProgressObservation(generation, context: context) else { return }
                appControlsCache.clearSnapshots()
                if isProgressAccessDenied(error) {
                    clearProgressState()
                    return
                }
                isTaskProgressStale = taskProgress != nil
                isAgentRosterStale = agentRoster != nil
                // A full progress-connection pool answers 429 with a delay;
                // reconnecting sooner would only be refused again.
                serverRequestedDelay = AidenStreamNetworkRecovery.serverRequestedDelayMilliseconds(after: error)
            }
            do {
                _ = try await recovery.recoverAfterProbeFailure(
                    minimumDelayMilliseconds: serverRequestedDelay,
                    onBackoff: {},
                    onWaiting: { _ in }
                )
            } catch {
                return
            }
        }
    }

    /// A progress stream can finish without the view disappearing (for
    /// example, after a capability denial or a cancelled request). Release the
    /// handle only if this is still the current generation so an older
    /// cancelled observer cannot clear a newly started observer.
    private func finishProgressObservation(generation: UInt64) {
        guard generation == progressObservationGeneration else { return }
        progressTask = nil
        isTaskProgressStale = taskProgress != nil
        isAgentRosterStale = agentRoster != nil
    }

    private func isCurrentProgressObservation(
        _ generation: UInt64?,
        context: AidenRemoteRequestContext
    ) -> Bool {
        guard !isRemoved, coordinator.isLive(context) else {
            clearProgressState()
            return false
        }
        guard let generation else { return true }
        guard generation == progressObservationGeneration && !Task.isCancelled else { return false }
        clearProgressStateForLostAccess()
        return canReadTaskProgress || canReadAgentRoster || canReadAppControls
    }

    private func applyProgress(_ event: AidenRemoteStreamEvent) {
        guard event.shouldApply else { return }
        switch event.type {
        case .taskUpdate:
            guard canReadTaskProgress else {
                clearTaskProgressState()
                return
            }
            guard let snapshot = event.taskProgress,
                  snapshot.chatId == chat.id else { return }
            if acceptTaskProgress(snapshot) || (taskProgress?.epoch == snapshot.epoch && taskProgress?.revision == snapshot.revision) {
                isTaskProgressStale = false
            }
        case .agentsUpdate:
            guard canReadAgentRoster else {
                clearAgentProgressState()
                return
            }
            guard let snapshot = event.agentRoster,
                  snapshot.chatId == chat.id else { return }
            if acceptAgentRoster(snapshot) || (agentRoster?.epoch == snapshot.epoch && agentRoster?.revision == snapshot.revision) {
                isAgentRosterStale = false
            }
        case .appControlsChanged:
            Task { await appControlsCache.refresh(read: readAppControls) }
        case .heartbeat:
            break
        default:
            break
        }
    }

    @discardableResult
    private func acceptTaskProgress(_ snapshot: AidenRemoteChatTaskProgress) -> Bool {
        guard snapshot.chatId == chat.id else { return false }
        guard AidenProgressPresentation.acceptsSnapshot(
            currentEpoch: taskProgress?.epoch,
            currentRevision: taskProgress?.revision,
            incomingEpoch: snapshot.epoch,
            incomingRevision: snapshot.revision
        ) else { return false }
        taskProgress = snapshot
        return true
    }

    @discardableResult
    private func acceptAgentRoster(_ snapshot: AidenRemoteChatAgentRoster) -> Bool {
        guard snapshot.chatId == chat.id else { return false }
        let previousTurnId = lastRosterTurnId
        let accepted = applyAgentRoster(snapshot)
        if accepted, let turnId = snapshot.turnId {
            lastRosterTurnId = turnId
            // A new turn, live or in a snapshot read on (re)connect, may be a
            // run started on the Mac, in Telegram or by the scheduler: attach
            // to it now rather than when the chat is reopened. The first turn
            // this chat sees is looked up too, because its run may have
            // registered after the opening lookup was answered.
            if turnId != previousTurnId, turnId != lastLocalTurnId {
                attachToAnnouncedTurn(reason: previousTurnId == nil ? .firstRosterTurn : .announcedTurn)
            }
        }
        return accepted
    }

    private func applyAgentRoster(_ snapshot: AidenRemoteChatAgentRoster) -> Bool {
        guard let current = agentRoster else {
            historicalAgentRosters.removeAll { $0.epoch != snapshot.epoch }
            agentRoster = snapshot
            return true
        }
        // Roster revision is global for the chat projection, including when a
        // new turn replaces the current roster. Fence stale responses before
        // considering turn transitions so an old turn can never roll back the
        // current view.
        guard AidenProgressPresentation.acceptsSnapshot(
            currentEpoch: current.epoch,
            currentRevision: current.revision,
            incomingEpoch: snapshot.epoch,
            incomingRevision: snapshot.revision
        ) else { return false }
        if current.epoch != snapshot.epoch {
            historicalAgentRosters = []
        }
        if current.turnId != snapshot.turnId {
            if current.epoch == snapshot.epoch, current.turnId != nil {
                upsertHistoricalRoster(current)
            }
            agentRoster = snapshot
            return true
        }
        agentRoster = snapshot
        return true
    }

    private func upsertHistoricalRoster(_ roster: AidenRemoteChatAgentRoster) {
        guard roster.turnId != nil, roster.epoch == agentRoster?.epoch else { return }
        if let existing = historicalAgentRosters.first(where: { $0.turnId == roster.turnId }),
           !AidenProgressPresentation.acceptsSnapshot(
               currentEpoch: existing.epoch,
               currentRevision: existing.revision,
               incomingEpoch: roster.epoch,
               incomingRevision: roster.revision
           ) {
            return
        }
        historicalAgentRosters.removeAll { $0.turnId == roster.turnId }
        historicalAgentRosters.insert(roster, at: 0)
        if historicalAgentRosters.count > 8 {
            historicalAgentRosters.removeLast(historicalAgentRosters.count - 8)
        }
    }

    func loadAgentRoster(turnId: String) async {
        clearProgressStateForLostAccess()
        guard canReadAgentRoster,
              let context = liveOwner,
              coordinator.isLive(context) else {
            clearAgentProgressState()
            return
        }
        do {
            let snapshot = try await coordinator.remoteClient(for: context).agentRoster(
                chatId: chat.id,
                turnId: turnId
            )
            guard !isRemoved, coordinator.isLive(context),
                  snapshot.chatId == chat.id,
                  snapshot.turnId == turnId,
                  snapshot.epoch == agentRoster?.epoch else { return }
            upsertHistoricalRoster(snapshot)
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            if isProgressAccessDenied(error) {
                clearAgentProgressState()
            } else {
                presentedError = String(localized: "That agent session is no longer available.")
            }
        }
    }

    // Await the already scheduled write without starting a new persistence owner.
    func waitForDraftPersistence() async {
        await draftPersistenceTask?.value
    }

    private func scheduleDraftPersistence() {
        // Retained, not live: a re-paired machine is still paired, so its text stays.
        guard !isReadOnlyPresentation, !isRemoved, coordinator.isRetained(owner), let session = draftSession else { return }
        let text = draft
        draftPersistenceTask?.cancel()
        draftPersistenceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self, !self.isRemoved,
                  self.coordinator.isRetained(self.owner),
                  self.draftSession == session,
                  self.draft == text else { return }
            _ = try? await self.draftStore.save(text, session: session)
        }
    }

    func selectProvider(_ providerId: String) {
        guard !chat.isBotChat else { return }
        guard selectedProviderId != providerId else { return }
        selectedProviderId = providerId
        selectedModelId = visibleProviders.first { $0.id == providerId }?.models.first?.id
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
        rememberExplicitModelSelection()
    }

    func selectModel(_ modelId: String) {
        guard !chat.isBotChat else { return }
        guard selectedModelId != modelId else { return }
        selectedModelId = modelId
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
        rememberExplicitModelSelection()
    }

    /// An explicit composer choice stays with this chat. In a new chat (no
    /// messages yet) it becomes this paired Mac's remembered default for later
    /// Workspace chats and launches. In an existing chat it is kept for that
    /// chat alone until its next send, so reopening the chat still shows it and
    /// the model other chats start with never changes.
    private func rememberExplicitModelSelection() {
        hasExplicitModelSelection = true
        guard !isReadOnlyFixture, !isRemoved, !chat.isBotChat,
              let context = liveOwner else { return }
        let selection = AidenChatModelSelection(
            providerId: selectedProviderId,
            modelId: selectedModelId,
            thinkingLevel: selectedThinkingLevel
        )
        if chat.messages.isEmpty {
            modelPreferenceStore.remember(selection, for: context.instanceId)
        } else {
            modelPreferenceStore.rememberChat(selection, for: context.instanceId, chatID: chat.id)
        }
    }

    func setBotVisionModelSelection(_ selection: AidenBotModelSelection?) {
        botVisionModelSelection = selection
    }

    func setBotPrimarySupportsImages(_ supportsImages: Bool?) {
        botPrimarySupportsImages = supportsImages
    }

    /// A Bot without an image model can't look at photos. Say so plainly
    /// instead of opening a setup flow; Advanced is where it can change.
    func requestBotVisionSetup() {
        guard chat.isBotChat, !acceptsImageAttachments else { return }
        presentedError = Self.botCannotSeePhotosMessage
    }

    static let botCannotSeePhotosMessage = "This Bot can’t look at photos yet. You can pick a photo model in its Profile under ••• → Advanced."

    func selectModel(providerId: String, modelId: String, thinkingLevel: String?) {
        guard !chat.isBotChat else { return }
        let next = [providerId, modelId, thinkingLevel ?? ""]
        let current = [selectedProviderId ?? "", selectedModelId ?? "", selectedThinkingLevel ?? ""]
        guard next != current else { return }
        selectedProviderId = providerId
        selectedModelId = modelId
        selectedThinkingLevel = thinkingLevel
        rememberExplicitModelSelection()
    }

    func send(retry: Bool = false) async {
        await send(retry: retry, automatic: false, authority: nil)
    }

    /// `authority` is the pairing that authorized an automatic resend; it is
    /// never swapped for a newer pairing of the same Mac.
    private func send(retry: Bool, automatic: Bool, authority: AidenRemoteRequestContext?) async {
        if !automatic {
            // A person's own send or Retry replaces a scheduled resend.
            cancelRateLimitedSendRetry()
            rateLimitedSendRetries = 0
        }
        if retry, let mode = pendingSend?.inputMode { await submitRunInput(mode, retry: true); return }
        guard !isReadOnlyPresentation else { return }
        let retryAttempt = retry ? pendingSend : nil
        guard retry ? canRetrySend : canSend else { return }
        let text = retryAttempt?.request.text ?? draft.trimmingCharacters(in: .whitespacesAndNewlines)
        switch aidenImageSendRecovery(
            isBotChat: chat.isBotChat,
            acceptsImages: acceptsImageAttachments,
            hasPendingImage: pendingAttachments.contains(where: { $0.kind == .image })
        ) {
        case .proceed:
            break
        case .configureBotVision:
            presentedError = Self.botCannotSeePhotosMessage
            return
        case .chooseImageCapableModel:
            presentedError = String(localized: "The selected model can’t read images. Choose an image-capable model, then try again.")
            return
        }
        // The chat stopped qualifying while the chip was on: keep the message
        // rather than send it to the main checkout.
        if retryAttempt == nil, startsInNewWorktree, !offersNewWorktree {
            startsInNewWorktree = false
            presentedError = AidenNewWorktreeCopy.noLongerOffered
            return
        }
        guard let context = authority ?? liveOwner,
              coordinator.isLive(context) else { return }
        // A saved send is only ever sent with the device credential it was made under.
        if let retryAttempt, retryAttempt.deviceId != context.deviceId { return }
        let submittedAttachments = retryAttempt?.attachments ?? pendingAttachments
        let submittedSkill = selectedSkill
        let modelSelection = turnModelSelection
        let request = retryAttempt?.request ?? AidenTurnRequestBuilder.make(
            text: text,
            providerId: modelSelection.providerId,
            modelId: modelSelection.modelId,
            thinkingLevel: modelSelection.thinkingLevel,
            attachments: submittedAttachments,
            skill: submittedSkill.map(AidenSkillInvocation.init(entry:))
        )
        let makesWorktree = retryAttempt == nil && startsInNewWorktree && offersNewWorktree
        let previousUpdatedAt = chat.updatedAt
        let optimisticID = "local-\(UUID().uuidString.lowercased())"
        let now = Date()
        let optimisticMessage = AidenChatMessage(
            id: optimisticID,
            role: .user,
            text: text,
            attachments: submittedAttachments.map {
                AidenMessageAttachment(
                    id: $0.id,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    kind: $0.kind,
                    size: $0.size
                )
            },
            createdAt: now
        )

        composerGeneration &+= 1
        transcriptGeneration &+= 1
        titleRefreshTask?.cancel()
        titleRefreshTask = nil
        titleRefreshID = nil
        stopVisualSnapshotRefresh()
        explicitSendCount &+= 1
        isStarting = true
        defer {
            isStarting = false
            transcriptGeneration &+= 1
            if !isRemoved, coordinator.isLive(context), chat.isTitlePending { schedulePendingTitleRefresh(context: context) }
        }
        presentedError = nil
        draftPersistenceTask?.cancel()
        suppressesDraftPersistence = true
        if retryAttempt == nil || draft == text { draft = "" }
        suppressesDraftPersistence = false
        let clearedDraftGeneration = draftGeneration
        pendingAttachments = retryAttempt == nil ? [] : pendingAttachments.filter { attachment in !submittedAttachments.contains { $0.id == attachment.id } }
        chat.messages.append(optimisticMessage)
        chat.updatedAt = now
        streamState = .queued
        let attempt = retryAttempt ?? AidenChatDraftStore.PendingSend(deviceId: context.deviceId, request: request,
            key: turnAttempts.key(for: request), createdAt: Date(), attachments: submittedAttachments)
        let idempotencyKey = attempt.key
        /// Takes the message back out of the chat. A Cancel can come long after
        /// the send (New worktree waits on a fetch), so anything typed meanwhile
        /// stays beside it.
        func restoreFailedSend() {
            chat.messages.removeAll { $0.id == optimisticID }
            chat.updatedAt = previousUpdatedAt
            draft = AidenDraftSendReconciliation.failedDraft(submitted: text, current: draft)
            pendingAttachments = AidenDraftSendReconciliation.failedAttachments(
                submitted: submittedAttachments,
                current: pendingAttachments
            )
            streamState = nil
        }
        do {
            if makesWorktree {
                // Revision 53: the Mac makes the worktree and moves this empty
                // chat into it before the message is sent there.
                let key = worktreeAttempt?.text == text ? worktreeAttempt!.key : UUID()
                worktreeAttempt = (text, key)
                let client = try coordinator.remoteClient(for: context)
                let chatId = chat.id
                let revision = chat.revision
                let setup = Task {
                    try await client.moveChatToNewWorktree(id: chatId, revision: revision, text: text, idempotencyKey: key)
                }
                worktreeSetupTask = setup
                worktreeSetupCanceled = false
                isSettingUpWorktree = true
                defer {
                    isSettingUpWorktree = false
                    worktreeSetupTask = nil
                }
                let moved: AidenChatNewWorktree
                do {
                    moved = try await withTaskCancellationHandler {
                        try await setup.value
                    } onCancel: {
                        setup.cancel()
                    }
                } catch {
                    if AidenNewWorktreeRetry.spendsKey(error) { worktreeAttempt = nil }
                    throw error
                }
                guard !isRemoved, coordinator.isLive(context) else { return }
                chat.workspaceId = moved.chat.workspaceId
                chat.revision = moved.chat.revision
                startsInNewWorktree = false
                worktreeAttempt = nil
                // Only the selected machine's list can refresh. Another machine's
                // catches up the next time it is selected.
                if coordinator.activeInstanceId == instanceId {
                    Task { await coordinator.refreshWorkspaces() }
                }
                // Canceled as the worktree arrived: the chat stays there, unsent.
                if setup.isCancelled || worktreeSetupCanceled { throw CancellationError() }
            }
            let session: AidenChatDraftStore.Session
            if let existing = draftSession { session = existing }
            else {
                session = await draftStore.beginSession(instanceId: instanceId, chatId: chat.id)
                draftSession = session
            }
            try await draftStore.savePendingSend(attempt, session: session)
            guard !isRemoved, coordinator.isLive(context) else { return }
            pendingSend = attempt
            isPendingSendRefusedBecauseBusy = false
            guard attempt.canRetry(), coordinator.isLive(context) else { throw AidenRemoteClientError.invalidResponse }
            let response = try await coordinator.remoteClient(for: context).startTurn(
                chatId: chat.id,
                request: request,
                idempotencyKey: idempotencyKey
            )
            // The Mac now holds this pick as the chat's own model.
            if !chat.isBotChat {
                modelPreferenceStore.forgetChat(
                    for: context.instanceId,
                    chatID: chat.id,
                    matching: AidenChatModelSelection(
                        providerId: request.providerId,
                        modelId: request.modelId,
                        thinkingLevel: request.thinkingLevel
                    )
                )
            }
            guard !isRemoved else { return }
            for reference in submittedAttachments { ownedUploadReferences.removeValue(forKey: reference.id) }
            let stream = AidenChatCache.ActiveStream(
                deviceId: context.deviceId,
                streamId: response.streamId,
                turnId: response.turnId,
                lastSequence: 0
            )
            var acceptedChat = chat
            acceptedChat.messages.removeAll { $0.id == optimisticID }
            if !acceptedChat.messages.contains(where: { $0.id == response.message.id }) {
                acceptedChat.messages.append(response.message)
            }
            // A normal installation switch retains an accepted turn for later
            // resume. Forgetting, revoking, or re-pairing the captured device
            // invalidates the context before any private cache/activity write.
            let writeToken = cache.reserveChatWrite()
            var acceptedWriteToken = writeToken
            var startedActivity = false
            var accepted = false
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                guard !isRemoved else { return }
                await draftStore.settlePendingSend(key: attempt.key, session: session)
                accepted = (try? await cache.saveChat(acceptedChat, instanceId: instanceId, writeToken: writeToken)) ?? true
                while !accepted {
                    guard !isRemoved else { return }
                    // Rebase the receipt on the winning local snapshot. This
                    // does not depend on another network read or resend POST.
                    // Reserve before loading so removal/new writes still win.
                    // Read the admitted winner, not disk: its file write may
                    // have failed, leaving no file or an older snapshot.
                    let retryToken = cache.reserveChatWrite()
                    guard var current = await cache.admittedChat(instanceId: instanceId, chatId: chat.id),
                          !isRemoved, coordinator.isRetained(context) else { return }
                    if !current.messages.contains(where: { $0.id == response.message.id }) {
                        current.messages.append(response.message)
                    }
                    accepted = (try? await cache.saveChat(current, instanceId: instanceId, writeToken: retryToken)) ?? true
                    if accepted { acceptedChat = current; acceptedWriteToken = retryToken }
                }
                accepted = (try? await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id, chatWriteToken: acceptedWriteToken)) ?? true
                guard accepted else { return }
                if let draftSession,
                   draftGeneration == clearedDraftGeneration,
                   draft.isEmpty {
                    _ = try? await draftStore.save("", session: draftSession)
                }
                guard !isRemoved, cache.isChatWriteRetained(acceptedWriteToken, instanceId: instanceId, chatId: chat.id) else {
                    accepted = false
                    return
                }
                startedActivity = true
                await liveActivities.start(
                    instanceID: instanceId,
                    chatID: chat.id,
                    title: chat.displayTitle,
                    streamID: response.streamId
                )
            }
            accepted = accepted && cache.isChatWriteRetained(acceptedWriteToken, instanceId: instanceId, chatId: chat.id)
            await beforeConsumerAdmission?()
            guard retained, accepted, !isRemoved else {
                if startedActivity {
                    await liveActivities.updateStatus(instanceID: instanceId, streamID: stream.streamId, state: .cancelled)
                }
                if coordinator.isLive(context) {
                    chat.messages.removeAll { $0.id == optimisticID }
                    streamState = nil
                }
                return
            }
            guard !isRemoved, coordinator.isLive(context) else { return }
            pendingSend = nil
            isPendingSendRefusedBecauseBusy = false
            turnAttempts.reset()
            rateLimitedSendRetries = 0
            if chat.messages.contains(where: { $0.id == optimisticID }) {
                messageRenderIDs[response.message.id] = optimisticID
            }
            chat = acceptedChat
            if retryAttempt == nil { selectedSkill = nil }
            if retryAttempt != nil, draft == text || draft.hasPrefix(text + "\n\n") { consumeRunInputDraft(text) }
            replaceLiveText("")
            reasoning = ""
            tools = []
            activityTimeline = nil
            pendingApproval = nil
            pendingQuestion = nil
            streamState = .queued
            coordinator.haptics.play(.actionStarted, scope: hapticScope, dedupeKey: "turn-start:\(response.streamId)")
            startStreaming(stream, context: context, feedbackPolicy: .localTurn)
        } catch let error where aidenIsCancellation(error) {
            guard !isRemoved, coordinator.isLive(context) else { return }
            restoreFailedSend()
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                // The selected machine leaves with its chats. Another machine's
                // record stays while this chat is on screen, so the person gets
                // their words back. Nothing can retry over a revoked pairing.
                guard !isRemoved, coordinator.isRetained(context) else { return }
                restoreFailedSend()
                if let session = draftSession { await draftStore.settlePendingSend(key: attempt.key, session: session) }
                pendingSend = nil
                isPendingSendRefusedBecauseBusy = false
                presentedError = AidenDockCopy.machineRevoked
                coordinator.haptics.play(.error, scope: hapticScope)
                return
            }
            guard !isRemoved, coordinator.isLive(context) else { return }
            restoreFailedSend()
            if let rateLimit = error as? AidenRemoteClientError, rateLimit.isRetryableRateLimit,
               let session = draftSession,
               await scheduleRateLimitedSendRetry(replacing: attempt, error: rateLimit, session: session, context: context) {
                // The Mac was only busy: keep the send and try it again.
                return
            }
            if case AidenRemoteClientError.server(let status, let body) = error,
               AidenDraftSendReconciliation.refusalSettlesSend(status: status, code: body.code),
               let session = draftSession {
                await draftStore.settlePendingSend(key: attempt.key, session: session)
                pendingSend = nil
                isPendingSendRefusedBecauseBusy = false
                turnAttempts.reset()
                rateLimitedSendRetries = 0
            }
            if pendingSend == nil { presentedError = error.localizedDescription }
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// Both picker callbacks enter here synchronously, before transferring or
    /// converting selected files. Selection already owns the composer even
    /// though no upload reference exists yet.
    @discardableResult
    func prepareAttachments<Selection>(
        _ selection: Result<[Selection], Error>,
        prepare: @escaping @MainActor (Selection) async throws -> AidenAttachmentUpload
    ) -> Task<Void, Never>? {
        guard !isReadOnlyPresentation, !isRemoved else { return nil }
        let selections: [Selection]
        do {
            selections = try selection.get()
        } catch let error where aidenIsCancellation(error) {
            return nil
        } catch let error as CocoaError where error.code == .userCancelled {
            return nil
        } catch {
            presentedError = String(localized: "One selected attachment could not be added. Other attachments are still ready to send.")
            return nil
        }
        let capacity = max(0, 10 - pendingAttachments.count)
        guard !selections.isEmpty, capacity > 0,
              isConnected, !isPreparingAttachments, !isUploadingAttachment, !isStarting, !isStreaming,
              let context = liveOwner else { return nil }
        composerGeneration &+= 1
        let preparationID = UUID()
        attachmentPreparationID = preparationID
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if attachmentPreparationID == preparationID {
                    attachmentPreparationID = nil
                    attachmentPreparationTask = nil
                }
            }
            var uploads: [AidenAttachmentUpload] = []
            var failures = max(0, selections.count - capacity)
            for selection in selections.prefix(capacity) {
                guard !isRemoved, !Task.isCancelled, coordinator.isLive(context) else { return }
                do {
                    uploads.append(try await prepare(selection))
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    failures += 1
                }
            }
            guard !isRemoved, !Task.isCancelled, coordinator.isLive(context),
                  attachmentPreparationID == preparationID else { return }
            failures += await upload(uploads)
            guard !isRemoved, !Task.isCancelled, coordinator.isLive(context),
                  attachmentPreparationID == preparationID else { return }
            if failures > 0 {
                presentedError = failures == 1
                    ? String(localized: "One selected attachment could not be added. Other attachments are still ready to send.")
                    : String(localized: "\(failures) selected attachments could not be added. Other attachments are still ready to send.")
            }
        }
        attachmentPreparationTask = task
        return task
    }

    func cancelAttachmentPreparation() {
        attachmentPreparationTask?.cancel()
        attachmentPreparationTask = nil
        attachmentPreparationID = nil
    }

    @discardableResult
    func upload(_ uploads: [AidenAttachmentUpload]) async -> Int {
        guard uploadTask == nil, !isRemoved else { return uploads.count }
        let task = Task { await performUpload(uploads) }
        uploadTask = task
        let failures = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        uploadTask = nil
        await joinDeferredUploadRevocation()
        return failures
    }

    private func deferUploadRevocation(_ error: Error, context: AidenRemoteRequestContext) -> Bool {
        guard let error = error as? AidenRemoteClientError, error.isCredentialRevoked else { return false }
        uploadRevocation = (error, context)
        return true
    }

    /// Starts the deferred revocation at most once. Whichever path claims it —
    /// the upload/removal caller or a lifetime cleanup that purge joins — the
    /// handling lives in one owned task, so the caller can await it without
    /// the cleanup ever awaiting the purge that joins it.
    @discardableResult
    private func startDeferredUploadRevocation() -> Task<Void, Never>? {
        if let (error, context) = uploadRevocation {
            uploadRevocation = nil
            let coordinator = coordinator
            // A later revocation may arrive while an earlier purge is running;
            // its coordinator call returns at once for the stale context, so
            // the replacement must still finish only after the earlier purge.
            let previous = uploadRevocationTask
            uploadRevocationTask = Task {
                await previous?.value
                _ = await coordinator.handleCredentialRevocation(error, context: context)
            }
        }
        return uploadRevocationTask
    }

    /// Callers outside lifetime cleanup finish only after revocation has been
    /// handled, even when removal cleanup claimed it first.
    private func joinDeferredUploadRevocation() async {
        guard let revocation = startDeferredUploadRevocation() else { return }
        await revocation.value
        if uploadRevocationTask == revocation { uploadRevocationTask = nil }
    }

    private func performUpload(_ uploads: [AidenAttachmentUpload]) async -> Int {
        guard !uploads.isEmpty else { return 0 }
        guard !isReadOnlyPresentation, !isRemoved else { return uploads.count }
        guard isConnected, !isUploadingAttachment, !isStreaming, pendingAttachments.count < 10 else {
            return uploads.count
        }
        guard let context = liveOwner else { return uploads.count }
        guard let uploadClient = try? coordinator.remoteClient(for: context) else { return uploads.count }
        let imageWriteToken = cache.reserveChatWrite()
        composerGeneration &+= 1
        isUploadingAttachment = true
        presentedError = nil
        let progressID = UUID()
        uploadProgressID = progressID
        stopKeepsStagedUploads = false
        defer {
            isUploadingAttachment = false
            if uploadProgressID == progressID {
                uploadProgressID = nil
                uploadProgress = nil
            }
        }
        // Revision 50: a Mac that granted `attachments:raw` takes a picture as its own bytes.
        let rawImages = ownerServer?.supportsRawUploads == true
        let batch = Array(uploads.prefix(10 - pendingAttachments.count))
        var failedCount = 0
        var acceptedReferences: [AidenAttachmentReference] = []
        for (index, upload) in batch.enumerated() {
            if isRemoved || Task.isCancelled {
                await cleanupCancelledUpload(acceptedReferences)
                return uploads.count
            }
            uploadProgress = AidenUploadProgress(index: index, count: batch.count, fraction: 0)
            do {
                let reference = try await uploadClient.uploadAttachment(
                    chatId: chat.id,
                    upload: upload,
                    rawImages: rawImages,
                    progress: { [weak self] fraction in
                        Task { @MainActor in
                            self?.recordUploadProgress(fraction, index: index, id: progressID)
                        }
                    }
                )
                guard reference.isValid() else { throw AidenRemoteClientError.invalidResponse }
                ownedUploadReferences[reference.id] = (reference, context, uploadClient)
                guard !isRemoved, coordinator.isLive(context) else {
                    acceptedReferences.append(reference)
                    await cleanupCancelledUpload(acceptedReferences)
                    return uploads.count
                }
                if Task.isCancelled {
                    acceptedReferences.append(reference)
                    await cleanupCancelledUpload(acceptedReferences)
                    return uploads.count
                }
                pendingAttachments.append(reference)
                acceptedReferences.append(reference)
                if case .image(_, let mimeType, let data) = upload {
                    let attachment = AidenMessageAttachment(
                        id: reference.id,
                        name: reference.name,
                        mimeType: mimeType,
                        kind: .image,
                        size: reference.size
                    )
                    if isRemoved || Task.isCancelled {
                        await cleanupCancelledUpload(acceptedReferences)
                        return uploads.count
                    }
                    _ = try? await cache.saveAttachmentImage(
                        data,
                        instanceId: instanceId,
                        deviceId: context.deviceId,
                        chatId: chat.id,
                        attachment: attachment,
                        writeToken: imageWriteToken
                    )
                    if isRemoved || Task.isCancelled {
                        await cleanupCancelledUpload(acceptedReferences)
                        return uploads.count
                    }
                }
            } catch let error where aidenIsCancellation(error) {
                await cleanupCancelledUpload(acceptedReferences)
                return uploads.count
            } catch {
                if deferUploadRevocation(error, context: context) {
                    return uploads.count
                }
                guard !isRemoved, coordinator.isLive(context) else { return uploads.count }
                failedCount += 1
            }
        }
        if failedCount > 0 {
            presentedError = failedCount == 1
                ? String(localized: "One attachment could not be uploaded. Other attachments are still ready to send.")
                : String(localized: "\(failedCount) attachments could not be uploaded. Other attachments are still ready to send.")
            coordinator.haptics.play(acceptedReferences.isEmpty ? .error : .warning, scope: hapticScope)
        }
        return failedCount
    }

    /// A late report from an earlier upload or batch never moves the bar back.
    private func recordUploadProgress(_ fraction: Double, index: Int, id: UUID) {
        guard uploadProgressID == id, let current = uploadProgress, current.index == index,
              let next = current.advanced(to: fraction) else { return }
        uploadProgress = next
    }

    /// Stop on the progress bar: the upload in flight is dropped; what already
    /// reached the Mac stays ready to send, as on Android.
    func cancelUploads() {
        guard isUploadingAttachment else { return }
        stopKeepsStagedUploads = true
        cancelAttachmentPreparation()
        uploadTask?.cancel()
    }

    private func cleanupCancelledUpload(
        _ references: [AidenAttachmentReference]
    ) async {
        // A closed chat drops everything; Stop keeps the attachments already shown.
        let kept = stopKeepsStagedUploads && !isRemoved ? Set(pendingAttachments.map(\.id)) : []
        for reference in references where !kept.contains(reference.id) {
            await cleanupOwnedAttachment(reference.id)
        }
    }

    private func cleanupOwnedAttachment(_ id: String) async {
        if let cleanup = attachmentCleanupTasks[id] { await cleanup.value; return }
        guard let (reference, context, cleanupClient) = ownedUploadReferences.removeValue(forKey: id) else { return }
        pendingAttachments.removeAll { $0.id == id }
        let cleanup = Task { @MainActor [self] in
            await cache.removeAttachmentImage(instanceId: instanceId, deviceId: context.deviceId, chatId: chat.id, attachmentId: reference.id)
            do {
                try await cleanupClient.removeAttachment(chatId: chat.id, attachmentId: reference.id)
            } catch {
                _ = deferUploadRevocation(error, context: context)
            }
        }
        attachmentCleanupTasks[id] = cleanup
        await cleanup.value
        attachmentCleanupTasks.removeValue(forKey: id)
    }

    private func cleanupOwnedAttachmentsForRemoval() async {
        await beforeRemovalAttachmentCleanup?()
        for id in Set(ownedUploadReferences.keys).union(attachmentCleanupTasks.keys) {
            await cleanupOwnedAttachment(id)
        }
        // Do not await a purge from the lifetime cleanup that purge joins. The
        // upload caller joins the owned task instead.
        startDeferredUploadRevocation()
    }

    @discardableResult
    func upload(_ upload: AidenAttachmentUpload) async -> Int {
        await self.upload([upload])
    }

    func removeAttachment(_ attachment: AidenAttachmentReference) async {
        guard !isReadOnlyPresentation, !isStarting, !isRemoved,
              pendingAttachments.contains(where: { $0.id == attachment.id }) else { return }
        await cleanupOwnedAttachment(attachment.id)
        await joinDeferredUploadRevocation()
    }

    func finishImageArrivalReveal(generationID: String) {
        imageArrivalRevealGenerationIDs.remove(generationID)
    }

    func attachmentImageData(for attachment: AidenMessageAttachment) async -> Data? {
        guard !isReadOnlyFixture, !isRemoved else { return nil }
        guard attachment.kind == .image,
              let context = liveOwner
        else { return nil }
        let imageWriteToken = cache.reserveChatWrite()
        if let cached = await cache.attachmentImage(
            instanceId: instanceId,
            deviceId: context.deviceId,
            chatId: chat.id,
            attachment: attachment
        ) {
            guard !isRemoved, coordinator.isLive(context) else { return nil }
            return cached
        }
        guard !isRemoved, coordinator.isLive(context) else { return nil }
        do {
            let content = try await coordinator.remoteClient(for: context).attachmentContent(
                chatId: chat.id,
                attachmentId: attachment.id
            )
            guard !isRemoved, coordinator.isLive(context),
                  content.mimeType == attachment.mimeType,
                  let data = await AidenAttachmentImageDecoding.validatedData(
                      content.data,
                      mimeType: content.mimeType,
                      declaredSize: attachment.size
                  )
            else { return nil }
            guard !isRemoved, coordinator.isLive(context) else { return nil }
            let accepted = (try? await cache.saveAttachmentImage(
                data,
                instanceId: instanceId,
                deviceId: context.deviceId,
                chatId: chat.id,
                attachment: attachment,
                writeToken: imageWriteToken
            )) ?? true
            guard accepted, !isRemoved, coordinator.isLive(context) else { return nil }
            return data
        } catch {
            _ = await coordinator.handleCredentialRevocation(error, context: context)
            return nil
        }
    }

    /// This pairing has saved viewer documents on disk.
    var hasSavedVisualDocuments = false

    func pendingAttachmentImageData(for attachment: AidenAttachmentReference) async -> Data? {
        guard attachment.kind == .image else { return nil }
        return await attachmentImageData(for: AidenMessageAttachment(
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            size: attachment.size
        ))
    }

    var canControlCurrentRun: Bool {
        if activeStreamID == nil, foreignRun != nil { return canControlForeignRun }
        guard !isReadOnlyPresentation, isConnected, isStreaming,
              activeStreamID != nil,
              let installation = ownerInstallation,
              installation.instanceId == instanceId,
              installation.deviceCapabilities.contains(.chatWrite) else { return false }
        return chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
            && installation.hasNegotiatedAccess(to: .botWrite))
    }

    /// A launch intent belongs to the chat lifetime, not a removable composer.
    /// Consume before awaiting capture so remounts cannot replay it.
    func startVoiceForLaunch(if requested: Bool, start: () async -> Void) async {
        guard requested, !didConsumeVoiceLaunch else { return }
        didConsumeVoiceLaunch = true
        guard !isReadOnlyPresentation, !isRemoved, isConnected, !isStreaming, pendingQuestion == nil,
              liveOwner != nil, !Task.isCancelled else { return }
        await start()
    }

    @discardableResult
    func stop() async -> Bool {
        if activeStreamID == nil, foreignRun != nil, !isRemoved { return await stopForeignRun() }
        guard canControlCurrentRun, !isStopping, !isReadOnlyPresentation,
              !isRemoved, let streamID = activeStreamID,
              let context = liveOwner else { return false }
        // Reserve before the cache read yields so simultaneous taps cannot both
        // dispatch, and keep the current run visible until the Mac confirms Stop.
        isStopping = true
        defer { isStopping = false }
        return await cancelStreamOnce(streamID: streamID, context: context)
    }

    /// Cancel core for Stop. Callers hold `isStopping` so
    /// the composer controls stay inert for the whole operation.
    private func cancelStreamOnce(
        streamID expectedStreamID: String,
        context: AidenRemoteRequestContext
    ) async -> Bool {
        guard let stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id),
              !isRemoved, coordinator.isLive(context), canControlCurrentRun,
              activeStreamID == expectedStreamID, stream.streamId == expectedStreamID,
              stream.deviceId == context.deviceId, streamState?.isTerminal != true else { return false }
        do {
            let status = try await coordinator.remoteClient(for: context).cancelStream(id: stream.streamId)
            guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId,
                  streamState?.isTerminal != true else { return false }
            guard status.streamId == stream.streamId, status.chatId == chat.id else {
                presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
                return false
            }
            await apply(status, streamID: stream.streamId, context: context, feedbackPolicy: .restoredStream)
            coordinator.haptics.play(.actionStopped, scope: hapticScope, dedupeKey: "turn-stop:\(stream.streamId)")
            return true
        } catch let error where aidenIsCancellation(error) {
            // Cancellation does not prove that the Mac stopped or rejected the
            // run. Preserve any status or approval received while awaiting it.
            return false
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId,
                  streamState?.isTerminal != true else { return false }
            presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
            coordinator.haptics.play(.error, scope: hapticScope)
            return false
        }
    }

    var supportsRunInput: Bool {
        guard !isReadOnlyFixture else { return false }
        return ownerServer?.supportsChatRunInput == true
    }

    /// The busy composer shows the Steer/Queue pill only when the server
    /// negotiated the feature. Old servers keep the Stop-only control.
    var showsRunInputOptions: Bool {
        AidenRunInputPresentation.offersRunInput(
            isStreaming: isStreaming,
            // Steer/Queue on a foreign run is not offered yet: Stop only.
            canControl: canControlCurrentRun && foreignRun == nil,
            supports: supportsRunInput
        )
    }

    var canSubmitRunInput: Bool {
        showsRunInputOptions && pendingSend == nil && sendRecoveryError == nil && pendingAttachments.isEmpty && selectedSkill == nil && !isSubmittingRunInput && !isStopping
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Picking a mode sends the draft in that mode; with nothing to send it only
    /// switches the pill.
    func selectRunInputMode(_ mode: AidenStreamInputMode) async {
        runInputMode = mode
        guard canSubmitRunInput else { return }
        await submitRunInput(mode)
    }

    func submitRunInput(_ mode: AidenStreamInputMode, retry: Bool = false) async {
        let saved = retry ? pendingSend : nil
        let text = saved?.request.text ?? draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (retry ? canRetrySend : canSubmitRunInput), !text.isEmpty,
              let streamID = saved?.streamId ?? activeStreamID,
              let context = liveOwner else { return }
        let key: UUID
        if let saved { key = saved.key }
        else if AidenRunInputPresentation.reusesIdempotencyKey(
            last: lastRunInputAttempt, streamId: streamID, mode: mode, text: text
        ), let last = lastRunInputAttempt {
            key = last.key
        } else {
            key = UUID()
        }
        let attempt = AidenRunInputPresentation.Attempt(
            key: key, streamId: streamID, mode: mode, text: text
        )
        lastRunInputAttempt = attempt
        isSubmittingRunInput = true
        defer { isSubmittingRunInput = false }
        // The draft clears the moment the input leaves, like a sent message; it
        // comes back if the Mac rejects or never confirms it and nothing new was
        // typed meanwhile. Only the screen clears now: the saved draft is the
        // text's durable copy until the Mac admits it, so a rejection that lands
        // after this screen or pairing changed still leaves it on disk.
        // A retry resends the saved text, not the draft.
        let draftBeforeSend = draft
        let draftAfterSend = retry ? draft : AidenRunInputPresentation.consumedDraft(submitted: text, current: draft)
        if !retry { clearRunInputDraftOnScreen(text) }
        let restoreDraft = { [self] in
            guard !retry else { return }
            restoreRunInputDraft(submitted: text, previous: draftBeforeSend, consumedTo: draftAfterSend)
        }
        do {
            let session: AidenChatDraftStore.Session
            if let existing = draftSession { session = existing }
            else { session = await draftStore.beginSession(instanceId: instanceId, chatId: chat.id); draftSession = session }
            let pending = saved ?? AidenChatDraftStore.PendingSend(deviceId: context.deviceId, request: AidenTurnStart(text: text), key: key,
                createdAt: Date(), attachments: [], streamId: streamID, inputMode: mode)
            try await draftStore.savePendingSend(pending, session: session)
            pendingSend = pending
            isPendingSendRefusedBecauseBusy = false
            guard pending.canRetry(), coordinator.isLive(context) else { throw AidenRemoteClientError.invalidResponse }
            let result = try await coordinator.remoteClient(for: context).submitStreamInput(
                id: streamID,
                input: AidenStreamInputRequest(mode: mode, text: text),
                idempotencyKey: key
            )
            // The response must bind to the stream that was displayed when the
            // submission left; a mismatched receipt is never trusted.
            guard result.streamId == streamID, result.chatId == chat.id, result.mode == mode else {
                guard coordinator.isLive(context) else { return }
                restoreDraft()
                presentedError = String(localized: "The run input was not confirmed. Your draft is back — check the chat before trying again.")
                return
            }
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                guard !isRemoved else { return }
                await draftStore.settlePendingSend(key: key, session: session)
                // The admitted text leaves the saved draft under the same
                // ownership, so a screen or pairing change before this answer
                // cannot offer it again as an unsent draft. A draft typed and
                // saved since is left alone.
                if !retry, AidenRunInputPresentation.consumesDraft(result) {
                    await draftStore.consumeDraft(submitted: text, from: draftBeforeSend, session: session)
                }
            }
            guard retained, !isRemoved, coordinator.isLive(context) else { return }
            pendingSend = nil
            isPendingSendRefusedBecauseBusy = false
            if lastRunInputAttempt == attempt { lastRunInputAttempt = nil }
            if AidenRunInputPresentation.consumesDraft(result) {
                if retry { consumeRunInputDraft(text) } else { persistDraftNow() }
                if let receipt = AidenRunInputPresentation.receipt(for: result) {
                    showRunInputReceipt(receipt)
                }
                coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "run-input:\(key.uuidString)")
                // The Mac persisted the message before queue admission; pull it
                // into the transcript without waiting for the next turn.
                _ = await reconcileChat(context: context)
            } else {
                restoreDraft()
                presentedError = AidenRunInputPresentation.rejectionMessage(result.reason)
                coordinator.haptics.play(.error, scope: hapticScope)
            }
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context) else { return }
            restoreDraft()
            presentedError = String(localized: "The run input was not confirmed. Your draft is back — check the chat before trying again.")
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    var canReadAppControls: Bool {
        guard !isReadOnlyFixture, chat.botId == nil,
              ownerServer?.features.contains("chat-ui-panels-enabled-v1") == true,
              let installation = ownerInstallation,
              installation.instanceId == instanceId else { return false }
        return installation.hasNegotiatedAccess(to: .appControlsRead)
    }
    func loadAppControls(_ panel: AidenAppControlPanel) async throws -> AidenAppControlSnapshot {
        try await appControlsCache.load(panel, read: readAppControls)
    }
    private func readAppControls(_ panel: AidenAppControlPanel) async throws -> AidenAppControlSnapshot {
        guard canReadAppControls else { throw AidenRemoteClientError.invalidResponse }
        let context = owner
        let client = try coordinator.remoteClient(for: context)
        let value = try await client.appControls(chatId: chat.id, panelId: panel.id)
        guard coordinator.isLive(context), canReadAppControls, panel.workspaceId == chat.workspaceId else { throw CancellationError() }
        return value
    }
    func applyAppControl(_ panel: AidenAppControlPanel, operation: AidenAppControlOperation) async throws -> AidenAppControlReceipt {
        guard canReadAppControls, ownerInstallation?.hasNegotiatedAccess(to: .appControlsRespond) == true, panel.workspaceId == chat.workspaceId else { throw AidenRemoteClientError.invalidResponse }
        let context = owner
        let client = try coordinator.remoteClient(for: context)
        let value = try await client.applyAppControl(chatId: chat.id, panelId: panel.id, operation: operation)
        guard coordinator.isLive(context), canReadAppControls else { throw CancellationError() }
        await appControlsCache.refresh(read: readAppControls)
        return value
    }

    var skillCatalog: [AidenRemoteSkillCatalogEntry] = []
    var selectedSkill: AidenRemoteSkillCatalogEntry?
    var skillCatalogLoaded = false
    var skillCatalogRetryPending = true
    var mentionAgents: [AidenRemoteChatAgent]?
    var mentionAgentsLoaded = false
    var mentionAgentsRetryPending = true
    var mentionFiles: [AidenWorkspaceFileEntry] = []
    var mentionFilesLoaded = false
    var mentionFilesRetryPending = true
    @ObservationIgnored var skillCatalogTask: Task<Void, Never>?
    @ObservationIgnored var mentionAgentsTask: Task<Void, Never>?
    @ObservationIgnored var mentionFilesTask: Task<Void, Never>?

    private func consumeRunInputDraft(_ text: String) {
        let remaining = AidenRunInputPresentation.consumedDraft(submitted: text, current: draft)
        guard remaining != draft else { return }
        draftPersistenceTask?.cancel()
        suppressesDraftPersistence = true
        draft = remaining
        suppressesDraftPersistence = false
        let clearedDraftGeneration = draftGeneration
        if let draftSession {
            Task { [weak self] in
                guard let self, draftGeneration == clearedDraftGeneration, draft == remaining else { return }
                _ = try? await draftStore.save(remaining, session: draftSession)
            }
        }
    }

    /// Clears the submitted text from the composer without touching the saved
    /// draft; `persistDraftNow` commits it once the Mac admits the input.
    private func clearRunInputDraftOnScreen(_ text: String) {
        let remaining = AidenRunInputPresentation.consumedDraft(submitted: text, current: draft)
        guard remaining != draft else { return }
        draftPersistenceTask?.cancel()
        suppressesDraftPersistence = true
        draft = remaining
        suppressesDraftPersistence = false
    }

    /// Saves the draft as it is now, unless it changes again first.
    private func persistDraftNow() {
        let value = draft
        let generation = draftGeneration
        guard let draftSession else { return }
        Task { [weak self] in
            guard let self, draftGeneration == generation, draft == value else { return }
            _ = try? await draftStore.save(value, session: draftSession)
        }
    }

    /// Puts a draft back after a run input the Mac rejected or never confirmed.
    /// Text typed since it was cleared is kept under the rejected text, as a
    /// failed send keeps it.
    private func restoreRunInputDraft(submitted: String, previous: String, consumedTo remaining: String) {
        guard previous != remaining else { return }
        let restored = draft == remaining ? previous : AidenDraftSendReconciliation.failedDraft(submitted: submitted, current: draft)
        guard restored != draft else { return }
        draftPersistenceTask?.cancel()
        suppressesDraftPersistence = true
        draft = restored
        suppressesDraftPersistence = false
        let restoredDraftGeneration = draftGeneration
        if let draftSession {
            Task { [weak self] in
                guard let self, draftGeneration == restoredDraftGeneration, draft == restored else { return }
                _ = try? await draftStore.save(restored, session: draftSession)
            }
        }
    }

    func showRunInputReceipt(_ text: String) {
        runInputReceiptTask?.cancel()
        runInputReceipt = text
        runInputReceiptTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.runInputReceipt = nil
        }
    }

    func respondToApproval(
        _ decision: AidenApprovalDecision,
        approvalID: String,
        scope: AidenApprovalScope = .once
    ) async {
        guard !isReadOnlyPresentation, isConnected, !isRespondingToApproval, !isStopping,
              let approval = pendingApproval, approval.id == approvalID else { return }
        guard approval.expiresAt > Date() else {
            pendingApproval = nil
            return
        }
        if activeStreamID == nil, foreignRun != nil {
            await respondToForeignApproval(decision, approval: approval, scope: scope)
            return
        }
        guard let streamID = activeStreamID,
              let context = liveOwner else { return }
        isRespondingToApproval = true
        defer { isRespondingToApproval = false }
        let capabilities = approvalCapabilities(for: context)
        let authorization = AidenApprovalResponseAuthorization.resolve(
            approval: approval, decision: decision, capabilities: capabilities
        )
        guard authorization == .allowed else {
            presentedError = switch authorization {
            case .allowed:
                nil
            case .approvalResponseRequired:
                String(localized: "Approval response access was removed from this paired device. The request has been refreshed without sending a decision.")
            case .scheduleWriteRequired:
                String(localized: "Schedule write access was removed from this paired device. The task was not approved.")
            case .hostApprovalRequired:
                String(localized: "This request can only be approved on your paired desktop.")
            }
            pendingApproval = nil
            streamState = .reconciling
            await restorePendingApproval(streamID: streamID, context: context)
            return
        }
        // Only a scope the Mac offered for this exact approval is ever sent.
        let requestedScope: AidenApprovalScope? = decision == .allow && scope != .once
            && approval.scopes.contains(scope) ? scope : nil
        pendingApproval = nil
        streamState = .running
        do {
            let response = try await coordinator.remoteClient(for: context).respondToApproval(
                id: approval.id,
                decision: decision,
                scope: requestedScope
            )
            guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            guard response.approvalId == approval.id, response.decision == decision else {
                presentedError = String(localized: "The approval response was not confirmed. Refreshing the current request from your Mac.")
                if pendingApproval == nil {
                    await restorePendingApproval(streamID: streamID, context: context, isFallback: true)
                }
                return
            }
            coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "approval-response:\(approval.id):\(decision.rawValue)")
        } catch let error where aidenIsCancellation(error) {
            guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            // The decision may already have reached the Mac. Resolve current
            // authority without resurrecting the captured card or showing an error.
            if pendingApproval == nil {
                await restorePendingApproval(streamID: streamID, context: context, isFallback: true)
            }
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            presentedError = String(localized: "The approval response was not confirmed. Refreshing the current request from your Mac.")
            if pendingApproval == nil {
                await restorePendingApproval(streamID: streamID, context: context, isFallback: true)
            }
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// Resolves the pending question prompt. A `cancelled` request dismisses
    /// the whole prompt; otherwise `answers` carries one entry per addressed
    /// question and unaddressed questions are recorded as skipped.
    func respondToQuestion(
        _ request: AidenQuestionRespondRequest,
        promptID: String,
        idempotencyKey: UUID
    ) async {
        guard !isReadOnlyPresentation, isConnected, !isRespondingToQuestion, !isStopping,
              let question = pendingQuestion, question.id == promptID, question.canRespond else { return }
        guard question.expiresAt > Date() else {
            pendingQuestion = nil
            // The Mac stopped waiting at expiresAt and the agent continued on
            // its own judgement; say so instead of silently dropping the answer.
            presentedError = String(localized: "This question expired, so Aiden continued with its best judgement. Send your answer as a message if it should change course.")
            return
        }
        if activeStreamID == nil, foreignRun != nil {
            await respondToForeignQuestion(request, question: question, idempotencyKey: idempotencyKey)
            return
        }
        guard let streamID = activeStreamID,
              let context = liveOwner else { return }
        isRespondingToQuestion = true
        defer { isRespondingToQuestion = false }
        pendingQuestion = nil
        if pendingApproval == nil { streamState = .running }
        do {
            let response = try await coordinator.remoteClient(for: context).respondToQuestion(
                id: question.id,
                request: request,
                idempotencyKey: idempotencyKey
            )
            guard coordinator.isLive(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            guard response.promptId == question.id else {
                presentedError = String(localized: "The question response was not confirmed. Refreshing the current prompt from your Mac.")
                if pendingQuestion == nil {
                    await restorePendingQuestion(streamID: streamID, context: context)
                }
                return
            }
            coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "question-response:\(question.id)")
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            presentedError = String(localized: "The question response was not confirmed. Refreshing the current prompt from your Mac.")
            // Never resurrect the captured card or retry a possibly accepted answer.
            if pendingQuestion == nil {
                await restorePendingQuestion(streamID: streamID, context: context)
            }
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    private func resolveModelSelection() {
        // An unsent pick made in this chat before it was last closed wins
        // like a pick made now.
        if !hasExplicitModelSelection, !isReadOnlyFixture, !chat.isBotChat, !chat.messages.isEmpty,
           let pick = modelPreferenceStore.chatSelection(for: instanceId, chatID: chat.id) {
            selectedProviderId = pick.providerId
            selectedModelId = pick.modelId
            selectedThinkingLevel = pick.thinkingLevel
            hasExplicitModelSelection = true
        }
        let selection = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: selectedProviderId,
            selectedModelId: selectedModelId,
            selectedThinkingLevel: selectedThinkingLevel,
            remembered: hasExplicitModelSelection || isReadOnlyFixture || chat.isBotChat
                ? nil
                : modelPreferenceStore.selection(for: instanceId),
            hasExplicitSelection: hasExplicitModelSelection
        )
        selectedProviderId = selection.providerId
        selectedModelId = selection.modelId
        selectedThinkingLevel = selection.thinkingLevel
    }

    private func showRecoveryWarning(_ message: String) {
        presentedError = message
        recoveryWarning = message
    }

    private func clearRecoveryWarning() {
        if let recoveryWarning, presentedError == recoveryWarning { presentedError = nil }
        recoveryWarning = nil
    }

    private func restoreStreamIfNeeded(needed: Bool) async {
        guard needed, !isRemoved, activeStreamID == nil, !isStarting else { return }
        isRestoringStream = true
        defer { isRestoringStream = false }
        let generation = transcriptGeneration
        guard var stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id) else { return }
        guard activeStreamID == nil, !isStarting, generation == transcriptGeneration else { return }
        // Only the stream identity is durable. The live text/reasoning/tool buffers
        // are process-local, so a cold owner must reconstruct them from sequence zero.
        stream.lastSequence = 0
        guard let context = liveOwner else { return }
        guard stream.deviceId == context.deviceId else {
            await cache.removeActiveStream(instanceId: instanceId, chatId: chat.id)
            await liveActivities.endAll(forInstanceID: instanceId)
            return
        }
        do {
            let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
            guard !isRemoved, coordinator.isLive(context), activeStreamID == nil,
                  !isStarting, generation == transcriptGeneration else { return }
            clearRecoveryWarning()
            activeStreamID = stream.streamId
            if !status.state.isTerminal {
                await liveActivities.start(
                    instanceID: instanceId,
                    chatID: chat.id,
                    title: chat.displayTitle,
                    streamID: stream.streamId
                )
            }
            guard !isRemoved, activeStreamID == stream.streamId else {
                if isRemoved { await liveActivities.updateStatus(instanceID: instanceId, streamID: stream.streamId, state: .cancelled) }
                return
            }
            await apply(
                status,
                streamID: stream.streamId,
                context: context,
                feedbackPolicy: .restoredStream
            )
            guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId,
                  !isStarting, generation == transcriptGeneration else { return }
            // A terminal status can become visible before its final SSE event is
            // consumed. Keep the durable cursor and replay first so cancellation
            // and provider-failure details are never skipped on reopen.
            startStreaming(stream, context: context, feedbackPolicy: .restoredStream)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context) else { return }
            guard activeStreamID == nil, !isStarting, generation == transcriptGeneration else { return }
            showRecoveryWarning(error.localizedDescription)
            await liveActivities.markStale(instanceID: instanceId, streamID: stream.streamId)
            guard !isRemoved, coordinator.isLive(context), activeStreamID == nil,
                  !isStarting, generation == transcriptGeneration else { return }
            // Retain and resume the stream identity even if the first status
            // probe happens while the phone is offline.
            startStreaming(stream, context: context, feedbackPolicy: .restoredStream)
        }
    }

    private func startStreaming(
        _ stream: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) {
        guard !isRemoved else { return }
        terminalReconciliationTask?.cancel()
        terminalReconciliationTask = nil
        streamTask?.cancel()
        activeStreamID = stream.streamId
        lastLocalTurnId = stream.turnId
        if streamState == nil { streamState = .reconciling }
        streamTask = Task { [weak self] in
            await self?.consume(stream, context: context, feedbackPolicy: feedbackPolicy)
        }
    }

    private func consume(
        _ original: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        var stream = original
        var terminalReplayGate = AidenTerminalReplayGate()
        var recovery = AidenStreamNetworkRecovery(path: networkPath ?? AidenNetworkAvailability())
        let streamID = original.streamId
        let onWaiting: (Bool) async -> Void = { [weak self] waiting in
            await self?.setWaitingForNetwork(waiting, streamID: streamID)
        }
        while !Task.isCancelled && coordinator.isLive(context) && activeStreamID == stream.streamId {
            do {
                let events = try coordinator.remoteClient(for: context).streamEvents(
                    id: stream.streamId,
                    after: stream.lastSequence
                )
                for try await event in events {
                    try Task.checkCancellation()
                    guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                    guard event.streamId == stream.streamId else { continue }
                    clearRecoveryWarning()
                    if event.sequence <= stream.lastSequence { continue }
                    if event.sequence != stream.lastSequence + 1 {
                        await reconcileChat(context: context)
                    }
                    await apply(event, context: context, feedbackPolicy: feedbackPolicy)
                    guard activeStreamID == stream.streamId else { return }
                    stream.lastSequence = event.sequence
                    if event.terminal { return }
                    // Advance only with the in-memory buffers. Persisting a cursor
                    // alone loses their prefix after relaunch and writes on every token.
                }

                // A stream that ended without a terminal frame is a lost stream
                // too: offline, park before any status probe or reconnect.
                flushPendingStreamingContent()
                if recovery.parksAfterStreamFailure, stopIfLeftBehind(.stream(stream, feedbackPolicy)) { return }
                guard try await recovery.shouldProbeAfterStreamFailure(onWaiting: onWaiting) else { continue }
                guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                recovery.recordHealthy()
                clearRecoveryWarning()
                await apply(
                    status,
                    streamID: stream.streamId,
                    context: context,
                    feedbackPolicy: feedbackPolicy
                )
                if status.state.isTerminal {
                    if terminalReplayGate.shouldReplay(status.state) { continue }
                    await finishStream(expectedStreamID: stream.streamId, context: context)
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                guard !Task.isCancelled else { return }
                flushPendingStreamingContent()
                if recovery.parksAfterStreamFailure, stopIfLeftBehind(.stream(stream, feedbackPolicy)) { return }
                // Offline: park without a status probe, warning, or backoff and
                // reopen from the last applied sequence when the path returns.
                do {
                    guard try await recovery.shouldProbeAfterStreamFailure(onWaiting: onWaiting) else { continue }
                } catch {
                    return
                }
                guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                do {
                    let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                    guard !isRemoved, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                    recovery.recordHealthy()
                    clearRecoveryWarning()
                    await apply(
                        status,
                        streamID: stream.streamId,
                        context: context,
                        feedbackPolicy: feedbackPolicy
                    )
                    if status.state.isTerminal {
                        if terminalReplayGate.shouldReplay(status.state) { continue }
                        await finishStream(expectedStreamID: stream.streamId, context: context)
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    guard !isRemoved, !Task.isCancelled, coordinator.isLive(context), activeStreamID == stream.streamId else { return }
                    if AidenTerminalReconciliation.isDefinitiveMissingStream(error),
                       await reconcileMissingStream(
                           stream,
                           context: context,
                           feedbackPolicy: feedbackPolicy
                       ) {
                        return
                    }
                    guard !isRemoved, !Task.isCancelled, activeStreamID == stream.streamId else { return }
                    if stopIfLeftBehind(.stream(stream, feedbackPolicy)) { return }
                    let message = error.localizedDescription
                    do {
                        _ = try await recovery.recoverAfterProbeFailure(
                            minimumDelayMilliseconds: AidenStreamNetworkRecovery.serverRequestedDelayMilliseconds(after: error),
                            onBackoff: { [weak self] in
                                guard let self, !self.isRemoved, self.activeStreamID == streamID else { return }
                                self.showRecoveryWarning(message)
                                await self.liveActivities.markStale(instanceID: self.instanceId, streamID: streamID)
                            },
                            onWaiting: onWaiting
                        )
                    } catch {
                        return
                    }
                    continue
                }
            }
        }
    }

    /// What a left-behind chat stopped doing. The cached stream record stays,
    /// so a fresh model for this chat restores the run as it does after a relaunch.
    private enum LeftBehindWork {
        case stream(AidenChatCache.ActiveStream, AidenStreamFeedbackPolicy)
        case reconciliation(streamID: String)

        var streamID: String {
            switch self {
            case .stream(let stream, _): stream.streamId
            case .reconciliation(let streamID): streamID
            }
        }
    }

    /// Ends a failed retry loop once nothing would ever come back for it. A
    /// loop holds the model, so without this an unreachable machine keeps a
    /// closed chat and its requests going for good. Runs without suspending:
    /// the view coming back must find either a running loop or `leftBehindWork`.
    private func stopIfLeftBehind(_ work: LeftBehindWork) -> Bool {
        guard isLeftBehind else { return false }
        leftBehindWork = work
        Task { [liveActivities, instanceId] in
            await liveActivities.markStale(instanceID: instanceId, streamID: work.streamID)
        }
        return true
    }

    /// Tracks the view on screen. Coming back restarts whatever a left-behind
    /// chat stopped, from the sequence it had reached.
    func setViewPresent(_ present: Bool) {
        isViewGone = !present
        if !isReadOnlyFixture {
            coordinator.setOnScreen(present, view: self, instanceId: owner.instanceId)
        }
        guard present, let work = leftBehindWork else { return }
        leftBehindWork = nil
        guard !isRemoved, activeStreamID == work.streamID, let context = liveOwner else { return }
        switch work {
        case .stream(let stream, let feedbackPolicy):
            startStreaming(stream, context: context, feedbackPolicy: feedbackPolicy)
        case .reconciliation(let streamID):
            scheduleTerminalReconciliation(expectedStreamID: streamID, context: context)
        }
    }

    /// Await the stream loop and any reconciliation after it, without starting
    /// or cancelling either.
    func waitForStreamWork() async {
        await streamTask?.value
        await terminalReconciliationTask?.value
    }

    private func setWaitingForNetwork(_ waiting: Bool, streamID: String) async {
        if waiting {
            guard !isRemoved, activeStreamID == streamID else { return }
            networkWaitStreamID = streamID
            // Losing the network is not an error: drop any recovery warning so
            // the composer shows no banner while the run waits.
            clearRecoveryWarning()
            await liveActivities.markStale(instanceID: instanceId, streamID: streamID)
        } else if networkWaitStreamID == streamID {
            networkWaitStreamID = nil
        }
    }

    private func apply(
        _ event: AidenRemoteStreamEvent,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        guard !isRemoved, coordinator.isLive(context),
              activeStreamID == event.streamId,
              event.shouldApply else { return }
        // Text received before any other event is shown before it lands, so
        // tools, approvals and terminal states never overtake the reply.
        // `done` drains faster instead: the settled reply replaces the live
        // one with the whole text, so dumping the backlog would only make the
        // end of the reply jump.
        if event.type == .done {
            finishStreamingReveal()
        } else if event.type != .textDelta, event.type != .heartbeat {
            flushPendingStreamingContent()
        }
        if event.type == .questionRequired {
            // Resolving an approval on the Mac emits the surviving question
            // with no running status in between, so a cached approval may
            // already be gone. Re-read approval authority first: its nil path
            // restores the question, and a still-pending approval keeps
            // precedence while the question card refreshes alongside it.
            if pendingApproval != nil {
                await restorePendingApproval(
                    streamID: event.streamId,
                    context: context,
                    announce: feedbackPolicy.allowsFeedback
                )
                return
            }
            await restorePendingQuestion(
                streamID: event.streamId,
                context: context,
                announce: feedbackPolicy.allowsFeedback
            )
            return
        }
        guard let payload = event.payload else { return }
        switch event.type {
        case .snapshot:
            streamState = .reconciling
            if chat.isBotChat {
                // A projection reset is followed by a cumulative replacement.
                // Bot progress is disclosure-only, so discard the old ephemeral
                // copy before accepting that replacement instead of appending it.
                replaceLiveText("")
                reasoning = ""
            }
            await reconcileChat(context: context)
        case .status:
            if let value = payload.state, let state = AidenStreamState(rawValue: value) {
                if state == .waitingForApproval {
                    await restorePendingApproval(
                        streamID: event.streamId,
                        context: context,
                        announce: feedbackPolicy.allowsFeedback
                    )
                    break
                }
                streamState = state
                if state != .waitingForApproval {
                    pendingApproval = nil
                    pendingQuestion = nil
                }
                await publishLiveActivityStatus(streamID: event.streamId, state: state)
            }
        case .textDelta:
            receiveLiveText(payload.text ?? "")
            streamState = .running
            if AidenQuietOpenChat.publishesAmbientProgress(isChatForegrounded: isAmbientSurfaceQuiet) {
                await liveActivities.appendResponse(payload.text ?? "", instanceID: instanceId, streamID: event.streamId)
            }
        case .reasoningDelta:
            reasoning += payload.text ?? ""
            if AidenQuietOpenChat.publishesAmbientProgress(isChatForegrounded: isAmbientSurfaceQuiet) {
                await liveActivities.reasoning(instanceID: instanceId, streamID: event.streamId)
            }
        case .toolStarted:
            if let id = payload.toolId, let name = payload.name {
                tools.append(AidenLiveTool(id: id, name: name, status: nil))
            }
            if AidenQuietOpenChat.publishesAmbientProgress(isChatForegrounded: isAmbientSurfaceQuiet) {
                await liveActivities.toolStarted(name: payload.name, instanceID: instanceId, streamID: event.streamId)
            }
        case .toolFinished:
            if let id = payload.toolId, let index = tools.firstIndex(where: { $0.id == id }) {
                tools[index].status = payload.status
            }
            if AidenQuietOpenChat.publishesAmbientProgress(isChatForegrounded: isAmbientSurfaceQuiet) {
                await liveActivities.toolFinished(instanceID: instanceId, streamID: event.streamId)
            }
        case .timeline:
            if let timeline = payload.timeline {
                activityTimeline = timeline
                imageArrivalRevealGenerationIDs = AidenImageGenerationPlaceholderState.armedArrivalReveals(
                    imageArrivalRevealGenerationIDs,
                    after: timeline
                )
            }
        case .approvalRequired:
            await restorePendingApproval(
                streamID: event.streamId,
                context: context,
                announce: feedbackPolicy.allowsFeedback
            )
        case .error:
            pendingApproval = nil
            pendingQuestion = nil
            // The terminal chat reconciliation renders the durable, fixed-copy
            // outcome inline. Avoid covering that actionable state with a
            // second generic modal alert.
            presentedError = nil
            streamState = .error
            alertRun(.failed, id: event.streamId)
            if feedbackPolicy.allowsFeedback {
                coordinator.haptics.play(
                    .error,
                    scope: hapticScope,
                    dedupeKey: "turn-terminal:\(event.streamId):error"
                )
            }
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .failed,
                message: String(localized: "Response failed"),
                errorSummary: payload.message
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .cancelled:
            pendingApproval = nil
            pendingQuestion = nil
            streamState = .cancelled
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .cancelled,
                message: String(localized: "Response cancelled")
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .done:
            pendingApproval = nil
            pendingQuestion = nil
            streamState = .done
            alertRun(.completed, id: event.streamId)
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .complete,
                message: String(localized: "Response complete")
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .heartbeat:
            break
        default:
            break
        }
    }

    private func apply(
        _ status: AidenStreamStatus,
        streamID: String,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        guard activeStreamID == streamID,
              status.streamId == streamID,
              status.chatId == chat.id,
              coordinator.isLive(context)
        else { return }
        if status.state == .waitingForApproval {
            await restorePendingApproval(
                streamID: streamID,
                context: context,
                announce: AidenStreamFeedbackDecision.announcesApproval(feedbackPolicy)
            )
            return
        }
        pendingApproval = nil
        pendingQuestion = nil
        streamState = status.state
        switch status.state {
        case .done: alertRun(.completed, id: streamID)
        case .error, .interrupted: alertRun(.failed, id: streamID)
        default: break
        }
        if feedbackPolicy.allowsFeedback,
           status.state == .error || status.state == .interrupted {
            coordinator.haptics.play(
                .error,
                scope: hapticScope,
                dedupeKey: "turn-terminal:\(streamID):error"
            )
        }
        await publishLiveActivityStatus(streamID: streamID, state: status.state)
    }

    func restorePendingApproval(
        streamID: String,
        context: AidenRemoteRequestContext,
        announce: Bool = false,
        isFallback: Bool = false
    ) async {
        guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
              streamState?.isTerminal != true else { return }
        if isFallback, let read = approvalSnapshotInFlight,
           read.streamID == streamID, coordinator.isLive(read.context),
           read.approval == pendingApproval, read.state == streamState { return }
        approvalSnapshotGeneration &+= 1
        let snapshotGeneration = approvalSnapshotGeneration
        approvalSnapshotInFlight = (streamID, context, pendingApproval, streamState)
        defer {
            if snapshotGeneration == approvalSnapshotGeneration { approvalSnapshotInFlight = nil }
        }
        let expectedApproval = pendingApproval
        let expectedState = streamState
        do {
            let snapshot = try await coordinator.remoteClient(for: context).streamApproval(id: streamID)
            guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
                  snapshotGeneration == approvalSnapshotGeneration,
                  pendingApproval == expectedApproval, streamState == expectedState else { return }
            guard let approval = AidenPendingApprovalResolution.resolve(
                snapshot.approval,
                streamId: streamID,
                chatId: chat.id,
                capabilities: approvalCapabilities(for: context)
            ) else {
                pendingApproval = nil
                // A pending question prompt shares the waiting_for_approval
                // status; check its snapshot before declaring a reconcile gap.
                await restorePendingQuestion(
                    streamID: streamID,
                    context: context,
                    announce: announce
                )
                return
            }
            pendingApproval = approval
            streamState = .waitingForApproval
            alertRun(.needsApproval, id: approval.id)
            if announce {
                coordinator.haptics.play(
                    .warning,
                    scope: hapticScope,
                    dedupeKey: "approval-required:\(approval.id)"
                )
            }
            await liveActivities.approvalRequired(instanceID: instanceId, streamID: streamID)
            // A question prompt may be pending alongside the approval; a nil
            // snapshot simply clears stale card state without touching status.
            await restorePendingQuestion(
                streamID: streamID,
                context: context,
                reconcilesOnNil: false
            )
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context), activeStreamID == streamID,
                  snapshotGeneration == approvalSnapshotGeneration,
                  pendingApproval == expectedApproval, streamState == expectedState else { return }
            pendingApproval = nil
            await restorePendingQuestion(
                streamID: streamID,
                context: context,
                reconcilesOnNil: true,
                marksStaleOnFailure: true
            )
        }
    }

    /// Restores the pending `ask_user_question` prompt for this stream. The
    /// Mac projects the wait as `waiting_for_approval`, so this is also the
    /// fallback when the approval snapshot comes back empty.
    func restorePendingQuestion(
        streamID: String,
        context: AidenRemoteRequestContext,
        announce: Bool = false,
        reconcilesOnNil: Bool = true,
        marksStaleOnFailure: Bool = false
    ) async {
        guard coordinator.isLive(context), activeStreamID == streamID,
              streamState?.isTerminal != true else { return }
        guard supportsQuestionPrompts(for: context) else {
            pendingQuestion = nil
            if reconcilesOnNil && pendingApproval == nil {
                streamState = .reconciling
                await publishLiveActivityStatus(streamID: streamID, state: .reconciling)
            }
            return
        }
        questionSnapshotGeneration &+= 1
        let snapshotGeneration = questionSnapshotGeneration
        let expectedQuestion = pendingQuestion
        let expectedState = streamState
        do {
            let snapshot = try await coordinator.remoteClient(for: context).streamQuestion(id: streamID)
            guard coordinator.isLive(context), activeStreamID == streamID,
                  snapshotGeneration == questionSnapshotGeneration,
                  pendingQuestion == expectedQuestion, streamState == expectedState else { return }
            guard let question = AidenPendingQuestionResolution.resolve(
                snapshot.question,
                streamId: streamID,
                chatId: chat.id,
                canRespond: canRespondToQuestions(for: context)
            ) else {
                pendingQuestion = nil
                if reconcilesOnNil && pendingApproval == nil {
                    streamState = .reconciling
                    await publishLiveActivityStatus(streamID: streamID, state: .reconciling)
                }
                return
            }
            pendingQuestion = question
            streamState = .waitingForApproval
            // The wire projects the question as `waiting_for_approval`; the
            // phone holds the question snapshot, so it shows "Needs your
            // answer" unless an approval (which gates the tool) is pending too.
            if AgentRunBlockingStatus.status(
                hasPendingApproval: pendingApproval != nil,
                hasPendingQuestion: true
            ) == .waitingForAnswer {
                await liveActivities.questionRequired(instanceID: instanceId, streamID: streamID)
                alertRun(.needsAnswer, id: question.id)
            }
            if announce {
                coordinator.haptics.play(
                    .warning,
                    scope: hapticScope,
                    dedupeKey: "question-required:\(question.id)"
                )
            }
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isLive(context), activeStreamID == streamID,
                  snapshotGeneration == questionSnapshotGeneration,
                  pendingQuestion == expectedQuestion, streamState == expectedState else { return }
            pendingQuestion = nil
            if reconcilesOnNil && pendingApproval == nil {
                streamState = .reconciling
                if marksStaleOnFailure {
                    await liveActivities.markStale(instanceID: instanceId, streamID: streamID)
                } else {
                    await publishLiveActivityStatus(streamID: streamID, state: .reconciling)
                }
            }
        }
    }

    func approvalCapabilities(
        for context: AidenRemoteRequestContext
    ) -> AidenApprovalCapabilities {
        guard !isRemoved, coordinator.isLive(context),
              let installation = ownerInstallation,
              installation.instanceId == context.instanceId,
              installation.deviceId == context.deviceId else {
            return AidenApprovalCapabilities(canRespond: false, canWriteSchedules: false)
        }
        return AidenApprovalCapabilities(
            canRespond: installation.hasNegotiatedAccess(to: .approvalRespond)
                && (chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
                    && installation.hasNegotiatedAccess(to: .botWrite))),
            canWriteSchedules: installation.hasNegotiatedAccess(to: .scheduleWrite)
        )
    }

    /// The question snapshot route exists only when the Mac advertises the
    /// feature; without it the stream stays approval-only and older snapshots
    /// are never requested.
    private func supportsQuestionPrompts(
        for context: AidenRemoteRequestContext
    ) -> Bool {
        coordinator.isLive(context) && ownerServer?.supportsQuestionPrompts == true
    }

    func canRespondToQuestions(
        for context: AidenRemoteRequestContext
    ) -> Bool {
        guard coordinator.isLive(context),
              let installation = ownerInstallation,
              installation.instanceId == context.instanceId,
              installation.deviceId == context.deviceId else {
            return false
        }
        return installation.hasNegotiatedAccess(to: .questionsRespond)
            && (chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
                && installation.hasNegotiatedAccess(to: .botWrite)))
    }

    @discardableResult
    func reconcileChat(context: AidenRemoteRequestContext) async -> Bool {
        guard !isStarting else { return false }
        let generation = transcriptGeneration
        let writeToken = cache.reserveChatWrite()
        do {
            let latest = try await fetchLatestTranscript(context: context)
            guard !isRemoved, coordinator.isLive(context) else { return false }
            guard generation == transcriptGeneration, !isStarting else { return false }
            // Supersede reads admitted while the authoritative fetch was pending,
            // before its cache write yields to the main actor again.
            transcriptGeneration &+= 1
            let publicationGeneration = transcriptGeneration
            guard await acceptLatestTranscript(latest, context: context, writeToken: writeToken) else { return false }
            guard publicationGeneration == transcriptGeneration, coordinator.isLive(context) else { return false }
            clearRecoveryWarning()
            return true
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard !isRemoved, coordinator.isLive(context), generation == transcriptGeneration, !isStarting else { return false }
            showRecoveryWarning(error.localizedDescription)
            return false
        }
    }

    /// The newest transcript a refresh read, ready to publish.
    private struct LatestTranscript {
        var chat: AidenChat
        var hasOlder: Bool
        /// The newest page to fold into the transcript on screen when it is
        /// published; nil when `chat` already replaces the transcript.
        var mergeWindow: AidenChatMessagesWindow?
    }

    /// Read the newest transcript. With `chat-messages-window-v1` and its
    /// revision-23 metadata this is the newest page, carrying the chat's
    /// current title, timestamps and model like a whole-chat read; it is
    /// folded into earlier pages already on screen when it is published (or
    /// replaces them when `replacing`). Without the window, or from a page
    /// that lacks metadata, it is the whole chat as before.
    private func fetchLatestTranscript(
        context: AidenRemoteRequestContext,
        replacing: Bool = false
    ) async throws -> LatestTranscript {
        let client = try coordinator.remoteClient(for: context)
        guard ownerServer?.supportsChatMessagesWindow == true else {
            return LatestTranscript(chat: try await client.chat(id: chat.id), hasOlder: false)
        }
        let window = try await client.messagesWindow(
            chatId: chat.id,
            limit: AidenTranscriptWindowing.pageSize
        )
        guard let windowChat = window.chat, windowChat.id == chat.id else {
            return LatestTranscript(chat: try await client.chat(id: chat.id), hasOlder: false)
        }
        guard !replacing, hasSettledTranscriptWindow else {
            return LatestTranscript(chat: windowChat, hasOlder: window.hasOlder)
        }
        // Cache the page folded into what is on screen now; publication folds
        // it again into whatever is on screen by then.
        let presentation = AidenTranscriptWindowing.mergingLatest(
            window,
            into: chat.messages,
            currentHasOlder: hasOlderMessages
        )
        var assembled = windowChat
        assembled.messages = presentation.messages
        return LatestTranscript(chat: assembled, hasOlder: presentation.hasOlder, mergeWindow: window)
    }

    @discardableResult
    private func acceptLatestTranscript(
        _ latest: LatestTranscript,
        context: AidenRemoteRequestContext,
        writeToken: UInt64,
        scheduleTitleRefresh: Bool = true
    ) async -> Bool {
        var hasOlder = latest.hasOlder
        guard await acceptRemoteChat(
            latest.chat,
            context: context,
            writeToken: writeToken,
            scheduleTitleRefresh: scheduleTitleRefresh,
            beforePublishing: { presented in
                // Merge against the transcript on screen now, not when the
                // read began: an earlier page loaded while the cache write was
                // pending stays in front of the newest page.
                guard let window = latest.mergeWindow, presented.revision == window.revision else {
                    return presented
                }
                let presentation = AidenTranscriptWindowing.mergingLatest(
                    window,
                    into: self.chat.messages,
                    currentHasOlder: self.hasOlderMessages
                )
                hasOlder = presentation.hasOlder
                var merged = presented
                merged.messages = presentation.messages
                return merged
            }
        ) else { return false }
        hasOlderMessages = hasOlder
        hasSettledTranscriptWindow = true
        scheduleVisualSnapshotRefresh(context: context)
        return true
    }

    /// Re-read the open chat a few times while its newest reply still lacks a
    /// visual snapshot the Mac is capturing. One schedule runs at a time; the
    /// re-reads it makes come back through here and are absorbed by it.
    private func scheduleVisualSnapshotRefresh(context: AidenRemoteRequestContext) {
        guard visualSnapshotRefreshTask == nil, nextVisualSnapshotRefreshDelay(attempt: 0) != nil else { return }
        let refreshID = UUID()
        visualSnapshotRefreshID = refreshID
        visualSnapshotRefreshTask = Task { [weak self] in
            var attempt = 0
            while true {
                guard !Task.isCancelled,
                      let delay = self?.nextVisualSnapshotRefreshDelay(attempt: attempt),
                      let sleep = self?.visualSnapshotRefreshSleep else { break }
                attempt += 1
                // The model is held only for the read, never across the wait.
                do { try await sleep(delay) } catch { break }
                guard !Task.isCancelled, let model = self,
                      await model.rereadForVisualSnapshots(context: context) else { break }
            }
            guard let model = self, model.visualSnapshotRefreshID == refreshID else { return }
            model.visualSnapshotRefreshTask = nil
            model.visualSnapshotRefreshID = nil
        }
    }

    private func nextVisualSnapshotRefreshDelay(attempt: Int) -> Duration? {
        AidenVisualSnapshotReconciliation.nextDelay(
            for: AidenVisualSnapshotReconciliation.awaitedMessage(in: chat.messages),
            attempt: attempt,
            now: Date()
        )
    }

    /// One snapshot re-read through the normal newest-transcript path. False
    /// stops the schedule: the chat changed, closed, or a turn took over.
    private func rereadForVisualSnapshots(context: AidenRemoteRequestContext) async -> Bool {
        guard !isRemoved, coordinator.isLive(context), activeStreamID == nil, !isStarting else { return false }
        let generation = transcriptGeneration
        let writeToken = cache.reserveChatWrite()
        do {
            let latest = try await fetchLatestTranscript(context: context)
            guard !Task.isCancelled, !isRemoved, coordinator.isLive(context) else { return false }
            guard generation == transcriptGeneration, activeStreamID == nil, !isStarting else { return false }
            await acceptLatestTranscript(latest, context: context, writeToken: writeToken)
            return true
        } catch let error where aidenIsCancellation(error) {
            return false
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            // A missed snapshot is cosmetic; the next normal refresh shows it.
            return !isRemoved && coordinator.isLive(context)
        }
    }

    /// Stop waiting for late snapshots: the chat left the screen, the app went
    /// to the background, or a new turn started. The next load re-arms it.
    func stopVisualSnapshotRefresh() {
        visualSnapshotRefreshTask?.cancel()
        visualSnapshotRefreshTask = nil
        visualSnapshotRefreshID = nil
    }

    /// Page back one window from the oldest message on screen. If the Mac no
    /// longer has that message (`revision_conflict`), reload from the newest.
    func loadEarlierMessages() async {
        guard !isReadOnlyFixture, hasOlderMessages, !isLoadingEarlierMessages, !isRemoved,
              ownerServer?.supportsChatMessagesWindow == true,
              let context = liveOwner,
              coordinator.isLive(context),
              let cursor = AidenTranscriptWindowing.earlierCursor(in: chat.messages) else { return }
        isLoadingEarlierMessages = true
        defer { isLoadingEarlierMessages = false }
        do {
            let page = try await coordinator.remoteClient(for: context).messagesWindow(
                chatId: chat.id,
                before: cursor,
                limit: AidenTranscriptWindowing.pageSize
            )
            // A reload that replaced the transcript meanwhile owns the screen.
            guard !isRemoved, coordinator.isLive(context),
                  AidenTranscriptWindowing.earlierCursor(in: chat.messages) == cursor else { return }
            let presentation = AidenTranscriptWindowing.prepending(page, to: chat.messages)
            chat.messages = presentation.messages
            hasOlderMessages = presentation.hasOlder
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context) else { return }
            if Self.isRevisionConflict(error) {
                await reloadLatestTranscriptWindow(context: context)
            } else {
                presentedError = error.localizedDescription
            }
        }
    }

    private func reloadLatestTranscriptWindow(context: AidenRemoteRequestContext) async {
        guard !isStarting else { return }
        let generation = transcriptGeneration
        let writeToken = cache.reserveChatWrite()
        do {
            let latest = try await fetchLatestTranscript(context: context, replacing: true)
            guard !isRemoved, coordinator.isLive(context), generation == transcriptGeneration, !isStarting else { return }
            await acceptLatestTranscript(latest, context: context, writeToken: writeToken)
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard !isRemoved, coordinator.isLive(context) else { return }
            presentedError = error.localizedDescription
        }
    }

    private static func isRevisionConflict(_ error: Error) -> Bool {
        guard case .server(_, let body)? = error as? AidenRemoteClientError else { return false }
        return body.code.rawValue == "revision_conflict"
    }

    @discardableResult
    func acceptRemoteChat(
        _ remote: AidenChat,
        context: AidenRemoteRequestContext,
        writeToken: UInt64,
        scheduleTitleRefresh: Bool = true,
        beforePublishing: (AidenChat) -> AidenChat = { $0 }
    ) async -> Bool {
        guard !isRemoved, coordinator.isLive(context), !isStarting else { return false }
        let generation = transcriptGeneration
        _ = try? await cache.saveFetchedChat(remote, instanceId: instanceId, writeToken: writeToken)
        guard let canonical = await cache.admittedChat(instanceId: instanceId, chatId: remote.id) else { return false }
        let admitted = await cache.presenting(canonical, instanceId: instanceId)
        guard !isRemoved, coordinator.isLive(context), !isStarting, generation == transcriptGeneration else { return false }
        let presented = beforePublishing(admitted)
        chat = presented
        resolveModelSelection()
        if ownerIsSelected { onChatUpdated(presented) }
        reportChatViewed(presented)
        if scheduleTitleRefresh, presented.isTitlePending {
            schedulePendingTitleRefresh(context: context)
        }
        return true
    }

    private func schedulePendingTitleRefresh(context: AidenRemoteRequestContext) {
        guard titleRefreshTask == nil else { return }
        let refreshID = UUID()
        titleRefreshID = refreshID
        titleRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if titleRefreshID == refreshID {
                    titleRefreshTask = nil
                    titleRefreshID = nil
                }
            }
            for delay in AidenChatTitleReconciliation.retryMilliseconds {
                do {
                    try await Task.sleep(for: .milliseconds(delay))
                    guard !isStarting else { continue }
                    let generation = transcriptGeneration
                    let writeToken = cache.reserveChatWrite()
                    let remote = try await coordinator.remoteClient(for: context).chat(id: chat.id)
                    guard !isRemoved, coordinator.isLive(context) else { return }
                    guard generation == transcriptGeneration, !isStarting else { continue }
                    // A whole-chat read carries the title and every message.
                    await acceptLatestTranscript(
                        LatestTranscript(chat: remote, hasOlder: false),
                        context: context,
                        writeToken: writeToken,
                        scheduleTitleRefresh: false
                    )
                    if !remote.isTitlePending { return }
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    // A transient local-network interruption should not surface after a
                    // successful reply. The next normal refresh remains authoritative.
                    continue
                }
            }
        }
    }

    private func finishStream(expectedStreamID: String, context: AidenRemoteRequestContext) async {
        guard !isRemoved, coordinator.isLive(context), activeStreamID == expectedStreamID else { return }
        transcriptGeneration &+= 1
        guard await reconcileChat(context: context) else {
            scheduleTerminalReconciliation(expectedStreamID: expectedStreamID, context: context)
            return
        }
        guard activeStreamID == expectedStreamID else { return }
        await clearFinishedStream(expectedStreamID: expectedStreamID)
    }

    private func reconcileMissingStream(
        _ stream: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async -> Bool {
        guard activeStreamID == stream.streamId else { return false }
        transcriptGeneration &+= 1
        guard await reconcileChat(context: context) else { return false }
        guard activeStreamID == stream.streamId else { return false }
        // The published transcript now holds the reply; the Live Activity
        // updates below suspend, so drop the live copy first.
        clearLiveOutput()
        let resolution = AidenMissingStreamResolution.resolve(messages: chat.messages)
        if let event = AidenStreamFeedbackDecision.terminalEvent(
            for: resolution,
            policy: feedbackPolicy
        ) {
            coordinator.haptics.play(
                event,
                scope: hapticScope,
                dedupeKey: "turn-terminal:\(stream.streamId):error"
            )
        }
        switch resolution {
        case .cancelled:
            streamState = .cancelled
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .cancelled,
                message: String(localized: "Response cancelled")
            )
        case .failed:
            streamState = .error
            alertRun(.failed, id: stream.streamId)
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .failed,
                message: String(localized: "Response failed")
            )
        case .complete:
            streamState = .done
            alertRun(.completed, id: stream.streamId)
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .complete,
                message: String(localized: "Response complete")
            )
        case .interrupted:
            streamState = .interrupted
            alertRun(.failed, id: stream.streamId)
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .failed,
                message: String(localized: "Response interrupted")
            )
        }
        await clearFinishedStream(expectedStreamID: stream.streamId)
        return true
    }

    private func scheduleTerminalReconciliation(
        expectedStreamID: String,
        context: AidenRemoteRequestContext
    ) {
        guard terminalReconciliationTask == nil else { return }
        terminalReconciliationTask = Task { [weak self] in
            guard let self else { return }
            defer { terminalReconciliationTask = nil }
            var attempt = 0
            while !Task.isCancelled && coordinator.isLive(context) && activeStreamID == expectedStreamID {
                do {
                    let delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt: attempt)
                    try await Task.sleep(for: .milliseconds(delay))
                    guard !isRemoved, coordinator.isLive(context), activeStreamID == expectedStreamID else { return }
                    transcriptGeneration &+= 1
                    if await reconcileChat(context: context) {
                        guard activeStreamID == expectedStreamID else { return }
                        await clearFinishedStream(expectedStreamID: expectedStreamID)
                        return
                    }
                    if stopIfLeftBehind(.reconciliation(streamID: expectedStreamID)) { return }
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    // Keep the durable stream cursor and continue retrying while
                    // this desktop connection remains current. Long Tailscale or
                    // local-network outages must not erase terminal evidence.
                }
                attempt += 1
            }
        }
    }

    private func clearFinishedStream(expectedStreamID: String) async {
        guard activeStreamID == expectedStreamID else { return }
        transcriptGeneration &+= 1
        // The reconciled transcript holding the reply was published in this
        // same main-actor turn. Drop the live copy now, before the cache hop
        // below, so no frame draws the reply twice (settled and live).
        clearLiveOutput()
        _ = await cache.removeActiveStream(
            instanceId: instanceId,
            chatId: chat.id,
            ifStreamId: expectedStreamID
        )
        // A failed initial cache write must not keep a reconciled stream alive.
        // Conditional removal still preserves another owner's newer record.
        guard activeStreamID == expectedStreamID else { return }
        clearLiveOutput()
        pendingApproval = nil
        pendingQuestion = nil
        activeStreamID = nil
    }

    /// Clears the live reply: its text, reasoning, tools and timeline.
    private func clearLiveOutput() {
        replaceLiveText("")
        reasoning = ""
        tools = []
        activityTimeline = nil
    }
}
