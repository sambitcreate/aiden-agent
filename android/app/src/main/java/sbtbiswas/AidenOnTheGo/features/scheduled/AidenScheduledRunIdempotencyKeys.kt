package sbtbiswas.AidenOnTheGo.features.scheduled

import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteFailureClassification
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteFailurePolicy
import java.util.UUID

/**
 * Retains one run key per task while the server outcome is uncertain. Reusing the
 * key lets Aiden replay the accepted run instead of starting a duplicate.
 */
class AidenScheduledRunIdempotencyKeys(
    private val makeKey: () -> UUID = UUID::randomUUID
) {
    private val pending = mutableMapOf<String, UUID>()

    fun keyFor(taskId: String): UUID = pending.getOrPut(taskId, makeKey)

    fun accepted(taskId: String) {
        pending.remove(taskId)
    }

    fun failed(taskId: String, error: Throwable) {
        if (!aidenScheduledRunFailureIsAmbiguous(error)) pending.remove(taskId)
    }
}

fun aidenScheduledOperationCanClear(activeRequestId: UUID?, completedRequestId: UUID): Boolean =
    activeRequestId == completedRequestId

fun aidenScheduledRunFailureIsAmbiguous(error: Throwable): Boolean =
    AidenRemoteFailureClassification.isAmbiguous(error, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER)
