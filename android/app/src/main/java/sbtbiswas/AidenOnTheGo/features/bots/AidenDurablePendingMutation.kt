package sbtbiswas.AidenOnTheGo.features.bots

import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteFailureClassification
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteFailurePolicy

/** Outcome of classifying a failed durable Bot mutation transport call. */
enum class AidenDurableFailureSettlement {
    /** Outcome may have committed (or was already uncertain): retain pending attempt & key. */
    RETAIN_UNCERTAIN,
    /** First attempt failed with a proven before-effect refusal: safe to clear pending attempt. */
    CLEAR_DEFINITE
}

/**
 * Shared invariants for Android's durable pending-mutation Bot controllers (`Resume`, `Watch`,
 * `RoutineModels`, `Peers`, `OpenWork`):
 *
 * - 23-hour replay window matching the host's 24-hour idempotency ledger with a 1-hour skew margin,
 *   plus explicit exemption hook (e.g. OpenWork `Stop` / `Stop & Dismiss`).
 * - Sticky `previouslyUnknown` protection: once an attempt's outcome is unknown, no later refusal
 *   can clear it; only a same-key host reply or authoritative read reconciliation may settle it.
 * - Strict before-effect refusal classification via [AidenRemoteFailureClassification].
 */
object AidenDurablePendingMutation {
    /** 23 hours: leaves a 1-hour safety margin inside the host's 24-hour idempotency retention. */
    const val RETRY_WINDOW_MS: Long = 23L * 60L * 60L * 1000L

    /**
     * Returns `true` while an uncertain attempt started at [startedAtMs] may still be replayed at
     * [nowMs]. Clock rollback (`nowMs < startedAtMs`) fails closed unless [exempt] is `true`.
     */
    fun isRetryAllowed(startedAtMs: Long, nowMs: Long, exempt: Boolean = false): Boolean =
        exempt || (nowMs - startedAtMs in 0L until RETRY_WINDOW_MS)

    /**
     * Decides whether a failed transport call must retain the pending attempt or may clear it.
     * Once [previouslyUnknown] is `true`, the attempt stays sticky regardless of [error].
     */
    fun settleFailure(
        error: Throwable,
        previouslyUnknown: Boolean,
        policy: AidenRemoteFailurePolicy = AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL
    ): AidenDurableFailureSettlement =
        if (previouslyUnknown || AidenRemoteFailureClassification.isAmbiguous(error, policy)) {
            AidenDurableFailureSettlement.RETAIN_UNCERTAIN
        } else {
            AidenDurableFailureSettlement.CLEAR_DEFINITE
        }
}
