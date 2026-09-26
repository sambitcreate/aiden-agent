package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Test
import sbtbiswas.AidenOnTheGo.notifications.AgentRunActivityStatus
import sbtbiswas.AidenOnTheGo.notifications.AidenQuietOpenChat

/** Quiet Open Chat decision table (iOS parity: AidenChatTests quiet-open
 * coverage). Foregrounded conversations suppress ambient churn while blocking
 * kinds still post and terminal states clear the surface. */
class AidenQuietOpenChatTest {
    @Test
    fun backgroundChatPostsEveryStatus() {
        for (status in AgentRunActivityStatus.entries) {
            assertEquals(
                "$status must post while the chat is not foregrounded",
                AidenQuietOpenChat.Decision.POST,
                AidenQuietOpenChat.decision(status, isChatForegrounded = false)
            )
        }
    }

    @Test
    fun foregroundChatSuppressesAmbientProgress() {
        val ambient = listOf(
            AgentRunActivityStatus.STARTING,
            AgentRunActivityStatus.THINKING,
            AgentRunActivityStatus.USING_TOOL,
            AgentRunActivityStatus.SEARCHING_FILES,
            AgentRunActivityStatus.READING_FILES,
            AgentRunActivityStatus.RUNNING_COMMAND,
            AgentRunActivityStatus.RESPONDING
        )
        for (status in ambient) {
            assertEquals(
                "$status is ambient churn and must be suppressed",
                AidenQuietOpenChat.Decision.SUPPRESS,
                AidenQuietOpenChat.decision(status, isChatForegrounded = true)
            )
        }
    }

    @Test
    fun foregroundChatStillPostsBlockingStatuses() {
        val blocking = listOf(
            AgentRunActivityStatus.WAITING_FOR_APPROVAL,
            AgentRunActivityStatus.FAILED
        )
        for (status in blocking) {
            assertEquals(
                "$status needs attention and must still post",
                AidenQuietOpenChat.Decision.POST,
                AidenQuietOpenChat.decision(status, isChatForegrounded = true)
            )
        }
    }

    @Test
    fun foregroundChatDismissesTerminalStatusesQuietly() {
        val terminal = listOf(
            AgentRunActivityStatus.COMPLETE,
            AgentRunActivityStatus.CANCELLED
        )
        for (status in terminal) {
            assertEquals(
                "$status clears the ambient surface instead of posting",
                AidenQuietOpenChat.Decision.DISMISS,
                AidenQuietOpenChat.decision(status, isChatForegrounded = true)
            )
        }
    }
}
