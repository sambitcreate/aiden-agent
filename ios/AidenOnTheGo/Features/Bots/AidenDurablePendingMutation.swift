import Foundation

/// A frozen, durable Bot control attempt managed by ``AidenDurablePendingMutation``.
protocol AidenDurablePendingAttempt: Equatable {
    var pendingAttemptID: UUID? { get }
    var pendingAttemptCreatedAt: Date { get }
}

/// Shared persist-before-send durable mutation state machine for Bot control
/// models (`AidenBotResumeModel`, `AidenBotWatchModel`,
/// `AidenBotRoutineModelsModel`, `AidenBotPeersModel`,
/// `AidenBotPeerExchangeModel`, and `AidenBotOpenWorkModel`).
///
/// Unifies:
/// - Explicit lifecycle phases (`idle`, `inFlight`, `uncertain`, `storageBlocked`)
/// - Fail-closed `storageBlocked` and `storageGeneration` drift fencing
/// - Persist-before-send admission (no transport call when persistence fails)
/// - Bounded 23-hour replay window with explicit per-attempt exemptions
/// - Sticky `previouslyUnknown` protection so a later guard refusal never clears
///   an earlier uncertain request
/// - Concurrent authoritative-read settlement guard so a late retry failure
///   cannot re-mark an already-settled attempt as uncertain
@MainActor
struct AidenDurablePendingMutation<Attempt: AidenDurablePendingAttempt> {
    static var defaultMaxReplayAge: TimeInterval { 23 * 3600 }

    enum Phase: Equatable {
        case idle
        case inFlight(attempt: Attempt, previouslyUnknown: Bool)
        case uncertain(attempt: Attempt)
        case storageBlocked(retained: Attempt?)
    }

    enum PersistOutcome: Equatable {
        /// Durable state was persisted cleanly (or no store is configured).
        case saved
        /// In-memory precondition declined to write without a storage failure
        /// (for example an invalid draft in memory or a non-current scope).
        case rejectedBeforeWrite
        /// The underlying store write threw; fail closed into `storageBlocked`.
        case storageFailed
    }

    enum ReplayPolicy: Equatable {
        /// Allows replay only when `0 <= age < maxAge` (default 23 hours).
        case bounded(maxAge: TimeInterval = 23 * 3600)
        /// Allows replay for any non-negative age (`age >= 0`), used when a
        /// fresh authoritative GET proved the host still holds the matching
        /// pending receipt (PeerExchange `protectedPendingNonce`).
        case nonNegativeAgeOnly
        /// Always allows replay regardless of elapsed clock age (OpenWork `.isStop`).
        case unrestricted
    }

    enum BeginResult: Equatable {
        case started
        case unavailable
        case rejectedBeforeWrite
        case storageBlocked
    }

    enum RetryStart: Equatable {
        case started(Attempt)
        case expired(Attempt)
        case unavailable
        case rejectedBeforeWrite
        case storageBlocked
    }

    enum FailureResolution: Equatable {
        /// A concurrent authoritative read already settled this attempt, or a
        /// different attempt is active. Caller must leave state untouched.
        case superseded
        /// The attempt remains uncertain (either ambiguous failure or
        /// `previouslyUnknown` stickiness); phase is now `.uncertain(attempt)`.
        case retainedUncertain
        /// First-attempt definite before-effect refusal; phase is now `.idle`
        /// (or `.storageBlocked(retained: nil)` if clearing storage failed).
        case clearedDefiniteRefusal(storageBlocked: Bool)
    }

    private(set) var phase: Phase
    let storageGeneration: String?
    private let currentStorageGeneration: (@MainActor () -> String?)?

    init(
        restoredAttempt: Attempt? = nil,
        storageReadFailed: Bool = false,
        storageGeneration: String? = nil,
        currentStorageGeneration: (@MainActor () -> String?)? = nil
    ) {
        self.storageGeneration = storageGeneration
        self.currentStorageGeneration = currentStorageGeneration
        if storageReadFailed {
            self.phase = .storageBlocked(retained: nil)
        } else if let restoredAttempt {
            self.phase = .uncertain(attempt: restoredAttempt)
        } else {
            self.phase = .idle
        }
    }

    var storageIsCurrent: Bool {
        guard let currentStorageGeneration else { return true }
        return currentStorageGeneration() == storageGeneration
    }

    var pending: Attempt? {
        switch phase {
        case .idle:
            return nil
        case let .inFlight(attempt, _), let .uncertain(attempt):
            return attempt
        case let .storageBlocked(retained):
            return retained
        }
    }

    var isInFlight: Bool {
        if case .inFlight = phase { return true }
        return false
    }

    /// True whenever an unresolved attempt's host outcome is already unknown,
    /// including while an explicit retry of that unknown attempt is in flight
    /// so concurrent authoritative `load()` reads can still reconcile it.
    var isUncertain: Bool {
        switch phase {
        case .idle:
            return false
        case let .inFlight(_, previouslyUnknown):
            return previouslyUnknown
        case .uncertain:
            return true
        case let .storageBlocked(retained):
            return retained != nil
        }
    }

    var isStorageBlocked: Bool {
        if case .storageBlocked = phase { return true }
        return false
    }

    /// True when the engine is neither storage-blocked nor drifted past its
    /// captured store purge generation.
    var canWrite: Bool {
        !isStorageBlocked && storageIsCurrent
    }

    /// True when `id` matches the currently active in-flight attempt.
    func isCurrentInFlight(matching id: UUID?) -> Bool {
        guard let id, case let .inFlight(attempt, _) = phase else { return false }
        return attempt.pendingAttemptID == id
    }

    /// True when `attempt` equals the currently active in-flight attempt.
    func isCurrentInFlight(_ attempt: Attempt) -> Bool {
        guard case let .inFlight(current, _) = phase else { return false }
        return current == attempt
    }

    /// Transitions `.idle` -> `.inFlight(attempt, previouslyUnknown: false)` and
    /// persists BEFORE transport. If persistence fails, transitions atomically
    /// to `.storageBlocked(retained: nil)` so no transport call can proceed.
    @discardableResult
    mutating func begin(
        _ attempt: Attempt,
        persist: (_ pending: Attempt) -> PersistOutcome
    ) -> BeginResult {
        guard canWrite, phase == .idle else { return .unavailable }
        switch persist(attempt) {
        case .saved:
            phase = .inFlight(attempt: attempt, previouslyUnknown: false)
            return .started
        case .rejectedBeforeWrite:
            phase = .idle
            return .rejectedBeforeWrite
        case .storageFailed:
            phase = .storageBlocked(retained: nil)
            return .storageBlocked
        }
    }

    /// Adopts an existing unknown attempt from another flow (for example
    /// `AidenBotResumeModel.adoptOrdinaryPending`) into `.uncertain(attempt)`.
    @discardableResult
    mutating func adoptUncertain(
        _ attempt: Attempt,
        persist: (_ pending: Attempt) -> PersistOutcome
    ) -> Bool {
        guard phase == .idle else { return false }
        switch persist(attempt) {
        case .saved:
            phase = .uncertain(attempt: attempt)
            return true
        case .rejectedBeforeWrite:
            phase = .idle
            return false
        case .storageFailed:
            phase = .storageBlocked(retained: attempt)
            return false
        }
    }

    /// Evaluates the replay age policy and, if eligible, transitions
    /// `.uncertain(attempt)` -> `.inFlight(attempt, previouslyUnknown: true)`.
    mutating func beginRetry(
        now: Date = Date(),
        policy: ReplayPolicy = .bounded()
    ) -> RetryStart {
        beginRetry(now: now, policy: policy) { _ in .saved }
    }

    /// Evaluates the replay age policy, runs `persist` before transitioning
    /// `.uncertain(attempt)` -> `.inFlight(attempt, previouslyUnknown: true)`,
    /// and fails closed to `.storageBlocked(retained: attempt)` if persistence fails.
    mutating func beginRetry(
        now: Date = Date(),
        policy: ReplayPolicy = .bounded(),
        persist: (_ pending: Attempt) -> PersistOutcome
    ) -> RetryStart {
        guard canWrite, case let .uncertain(attempt) = phase else {
            return .unavailable
        }
        let age = now.timeIntervalSince(attempt.pendingAttemptCreatedAt)
        guard Self.allowsReplay(age: age, policy: policy) else {
            return .expired(attempt)
        }
        switch persist(attempt) {
        case .saved:
            phase = .inFlight(attempt: attempt, previouslyUnknown: true)
            return .started(attempt)
        case .rejectedBeforeWrite:
            return .rejectedBeforeWrite
        case .storageFailed:
            phase = .storageBlocked(retained: attempt)
            return .storageBlocked
        }
    }

    /// Settles the current pending attempt (either from an accepted transport
    /// reply or from a concurrent authoritative `load()` receipt) by moving to
    /// `.idle` and persisting with `settling: id`.
    @discardableResult
    mutating func settle(
        matching id: UUID,
        persist: (_ settlingID: UUID) -> PersistOutcome
    ) -> Bool {
        guard let current = pending, current.pendingAttemptID == id else {
            return false
        }
        phase = .idle
        switch persist(id) {
        case .saved, .rejectedBeforeWrite:
            return true
        case .storageFailed:
            phase = .storageBlocked(retained: nil)
            return false
        }
    }

    /// Moves an in-flight attempt to `.uncertain(attempt)` without settling it
    /// (for example, a non-terminal Stop acknowledgement).
    mutating func markUncertain(matching id: UUID) {
        guard case let .inFlight(attempt, _) = phase,
              attempt.pendingAttemptID == id else {
            return
        }
        phase = .uncertain(attempt: attempt)
    }

    /// Safety `defer` hook for transport calls: if the call exits early (for
    /// example because the foreground visit changed or scope became non-current)
    /// while this attempt is still `.inFlight`, transitions it to
    /// `.uncertain(attempt)` so `isInFlight` never leaks `true` and the
    /// dispatched identity is kept.
    mutating func abandonInFlightIfUnsettled(matching id: UUID?) {
        guard let id,
              case let .inFlight(attempt, _) = phase,
              attempt.pendingAttemptID == id else {
            return
        }
        phase = .uncertain(attempt: attempt)
    }

    /// Resolves a thrown transport/HTTP error for an in-flight attempt using
    /// `AidenRemoteFailureClassification`, preserving `previouslyUnknown`
    /// stickiness and guarding against concurrent `load()` settlement.
    mutating func resolveFailure(
        matching id: UUID,
        error: Error,
        policy: AidenRemoteFailureClassification.Policy = .beforeEffectRefusal(),
        persistClear: (_ settlingID: UUID) -> PersistOutcome
    ) -> FailureResolution {
        guard case let .inFlight(attempt, previouslyUnknown) = phase,
              attempt.pendingAttemptID == id else {
            return .superseded
        }
        let ambiguous = AidenRemoteFailureClassification.isAmbiguous(error, policy: policy)
        if previouslyUnknown || ambiguous {
            phase = .uncertain(attempt: attempt)
            return .retainedUncertain
        }
        phase = .idle
        switch persistClear(id) {
        case .saved, .rejectedBeforeWrite:
            return .clearedDefiniteRefusal(storageBlocked: false)
        case .storageFailed:
            phase = .storageBlocked(retained: nil)
            return .clearedDefiniteRefusal(storageBlocked: true)
        }
    }

    /// Resolves a structured HTTP 200 `.rejected` reply for an in-flight
    /// attempt, preserving `previouslyUnknown` stickiness and `.unavailable`
    /// uncertainty, and guarding against concurrent `load()` settlement.
    mutating func resolveRejection(
        matching id: UUID,
        isUncertainOutcome: Bool,
        persistClear: (_ settlingID: UUID) -> PersistOutcome
    ) -> FailureResolution {
        guard case let .inFlight(attempt, previouslyUnknown) = phase,
              attempt.pendingAttemptID == id else {
            return .superseded
        }
        if previouslyUnknown || isUncertainOutcome {
            phase = .uncertain(attempt: attempt)
            return .retainedUncertain
        }
        phase = .idle
        switch persistClear(id) {
        case .saved, .rejectedBeforeWrite:
            return .clearedDefiniteRefusal(storageBlocked: false)
        case .storageFailed:
            phase = .storageBlocked(retained: nil)
            return .clearedDefiniteRefusal(storageBlocked: true)
        }
    }

    /// Records a storage write failure triggered outside a mutation transition
    /// (for example while persisting a draft edit), failing closed into
    /// `.storageBlocked` while retaining any already-pending attempt.
    mutating func recordStorageFailure() {
        phase = .storageBlocked(retained: pending)
    }

    private static func allowsReplay(age: TimeInterval, policy: ReplayPolicy) -> Bool {
        switch policy {
        case let .bounded(maxAge):
            return age >= 0 && age < maxAge
        case .nonNegativeAgeOnly:
            return age >= 0
        case .unrestricted:
            return true
        }
    }
}

@MainActor
func aidenRestoreBotControl<State, Attempt: AidenDurablePendingAttempt>(
    load: () throws -> State?,
    attempt: (State) -> Attempt?,
    storageGeneration: String? = nil,
    currentStorageGeneration: (@MainActor () -> String?)? = nil,
    readErrorMessage: String
) -> (state: State?, mutation: AidenDurablePendingMutation<Attempt>, message: String?) {
    var state: State?
    var readFailed = false
    var message: String?
    do {
        state = try load()
    } catch {
        readFailed = true
        message = readErrorMessage
    }
    let mutation = AidenDurablePendingMutation(
        restoredAttempt: state.flatMap(attempt),
        storageReadFailed: readFailed,
        storageGeneration: storageGeneration,
        currentStorageGeneration: currentStorageGeneration
    )
    return (state: state, mutation: mutation, message: message)
}
