package sbtbiswas.AidenOnTheGo.notifications

/**
 * Quiet Open Chat policy: while a conversation is on screen, its ambient
 * notification stays quiet — the user is already watching the live transcript.
 * Blocking kinds that need attention (approvals, errors) still post, and
 * terminal states clear the surface quietly. Mirrors iOS `AidenQuietOpenChat`.
 */
object AidenQuietOpenChat {
    /**
     * POST publishes the notification. SUPPRESS and DISMISS both skip posting;
     * while foregrounded the chat never holds a posted ambient entry, so both
     * also clear any previously posted notification. The distinction is kept
     * for future push kinds where "not delivered" and "cleared" differ.
     */
    enum class Decision {
        POST,
        SUPPRESS,
        DISMISS
    }

    fun decision(
        status: AgentRunActivityStatus,
        isChatForegrounded: Boolean
    ): Decision {
        if (!isChatForegrounded) return Decision.POST
        return when (status) {
            AgentRunActivityStatus.WAITING_FOR_APPROVAL,
            AgentRunActivityStatus.FAILED -> Decision.POST
            AgentRunActivityStatus.COMPLETE,
            AgentRunActivityStatus.CANCELLED -> Decision.DISMISS
            AgentRunActivityStatus.STARTING,
            AgentRunActivityStatus.THINKING,
            AgentRunActivityStatus.USING_TOOL,
            AgentRunActivityStatus.SEARCHING_FILES,
            AgentRunActivityStatus.READING_FILES,
            AgentRunActivityStatus.RUNNING_COMMAND,
            AgentRunActivityStatus.RESPONDING -> Decision.SUPPRESS
        }
    }
}
