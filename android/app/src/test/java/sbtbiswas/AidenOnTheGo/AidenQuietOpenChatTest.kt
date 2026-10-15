package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import sbtbiswas.AidenOnTheGo.notifications.AgentRunActivityStatus
import sbtbiswas.AidenOnTheGo.notifications.AgentRunBlockingStatus
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
            AgentRunActivityStatus.WAITING_FOR_ANSWER,
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

    @Test
    fun waitingStreamReadsAsAnswerOnlyWhenALoneQuestionIsPending() {
        assertEquals(
            AgentRunActivityStatus.WAITING_FOR_ANSWER,
            AgentRunBlockingStatus.status(hasPendingApproval = false, hasPendingQuestion = true)
        )
        assertEquals(
            AgentRunActivityStatus.WAITING_FOR_APPROVAL,
            AgentRunBlockingStatus.status(hasPendingApproval = true, hasPendingQuestion = false)
        )
        // An approval gates the tool call, so it wins when both are pending.
        assertEquals(
            AgentRunActivityStatus.WAITING_FOR_APPROVAL,
            AgentRunBlockingStatus.status(hasPendingApproval = true, hasPendingQuestion = true)
        )
        // Snapshots not loaded yet: keep the wire's approval projection.
        assertEquals(
            AgentRunActivityStatus.WAITING_FOR_APPROVAL,
            AgentRunBlockingStatus.status(hasPendingApproval = false, hasPendingQuestion = false)
        )
    }

    @Test
    fun approvalAndAnswerWaitsUseDistinctCopy() {
        assertEquals(
            "Needs your approval",
            AgentRunBlockingStatus.activityLine(AgentRunActivityStatus.WAITING_FOR_APPROVAL)
        )
        assertEquals(
            "Needs your answer",
            AgentRunBlockingStatus.activityLine(AgentRunActivityStatus.WAITING_FOR_ANSWER)
        )
        assertNotEquals(
            AgentRunActivityStatus.WAITING_FOR_APPROVAL.title,
            AgentRunActivityStatus.WAITING_FOR_ANSWER.title
        )
        assertNull(AgentRunBlockingStatus.activityLine(AgentRunActivityStatus.RESPONDING))
    }
}
