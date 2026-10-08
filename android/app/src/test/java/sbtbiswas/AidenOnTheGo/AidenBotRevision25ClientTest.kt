package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotRoutineWriteFailure
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.time.Instant
import java.util.UUID

/** Revision 25 Bot routes over HTTP, against the shared fixture payloads. */
class AidenBotRevision25ClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }

    private fun pair(key: String, part: String): JsonElement = fixture.getValue(key).jsonObject.getValue(part)

    private fun ok(body: JsonElement, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun error(code: Int, errorCode: String) = MockResponse().setResponseCode(code).setBody(
        """{"error":{"code":"$errorCode","message":"Nope.","requestId":"req_1","retryable":false}}"""
    )

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        val capabilities = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE, AidenRemoteCapability.CHAT_WRITE)
        client = AidenRemoteClient(
            installation = AidenInstallation(
                instanceId = "test_instance",
                deviceId = "test_device",
                name = "Test Mac",
                endpoint = server.url("/api/aiden/v1").toString(),
                serverSpkiSha256 = "sha256/test",
                deviceCapabilities = capabilities,
                serverCapabilities = capabilities,
                createdAt = Instant.now()
            ),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient.Builder().build()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    @Test
    fun aRevision24BotListFailsWithThePlainUpdateMessageInsteadOfASerializerDump() = runBlocking {
        // A revision-24 Mac still sends Favorites and Archived Bots.
        val list = fixture.getValue("botList").jsonObject
        val summary = list.getValue("bots").jsonArray[0].jsonObject
        val revision24 = JsonObject(
            list + ("bots" to JsonArray(listOf(JsonObject(summary + ("health" to JsonPrimitive("archived")))))) +
                ("favorites" to Json.parseToJsonElement("""{"botIds":[],"revision":"fav_1"}"""))
        )
        server.enqueue(ok(revision24))
        try {
            client.bots()
            fail("A revision-24 list must not decode")
        } catch (e: AidenBotContractException) {
            assertTrue(e.message!!.startsWith("Aiden Agent returned Bot information this version"))
        }

        // The current shape still decodes through the same route.
        server.enqueue(ok(list))
        assertEquals("bot_fixture_01", client.bots().bots.single().id)
    }

    @Test
    fun startChatOnAPresetAcceptsBothTheCreatingAndTheReplayedAnswer() = runBlocking {
        val created = pair("botPresetCreate", "response").jsonObject
        val replayed = JsonObject(created + ("created" to JsonPrimitive(false)))
        server.enqueue(ok(created, 201))
        server.enqueue(ok(replayed, 200))
        val key = UUID.randomUUID()

        val first = client.createBotFromPreset("chief-of-staff", key)
        val second = client.createBotFromPreset("chief-of-staff", key)

        assertTrue(first.created)
        assertFalse(second.created)
        assertEquals(first.bot.id, second.bot.id)
        val request = server.takeRequest()
        assertEquals("/api/aiden/v1/bots/from-preset", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals("""{"presetId":"chief-of-staff"}""", request.body.readUtf8())
        assertEquals(key.toString(), server.takeRequest().getHeader("Idempotency-Key"))
    }

    @Test
    fun deleteSendsTheRevisionAndTreatsAnAlreadyGoneBotAsDeleted() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(error(404, "not_found"))
        client.deleteBot("bot_fixture_01", "rev_7")
        client.deleteBot("bot_fixture_01", "rev_7")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01", request.path)
        assertEquals("rev_7", request.getHeader("If-Match"))

        // Any other refusal is still a failure the screen must show.
        server.enqueue(error(409, "revision_conflict"))
        try {
            client.deleteBot("bot_fixture_01", "rev_6")
            fail("A stale delete must fail")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(409, e.statusCode)
        }
    }

    @Test
    fun aStaleRoutineRevisionIsAConflictTheProfileReloadsFor() = runBlocking {
        server.enqueue(error(409, "revision_conflict"))
        val failure = try {
            client.updateBotRoutine("bot_fixture_01", "routine_fixture_01", "old_rev", AidenBotRoutineUpdateRequest(enabled = false))
            null
        } catch (e: AidenRemoteClientException.Server) {
            e
        }
        assertNotNull(failure)
        assertEquals(AidenRemoteErrorCode.REVISION_CONFLICT, failure!!.body.code)
        assertEquals("old_rev", server.takeRequest().getHeader("If-Match"))

        val meaning = aidenBotRoutineWriteFailure(failure, "fallback")
        assertTrue(meaning.reload)
        assertEquals("This routine changed on your Mac. Check it and try again.", meaning.message)
        // A dropped connection is not a conflict: keep the list and offer a retry.
        val offline = aidenBotRoutineWriteFailure(java.io.IOException("offline"), "fallback")
        assertFalse(offline.reload)
        assertEquals("fallback", offline.message)
    }

    @Test
    fun aConnectionRequestForAnUnknownPluginIsARefusalNotACrash() = runBlocking {
        server.enqueue(error(404, "not_found"))
        try {
            client.requestBotConnection("bot_fixture_01", "not-a-plugin", UUID.randomUUID())
            fail("Unknown plugin must be refused")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(404, e.statusCode)
        }
        server.enqueue(ok(pair("botConnectionRequest", "response")))
        val receipt = client.requestBotConnection("bot_fixture_01", "google-calendar", UUID.randomUUID())
        assertEquals(AidenBotConnectionRequestStatus.SENT, receipt.status)
    }

    @Test
    fun theSessionFeedDeliversFramesInOrderAndRejectsAnotherBotsFrames() = runBlocking {
        val events = fixture.getValue("botSessionEvents").jsonArray
        val body = events.joinToString("") { "data: $it\n\n" }
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        val received = client.botSessionEvents("bot_fixture_01").toList()
        assertEquals(events.size, received.size)
        assertEquals(listOf("snapshot", "partial", "entry", "state", "closed", "state"), received.map { it.type })
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/session/events", server.takeRequest().path)

        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        try {
            client.botSessionEvents("bot_other").toList()
            fail("Frames for another Bot must be rejected")
        } catch (e: sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException) {
            assertEquals(sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException.InvalidStreamIdentity, e)
        }
    }
}
