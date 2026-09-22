package sbtbiswas.AidenOnTheGo.features.scheduled

import kotlinx.serialization.SerializationException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.io.IOException
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

fun aidenScheduledRunFailureIsAmbiguous(error: Throwable): Boolean = when (error) {
    is IOException,
    is SerializationException,
    is AidenRemoteContractException,
    is AidenRemoteClientException.InvalidResponse,
    is AidenRemoteClientException.Disconnected,
    is AidenRemoteClientException.UnexpectedStatus -> true

    is AidenRemoteClientException.Server ->
        error.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT ||
                error.body.code == AidenRemoteErrorCode.INTERNAL_ERROR

    else -> false
}
