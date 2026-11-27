import Foundation
import Observation

/// Explicit sub-machines extracted from `AidenChatViewModel` for chat-level
/// mutations and authority snapshot reads:
/// - `AidenWorktreeSetupMachine`: revision-53 worktree setup + cancel-after-finish guard
/// - `AidenChatForkAttemptMachine`: idempotent chat fork key retention
/// - `AidenContinueInNewChatAttemptMachine`: idempotent continue-in-new-chat key retention
/// - `AidenApprovalSnapshotFence` / `AidenQuestionSnapshotFence`: monotonic snapshot read fences
@MainActor
struct AidenChatMutationSubMachines {
    let worktreeSetup = AidenWorktreeSetupMachine()
    var forkAttempt = AidenChatForkAttemptMachine()
    var continueInNewChatAttempt = AidenContinueInNewChatAttemptMachine()
    var approvalSnapshots = AidenApprovalSnapshotFence()
    var questionSnapshots = AidenQuestionSnapshotFence()
}

// MARK: - Worktree Setup (contract revision 53)

/// Owns the first-message worktree setup task, its per-text idempotency key,
/// and the `worktreeSetupCanceled` cancel-after-finish guard.
@MainActor
@Observable
final class AidenWorktreeSetupMachine {
    struct Attempt: Equatable, Sendable {
        let text: String
        let idempotencyKey: UUID
    }

    enum Phase: Equatable, Sendable {
        case idle
        case settingUp(attempt: Attempt, canceled: Bool)
    }

    private(set) var phase: Phase = .idle
    @ObservationIgnored private(set) var retainedAttempt: Attempt?
    @ObservationIgnored private var setupTask: Task<AidenChatNewWorktree, Error>?

    deinit {
        setupTask?.cancel()
    }

    var isSettingUp: Bool {
        if case .settingUp = phase { return true }
        return false
    }

    /// True if Cancel was pressed during the active setup. A task that already
    /// finished ignores `Task.cancel()`, so the press is preserved here.
    var isCanceled: Bool {
        if case .settingUp(_, let canceled) = phase { return canceled }
        return false
    }

    /// Reuses the retained key when retrying the exact same prompt text, or
    /// mints a fresh key otherwise.
    @discardableResult
    func begin(for text: String, makeKey: () -> UUID = UUID.init) -> Attempt {
        let attempt: Attempt
        if let existing = retainedAttempt, existing.text == text {
            attempt = existing
        } else {
            attempt = Attempt(text: text, idempotencyKey: makeKey())
            retainedAttempt = attempt
        }
        phase = .settingUp(attempt: attempt, canceled: false)
        return attempt
    }

    /// Stops waiting for the worktree. Preserves the cancel signal even if the
    /// underlying task already resolved before cancellation propagated.
    func cancel() {
        guard case .settingUp(let attempt, _) = phase else { return }
        phase = .settingUp(attempt: attempt, canceled: true)
        setupTask?.cancel()
    }

    /// Evaluates the cancel-after-finish guard once setup completes.
    func shouldThrowCancellationAfterFinish(taskWasCancelled: Bool) -> Bool {
        taskWasCancelled || isCanceled
    }

    /// Records a failed worktree request, spending the retained key only when
    /// `AidenNewWorktreeRetry.spendsKey(_:)` proves the failure is terminal.
    func recordFailure(_ error: Error) {
        if AidenNewWorktreeRetry.spendsKey(error) {
            retainedAttempt = nil
        }
    }

    /// Clears the retained key after the chat has moved into the new worktree.
    func recordMoved() {
        retainedAttempt = nil
    }

    /// Ends the active setup phase without disturbing `retainedAttempt`.
    func endPhase() {
        phase = .idle
        setupTask = nil
    }

    /// Runs a worktree setup operation under this machine's lifecycle, applying
    /// `onMoved` before enforcing the cancel-after-finish guard so a worktree
    /// created just as Cancel was pressed is still adopted while the message
    /// stays unsent.
    ///
    /// Returns `false` if `onMoved` reported that the chat was removed or its
    /// owner context is no longer live (caller should stop immediately).
    func execute(
        text: String,
        makeKey: () -> UUID = UUID.init,
        operation: @escaping @MainActor (UUID) async throws -> AidenChatNewWorktree,
        onMoved: @MainActor (AidenChatNewWorktree) async -> Bool
    ) async throws -> Bool {
        let attempt = begin(for: text, makeKey: makeKey)
        let setup = Task { try await operation(attempt.idempotencyKey) }
        setupTask = setup
        defer { endPhase() }
        let moved: AidenChatNewWorktree
        do {
            moved = try await withTaskCancellationHandler {
                try await setup.value
            } onCancel: {
                setup.cancel()
            }
        } catch {
            recordFailure(error)
            throw error
        }
        let shouldContinue = await onMoved(moved)
        guard shouldContinue else { return false }
        recordMoved()
        if shouldThrowCancellationAfterFinish(taskWasCancelled: setup.isCancelled) {
            throw CancellationError()
        }
        return true
    }
}

// MARK: - Fork & Continue-in-New-Chat Attempt Retention

/// Explicit idempotency-key retention sub-machine for `fork(messageId:action:summaryFocus:)`.
struct AidenChatForkAttemptMachine: Equatable {
    var retained: AidenChatForkAttempt?

    mutating func begin(
        context: AidenRemoteRequestContext,
        request: AidenChatForkAttempt.Request,
        makeKey: () -> UUID = UUID.init
    ) -> AidenChatForkAttempt {
        let attempt = AidenChatForkAttempt.retaining(
            retained,
            context: context,
            request: request,
            makeKey: makeKey
        )
        retained = attempt
        return attempt
    }

    mutating func recordSuccess(_ attempt: AidenChatForkAttempt) {
        if retained == attempt {
            retained = nil
        }
    }

    mutating func recordFailure(_ error: Error, for attempt: AidenChatForkAttempt) {
        if aidenIsCancellation(error) {
            // A cancelled request may already have reached the Mac; keep the key.
            return
        }
        if retained == attempt, !AidenChatForkAttempt.outcomeIsUnknown(after: error) {
            retained = nil
        }
    }
}

/// Explicit idempotency-key retention sub-machine for `continueInNewChat(workspaceId:)`.
struct AidenContinueInNewChatAttemptMachine: Equatable {
    var retained: AidenContinueInNewChatAttempt?

    mutating func begin(
        context: AidenRemoteRequestContext,
        chatId: String,
        revision: String,
        workspaceId: String,
        makeKey: () -> UUID = UUID.init
    ) -> AidenContinueInNewChatAttempt {
        if let existing = retained,
           existing.context == context,
           existing.chatId == chatId,
           existing.revision == revision,
           existing.workspaceId == workspaceId {
            return existing
        }
        let attempt = AidenContinueInNewChatAttempt(
            context: context,
            chatId: chatId,
            revision: revision,
            workspaceId: workspaceId,
            idempotencyKey: makeKey()
        )
        retained = attempt
        return attempt
    }

    mutating func recordSuccess(_ attempt: AidenContinueInNewChatAttempt) {
        if retained == attempt {
            retained = nil
        }
    }

    mutating func recordFailure(_ error: Error, for attempt: AidenContinueInNewChatAttempt) {
        if aidenIsCancellation(error) {
            // A cancelled request may already have reached the computer; keep the key.
            return
        }
        if retained == attempt, !AidenChatForkAttempt.outcomeIsUnknown(after: error) {
            retained = nil
        }
    }
}

// MARK: - Approval & Question Snapshot Generation Fences

/// Monotonic fence for `restorePendingApproval` reads, including fallback
/// coalescing so a fallback read never duplicates an identical in-flight read.
struct AidenApprovalSnapshotFence: Equatable {
    struct Token: Equatable {
        let generation: UInt64
        let streamID: String
        let context: AidenRemoteRequestContext
        let expectedApproval: AidenPendingApproval?
        let expectedState: AidenStreamState?
    }

    private(set) var generation: UInt64 = 0
    private(set) var inFlight: Token?

    /// Starts a fenced approval snapshot read. Returns `nil` when `isFallback`
    /// is true and an identical live read is already in flight.
    mutating func begin(
        streamID: String,
        context: AidenRemoteRequestContext,
        pendingApproval: AidenPendingApproval?,
        streamState: AidenStreamState?,
        isFallback: Bool,
        isInFlightContextLive: Bool
    ) -> Token? {
        if isFallback,
           let read = inFlight,
           read.streamID == streamID,
           isInFlightContextLive,
           read.expectedApproval == pendingApproval,
           read.expectedState == streamState {
            return nil
        }
        generation &+= 1
        let token = Token(
            generation: generation,
            streamID: streamID,
            context: context,
            expectedApproval: pendingApproval,
            expectedState: streamState
        )
        inFlight = token
        return token
    }

    /// True only when the snapshot response still matches the current
    /// generation, active stream, expected approval/state, and live context.
    func accepts(
        _ token: Token,
        activeStreamID: String?,
        pendingApproval: AidenPendingApproval?,
        streamState: AidenStreamState?,
        isRemoved: Bool,
        isContextLive: Bool
    ) -> Bool {
        !isRemoved
            && isContextLive
            && activeStreamID == token.streamID
            && token.generation == generation
            && pendingApproval == token.expectedApproval
            && streamState == token.expectedState
    }

    mutating func finish(_ token: Token) {
        if token.generation == generation {
            inFlight = nil
        }
    }
}

/// Monotonic fence for `restorePendingQuestion` reads.
struct AidenQuestionSnapshotFence: Equatable {
    struct Token: Equatable {
        let generation: UInt64
        let streamID: String
        let expectedQuestion: AidenPendingQuestion?
        let expectedState: AidenStreamState?
    }

    private(set) var generation: UInt64 = 0

    mutating func begin(
        streamID: String,
        pendingQuestion: AidenPendingQuestion?,
        streamState: AidenStreamState?
    ) -> Token {
        generation &+= 1
        return Token(
            generation: generation,
            streamID: streamID,
            expectedQuestion: pendingQuestion,
            expectedState: streamState
        )
    }

    func accepts(
        _ token: Token,
        activeStreamID: String?,
        pendingQuestion: AidenPendingQuestion?,
        streamState: AidenStreamState?,
        isContextLive: Bool
    ) -> Bool {
        isContextLive
            && activeStreamID == token.streamID
            && token.generation == generation
            && pendingQuestion == token.expectedQuestion
            && streamState == token.expectedState
    }
}
