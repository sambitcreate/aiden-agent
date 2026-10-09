package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.chat.aidenEligibleImageAttachments
import sbtbiswas.AidenOnTheGo.features.chat.aidenUnsupportedHtmlArtifacts
import sbtbiswas.AidenOnTheGo.features.chat.aidenVisualDisplay
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatMessagesWindow
import sbtbiswas.AidenOnTheGo.models.AidenServer

/** Revision 27 inline visuals against the shared contract fixture, through the client's wire codec. */
class AidenChatVisualsContractTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }

    private fun visualMessages(): List<Pair<String, AidenChatMessage>> {
        val chat = json.decodeFromJsonElement(AidenChat.serializer(), fixture.getValue("chat"))
        val window = json.decodeFromJsonElement(AidenChatMessagesWindow.serializer(), fixture.getValue("messagesWindow"))
        return listOf(chat.messages, window.messages).map { messages ->
            messages.single { !it.visuals.isNullOrEmpty() }
        }.let { (fromChat, fromWindow) -> listOf("chat" to fromChat, "messagesWindow" to fromWindow) }
    }

    @Test
    fun serverAdvertisesChatVisuals() {
        val server = json.decodeFromJsonElement(AidenServer.serializer(), fixture.getValue("server"))
        assertTrue(server.supportsChatVisuals)
    }

    @Test
    fun chatAndMessagesWindowCarryTheSameVisualsWithTheirSnapshots() {
        val messages = visualMessages()
        assertEquals(messages[0].second, messages[1].second)
        for ((source, message) in messages) {
            val visuals = message.visuals.orEmpty()
            assertEquals(source, listOf("artifact_fixture_01" to "html", "ui_fixture_01" to "ui"), visuals.map { it.id to it.kind })

            // Every snapshot names a PNG/JPEG image on the same message, and only snapshots are hidden.
            val byId = message.attachments.orEmpty().associateBy { it.id }
            for (visual in visuals) {
                val snapshot = byId.getValue(visual.snapshotAttachmentId!!)
                assertEquals(source, AidenAttachmentKind.IMAGE, snapshot.kind)
                assertEquals(source, snapshot, aidenVisualDisplay(visual, message.attachments.orEmpty()).snapshot)
            }
            assertEquals(source, emptyList<Any>(), aidenEligibleImageAttachments(message.attachments.orEmpty(), visuals))

            // Each visual names a tool step on the timeline, which draws it.
            val toolSteps = message.timeline!!.steps.filter { it.kind == AidenAgentStep.Kind.TOOL }
                .associateBy { it.toolCallId }
            assertEquals(source, "render_artifact", toolSteps.getValue(visuals[0].toolCallId).toolName)
            assertEquals(source, "render_ui", toolSteps.getValue(visuals[1].toolCallId).toolName)

            // The html visual is the message's html artifact; its snapshot replaces the "can't view" notice.
            assertEquals(source, message.htmlArtifacts.orEmpty().map { it.id }, listOf(visuals[0].id))
            assertEquals(source, emptyList<Any>(), aidenUnsupportedHtmlArtifacts(message))
            assertTrue(source, message.isWireSafe)
        }
    }
}
