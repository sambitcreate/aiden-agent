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

    private val base = Instant.parse("2026-10-01T12:00:00Z")

    private fun summary(
        id: String,
        updatedSeconds: Long,
        active: Boolean = false,
        rowState: String? = null,
        workspaceId: String = "alpha"
    ) = AidenChatSummary(
        id = id,
        workspaceId = workspaceId,
        title = id,
        titlePending = false,
        createdAt = base,
        updatedAt = base.plusSeconds(updatedSeconds),
        revision = "$id-r1",
        activity = if (active) AidenChatSummaryActivity.ACTIVE else AidenChatSummaryActivity.IDLE,
        rowStateWire = rowState
    )

    @Test
    fun chatsNeedingTheUserSortAboveNewerWorkingAndIdleChats() {
        val newestFirst = listOf(
            summary("idle-newest", 50),
            summary("running", 40, active = true, rowState = "working"),
            summary("idle-middle", 30),
            summary("question", 20, active = true, rowState = "needs_input"),
            summary("approval", 10, active = true, rowState = "needs_approval")
        )

        assertEquals(
            listOf("approval", "question", "running", "idle-newest", "idle-middle"),
            aidenNeedsAttentionFirst(newestFirst).map { it.id }
        )
    }

    @Test
    fun tiesKeepTheIncomingRecencyOrder() {
        val newestFirst = listOf(
            summary("idle-c", 30),
            summary("run-b", 25, active = true),
            summary("idle-b", 20),
            summary("run-a", 15, active = true, rowState = "working"),
            summary("idle-a", 10)
        )

        assertEquals(
            listOf("run-b", "run-a", "idle-c", "idle-b", "idle-a"),
            aidenNeedsAttentionFirst(newestFirst).map { it.id }
        )
    }

    @Test
    fun staleAttentionStateOnAnIdleChatDoesNotJumpTheQueue() {
        // The local activity signal is authoritative for idleness, so a server
        // attention state left on a finished chat must not promote it.
        val newestFirst = listOf(
            summary("newer", 20),
            summary("stale-approval", 10, active = false, rowState = "needs_approval")
        )

        assertEquals(
            listOf("newer", "stale-approval"),
            aidenNeedsAttentionFirst(newestFirst).map { it.id }
        )
    }

    @Test
    fun workspaceSidebarSurfacesAttentionFirstWithoutReorderingWorkspaces() {
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
        assertEquals(
            listOf("alpha-approval", "alpha-newest"),
            projection.sections.first().chats.map { it.id }
        )
        assertEquals(
            listOf("beta-working", "beta-idle"),
            projection.sections.last().chats.map { it.id }
        )
        assertEquals(
            listOf("alpha-approval", "beta-working", "alpha-newest", "beta-idle"),
            projection.recents.map { it.id }
        )
    }
}
