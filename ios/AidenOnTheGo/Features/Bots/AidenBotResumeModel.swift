import Foundation
import Observation

protocol AidenBotResumeTransport: Sendable {
    func botRoutineResumeStatus(botId: String) async throws -> AidenBotResumeStatus
    func resumeBotSession(botId: String, idempotencyKey: UUID, acknowledgeUnknownCost: Bool, expectedSubmissionId: String?, expectedCostReceiptId: String?) async throws -> AidenBotSessionStateView
}
extension AidenRemoteClient: AidenBotResumeTransport {}

/// Only a recognized before-effect refusal may release a first Resume key.
/// Unknown/unfinished outcome codes (including a 409) preserve the exact body;
/// neither the HTTP status nor retryable flag proves an effect did not occur.
func aidenBotResumeFailureIsAmbiguous(_ error: Error) -> Bool {
    if case let AidenRemoteClientError.server(_, body) = error {
        let beforeEffectCodes: Set<String> = [
            "invalid_request", "payload_too_large", "authentication_required", "credential_revoked",
            "capability_denied", "server_identity_changed", "not_found", "bot_archived",
            "operation_stale", "bot_paused", "idempotency_conflict", "idempotency_capacity", "rate_limited",
        ]
        guard beforeEffectCodes.contains(body.code.rawValue) else { return true }
    }
    if case AidenRemoteClientError.unexpectedStatus = error { return true }
    return aidenBotSessionFailureIsAmbiguous(error)
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
    private(set) var pending: AidenBotResumeAttempt?
    private(set) var needsConsent = false
    private(set) var busy = false
    var message: String?
    private var consentVersion: String?
    private var consentSubmissionID: String?
    private var consentCostReceiptID: String?
    private var storageBlocked = false
    private var visitIsActive = true
    private var visitGeneration: UInt = 0
    init(botID: String, transport: any AidenBotResumeTransport,
         mayResume: @escaping @MainActor () -> Bool = { true }, version: @escaping @MainActor () -> String = { "current" },
         store: AidenBotRoutineControlStore? = nil, scope: AidenBotRoutineControlStore.Scope? = nil) {
        self.botID = botID; self.transport = transport; self.mayResume = mayResume; self.version = version; self.store = store; self.scope = scope
        self.storageGeneration = scope.flatMap { store?.generation(for: $0) }
        if let store, let scope {
            do { pending = try store.load(scope)?.resume }
            catch { storageBlocked = true; message = "This phone couldn’t recover its earlier Resume request. Inspect the host before resuming." }
        }
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
    var preventsLegacyResume: Bool { pending != nil || busy || needsConsent || storageBlocked }
    private var canUseVisit: Bool { visitIsActive && mayResume() && storageIsCurrent }

    /// A capability negotiated during this visit cannot upgrade an older unknown {} request.
    func adoptOrdinaryPending(key: UUID, createdAt: Date) {
        guard pending == nil, !busy else { return }
        pending = .init(key: key, acknowledgeUnknownCost: false, createdAt: createdAt)
        persist()
    }
    private var storageIsCurrent: Bool { scope.flatMap { store?.generation(for: $0) } == storageGeneration }
    func cancelConsent() { needsConsent = false; consentVersion = nil; consentSubmissionID = nil; consentCostReceiptID = nil }
    func request() async -> AidenBotSessionStateView? {
        guard canUseVisit, !busy, !storageBlocked else { return nil }
        if let pending { return await send(pending, previouslyUnknown: true) }
        busy = true
        let before = version()
        let visit = visitGeneration
        do {
            let status = try await aidenBotWithin(.seconds(12)) { [transport, botID] in try await transport.botRoutineResumeStatus(botId: botID) }
            busy = false
            guard canUseVisit, visitGeneration == visit, version() == before else { return nil }
            if status.requiresUnknownCostAcknowledgement {
                consentVersion = before; consentSubmissionID = status.interruptedSubmissionId; consentCostReceiptID = status.costReceiptId; needsConsent = true; return nil
            }
            return await begin(acknowledge: false, submissionID: nil, costReceiptID: nil)
        } catch {
            busy = false
            if canUseVisit, visitGeneration == visit { message = "The host couldn’t confirm whether another charge may be needed. Try Resume again when connected." }
            return nil
        }
    }
    func confirm() async -> AidenBotSessionStateView? {
        guard needsConsent, let submissionID = consentSubmissionID, let receiptID = consentCostReceiptID, pending == nil, canUseVisit, version() == consentVersion, !busy, !storageBlocked else {
            cancelConsent(); return nil
        }
        cancelConsent()
        return await begin(acknowledge: true, submissionID: submissionID, costReceiptID: receiptID)
    }
    private func begin(acknowledge: Bool, submissionID: String?, costReceiptID: String?) async -> AidenBotSessionStateView? {
        let attempt = AidenBotResumeAttempt(key: UUID(), acknowledgeUnknownCost: acknowledge, createdAt: Date(), expectedSubmissionId: submissionID, expectedCostReceiptId: costReceiptID)
        pending = attempt
        guard persist() else { return nil }
        return await send(attempt, previouslyUnknown: false)
    }
    private func send(_ attempt: AidenBotResumeAttempt, previouslyUnknown: Bool) async -> AidenBotSessionStateView? {
        guard canUseVisit, !busy, !storageBlocked else { return nil }
        let age = Date().timeIntervalSince(attempt.createdAt)
        guard age >= 0, age < 23 * 3600 else {
            message = "The earlier Resume request is too old to replay safely. Its outcome remains unknown; inspect the host."
            return nil
        }
        busy = true; defer { busy = false }
        let visit = visitGeneration
        do {
            let result = try await aidenBotWithin(.seconds(12)) { [transport, botID] in
                try await transport.resumeBotSession(botId: botID, idempotencyKey: attempt.key, acknowledgeUnknownCost: attempt.acknowledgeUnknownCost, expectedSubmissionId: attempt.expectedSubmissionId, expectedCostReceiptId: attempt.expectedCostReceiptId)
            }
            guard canUseVisit, visitGeneration == visit else { return nil }
            pending = nil
            guard persist(settling: attempt.key) else { return nil }
            return result
        } catch {
            guard canUseVisit, visitGeneration == visit else { return nil }
            if !previouslyUnknown, !aidenBotResumeFailureIsAmbiguous(error) {
                pending = nil; persist(settling: attempt.key)
            }
            message = pending == nil ? "The Bot wasn’t resumed. Try again to review the host’s current status." : "The Resume response was lost. Retry keeps the same request and cost acknowledgement."
            return nil
        }
    }
    @discardableResult private func persist(settling nonce: UUID? = nil) -> Bool {
        guard let store, let scope else { return true }
        do { try store.save(pending.map { .init(resume: $0) }, scope: scope, settling: nonce, generation: storageGeneration); return true }
        catch { storageBlocked = true; message = "The Resume request couldn’t be safely retained on this phone. Inspect the host before trying again."; return false }
    }
}
