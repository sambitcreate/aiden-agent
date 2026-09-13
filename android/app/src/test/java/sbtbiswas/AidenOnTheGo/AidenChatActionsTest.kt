package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenEnvironmentPaneState
import androidx.lifecycle.SavedStateHandle

class AidenChatActionsTest {
    private val base = """{"id":"chat-a","workspaceId":"workspace-a","title":"Original","messages":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","revision":"revision-a"}"""
    @Test fun renameUsesServerUnicodeScalarLimitAndVisibleValidationBoundary() {
        assertTrue(sbtbiswas.AidenOnTheGo.models.AidenChatActionValidation.validTitle("😀".repeat(200)))
        assertFalse(sbtbiswas.AidenOnTheGo.models.AidenChatActionValidation.validTitle("😀".repeat(201)))
        assertFalse(sbtbiswas.AidenOnTheGo.models.AidenChatActionValidation.validTitle("   "))
        assertTrue(sbtbiswas.AidenOnTheGo.models.AidenChatActionValidation.validTitle("  Name  "))
    }
    @Test fun renameArchiveAndRestoreUseDistinctConditionalRequests() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test", OkHttpClient())
            server.enqueue(MockResponse().setBody(base))
            client.updateChat("chat-a", "revision-a", "New name")
            server.takeRequest().let { assertEquals("PATCH", it.method); assertTrue(it.getHeader("If-Match")!!.contains("revision-a")); assertEquals(Json.parseToJsonElement("""{"title":"New name"}"""), Json.parseToJsonElement(it.body.readUtf8())) }
            for (archived in listOf(true, false)) {
                server.enqueue(MockResponse().setBody(base))
                client.setChatArchived("chat-a", "revision-a", archived)
                server.takeRequest().let { assertEquals("/api/aiden/v1/chats/chat-a", it.path); assertTrue(it.getHeader("If-Match")!!.contains("revision-a")); assertEquals(buildJsonObject { put("archived", archived) }, Json.parseToJsonElement(it.body.readUtf8())) }
            }
            server.enqueue(MockResponse().setBody("""{"chats":[$base]}"""))
            client.chats(includeArchived = true)
            assertEquals("/api/aiden/v1/chats?includeArchived=true", server.takeRequest().path)
        } finally { server.shutdown() }
    }
    @Test fun archiveProjectionIsOptionalAndSummaryPreservesTimestamp() {
        assertNull(Json.decodeFromString<AidenChat>(base).archivedAt)
        val archived = JsonObject(Json.parseToJsonElement(base).jsonObject + ("archivedAt" to JsonPrimitive("2026-01-02T00:00:00Z")))
        val chat = Json.decodeFromString<AidenChat>(archived.toString())
        assertNotNull(chat.archivedAt)
        assertEquals(chat.archivedAt, AidenChatSummary.fromChat(chat).archivedAt)
    }
    @Test fun modifiedAndAllFilesShareRetainedSelectionWithoutChangingBrowser() {
        val handle = SavedStateHandle()
        val state = AidenEnvironmentPaneState(handle)
        assertEquals("Modified", state.fileMode.value)
        state.selectFileMode("All Files"); state.select("Browser")
        assertEquals("All Files", AidenEnvironmentPaneState(handle).fileMode.value)
        state.selectFileMode("unknown")
        assertEquals("All Files", state.fileMode.value)
        assertEquals("Browser", state.selectedTool.value)
        state.select("Changes")
        assertEquals("Modified", state.fileMode.value)
    }
}
