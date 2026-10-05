package sbtbiswas.AidenOnTheGo.notifications

import java.time.Instant

data class AgentRunContentState(
    val sessionId: String,
    val sessionTitle: String,
    val status: AgentRunActivityStatus,
    val currentActivity: String,
    val responseExcerpt: String = "",
    val startedAt: Instant,
    val updatedAt: Instant,
    val isStale: Boolean = false,
    val isFinal: Boolean = false,
    val errorSummary: String? = null
)

enum class AgentRunActivityStatus(val title: String, val compactTitle: String) {
    STARTING("Starting", "Start"),
    THINKING("Thinking", "Think"),
    USING_TOOL("Using tool", "Tool"),
    SEARCHING_FILES("Searching files", "Search"),
    READING_FILES("Reading files", "Files"),
    RUNNING_COMMAND("Running command", "Cmd"),
    RESPONDING("Responding", "Reply"),
    WAITING_FOR_APPROVAL("Waiting for approval", "Approve"),
    WAITING_FOR_ANSWER("Waiting for answer", "Answer"),
    COMPLETE("Complete", "Done"),
    FAILED("Failed", "Fail"),
    CANCELLED("Cancelled", "Stop")
}

/**
 * The Remote contract projects both a pending tool approval and a pending
 * `ask_user_question` prompt as `waiting_for_approval`. The phone already
 * holds both prompt snapshots, so it tells them apart client-side: an
 * approval wins when both are pending (it gates the tool call), a lone
 * question reads as "Needs your answer". Mirrors iOS `AgentRunBlockingStatus`.
 */
object AgentRunBlockingStatus {
    fun status(hasPendingApproval: Boolean, hasPendingQuestion: Boolean): AgentRunActivityStatus =
        if (hasPendingQuestion && !hasPendingApproval) {
            AgentRunActivityStatus.WAITING_FOR_ANSWER
        } else {
            AgentRunActivityStatus.WAITING_FOR_APPROVAL
        }

    fun activityLine(status: AgentRunActivityStatus): String? = when (status) {
        AgentRunActivityStatus.WAITING_FOR_APPROVAL -> "Needs your approval"
        AgentRunActivityStatus.WAITING_FOR_ANSWER -> "Needs your answer"
        else -> null
    }
}

object AgentRunActivitySanitizer {
    const val MAX_SESSION_TITLE_CHARS = 42
    const val MAX_ACTIVITY_CHARS = 64
    const val MAX_EXCERPT_CHARS = 140
    const val MAX_TOOL_LABEL_CHARS = 28

    fun sessionTitle(raw: String): String {
        val normalized = raw.trim().replace(Regex("\\s+"), " ")
        val title = if (normalized.isEmpty()) "Aiden chat" else normalized
        return if (title.length > MAX_SESSION_TITLE_CHARS) title.take(MAX_SESSION_TITLE_CHARS - 3) + "..." else title
    }

    fun activityLine(raw: String): String {
        val normalized = raw.trim().replace(Regex("\\s+"), " ")
        return if (normalized.length > MAX_ACTIVITY_CHARS) normalized.take(MAX_ACTIVITY_CHARS - 3) + "..." else normalized
    }

    fun responseExcerpt(raw: String): String {
        val normalized = raw.trim().replace(Regex("\\s+"), " ")
        return if (normalized.length > MAX_EXCERPT_CHARS) normalized.take(MAX_EXCERPT_CHARS - 3) + "..." else normalized
    }
}
