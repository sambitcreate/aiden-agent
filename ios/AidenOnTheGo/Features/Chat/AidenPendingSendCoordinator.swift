import Foundation
import Observation

/// Coordinates durable pending-send recovery and automatic 429 retry backoff
/// with `AidenChatDraftStore`.
///
/// Extracted from `AidenChatViewModel.swift` so the 9-term `canRetrySend`
/// predicate, bounded automatic 429 retry budget (`maxRateLimitedSendRetries`),
/// recovery copy, and draft-store settlement are isolated in one observable
/// sub-machine.
@MainActor
@Observable
final class AidenPendingSendCoordinator {
    /// A send the Mac refused with a retryable 429 is sent again on its own
    /// after the server's delay, this many times in a row before Retry is
    /// left to the person.
    static let maxRateLimitedSendRetries = 3

    enum RateLimitRetryState: Equatable, Sendable {
        case none
        case waitingAutomatic
        case refusedBecauseBusy
    }

    /// All host-side gates combined with `pendingSend` to form the 9-term
    /// `canRetrySend` predicate.
    struct RetryEligibilityInputs: Equatable, Sendable {
        let isConnected: Bool
        let isOwnerLive: Bool
        let isStarting: Bool
        let isSubmittingRunInput: Bool
        let isRestoringStream: Bool
        let hasActiveStream: Bool
        let isStreaming: Bool
    }

    private let draftStore: AidenChatDraftStore
    private(set) var pendingSend: AidenChatDraftStore.PendingSend?
    private(set) var sendRecoveryError: String?
    private(set) var rateLimitRetryState: RateLimitRetryState = .none

    @ObservationIgnored private var turnAttempts = AidenTurnAttemptTracker()
    @ObservationIgnored private(set) var rateLimitedSendRetries = 0
    @ObservationIgnored private var rateLimitedSendRetryTask: Task<Void, Never>?

    /// Waits out a retryable 429 before sending again; tests shorten it.
    @ObservationIgnored var rateLimitedSendRetrySleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }

    init(draftStore: AidenChatDraftStore) {
        self.draftStore = draftStore
    }

    deinit {
        rateLimitedSendRetryTask?.cancel()
    }

    /// The Mac was busy and the saved send will go out again on its own.
    var isWaitingToRetryRateLimitedSend: Bool {
        rateLimitRetryState == .waitingAutomatic
    }

    /// The Mac kept refusing the saved send with a retryable 429 until the
    /// automatic resends ran out. Nothing was appended, so Retry is safe.
    var isPendingSendRefusedBecauseBusy: Bool {
        rateLimitRetryState == .refusedBecauseBusy
    }

    /// The 9-term retry eligibility predicate:
    /// 1. `pendingSend != nil`
    /// 2. `pendingSend.canRetry(at: now)`
    /// 3. `isConnected`
    /// 4. `isOwnerLive`
    /// 5. `!isStarting`
    /// 6. `!isSubmittingRunInput`
    /// 7. `!isRestoringStream`
    /// 8. `pendingSend.streamId != nil || !hasActiveStream`
    /// 9. `pendingSend.streamId != nil || !isStreaming`
    func canRetry(inputs: RetryEligibilityInputs, now: Date = Date()) -> Bool {
        guard let pendingSend, pendingSend.canRetry(at: now) else { return false }
        return inputs.isConnected
            && inputs.isOwnerLive
            && !inputs.isStarting
            && !inputs.isSubmittingRunInput
            && !inputs.isRestoringStream
            && (pendingSend.streamId != nil || (!inputs.hasActiveStream && !inputs.isStreaming))
    }

    func recoveryMessage(
        isStarting: Bool,
        isSubmittingRunInput: Bool,
        now: Date = Date()
    ) -> String? {
        if let sendRecoveryError { return sendRecoveryError }
        guard let pendingSend, !isStarting, !isSubmittingRunInput else { return nil }
        if isWaitingToRetryRateLimitedSend {
            return "Aiden Agent is busy. Your message will be sent again in a moment."
        }
        if isPendingSendRefusedBecauseBusy, pendingSend.canRetry(at: now) {
            return "Aiden Agent is still busy. Your message wasn’t sent; try again in a moment."
        }
        return pendingSend.canRetry(at: now)
            ? "Couldn’t confirm delivery. Retry uses the same saved request within its safe retry window."
            : "Couldn’t confirm delivery. The retry window has ended. Check the conversation on your computer before sending another message."
    }

    /// Restores any persisted pending send for `session` and `deviceId`.
    func load(session: AidenChatDraftStore.Session, deviceId: String) async {
        if rateLimitRetryState == .refusedBecauseBusy {
            rateLimitRetryState = .none
        }
        do {
            pendingSend = try await draftStore.loadPendingSend(session: session, deviceId: deviceId)
        } catch {
            sendRecoveryError = "The saved send could not be read. Check the conversation on your computer before dismissing it and sending again."
        }
    }

    /// Mints or reuses a stable `Idempotency-Key` for a fresh turn send.
    func makeTurnAttempt(
        deviceId: String,
        request: AidenTurnStart,
        attachments: [AidenAttachmentReference],
        now: Date = Date()
    ) -> AidenChatDraftStore.PendingSend {
        AidenChatDraftStore.PendingSend(
            deviceId: deviceId,
            request: request,
            key: turnAttempts.key(for: request),
            createdAt: now,
            attachments: attachments
        )
    }

    /// Persists `attempt` before transmission. Does not adopt `attempt` into
    /// `pendingSend` until the caller verifies the owner is still live.
    func persistBeforeSend(
        _ attempt: AidenChatDraftStore.PendingSend,
        session: AidenChatDraftStore.Session
    ) async throws {
        try await draftStore.savePendingSend(attempt, session: session)
    }

    /// Adopts a persisted attempt as the active pending send and clears any
    /// prior busy-exhausted banner.
    func adoptPersistedAttempt(_ attempt: AidenChatDraftStore.PendingSend) {
        pendingSend = attempt
        if rateLimitRetryState == .refusedBecauseBusy {
            rateLimitRetryState = .none
        }
    }

    /// Called when a person manually starts a send or Retry, superseding any
    /// scheduled automatic resend.
    func cancelAutomaticRetryForManualAction() {
        cancelRateLimitedSendRetry()
        rateLimitedSendRetries = 0
    }

    func cancelRateLimitedSendRetry() {
        rateLimitedSendRetryTask?.cancel()
        rateLimitedSendRetryTask = nil
        rateLimitRetryState = .none
    }

    /// Clears pending state once the Mac accepted the turn or run input.
    func markAccepted(resetTurnAttempts: Bool = true) {
        pendingSend = nil
        if rateLimitRetryState == .refusedBecauseBusy {
            rateLimitRetryState = .none
        }
        if resetTurnAttempts {
            turnAttempts.reset()
            rateLimitedSendRetries = 0
        }
    }

    /// Settles and clears a pending send after a definitive server refusal.
    func settleDefinitiveRefusal(
        key: UUID,
        session: AidenChatDraftStore.Session
    ) async {
        await draftStore.settlePendingSend(key: key, session: session)
        pendingSend = nil
        if rateLimitRetryState == .refusedBecauseBusy {
            rateLimitRetryState = .none
        }
        turnAttempts.reset()
        rateLimitedSendRetries = 0
    }

    /// Settles and clears a pending send after the machine's credential was revoked.
    func clearAfterRevocation(
        key: UUID,
        session: AidenChatDraftStore.Session?
    ) async {
        if let session {
            await draftStore.settlePendingSend(key: key, session: session)
        }
        pendingSend = nil
        if rateLimitRetryState == .refusedBecauseBusy {
            rateLimitRetryState = .none
        }
    }

    /// Discards the saved pending send from disk and clears recovery state.
    func discard(session: AidenChatDraftStore.Session) async throws {
        cancelRateLimitedSendRetry()
        rateLimitedSendRetries = 0
        try await draftStore.savePendingSend(nil, session: session)
        pendingSend = nil
        sendRecoveryError = nil
        turnAttempts.reset()
    }

    /// The Mac refused `attempt` with a retryable 429 before running it, and
    /// settled its Idempotency-Key as rejected, so that key cannot be sent
    /// again. The same request is saved again under a fresh key and sent once
    /// the server's delay has passed. Returns `false` when the fresh attempt
    /// could not be saved, leaving the failure terminal.
    func scheduleRateLimitedSendRetry(
        replacing attempt: AidenChatDraftStore.PendingSend,
        error: AidenRemoteClientError,
        session: AidenChatDraftStore.Session,
        isContextLive: @MainActor () -> Bool,
        now: Date = Date(),
        onRetry: @escaping @MainActor () async -> Void
    ) async -> Bool {
        await draftStore.settlePendingSend(key: attempt.key, session: session)
        turnAttempts.reset()
        let fresh = AidenChatDraftStore.PendingSend(
            deviceId: attempt.deviceId,
            request: attempt.request,
            key: turnAttempts.key(for: attempt.request),
            createdAt: now,
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
        guard isContextLive(), rateLimitedSendRetries < Self.maxRateLimitedSendRetries else {
            rateLimitRetryState = .refusedBecauseBusy
            return true
        }
        let delay: Duration = error.serverRetryAfterSeconds.map { .seconds($0) }
            ?? .milliseconds(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: rateLimitedSendRetries))
        rateLimitedSendRetries += 1
        rateLimitedSendRetryTask?.cancel()
        rateLimitRetryState = .waitingAutomatic
        let sleep = rateLimitedSendRetrySleep
        let key = fresh.key
        rateLimitedSendRetryTask = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            guard let self, !Task.isCancelled, self.pendingSend?.key == key else { return }
            self.rateLimitedSendRetryTask = nil
            self.rateLimitRetryState = .none
            await onRetry()
        }
        return true
    }
}
