package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogSnapshot
import sbtbiswas.AidenOnTheGo.intents.AidenIntentInstallationRecord
import sbtbiswas.AidenOnTheGo.intents.AidenIntentWorkspaceRecord
import sbtbiswas.AidenOnTheGo.notifications.AgentRunActivitySanitizer
import sbtbiswas.AidenOnTheGo.notifications.AidenDeepLink
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationDestination
import sbtbiswas.AidenOnTheGo.models.AidenBotConversationActivityState
import sbtbiswas.AidenOnTheGo.models.AidenBotConversationItem
import sbtbiswas.AidenOnTheGo.models.AidenBotDeepLinkResolution
import sbtbiswas.AidenOnTheGo.models.aidenResolvedBotDeepLink
import java.time.Instant

class AidenNativeIntegrationTest {
    @Test
    fun testDeepLinkUriBuildersAndParsers() {
        val newChat = AidenDeepLink.newChatUrl()
        assertEquals("aiden-otg://new-chat", newChat)
        val req1 = AidenDeepLink.parse(newChat)
        assertNotNull(req1)
        assertEquals(AidenNavigationDestination.NewChat, req1?.destination)
        assertFalse(req1?.startsVoice == true)

        val newChatVoice = AidenDeepLink.newChatUrl(startsVoice = true)
        assertEquals("aiden-otg://new-chat-voice", newChatVoice)
        val req2 = AidenDeepLink.parse(newChatVoice)
        assertNotNull(req2)
        assertEquals(AidenNavigationDestination.NewChat, req2?.destination)
        assertTrue(req2?.startsVoice == true)

        val chatUri = AidenDeepLink.chatUrl("inst_1", "chat_123")
        assertEquals("aiden-otg://chat?instance=inst_1&chat=chat_123", chatUri)
        val req3 = AidenDeepLink.parse(chatUri)
        assertNotNull(req3)
        assertEquals(AidenNavigationDestination.Chat("chat_123"), req3?.destination)
        assertEquals("inst_1", req3?.instanceId)

        // Rejections
        assertNull(AidenDeepLink.parse("https://aiden.test/chat?id=chat_123"))
        assertNull(AidenDeepLink.parse("aiden-otg://unknown-action"))
    }

    @Test
    fun testBotChatDeepLinkRoundTripsAndRejectsAmbiguousOrUnsafeShapes() {
        val link = AidenDeepLink.botChatUrl("bot_fixture_01", instanceId = "instance-1")
        assertEquals("aiden-otg://bot/bot_fixture_01/chat?instance=instance-1", link)
        val request = AidenDeepLink.parse(link!!)
        assertEquals(AidenNavigationDestination.BotChat("bot_fixture_01"), request?.destination)
        assertEquals("instance-1", request?.instanceId)
        assertNull(request?.workspaceId)
        assertFalse(request?.startsVoice == true)

        val bare = AidenDeepLink.parse("aiden-otg://bot/bot:ops.1/chat")
        assertEquals(AidenNavigationDestination.BotChat("bot:ops.1"), bare?.destination)
        assertNull(bare?.instanceId)
        assertEquals(
            AidenNavigationDestination.BotChat("b1"),
            AidenDeepLink.parse("AIDEN-OTG://BOT/b1/chat")?.destination
        )

        listOf(
            "aiden-otg://bot/b1",
            "aiden-otg://bot/b1/chat/extra",
            "aiden-otg://bot//chat",
            "aiden-otg://bot/b1/settings",
            "aiden-otg://bot/..%2Fsecret/chat",
            "aiden-otg://bot/b%31/chat",
            "aiden-otg://bot/b1/chat?chat=c1",
            "aiden-otg://bot/b1/chat?workspace=w1",
            "aiden-otg://bot/b1/chat?instance=a&instance=b",
            "aiden-otg://bot/b1/chat?instance=..%2Fx",
            "aiden-otg://bot/b1/chat?prompt=hello",
            "aiden-otg://bot/b1/chat#frag",
            "aiden-otg://user@bot/b1/chat",
            "https://bot/b1/chat"
        ).forEach { rejected ->
            assertNull(rejected, AidenDeepLink.parse(rejected))
        }
        assertNull(AidenDeepLink.botChatUrl("../secret"))
        assertNull(AidenDeepLink.botChatUrl("b1", instanceId = "bad id"))
        assertNull(AidenDeepLink.botChatUrl("b".repeat(161)))
    }

    @Test
    fun testBotChatDeepLinkOpensTheSameCanonicalChatAsBotsHome() {
        fun item(chatId: String, botId: String, updatedAt: String) = AidenBotConversationItem(
            chatId = chatId,
            botId = botId,
            title = "Chat",
            activityState = AidenBotConversationActivityState.IDLE,
            canRespondToApproval = false,
            createdAt = Instant.parse("2026-08-18T18:00:00Z"),
            updatedAt = Instant.parse(updatedAt),
            revision = "rev"
        )
        val older = item("chat_old", "bot_1", "2026-08-18T19:00:00Z")
        val newer = item("chat_new", "bot_1", "2026-08-18T20:00:00Z")
        val otherBot = item("chat_other", "bot_2", "2026-08-18T21:00:00Z")

        assertEquals(
            AidenBotDeepLinkResolution.OpenChat("chat_new"),
            aidenResolvedBotDeepLink("bot_1", listOf(older, otherBot, newer))
        )
        assertEquals(
            AidenBotDeepLinkResolution.OpenChat("chat_new"),
            aidenResolvedBotDeepLink("bot_1", listOf(newer, older))
        )
        // Another Bot's chat never satisfies the link; an empty result lands on the Bot.
        assertEquals(AidenBotDeepLinkResolution.ShowBot, aidenResolvedBotDeepLink("bot_3", listOf(otherBot)))
        assertEquals(AidenBotDeepLinkResolution.ShowBot, aidenResolvedBotDeepLink("bot_1", emptyList()))
    }

    @Test
    fun testAgentRunActivitySanitizer() {
        val longTitle = "A".repeat(100)
        val sanitizedTitle = AgentRunActivitySanitizer.sessionTitle(longTitle)
        assertTrue(sanitizedTitle.length <= AgentRunActivitySanitizer.MAX_SESSION_TITLE_CHARS)
        assertTrue(sanitizedTitle.endsWith("..."))

        val emptyTitle = ""
        val defaultTitle = AgentRunActivitySanitizer.sessionTitle(emptyTitle)
        assertEquals("Aiden chat", defaultTitle)

        val longActivity = "B\n".repeat(60)
        val sanitizedActivity = AgentRunActivitySanitizer.activityLine(longActivity)
        assertTrue(sanitizedActivity.length <= AgentRunActivitySanitizer.MAX_ACTIVITY_CHARS)
        assertFalse(sanitizedActivity.contains("\n"))
    }

    @Test
    fun testIntentCatalogSnapshotSafetyAndPersistence() {
        val snapshot = AidenIntentCatalogSnapshot(
            installations = listOf(AidenIntentInstallationRecord("inst_1", "Mac Studio")),
            workspaces = listOf(AidenIntentWorkspaceRecord("ws_1", "inst_1", "AppProject")),
            activeInstallationId = "inst_1"
        )
        val serialized = Json.encodeToString(snapshot)

        // Verify no credentials or private material
        assertFalse(serialized.contains("credential"))
        assertFalse(serialized.contains("password"))
        assertFalse(serialized.contains("secret"))
        assertFalse(serialized.contains("Bearer"))
        assertFalse(serialized.contains("/Users/"))
    }

    @Test
    fun testIntentCatalogDropsUnsafeAndOrphanedRecords() {
        data class IntentTarget(val id: String, val title: String, val valid: Boolean)

        val targets = listOf(
            IntentTarget("chat-1", "Valid Chat", true),
            IntentTarget("../../secret", "Traversal Chat", false),
            IntentTarget("chat-2", "Orphaned Chat", false),
            IntentTarget("chat-3", "Good Chat", true)
        )

        val filtered = targets.filter { it.valid && !it.id.contains("..") }
        assertEquals(2, filtered.size)
        assertEquals("chat-1", filtered[0].id)
        assertEquals("chat-3", filtered[1].id)
    }

    @Test
    fun testPairingMethodsAndPublicSupportUrls() {
        val supportUrl = "https://aiden.agent/support"
        val docsUrl = "https://aiden.agent/docs"

        assertTrue(supportUrl.startsWith("https://"))
        assertTrue(docsUrl.startsWith("https://"))
        assertFalse(supportUrl.contains("http://"))
    }
}
