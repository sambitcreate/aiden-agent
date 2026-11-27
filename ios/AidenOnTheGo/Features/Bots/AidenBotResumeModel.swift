import Foundation
import Observation

protocol AidenBotResumeTransport: Sendable {
    func botRoutineResumeStatus(botId: String) async throws -> AidenBotResumeStatus
    func resumeBotSession(botId: String, idempotencyKey: UUID, acknowledgeUnknownCost: Bool, expectedSubmissionId: String?, expectedCostReceiptId: String?) async throws -> AidenBotSessionStateView
}
extension AidenRemoteClient: AidenBotResumeTransport {}

extension AidenBotResumeAttempt: AidenDurablePendingAttempt {
    var pendingAttemptID: UUID? { key }
    var pendingAttemptCreatedAt: Date { createdAt }
}

/// Only a recognized before-effect refusal may release a first Resume key.
/// Unknown/unfinished outcome codes (including a 409) preserve the exact body;
/// neither the HTTP status nor retryable flag proves an effect did not occur.
func aidenBotResumeFailureIsAmbiguous(_ error: Error) -> Bool {
    AidenRemoteFailureClassification.isAmbiguous(error, policy: .beforeEffectRefusal())
}

@MainActor @Observable
final class AidenBotResumeModel {
    static let confirmation = "The cost of an earlier provider request is unconfirmed. Resuming may incur another charge. Known spending limits still apply."
    let botID: String
    private let transport: any AidenBotResumeTransport
    private let mayResume: @MainActor () -> Bool
    private let version: @MainActor () -> String
    private let store: AidenBotRoutineControlStore?
    private let scope: AidenBotRoutineControlStore.Scope?
    private let storageGeneration: String?
    private var mutation: AidenDurablePendingMutation<AidenBotResumeAttempt>
    private(set) var needsConsent = false
    private var preflightBusy = false
    var message: String?
    private var consentVersion: String?
    private var consentSubmissionID: String?
    private var consentCostReceiptID: String?
    private var visitIsActive = true
    private var visitGeneration: UInt = 0

    var pending: AidenBotResumeAttempt? { mutation.pending }
    var busy: Bool { preflightBusy || mutation.isInFlight }

    init(botID: String, transport: any AidenBotResumeTransport,
         mayResume: @escaping @MainActor () -> Bool = { true }, version: @escaping @MainActor () -> String = { "current" },
         store: AidenBotRoutineControlStore? = nil, scope: AidenBotRoutineControlStore.Scope? = nil) {
        self.botID = botID; self.transport = transport; self.mayResume = mayResume; self.version = version; self.store = store; self.scope = scope
        let generation = scope.flatMap { store?.generation(for: $0) }
        self.storageGeneration = generation
        let restored = aidenRestoreBotControl(
            load: { try store.flatMap { s in try scope.flatMap { try s.load($0) } } },
            attempt: { $0.resume },
            storageGeneration: generation,
            currentStorageGeneration: scope.flatMap { capturedScope in
                store.map { capturedStore in { capturedStore.generation(for: capturedScope) } }
            },
            readErrorMessage: "This phone couldn’t recover its earlier Resume request. Inspect the computer before resuming."
        )
        self.mutation = restored.mutation
        if let readErrorMessage = restored.message { self.message = readErrorMessage }
    }

    /// Resume authority belongs to one visible, active visit. Backgrounding
    /// invalidates preflight and consent without touching the durable feed or
    /// an exact request that may already have reached the host.
    func setForegroundVisit(active: Bool) {
        guard active != visitIsActive else { return }
        visitIsActive = active
        visitGeneration &+= 1
        cancelConsent()
    }

    /// An unresolved managed operation cannot be replaced by the legacy {} route.
    var preventsLegacyResume: Bool { mutation.pending != nil || busy || needsConsent || mutation.isStorageBlocked }
    private var canUseVisit: Bool { visitIsActive && mayResume() && mutation.storageIsCurrent }

    /// A capability negotiated during this visit cannot upgrade an older unknown {} request.
    func adoptOrdinaryPending(key: UUID, createdAt: Date) {
        guard !busy else { return }
        _ = mutation.adoptUncertain(.init(key: key, acknowledgeUnknownCost: false, createdAt: createdAt)) { attempt in
            persistStore(pending: attempt)
        }
    }

    func cancelConsent() { needsConsent = false; consentVersion = nil; consentSubmissionID = nil; consentCostReceiptID = nil }

    func request() async -> AidenBotSessionStateView? {
        guard canUseVisit, !busy, mutation.canWrite else { return nil }
        if mutation.pending != nil {
            switch mutation.beginRetry() {
            case let .started(attempt):
                return await send(attempt)
            case .expired:
                message = "The earlier Resume request is too old to replay safely. Its outcome remains unknown; inspect the computer."
                return nil
            case .unavailable, .rejectedBeforeWrite, .storageBlocked:
                return nil
            }
        }
        preflightBusy = true
        let before = version()
        let visit = visitGeneration
        do {
            let status = try await aidenBotWithin(.seconds(12)) { [transport, botID] in try await transport.botRoutineResumeStatus(botId: botID) }
            preflightBusy = false
            guard canUseVisit, visitGeneration == visit, version() == before else { return nil }
            if status.requiresUnknownCostAcknowledgement {
                consentVersion = before; consentSubmissionID = status.interruptedSubmissionId; consentCostReceiptID = status.costReceiptId; needsConsent = true; return nil
            }
            return await begin(acknowledge: false, submissionID: nil, costReceiptID: nil)
        } catch {
            preflightBusy = false
            if canUseVisit, visitGeneration == visit { message = "The computer couldn’t confirm whether another charge may be needed. Try Resume again when connected." }
            return nil
        }
    }

    func confirm() async -> AidenBotSessionStateView? {
        guard needsConsent, let submissionID = consentSubmissionID, let receiptID = consentCostReceiptID,
              mutation.pending == nil, canUseVisit, version() == consentVersion, !busy, mutation.canWrite else {
            cancelConsent(); return nil
        }
        cancelConsent()
        return await begin(acknowledge: true, submissionID: submissionID, costReceiptID: receiptID)
    }

    private func begin(acknowledge: Bool, submissionID: String?, costReceiptID: String?) async -> AidenBotSessionStateView? {
        let attempt = AidenBotResumeAttempt(key: UUID(), acknowledgeUnknownCost: acknowledge, createdAt: Date(), expectedSubmissionId: submissionID, expectedCostReceiptId: costReceiptID)
        guard mutation.begin(attempt, persist: { persistStore(pending: $0) }) == .started else { return nil }
        return await send(attempt)
    }

    private func send(_ attempt: AidenBotResumeAttempt) async -> AidenBotSessionStateView? {
        defer { mutation.abandonInFlightIfUnsettled(matching: attempt.key) }
        let visit = visitGeneration
        do {
            let result = try await aidenBotWithin(.seconds(12)) { [transport, botID] in
                try await transport.resumeBotSession(botId: botID, idempotencyKey: attempt.key, acknowledgeUnknownCost: attempt.acknowledgeUnknownCost, expectedSubmissionId: attempt.expectedSubmissionId, expectedCostReceiptId: attempt.expectedCostReceiptId)
            }
            guard canUseVisit, visitGeneration == visit else { return nil }
            guard mutation.settle(matching: attempt.key, persist: { persistStore(pending: nil, settling: $0) }) else { return nil }
            return result
        } catch {
            guard canUseVisit, visitGeneration == visit else { return nil }
            let resolution = mutation.resolveFailure(matching: attempt.key, error: error) { settlingID in
                persistStore(pending: nil, settling: settlingID)
            }
            switch resolution {
            case .superseded:
                return nil
            case let .clearedDefiniteRefusal(storageBlocked):
                if !storageBlocked {
                    message = "The Bot wasn’t resumed. Try again to review the computer’s current status."
                }
                return nil
            case .retainedUncertain:
                message = "The Resume response was lost. Retry keeps the same request and cost acknowledgement."
                return nil
            }
        }
    }

    private func persistStore(pending: AidenBotResumeAttempt?, settling nonce: UUID? = nil) -> AidenDurablePendingMutation<AidenBotResumeAttempt>.PersistOutcome {
        guard let store, let scope else { return .saved }
        do {
            try store.save(pending.map { .init(resume: $0) }, scope: scope, settling: nonce, generation: storageGeneration)
            return .saved
        } catch {
            message = "The Resume request couldn’t be safely retained on this phone. Inspect the computer before trying again."
            return .storageFailed
        }
    }
}
