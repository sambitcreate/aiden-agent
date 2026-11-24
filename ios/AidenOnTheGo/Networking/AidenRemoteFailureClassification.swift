import Foundation

/// Shared endpoint-contract failure ambiguity classification for Aiden Remote mutations.
///
/// Every idempotent iOS mutation falls into one of two host-contract tiers:
///
/// - ``Policy/beforeEffectRefusal(treatsReplayedInternalErrorConflictAsSettled:)``:
///   endpoints where only a recognized before-effect refusal code proves no side
///   effect occurred (`AidenBotResumeModel`, `AidenBotPeersModel`,
///   `AidenBotPeerExchangeModel`, `AidenBotOpenWorkModel`, `AidenBotWatchModel`,
///   `AidenBotRoutineModelsModel`, `AidenBotSessionModel`, Bot settings/avatar/
///   conversation creation). Unknown or unfinished codes (including
///   `409 idempotency_in_flight`, `400 operation_in_progress`,
///   `409 server_interrupted`, `5xx`, `408`, `429`), unparsed HTTP statuses
///   (`.unexpectedStatus`), `.invalidResponse`, `URLError`, `CancellationError`,
///   and non-`AidenRemoteClientError` failures are ambiguous so the caller retains
///   its exact request body and idempotency key.
///
/// - ``Policy/cachedRejectionLedger``:
///   endpoints backed by `executeAidenDurableOperation` (`AidenRemoteCoordinator`,
///   `AidenScheduledTasksModel`, `AidenWorkspaceGitModel`, `AidenChatForkAttempt`,
///   `AidenNewWorktreeRetry`), where the host caches structured rejections under
///   the key for 24 hours (`AidenIdempotencyLedger`) and reports every unrecorded,
///   in-flight, or unknown outcome as `409 idempotency_in_flight`. Client-local
///   failures never reach the host; `CancellationError`, `URLError`,
///   non-`AidenRemoteClientError`, `.invalidResponse`, `.unexpectedStatus`, and
///   `409 idempotency_in_flight` are always ambiguous (never drop the key), while
///   other structured `.server` rejections are settled refusals cached by the ledger.
enum AidenRemoteFailureClassification {
    enum Policy: Sendable, Equatable {
        /// Strict before-effect refusal allowlist.
        ///
        /// Set `treatsReplayedInternalErrorConflictAsSettled: true` only for
        /// `POST /bots/{botId}/messages` (`AidenBotSessionModel.messageFailureIsAmbiguous`),
        /// where the host durable ledger maps a replayed settled `internal_error`
        /// rejection to HTTP `409 internal_error`
        /// (`protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json`).
        case beforeEffectRefusal(treatsReplayedInternalErrorConflictAsSettled: Bool = false)

        /// Durable ledger (`executeAidenDurableOperation`) cached-rejection policy.
        case cachedRejectionLedger
    }

    /// Recognized server error codes that prove a request was refused before any
    /// irreversible side effect occurred.
    ///
    /// Explicitly excludes `idempotency_in_flight`, `operation_in_progress`,
    /// `internal_error`, `server_interrupted`, and any unrecognized future codes.
    static let beforeEffectCodes: Set<String> = [
        // Core protocol, auth, admission, and Bot resume before-effect refusals
        "invalid_request",
        "payload_too_large",
        "authentication_required",
        "credential_revoked",
        "capability_denied",
        "server_identity_changed",
        "not_found",
        "bot_archived",
        "operation_stale",
        "bot_paused",
        "idempotency_conflict",
        "idempotency_capacity",
        "rate_limited",
        // Domain before-effect CAS, validation, and precondition refusals
        "revision_conflict",
        "already_exists",
        "handle_invalid",
        "handle_expired",
        "handle_wrong_device",
        "handle_capacity",
        "approval_already_resolved",
        "approval_resolved",
        "approval_expired",
        "question_already_resolved",
        "question_expired",
        "memory_entry_not_found",
        "memory_over_budget",
        "memory_blocked",
        "routine_proposal_not_found",
        "handoff_expired",
        "access_request_expired",
        "plan_expired",
    ]

    /// Returns `true` when `error` leaves the mutation outcome unknown so the
    /// caller must preserve its idempotency key or frozen pending mutation.
    static func isAmbiguous(_ error: Error, policy: Policy) -> Bool {
        if error is CancellationError || error is URLError {
            return true
        }
        guard let remoteError = error as? AidenRemoteClientError else {
            return true
        }
        switch remoteError {
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
            return false
        case .invalidResponse, .unexpectedStatus:
            return true
        case let .server(statusCode, body):
            switch policy {
            case let .beforeEffectRefusal(treatsReplayedInternalErrorConflictAsSettled):
                if treatsReplayedInternalErrorConflictAsSettled,
                   statusCode == 409,
                   body.code.rawValue == "internal_error" {
                    return false
                }
                guard beforeEffectCodes.contains(body.code.rawValue) else {
                    return true
                }
                return isAmbiguousHTTPStatus(statusCode)
            case .cachedRejectionLedger:
                return body.code.rawValue == "idempotency_in_flight"
            }
        }
    }

    /// Returns `true` when `error` proves the host recorded a terminal rejection
    /// under the idempotency key in the 24-hour durable ledger, so a subsequent
    /// attempt must mint a fresh key.
    ///
    /// Client-local failures never reached the host and do not spend the key.
    /// Transport losses, cancellations, unparsed HTTP responses, and
    /// `409 idempotency_in_flight` leave the outcome unknown and never spend the key.
    static func spendsDurableKey(_ error: Error) -> Bool {
        guard case .server = error as? AidenRemoteClientError else {
            return false
        }
        return !isAmbiguous(error, policy: .cachedRejectionLedger)
    }

    private static func isAmbiguousHTTPStatus(_ statusCode: Int) -> Bool {
        (200..<300).contains(statusCode)
            || statusCode == 408
            || statusCode == 429
            || statusCode >= 500
    }
}
