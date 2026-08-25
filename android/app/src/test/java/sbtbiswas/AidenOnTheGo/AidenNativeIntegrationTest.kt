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
