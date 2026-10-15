package sbtbiswas.AidenOnTheGo.protocol

import kotlinx.serialization.Serializable

@Serializable
data class AidenRemoteErrorEnvelope(
    val error: Body
) {
    @Serializable
    data class Details(
        val currentRevision: String? = null,
        val retryAfterSeconds: Int? = null,
        val chatId: String? = null,
        val minimumClientVersion: String? = null,
        val limit: Int? = null,
        val field: String? = null,
        /** The winning decision a run-control loser receives with `approval_resolved`. */
        val decision: String? = null,
        /** The winning outcome a run-control loser receives with `question_already_resolved`. */
        val outcome: String? = null,
        val resolvedAt: String? = null
    )

    @Serializable
    data class Body(
        val code: AidenRemoteErrorCode,
        val message: String,
        val requestId: String,
        val retryable: Boolean,
        val details: Details? = null
    )
}
