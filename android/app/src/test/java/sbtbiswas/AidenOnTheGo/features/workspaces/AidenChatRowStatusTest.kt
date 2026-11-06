package sbtbiswas.AidenOnTheGo.features.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatRowState
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenNoWorkspace
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

    @Test
    fun chatsWithoutAWorkspaceShareOneChatsSectionOnTheirHome() {
        fun hidden(id: String, createdSeconds: Long) = AidenWorkspace(
            id = id,
            name = "No workspace",
            permission = AidenWorkspacePermission.ASK,
            hasFolder = true,
            noWorkspace = true,
            createdAt = base.plusSeconds(createdSeconds),
            updatedAt = base,
            revision = "$id-r1"
        )
        val workspaces = listOf(
            hidden("hidden-b", 2),
            AidenWorkspace(id = "alpha", name = "Alpha", permission = AidenWorkspacePermission.ASK, updatedAt = base, revision = "alpha-r1"),
            hidden("default", 9),
            hidden("hidden-a", 1)
        )
        val chats = listOf(
            summary("soup", 30, workspaceId = "hidden-a"),
            summary("trip", 20, workspaceId = "hidden-b"),
            summary("first", 10, workspaceId = "default"),
            summary("alpha-chat", 5, workspaceId = "alpha")
        )

        val projection = projectAidenWorkspaceSidebar(workspaces, chats, "")

        // The default record is the home even though others are older; every hidden chat sits under it.
        assertEquals(listOf("default", "alpha"), projection.sections.map { it.workspace.id })
        assertEquals("Chats", projection.sections.first().workspace.name)
        assertEquals(listOf("soup", "trip", "first"), projection.sections.first().chats.map { it.id })
        assertEquals(4, projection.recents.size)
        // Pickers and the workspace list never offer a hidden record.
        assertEquals(listOf("alpha"), AidenNoWorkspace.choices(workspaces).map { it.id })

        // Without a default record, the oldest hidden record is the home.
        val withoutDefault = workspaces.filterNot { it.id == "default" }
        assertEquals("hidden-a", AidenNoWorkspace.home(withoutDefault)?.id)
        // A Mac that lists no hidden records has no home, so the phone hides "No Workspace".
        assertNull(AidenNoWorkspace.home(workspaces.filterNot { it.noWorkspace }))

        // An older build could archive a "No workspace" record; the Chats group has no Unarchive,
        // so that flag is ignored and its chats stay listed. Archived projects stay archived.
        assertEquals(
            listOf("hidden-b", "default", "hidden-a"),
            AidenNoWorkspace.unarchived(workspaces, setOf("default", "alpha")).map { it.id }
        )

        // Recents search matches the label a hidden chat shows ("Chats"), not the record's name.
        assertEquals(
            listOf("soup", "trip", "first"),
            projectAidenWorkspaceSidebar(workspaces, chats, "chats").recents.map { it.id }
        )
        assertEquals(emptyList<String>(), projectAidenWorkspaceSidebar(workspaces, chats, "No workspace").recents.map { it.id })

        // A chat another device started in a fresh hidden record is left out until the phone
        // re-reads its workspaces, and it asks once per such record.
        val fromAnotherPhone = summary("elsewhere", 40, workspaceId = "hidden-new")
        assertEquals(
            emptyList<String>(),
            projectAidenWorkspaceSidebar(workspaces, chats + fromAnotherPhone, "").recents
                .filter { it.id == "elsewhere" }.map { it.id }
        )
        val chatWorkspaceIds = (chats + fromAnotherPhone).map { it.workspaceId }
        assertEquals(setOf("hidden-new"), AidenNoWorkspace.unlistedWorkspaceIds(chatWorkspaceIds, workspaces, emptySet()))
        assertEquals(emptySet<String>(), AidenNoWorkspace.unlistedWorkspaceIds(chatWorkspaceIds, workspaces, setOf("hidden-new")))
        val reRead = workspaces + hidden("hidden-new", 12)
        assertEquals(emptySet<String>(), AidenNoWorkspace.unlistedWorkspaceIds(chatWorkspaceIds, reRead, emptySet()))
        assertEquals(
            listOf("elsewhere", "soup", "trip", "first"),
            projectAidenWorkspaceSidebar(reRead, chats + fromAnotherPhone, "").sections.first().chats.map { it.id }
        )

        // A new-chat link aimed at a hidden home the Mac has since released (one that isn't
        // `default`) lands in a replacement: after the re-read lists the replacement and not the
        // old home, the chat still opens.
        val afterRelease = workspaces.filter { it.id != "hidden-a" } + hidden("replacement", 13)
        assertTrue(AidenNoWorkspace.opensCreatedChat(true, "hidden-a", "replacement", afterRelease))
        assertFalse(AidenNoWorkspace.opensCreatedChat(true, "hidden-a", "never-listed", afterRelease))
        // A create in an ordinary workspace opens only in that workspace, while it is still listed.
        assertTrue(AidenNoWorkspace.opensCreatedChat(false, "alpha", "alpha", workspaces))
        assertFalse(AidenNoWorkspace.opensCreatedChat(false, "alpha", "replacement", afterRelease))
        assertFalse(AidenNoWorkspace.opensCreatedChat(false, "alpha", "alpha", workspaces.filter { it.id != "alpha" }))
    }
}
