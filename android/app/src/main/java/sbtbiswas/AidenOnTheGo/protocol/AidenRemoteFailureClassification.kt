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
     * Strict before-effect refusal allowlist for Bot control and custom-receipt routes
     * (`resume`, `open-work`, `peers`, `routine-models`).
     *
     * Only structured 4xx responses (excluding `408`/`429`) whose error code is on
     * [AidenRemoteFailureClassification.BEFORE_EFFECT_REFUSAL_CODES] prove the request had no
     * effect. `409 idempotency_in_flight`, `409 internal_error`, unknown `409`s, `400` with
     * unrecognized codes, `5xx`, `408`, `429`, unstructured [AidenRemoteClientException.UnexpectedStatus],
     * transport/parse failures, and [CancellationException] are all ambiguous.
     */
    BEFORE_EFFECT_REFUSAL,

    /**
     * Same strict before-effect refusal allowlist as [BEFORE_EFFECT_REFUSAL], plus
     * `409 revision_conflict` for routes whose optimistic-concurrency revision check rejects
     * stale writes before any effect (`watches`, `avatar`).
     */
    BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT,

    /**
     * Durable idempotency ledger routes (`executeAidenDurableOperation`) aligned with
     * `protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json` (`messages`, Bot session
     * control actions, scheduled task run-now, Bot create):
     * - `5xx`, `408`, `429`, and `409 idempotency_in_flight` are ambiguous (keep key).
     * - Other structured 4xx responses with a genuinely decoded error envelope (including
     *   replayed settled rejections such as `409 internal_error` and `409 idempotency_conflict`)
     *   settle the key.
     * - Unreadable/malformed error envelopes ([AidenRemoteClientException.Server.isDecodedEnvelope]
     *   == `false`), unstructured [AidenRemoteClientException.UnexpectedStatus], transport/parse
     *   failures, and [CancellationException] are ambiguous (keep key), because an unreadable HTTP
     *   409 may have been `409 idempotency_in_flight`.
     */
    CACHED_REJECTION_LEDGER,

    /**
     * Durable idempotency ledger routes (`fork`, `continue-in-new-chat`, `new-worktree`) where
     * the host caches every structured server rejection under the key for 24 hours:
     * - `409 idempotency_in_flight`, unreadable/malformed error envelopes (including any
     *   undecodable HTTP 409), transport failures, and [CancellationException] keep the key;
     *   any other genuinely decoded [AidenRemoteClientException.Server] response spends it.
     */
    CACHED_REJECTION_LEDGER_STRICT
}

object AidenRemoteFailureClassification {
    /**
     * Structured error codes the host returns strictly before any Bot control or custom-receipt
     * mutation effect can commit.
     */
    val BEFORE_EFFECT_REFUSAL_CODES: Set<AidenRemoteErrorCode> = setOf(
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
        AidenRemoteErrorCode.RATE_LIMITED
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
            AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL ->
                isBeforeEffectAmbiguous(error, allowRevisionConflict = false)
            AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT ->
                isBeforeEffectAmbiguous(error, allowRevisionConflict = true)
            AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER ->
                isCachedRejectionLedgerAmbiguous(error)
            AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER_STRICT ->
                isCachedRejectionLedgerStrictAmbiguous(error, unreadableResponseAmbiguous)
        }
    }

    private fun isBeforeEffectAmbiguous(error: Throwable, allowRevisionConflict: Boolean): Boolean = when (error) {
        is AidenRemoteClientException.Server -> {
            if (!error.isDecodedEnvelope || isTransientHttpStatus(error.statusCode) || error.statusCode !in 400..499) {
                true
            } else {
                val allowed = error.body.code in BEFORE_EFFECT_REFUSAL_CODES ||
                    (allowRevisionConflict && error.body.code == AidenRemoteErrorCode.REVISION_CONFLICT)
                !allowed
            }
        }
        is AidenRemoteClientException.UnexpectedStatus -> true
        else -> true
    }

    private fun isCachedRejectionLedgerAmbiguous(error: Throwable): Boolean = when (error) {
        is AidenRemoteClientException.Server ->
            !error.isDecodedEnvelope ||
                isTransientHttpStatus(error.statusCode) ||
                (error.statusCode == 409 && error.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT)
        is AidenRemoteClientException.UnexpectedStatus -> true
        else -> true
    }

    private fun isCachedRejectionLedgerStrictAmbiguous(
        error: Throwable,
        unreadableResponseAmbiguous: Boolean
    ): Boolean = when (error) {
        is AidenRemoteClientException.Server ->
            if (!error.isDecodedEnvelope) {
                unreadableResponseAmbiguous || error.statusCode == 409
            } else {
                error.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT
            }
        is AidenRemoteClientException.UnexpectedStatus ->
            unreadableResponseAmbiguous || error.statusCode == 409
        is AidenRemoteClientException.InvalidResponse,
        is AidenRemoteClientException.IdempotencyConflict -> unreadableResponseAmbiguous
        else -> true
    }
}
