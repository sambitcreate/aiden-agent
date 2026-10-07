package sbtbiswas.AidenOnTheGo.features.bots

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

class AidenBotHomeBehaviorTest {
    private val t0 = Instant.parse("2026-10-07T12:00:00Z")

    private fun bot(id: String, name: String, purpose: String = "", updated: Instant = t0, archived: Boolean = false) = AidenBotSummary(
        id = id,
        name = name,
        purpose = purpose,
        avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.DEFAULT)),
        health = if (archived) AidenBotHealth.ARCHIVED else AidenBotHealth.READY,
        createdAt = t0.minusSeconds(86_400),
        updatedAt = updated,
        revision = "r1",
        archivedAt = if (archived) updated else null
    )

    private fun chat(
        chatId: String,
        botId: String,
        preview: String? = null,
        updated: Instant = t0,
        state: AidenBotConversationActivityState = AidenBotConversationActivityState.IDLE,
        canRespond: Boolean = false
    ) = AidenBotConversationItem(
        chatId = chatId,
        botId = botId,
        title = "",
        preview = preview,
        activityState = state,
        canRespondToApproval = canRespond,
        createdAt = t0.minusSeconds(86_400),
        updatedAt = updated,
        revision = "c1"
    )

    @Test
    fun rowsAreNewestFirstAndArchivedBotsAreGone() {
        val rows = aidenBotHomeRows(
            bots = listOf(
                bot("a", "Alpha", updated = t0.minusSeconds(600)),
                bot("b", "Beta", updated = t0.minusSeconds(900)),
                bot("old", "Old", updated = t0, archived = true)
            ),
            conversations = listOf(chat("chat-b", "b", "hi", updated = t0)),
            query = ""
        )
        // Beta's chat moved most recently, so it leads even though Alpha was edited later.
        assertEquals(listOf("b", "a"), rows.map { it.bot.id })
    }

    @Test
    fun eachBotShowsOnlyItsCanonicalChat() {
        val rows = aidenBotHomeRows(
            bots = listOf(bot("a", "Alpha")),
            conversations = listOf(
                chat("older", "a", "first", updated = t0.minusSeconds(60)),
                chat("newer", "a", "latest", updated = t0)
            ),
            query = ""
        )
        assertEquals(1, rows.size)
        assertEquals("newer", rows.single().conversation?.chatId)
        assertEquals("latest", rows.single().preview)
    }

    @Test
    fun searchMatchesNameSubtitleLastMessageOrARemoteHit() {
        val bots = listOf(bot("a", "Meal Planner", "Groceries"), bot("b", "Scout", "Research"), bot("c", "Coach"))
        val chats = listOf(chat("chat-b", "b", "Found three flights"))
        assertEquals(listOf("a"), aidenBotHomeRows(bots, chats, "meal").map { it.bot.id })
        assertEquals(listOf("a"), aidenBotHomeRows(bots, chats, "grocer").map { it.bot.id })
        assertEquals(listOf("b"), aidenBotHomeRows(bots, chats, "flights").map { it.bot.id })
        assertEquals(listOf("c"), aidenBotHomeRows(bots, chats, "older notes", remoteMatchBotIds = setOf("c")).map { it.bot.id })
        assertTrue(aidenBotHomeRows(bots, chats, "zzz").isEmpty())
    }

    @Test
    fun rowPreviewPutsApprovalsFirstAndInvitesAFirstMessage() {
        val scout = bot("b", "Scout")
        assertEquals("Say hi to Scout", AidenBotHomeRow(scout, null).preview)
        assertEquals("Say hi to Scout", AidenBotHomeRow(scout, chat("c", "b", "   ")).preview)
        assertEquals(
            "Needs your OK",
            AidenBotHomeRow(scout, chat("c", "b", "old", state = AidenBotConversationActivityState.WAITING_FOR_APPROVAL, canRespond = true)).preview
        )
        assertEquals(
            "Waiting for your OK on your Mac",
            AidenBotHomeRow(scout, chat("c", "b", "old", state = AidenBotConversationActivityState.WAITING_FOR_APPROVAL)).preview
        )
    }

    @Test
    fun activityDotShowsOnlyWhileTheBotIsBusy() {
        val scout = bot("b", "Scout")
        assertFalse(AidenBotHomeRow(scout, null).isWorking)
        assertFalse(AidenBotHomeRow(scout, chat("c", "b")).isWorking)
        assertTrue(AidenBotHomeRow(scout, chat("c", "b", state = AidenBotConversationActivityState.RUNNING)).isWorking)
        assertTrue(AidenBotHomeRow(scout, chat("c", "b", state = AidenBotConversationActivityState.QUEUED)).isWorking)
    }

    @Test
    fun rowTimeIsFriendlyRelativeToToday() {
        val zone = ZoneId.of("UTC")
        val now = Instant.parse("2026-10-07T18:00:00Z") // a Wednesday
        fun time(at: String) = aidenBotRowTime(Instant.parse(at), now, zone, Locale.US)
        assertEquals("10:51 AM", time("2026-10-07T10:51:00Z"))
        assertEquals("Yesterday", time("2026-10-06T23:00:00Z"))
        assertEquals("Sunday", time("2026-10-04T09:00:00Z"))
        assertEquals("Sep 20", time("2026-09-20T09:00:00Z"))
        assertEquals("Dec 31, 2025", time("2025-12-31T09:00:00Z"))
    }

    @Test
    fun chatPlaceholderAsksTheBotByName() {
        assertEquals("Ask Meal Planner", aidenBotChatPlaceholder("Meal Planner"))
        assertEquals("Ask your Bot", aidenBotChatPlaceholder("  "))
        assertEquals("Ask your Bot", aidenBotChatPlaceholder(null))
    }
}
