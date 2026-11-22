import Foundation

/// The Remote calls a background action needs. `AidenRemoteClient` is the
/// real one; tests use a recording fake.
protocol AidenAlertActionTransport: Sendable {
    func respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        scope: AidenApprovalScope?,
        idempotencyKey: UUID
    ) async throws -> AidenApprovalResponse
    func respondToRunApproval(
        runId: String,
        approvalId: String,
        decision: AidenApprovalDecision,
        scope: AidenApprovalScope?,
        idempotencyKey: UUID
    ) async throws -> AidenRemoteRunApprovalResult
    func respondToQuestion(
        id: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenQuestionRespondResponse
    func respondToRunQuestion(
        runId: String,
        promptId: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenRemoteRunQuestionResult
}

extension AidenRemoteClient: AidenAlertActionTransport {}

/// Sends one background action to its Mac. Approve and deny are once-only
/// (no broader scope); a reply is the first question's custom answer.
struct AidenAlertActionResponder {
    enum ClientLookup {
        case client(any AidenAlertActionTransport)
        /// Paired, but no client right now (offline, credentials missing).
        case unreachable
        /// No longer paired with this phone.
        case forgotten
    }

    /// Answers that lost a race or arrived too late; the ask is gone.
    static let resolvedCodes: Set<String> = [
        "approval_resolved",
        "approval_already_resolved",
        "approval_expired",
        "question_already_resolved",
        "question_expired",
    ]

    let lookup: @MainActor (String) -> ClientLookup

    @MainActor
    func run(_ action: AidenAlertAction) async -> AidenAlertActionOutcome {
        let chatURL = AidenDeepLink.chatURL(instanceId: action.instanceID, chatId: action.chatID)
        let client: any AidenAlertActionTransport
        switch lookup(action.instanceID) {
        case .forgotten:
            return .dropped
        case .unreachable:
            return .openApp(chatURL)
        case let .client(found):
            client = found
        }

        do {
            switch action {
            case let .approve(_, _, target):
                try await respond(to: target, decision: .allow, using: client)
            case let .deny(_, _, target):
                try await respond(to: target, decision: .deny, using: client)
            case let .reply(_, _, promptID, runID, text):
                let request = AidenQuestionRespondRequest(
                    cancelled: false,
                    answers: [.custom(questionIndex: 0, answer: text)]
                )
                if let runID {
                    _ = try await client.respondToRunQuestion(
                        runId: runID,
                        promptId: promptID,
                        request: request,
                        idempotencyKey: UUID()
                    )
                } else {
                    _ = try await client.respondToQuestion(id: promptID, request: request, idempotencyKey: UUID())
                }
            }
            return .done
        } catch let AidenRemoteClientError.server(statusCode, body)
            where statusCode == 409 && Self.resolvedCodes.contains(body.code.rawValue) {
            return .alreadyResolved
        } catch {
            return .openApp(chatURL)
        }
    }

    private func respond(
        to target: AgentRunApprovalTarget,
        decision: AidenApprovalDecision,
        using client: any AidenAlertActionTransport
    ) async throws {
        if let runID = target.runID {
            _ = try await client.respondToRunApproval(
                runId: runID,
                approvalId: target.approvalID,
                decision: decision,
                scope: nil,
                idempotencyKey: UUID()
            )
        } else {
            _ = try await client.respondToApproval(
                id: target.approvalID,
                decision: decision,
                scope: nil,
                idempotencyKey: UUID()
            )
        }
    }
}

extension AidenBackgroundActionBroker {
    /// The app's wiring: answer through the paired Mac's client, then show the
    /// answer on the card when the Mac took it or the ask was already gone.
    static func perform(
        coordinator: AidenRemoteCoordinator,
        liveActivities: AidenRemoteLiveActivityManager
    ) -> @MainActor (AidenAlertAction) async -> AidenAlertActionOutcome {
        { [weak coordinator] action in
            guard let coordinator else { return .openApp(nil) }
            let responder = AidenAlertActionResponder(lookup: { instanceID in
                guard coordinator.hosts.connection(for: instanceID) != nil else { return .forgotten }
                guard let context = try? coordinator.ownerContext(for: instanceID),
                      let client = try? coordinator.remoteClient(for: context) else { return .unreachable }
                return .client(client)
            })
            let outcome = await responder.run(action)
            guard outcome == .done || outcome == .alreadyResolved else { return outcome }
            switch action {
            case let .approve(_, _, target):
                await liveActivities.approvalAnswered(approvalID: target.approvalID, decision: .allow)
            case let .deny(_, _, target):
                await liveActivities.approvalAnswered(approvalID: target.approvalID, decision: .deny)
            case .reply:
                break
            }
            return outcome
        }
    }
}
