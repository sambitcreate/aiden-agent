package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceSubagents
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenSubagentsPaneState

class AidenWorkspaceSubagentsTest {
    private fun fixture(): JsonObject {
        val text = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        return Json.parseToJsonElement(text).jsonObject.getValue("workspaceSubagents").jsonObject
    }
    private fun decode(value: JsonElement = fixture(), workspace: String = "workspace_fixture_01", chat: String = "chat_fixture_01") =
        AidenWorkspaceSubagents.decode(value.toString().toByteArray(), workspace, chat)
    @Test fun requestUsesParentScopedEndpointAndExistingAuthentication() = kotlinx.coroutines.runBlocking {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        try {
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody(fixture().toString()).setHeader("Content-Type", "application/json"))
            val client = sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test-credential", okhttp3.OkHttpClient())
            assertEquals(1, client.workspaceSubagents("workspace_fixture_01", "chat_fixture_01").runs.size)
            val request = server.takeRequest()
            assertEquals("/api/aiden/v1/workspaces/workspace_fixture_01/chats/chat_fixture_01/subagents", request.path)
            assertEquals("GET", request.method)
            assertEquals("Bearer test-credential", request.getHeader("Authorization"))
            assertEquals(0L, request.bodySize)
        } finally { server.shutdown() }
    }
    @Test fun sharedFixtureDecodes() {
        val result = decode()
        assertEquals("completed", result.runs.single().state)
        assertEquals("reviewer", result.runs.single().role)
    }
    @Test fun rejectsCrossContextAndPrivateFields() {
        assertThrows(Exception::class.java) { decode(workspace = "another-workspace") }
        assertThrows(Exception::class.java) { decode(chat = "another-chat") }
        assertThrows(Exception::class.java) { decode(JsonObject(fixture() + ("privateTranscript" to JsonPrimitive("secret")))) }
    }
    @Test fun rejectsInvalidStatesRevisionsAndDuplicateRuns() {
        val source = fixture()
        val run = source.getValue("runs").jsonArray.single().jsonObject
        for ((field, value) in listOf("state" to JsonPrimitive("invented"), "revision" to JsonPrimitive(0), "label" to JsonPrimitive("x".repeat(81)), "startedAt" to JsonPrimitive(-1))) {
            val invalid = JsonObject(source + ("runs" to JsonArray(listOf(JsonObject(run + (field to value))))))
            assertThrows(Exception::class.java) { decode(invalid) }
        }
        assertThrows(Exception::class.java) { decode(JsonObject(source + ("runs" to JsonArray(listOf(run, run))))) }
    }
    @Test fun rejectsDuplicateJsonKeysAndOversizedRunList() {
        val raw = fixture().toString().replace("\"version\":1", "\"version\":1,\"version\":1")
        assertThrows(Exception::class.java) { AidenWorkspaceSubagents.decode(raw.toByteArray(), "workspace_fixture_01", "chat_fixture_01") }
        val source = fixture()
        val run = source.getValue("runs").jsonArray.single()
        assertThrows(Exception::class.java) { decode(JsonObject(source + ("runs" to JsonArray(List(101) { run })))) }
    }
    @Test fun reopeningOrReplacingSessionClearsPreviouslyAuthorizedProjection() {
        val state = AidenSubagentsPaneState()
        state.accept(decode())
        state.selected = state.result!!.runs.single()
        state.requireAuthorization()
        assertNull(state.result)
        assertNull(state.selected)
    }
    @Test fun lateRevisionCannotReplaceCurrentSummary() {
        val value = decode()
        val state = AidenSubagentsPaneState()
        assertTrue(state.accept(value))
        assertFalse(state.accept(value.copy(runs = value.runs.map { it.copy(revision = 1) })))
        assertEquals(2L, state.result!!.runs.single().revision)
    }
}
