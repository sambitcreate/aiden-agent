package sbtbiswas.AidenOnTheGo.protocol

import kotlinx.coroutines.CancellationException

/**
 * Endpoint-contract policies for deciding whether a failed Remote mutation may have taken effect
 * on the host (so the client must keep its pending attempt / `Idempotency-Key` for replay or
 * authoritative reconciliation) versus a definite refusal that proved no effect occurred or
 * settled the key in the host ledger.
 */
enum class AidenRemoteFailurePolicy {
    /**
     * Strict before-effect refusal allowlist for Bot control, custom-receipt and revision-checked
     * routes (`resume`, `open-work`, `peers`, `routine-models`, `watches`, `avatar`).
     *
     * Only structured 4xx responses (excluding `408`/`429`) with a decoded error envelope whose
     * code is on [AidenRemoteFailureClassification.BEFORE_EFFECT_REFUSAL_CODES] prove the request
     * had no effect. That list includes `409 revision_conflict`: the host's revision check rejects
     * a stale write before anything is written, and the ledger replays that same refusal under the
     * key. `409 idempotency_in_flight`, `409 internal_error`, unknown `409`s, `400` with
     * unrecognized codes, `5xx`, `408`, `429`, unstructured [AidenRemoteClientException.UnexpectedStatus],
     * transport/parse failures, and [CancellationException] are all ambiguous.
     */
    BEFORE_EFFECT_REFUSAL,

    /**
     * Durable idempotency ledger routes (`executeAidenDurableOperation` and
     * `AidenIdempotencyLedger`) aligned with
     * `protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json`: `messages`, Bot session
     * control actions, scheduled task run-now, Bot create, chat `fork`, `continue-in-new-chat`
     * and `new-worktree`.
     * - Structured `5xx`, `408` and `429` responses, and `idempotency_in_flight`, are ambiguous
     *   (keep key).
     * - Other structured 4xx responses with a genuinely decoded error envelope (including
     *   replayed settled rejections such as `409 internal_error` and `409 idempotency_conflict`)
     *   settle the key.
     * - Unreadable/malformed error envelopes ([AidenRemoteClientException.Server.isDecodedEnvelope]
     *   == `false`), unstructured [AidenRemoteClientException.UnexpectedStatus], transport/parse
     *   failures, and [CancellationException] are ambiguous (keep key), because an unreadable HTTP
     *   409 may have been `409 idempotency_in_flight`. A route that passes
     *   `unreadableResponseAmbiguous = false` to [AidenRemoteFailureClassification.isAmbiguous]
     *   spends the key on unreadable non-409 responses instead.
     */
    CACHED_REJECTION_LEDGER
}

object AidenRemoteFailureClassification {
    /**
     * Structured error codes the host returns strictly before any mutation effect can commit.
     *
     * This is the cross-client list: it must equal `recognizedBeforeEffectCodes` in
     * `protocol/aiden-remote/v1/fixtures/mutation-failure-ambiguity.json` and iOS's
     * `AidenRemoteFailureClassification.beforeEffectCodes`.
     */
    val BEFORE_EFFECT_REFUSAL_CODES: Set<AidenRemoteErrorCode> = setOf(
        // Core protocol, auth, admission, and Bot resume before-effect refusals
        AidenRemoteErrorCode.INVALID_REQUEST,
        AidenRemoteErrorCode.PAYLOAD_TOO_LARGE,
        AidenRemoteErrorCode.AUTHENTICATION_REQUIRED,
        AidenRemoteErrorCode.CREDENTIAL_REVOKED,
        AidenRemoteErrorCode.CAPABILITY_DENIED,
        AidenRemoteErrorCode.SERVER_IDENTITY_CHANGED,
        AidenRemoteErrorCode.NOT_FOUND,
        AidenRemoteErrorCode.BOT_ARCHIVED,
        AidenRemoteErrorCode.OPERATION_STALE,
        AidenRemoteErrorCode.BOT_PAUSED,
        AidenRemoteErrorCode.IDEMPOTENCY_CONFLICT,
        AidenRemoteErrorCode.IDEMPOTENCY_CAPACITY,
        AidenRemoteErrorCode.RATE_LIMITED,
        // Domain before-effect CAS, validation, and precondition refusals
        AidenRemoteErrorCode.REVISION_CONFLICT,
        AidenRemoteErrorCode.ALREADY_EXISTS,
        AidenRemoteErrorCode.HANDLE_INVALID,
        AidenRemoteErrorCode.HANDLE_EXPIRED,
        AidenRemoteErrorCode.HANDLE_WRONG_DEVICE,
        AidenRemoteErrorCode.HANDLE_CAPACITY,
        AidenRemoteErrorCode.APPROVAL_ALREADY_RESOLVED,
        AidenRemoteErrorCode.APPROVAL_RESOLVED,
        AidenRemoteErrorCode.APPROVAL_EXPIRED,
        AidenRemoteErrorCode.QUESTION_ALREADY_RESOLVED,
        AidenRemoteErrorCode.QUESTION_EXPIRED,
        AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND,
        AidenRemoteErrorCode.MEMORY_OVER_BUDGET,
        AidenRemoteErrorCode.MEMORY_BLOCKED,
        AidenRemoteErrorCode.ROUTINE_PROPOSAL_NOT_FOUND,
        AidenRemoteErrorCode.HANDOFF_EXPIRED,
        AidenRemoteErrorCode.ACCESS_REQUEST_EXPIRED,
        AidenRemoteErrorCode.PLAN_EXPIRED
    )

    private fun isPreSendLocalError(error: Throwable): Boolean = when (error) {
        is AidenRemoteClientException.MissingCredential,
        is AidenRemoteClientException.MissingTrustConfiguration,
        is AidenRemoteClientException.InstallationChanged,
        is AidenRemoteClientException.InvalidEndpoint -> true
        else -> false
    }

    private fun isTransientHttpStatus(statusCode: Int): Boolean =
        statusCode >= 500 || statusCode == 408 || statusCode == 429

    /**
     * Returns `true` when [error] leaves the remote mutation outcome unknown under [policy], so
     * the caller must retain its pending attempt / `Idempotency-Key`.
     *
     * Set [unreadableResponseAmbiguous] to `false` only for routes where an unreadable HTTP
     * response (`InvalidResponse` / `UnexpectedStatus` / `IdempotencyConflict`) indicates the
     * host already answered and would replay that same answer under the same key (e.g.
     * `new-worktree`).
     */
    fun isAmbiguous(
        error: Throwable,
        policy: AidenRemoteFailurePolicy,
        unreadableResponseAmbiguous: Boolean = true
    ): Boolean {
        if (error is CancellationException) return true
        if (isPreSendLocalError(error)) return false
        return when (policy) {
            AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL -> isBeforeEffectAmbiguous(error)
            AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER ->
                isCachedRejectionLedgerAmbiguous(error, unreadableResponseAmbiguous)
        }
    }

    private fun isBeforeEffectAmbiguous(error: Throwable): Boolean = when (error) {
        is AidenRemoteClientException.Server ->
            !error.isDecodedEnvelope ||
                isTransientHttpStatus(error.statusCode) ||
                error.statusCode !in 400..499 ||
                error.body.code !in BEFORE_EFFECT_REFUSAL_CODES
        is AidenRemoteClientException.UnexpectedStatus -> true
        else -> true
    }

    private fun isCachedRejectionLedgerAmbiguous(
        error: Throwable,
        unreadableResponseAmbiguous: Boolean
    ): Boolean = when (error) {
        is AidenRemoteClientException.Server ->
            if (!error.isDecodedEnvelope) {
                unreadableResponseAmbiguous || error.statusCode == 409
            } else {
                isTransientHttpStatus(error.statusCode) ||
                    error.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT
            }
        is AidenRemoteClientException.UnexpectedStatus ->
            unreadableResponseAmbiguous || error.statusCode == 409
        is AidenRemoteClientException.InvalidResponse,
        is AidenRemoteClientException.IdempotencyConflict -> unreadableResponseAmbiguous
        else -> true
    }
}
