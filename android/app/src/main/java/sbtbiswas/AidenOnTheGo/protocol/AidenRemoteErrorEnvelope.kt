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
        val resolvedAt: String? = null,
        /**
         * Revision 63, on `workspace_unavailable` to a phone holding `chat:continue-in-new-chat`:
         * why the chat's folder is gone. Kept as sent; read it through [workspaceUnavailableReason].
         */
        val reason: String? = null,
        /** Revision 63: whether the whole chat may be continued in a new chat in another workspace. */
        val canContinueInNewChat: Boolean? = null
    ) {
        /** [reason] as a known value; a reason this build does not know reads as null. */
        val workspaceUnavailableReason: AidenWorkspaceUnavailableReason?
            get() = AidenWorkspaceUnavailableReason.entries.firstOrNull { it.rawValue == reason }
    }

    @Serializable
    data class Body(
        val code: AidenRemoteErrorCode,
        val message: String,
        val requestId: String,
        val retryable: Boolean,
        val details: Details? = null
    )
}

/** Revision 63: why a chat's workspace folder is unavailable (`details.reason`). */
enum class AidenWorkspaceUnavailableReason(val rawValue: String) {
    FOLDER_MISSING("folder_missing"),
    WORKTREE_MISSING("worktree_missing")
}
