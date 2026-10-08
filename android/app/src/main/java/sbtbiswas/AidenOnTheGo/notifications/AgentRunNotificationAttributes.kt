package sbtbiswas.AidenOnTheGo.notifications

import java.time.Instant
import sbtbiswas.AidenOnTheGo.R
import androidx.annotation.StringRes

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

/**
 * [title] is the English status the in-app progress line uses; notifications show the
 * localized [titleRes] instead.
 */
enum class AgentRunActivityStatus(val title: String, val compactTitle: String, @StringRes val titleRes: Int) {
    STARTING("Starting", "Start", R.string.notification_agent_status_starting),
    THINKING("Thinking", "Think", R.string.notification_agent_status_thinking),
    USING_TOOL("Using tool", "Tool", R.string.notification_agent_status_using_tool),
    SEARCHING_FILES("Searching files", "Search", R.string.notification_agent_status_searching_files),
    READING_FILES("Reading files", "Files", R.string.notification_agent_status_reading_files),
    RUNNING_COMMAND("Running command", "Cmd", R.string.notification_agent_status_running_command),
    RESPONDING("Responding", "Reply", R.string.notification_agent_status_responding),
    WAITING_FOR_APPROVAL("Waiting for approval", "Approve", R.string.notification_agent_status_waiting_approval),
    WAITING_FOR_ANSWER("Waiting for answer", "Answer", R.string.notification_agent_status_waiting_answer),
    COMPLETE("Complete", "Done", R.string.notification_agent_status_complete),
    FAILED("Failed", "Fail", R.string.notification_agent_status_failed),
    CANCELLED("Cancelled", "Stop", R.string.notification_agent_status_cancelled)
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
