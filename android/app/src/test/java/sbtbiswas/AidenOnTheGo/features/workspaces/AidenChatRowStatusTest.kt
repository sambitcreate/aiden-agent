package sbtbiswas.AidenOnTheGo.features.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatRowState
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission
import java.time.Instant

class AidenChatRowStatusTest {
    @Test
    fun idleReadRowsRenderNothing() {
        val presentation = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = false)
        assertNull(presentation.contentDescription)
        assertNull(presentation.pillTitle)
        assertFalse(presentation.showsActivity)
        assertFalse(presentation.showsUnreadDot)
    }

    @Test
    fun attentionStatesUseDistinctSoftPillsWithoutTheWorkingDot() {
        val approval = AidenChatRowStatusPresentation.of(AidenChatRowState.NEEDS_APPROVAL, unread = false)
        val input = AidenChatRowStatusPresentation.of(AidenChatRowState.NEEDS_INPUT, unread = false)

        assertEquals(AidenChatRowStatusTone.WARNING, approval.pillTone)
        assertEquals(AidenChatRowStatusTone.ACCENT, input.pillTone)
        assertEquals("Needs approval", approval.contentDescription)
        assertEquals("Needs input", input.contentDescription)
        assertFalse(approval.showsActivity || input.showsActivity)
    }

    @Test
    fun workingAndUnreadAreIndependentAndBothSpoken() {
        val presentation = AidenChatRowStatusPresentation.of(AidenChatRowState.WORKING, unread = true)
        assertNull(presentation.pillTitle)
        assertTrue(presentation.showsActivity)
        assertTrue(presentation.showsUnreadDot)
        assertEquals("Working, Unread", presentation.contentDescription)

        val unreadOnly = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = true)
        assertEquals("Unread", unreadOnly.contentDescription)
        assertFalse(unreadOnly.showsActivity)
    }

    @Test
    fun unseenFailedTurnReplacesTheUnreadDotWithADangerPill() {
        val failed = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = true, failed = true)
        assertTrue(failed.showsFailed)
        assertFalse(failed.showsUnreadDot)
        assertEquals("Failed", failed.contentDescription)

        // A chat can be working again while its earlier failure is unseen.
        val workingAgain = AidenChatRowStatusPresentation.of(AidenChatRowState.WORKING, unread = true, failed = true)
        assertTrue(workingAgain.showsActivity && workingAgain.showsFailed)
        assertEquals("Working, Failed", workingAgain.contentDescription)

        // Once the chat is viewed, the failure is no longer news.
        val read = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = false, failed = true)
        assertFalse(read.showsFailed)
        assertNull(read.contentDescription)
    }

    private val base = Instant.parse("2026-10-01T12:00:00Z")

    private fun summary(
        id: String,
        updatedSeconds: Long,
        active: Boolean = false,
        rowState: String? = null,
        workspaceId: String = "alpha",
        unread: Boolean = false,
        lastRunFailed: Boolean = false
    ) = AidenChatSummary(
        id = id,
        workspaceId = workspaceId,
        title = id,
        titlePending = false,
        createdAt = base,
        updatedAt = base.plusSeconds(updatedSeconds),
        revision = "$id-r1",
        activity = if (active) AidenChatSummaryActivity.ACTIVE else AidenChatSummaryActivity.IDLE,
        rowStateWire = rowState,
        unread = unread,
        lastRunFailed = lastRunFailed
    )

    @Test
    fun workspaceSidebarAndRecentsListChatsNewestFirstWhateverTheyWaitOn() {
        val workspaces = listOf(
            AidenWorkspace(
                id = "alpha",
                name = "Alpha",
                permission = AidenWorkspacePermission.ASK,
                updatedAt = base,
                revision = "alpha-r1"
            ),
            AidenWorkspace(
                id = "beta",
                name = "Beta",
                permission = AidenWorkspacePermission.ASK,
                updatedAt = base,
                revision = "beta-r1"
            )
        )
        val chats = listOf(
            summary("alpha-newest", 100),
            summary("alpha-approval", 5, active = true, rowState = "needs_approval"),
            summary("beta-working", 60, active = true, rowState = "working", workspaceId = "beta"),
            summary("beta-idle", 70, workspaceId = "beta")
        )

        val projection = projectAidenWorkspaceSidebar(workspaces, chats, "")

        // Workspaces stay ordered by their newest activity, not by attention.
        assertEquals(listOf("alpha", "beta"), projection.sections.map { it.workspace.id })
        assertEquals(base.plusSeconds(100), projection.sections.first().newestActivityAt)
        // Waiting chats no longer jump the list; the Inbox is where they surface.
        assertEquals(
            listOf("alpha-newest", "alpha-approval"),
            projection.sections.first().chats.map { it.id }
        )
        assertEquals(
            listOf("beta-idle", "beta-working"),
            projection.sections.last().chats.map { it.id }
        )
        assertEquals(
            listOf("alpha-newest", "beta-idle", "beta-working", "alpha-approval"),
            projection.recents.map { it.id }
        )
    }
}
