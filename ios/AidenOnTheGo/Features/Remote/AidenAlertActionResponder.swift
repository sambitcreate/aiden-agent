import Foundation
import UserNotifications

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
        /// No longer paired with this phone, or the Mac revoked it.
        case forgotten
    }

    /// Answers that lost a race or arrived too late; the ask is gone.
    static let resolvedCodes: Set<String> = [
        "approval_resolved",
        "approval_already_resolved",
        "approval_expired",
        "question_already_resolved",
        "question_expired",
        // The run already finished (409) or the Mac no longer has it (404).
        "operation_stale",
        "run_gone",
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
            where [404, 409].contains(statusCode) && Self.resolvedCodes.contains(body.code.rawValue) {
            return .alreadyResolved(winner: Self.winner(body.details?.decision))
        } catch let error as AidenRemoteClientError where error.isCredentialRevoked {
            // The Mac will never take it; posting the alert again can't help.
            return .dropped
        } catch {
            return .openApp(chatURL)
        }
    }

    /// The Mac's winning decision, when it names one; expired, cancelled or
    /// unnamed reads as nil.
    private static func winner(_ decision: String?) -> AgentRunApprovalAnswer? {
        switch decision {
        case "allow": .allow
        case "deny": .deny
        default: nil
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
        let perform = perform(
            lookup: { [weak coordinator] instanceID in
                guard let coordinator else { return .unreachable }
                guard let connection = coordinator.hosts.connection(for: instanceID),
                      !connection.isRevoked else { return .forgotten }
                guard let context = try? coordinator.ownerContext(for: instanceID),
                      let client = try? coordinator.remoteClient(for: context) else { return .unreachable }
                return .client(client)
            },
            liveActivities: liveActivities
        )
        return { [weak coordinator] action in
            guard coordinator != nil else { return .openApp(nil) }
            return await perform(action)
        }
    }

    /// The card shows the answer that counts: the phone's own when the Mac
    /// took it, the Mac's winning one when someone answered first, and a
    /// neutral line when the Mac doesn't say who won. A reply that lands takes
    /// the question off the card.
    static func perform(
        lookup: @escaping @MainActor (String) -> AidenAlertActionResponder.ClientLookup,
        liveActivities: AidenRemoteLiveActivityManager
    ) -> @MainActor (AidenAlertAction) async -> AidenAlertActionOutcome {
        { action in
            let outcome = await AidenAlertActionResponder(lookup: lookup).run(action)
            let target: AgentRunApprovalTarget
            let asked: AgentRunApprovalAnswer
            switch action {
            case let .approve(_, _, approval):
                (target, asked) = (approval, .allow)
            case let .deny(_, _, approval):
                (target, asked) = (approval, .deny)
            case let .reply(instanceID, chatID, _, _, _):
                switch outcome {
                case .done:
                    await liveActivities.questionAnswered(instanceID: instanceID, chatID: chatID, landed: true)
                case .alreadyResolved:
                    await liveActivities.questionAnswered(instanceID: instanceID, chatID: chatID, landed: false)
                case .openApp, .dropped:
                    break
                }
                return outcome
            }
            switch outcome {
            case .done:
                await liveActivities.approvalAnswered(approvalID: target.approvalID, decision: asked)
            case let .alreadyResolved(winner):
                await liveActivities.approvalAnswered(approvalID: target.approvalID, decision: winner)
            case .openApp, .dropped:
                break
            }
            return outcome
        }
    }
}

/// The alert for an answer from a Live Activity that didn't reach the Mac.
/// It names no chat or approval text, and a tap opens the chat to answer.
enum AidenUnansweredCardAction {
    nonisolated static let identifierPrefix = "aiden.card-unanswered."

    @MainActor
    static func post(_ action: AidenAlertAction, link: URL?, center: AidenRunAlertCenter) async {
        switch await center.currentAuthorizationStatus() {
        case .authorized, .provisional, .ephemeral:
            break
        default:
            return
        }
        guard let link = link ?? AidenDeepLink.chatURL(instanceId: action.instanceID, chatId: action.chatID) else {
            return
        }
        let content = UNMutableNotificationContent()
        content.title = switch action {
        case .deny: String(localized: "Deny didn't reach your computer")
        case .approve, .reply: String(localized: "Your answer didn't reach your computer")
        }
        content.body = String(localized: "Open the chat to answer there.")
        content.userInfo = [
            AidenRunAlertNotifier.deepLinkUserInfoKey: link.absoluteString,
            AidenRunAlertNotifier.instanceUserInfoKey: action.instanceID,
        ]
        let request = UNNotificationRequest(
            identifier: AidenMachineNotificationIdentifier.make(
                prefix: identifierPrefix,
                instanceId: action.instanceID,
                id: action.chatID
            ),
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }
}
