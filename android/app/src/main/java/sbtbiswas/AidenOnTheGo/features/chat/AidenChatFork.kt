package sbtbiswas.AidenOnTheGo.features.chat

import sbtbiswas.AidenOnTheGo.models.AidenChatForkPosition
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode

/**
 * Which messages offer the fork actions. Mirrors the Mac's rules so the menu
 * never offers a cut the server would refuse as ineligible.
 */
object AidenChatForkEligibility {
    private fun isPersisted(message: AidenChatMessage): Boolean = !message.id.startsWith("local-")

    private fun hasUserBefore(messages: List<AidenChatMessage>, index: Int): Boolean =
        (0 until index).any { messages[it].role == AidenChatRole.USER }

    /** "Fork from here": a settled assistant reply that follows a prompt. */
    fun canForkFrom(messages: List<AidenChatMessage>, messageId: String): Boolean {
        val index = messages.indexOfFirst { it.id == messageId }
        if (index < 0) return false
        val message = messages[index]
        return message.role == AidenChatRole.ASSISTANT && isPersisted(message) &&
            message.timeline?.status != AidenGenerationTimelineStatus.RUNNING &&
            hasUserBefore(messages, index)
    }

    /** "Fork with summary…": as above, and something follows the cut to summarize. */
    fun canForkWithSummary(messages: List<AidenChatMessage>, messageId: String): Boolean =
        canForkFrom(messages, messageId) && messages.lastOrNull()?.id != messageId

    /** "Edit in fork": any of your prompts except the first. */
    fun canEditInFork(messages: List<AidenChatMessage>, messageId: String): Boolean {
        val index = messages.indexOfFirst { it.id == messageId }
        if (index < 0) return false
        val message = messages[index]
        return message.role == AidenChatRole.USER && isPersisted(message) && hasUserBefore(messages, index)
    }
}

/** One fork request; a retry of the same request reuses its idempotency key. */
internal data class AidenChatForkAttempt(
    val revision: String,
    val messageId: String,
    val position: AidenChatForkPosition,
    val withSummary: Boolean,
    val instructions: String?
)

/** How the lineage row names the chat this one was forked from. */
sealed interface AidenChatForkSource {
    val chatId: String

    data class Resolving(override val chatId: String) : AidenChatForkSource
    data class Named(override val chatId: String, val title: String) : AidenChatForkSource
    /** The Mac no longer has the source chat. */
    data class Deleted(override val chatId: String) : AidenChatForkSource
    /** The source could not be looked up right now. */
    data class Unknown(override val chatId: String) : AidenChatForkSource
}

object AidenChatForkErrors {
    const val SUMMARY_HOLD_MESSAGE =
        "This fork is waiting for its summary. Wait for it, retry it, or continue without it."

    private fun serverError(error: Throwable): AidenRemoteClientException.Server? =
        error as? AidenRemoteClientException.Server

    fun isRevisionConflict(error: Throwable): Boolean =
        serverError(error)?.let { it.statusCode == 409 && it.body.code == AidenRemoteErrorCode.REVISION_CONFLICT } == true

    fun isNotFound(error: Throwable): Boolean =
        serverError(error)?.let { it.statusCode == 404 || it.body.code == AidenRemoteErrorCode.NOT_FOUND } == true

    /** A summary route's 404 or 409 means the summary already changed elsewhere. */
    fun isSummaryMovedOn(error: Throwable): Boolean = isNotFound(error) || isRevisionConflict(error)

    /** What a failed fork tells the user. */
    fun forkMessage(error: Throwable): String {
        val server = serverError(error)
        return when {
            server == null -> error.localizedMessage ?: "The fork could not be created."
            server.body.code == AidenRemoteErrorCode.OPERATION_IN_PROGRESS ->
                "This chat is busy on your Mac. Try forking again in a moment."
            isRevisionConflict(error) ->
                "This chat changed on your Mac. Check the latest messages and try again."
            server.statusCode == 413 || server.body.code == AidenRemoteErrorCode.PAYLOAD_TOO_LARGE ->
                "This chat is too large to fork."
            isNotFound(error) -> "That message is no longer available to fork."
            else -> server.localizedMessage ?: "The fork could not be created."
        }
    }
}
