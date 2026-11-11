package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotWatches
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.time.Instant
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient

class AidenBotWatchClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient
    @Before fun setup() { server = MockWebServer(); server.start(); client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test_credential", OkHttpClient.Builder().build()) }
    @After fun close() { server.shutdown() }
    private fun ok(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    @Test fun fullManagementUsesOnlyTypedBodiesAndNoAutomaticRunFromTest() = runBlocking {
        server.enqueue(ok(AidenBotWireJson.json.encodeToString(AidenBotWatchList.serializer(), watchList())))
        assertEquals("Personal", client.botWatches("bot_fixture_01").watches.single().source.accountLabel)
        assertEquals("GET", server.takeRequest().method)
        server.enqueue(ok("""{"choices":[{"id":"$SOURCE_ID","templateId":"mail_messages","providerLabel":"Mail","accountLabel":"Personal","resourceLabel":"Inbox","available":true}],"unavailableReasons":[]}"""))
        assertEquals(SOURCE_ID, client.botWatchSources("bot_fixture_01").choices.single().id)
        val discovery = server.takeRequest(); assertEquals("POST", discovery.method); assertEquals("{}", discovery.body.readUtf8())
        val config = AidenBotWatchSaveRequest("Priority mail", "Summarize meaningful changes", AidenBotWatchCondition.Email(unreadOnly = true), 30, MUTATION_ID, SOURCE_ID)
        server.enqueue(ok(WATCH_JSON.replace(WATCH_ID, MUTATION_ID))); client.saveBotWatch("bot_fixture_01", null, config)
        val create = server.takeRequest(); val body = Json.parseToJsonElement(create.body.readUtf8()).jsonObject
        assertEquals("POST", create.method); assertEquals("/api/aiden/v1/bots/bot_fixture_01/watches", create.path)
        assertEquals(setOf("name", "prompt", "condition", "everyMinutes", "mutationId", "sourceChoiceId"), body.keys)
        assertEquals(MUTATION_ID, body.getValue("mutationId").jsonPrimitive.content)
        server.enqueue(ok(WATCH_JSON)); client.saveBotWatch("bot_fixture_01", WATCH_ID, config.copy(sourceChoiceId = null, expectedRevision = "1"))
        val edit = server.takeRequest(); assertEquals("PATCH", edit.method); assertFalse(Json.parseToJsonElement(edit.body.readUtf8()).jsonObject.containsKey("sourceChoiceId"))
        server.enqueue(ok(WATCH_JSON)); client.enableBotWatch("bot_fixture_01", WATCH_ID, AidenBotWatchMutation("1", MUTATION_ID, false))
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/watches/$WATCH_ID/enabled", server.takeRequest().path)
        server.enqueue(ok("""{"checkedAt":1793728800000,"result":"unchanged","itemCount":3,"changeCount":0,"preview":[]}"""))
        assertEquals(3, client.testBotWatch("bot_fixture_01", AidenBotWatchTestRequest(id = WATCH_ID, expectedRevision = "1")).itemCount)
        val test = server.takeRequest(); assertEquals("/api/aiden/v1/bots/bot_fixture_01/watches/test", test.path)
        assertEquals(setOf("id", "expectedRevision"), Json.parseToJsonElement(test.body.readUtf8()).jsonObject.keys)
        assertEquals(6, server.requestCount)
        server.enqueue(ok("""{"id":"$WATCH_ID","revision":"1","admitted":true}""")); assertTrue(client.runBotWatch("bot_fixture_01", WATCH_ID, AidenBotWatchMutation("1", MUTATION_ID)).admitted)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/watches/$WATCH_ID/run", server.takeRequest().path)
        server.enqueue(ok("""{"id":"$WATCH_ID","revision":"deleted:1","removed":true}""")); assertTrue(client.deleteBotWatch("bot_fixture_01", WATCH_ID, AidenBotWatchMutation("1", MUTATION_ID)).removed)
        val deletion = server.takeRequest(); assertEquals("DELETE", deletion.method)
        assertEquals("1", Json.parseToJsonElement(deletion.body.readUtf8()).jsonObject.getValue("expectedRevision").jsonPrimitive.content)
    }
    @Test fun watchCapabilityIsNegotiatedAloneOnlyWhenOfferedAndOldHostsMayRefuse() = runBlocking {
        val base = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)
        val installation = AidenInstallation(instanceId = "test_instance", deviceId = "test_device", name = "Host",
            endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
            deviceCapabilities = base, serverCapabilities = base, createdAt = Instant.EPOCH)
        val old = AidenServer(instanceId = "test_instance", name = "Host", capabilities = base, serverCapabilities = base)
        assertNull(aidenRequestBotWatches(client, old, installation)); assertEquals(0, server.requestCount)
        val offered = old.copy(serverCapabilities = base + AidenRemoteCapability.BOT_WATCHES)
        server.enqueue(ok("""{"capabilities":["bot:read","bot:write","bot:watches"]}"""))
        server.enqueue(ok("""{"instanceId":"test_instance","name":"Host","capabilities":["bot:read","bot:write","bot:watches"],"serverCapabilities":["bot:read","bot:write","bot:watches"]}"""))
        val granted = requireNotNull(aidenRequestBotWatches(client, offered, installation))
        assertTrue(granted.server.supportsBotWatches)
        val ask = server.takeRequest()
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(listOf("bot:watches"), Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content })
        server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":"invalid_request","message":"Unsupported","requestId":"req_1","retryable":false}}"""))
        assertNull(aidenRequestBotWatches(client, offered, installation))
        assertEquals(3, server.requestCount)
    }

    @Test fun lostRunResponseIsNeverAutomaticallyRetried() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertTrue(runCatching { client.runBotWatch("bot_fixture_01", WATCH_ID, AidenBotWatchMutation("1", MUTATION_ID)) }.isFailure)
        assertEquals(1, server.requestCount)
    }
    @Test fun rejectsCrossBotAndCrossWatchResponses() = runBlocking {
        server.enqueue(ok(WATCH_JSON.replace("bot_fixture_01", "different_bot")))
        assertTrue(runCatching { client.saveBotWatch("bot_fixture_01", WATCH_ID,
            AidenBotWatchSaveRequest("Mail", "Review", AidenBotWatchCondition.Email(unreadOnly = false), 30, MUTATION_ID, expectedRevision = "1")) }.isFailure)
        server.enqueue(ok("""{"id":"$SOURCE_ID","revision":"1","admitted":true}"""))
        assertTrue(runCatching { client.runBotWatch("bot_fixture_01", WATCH_ID, AidenBotWatchMutation("1", MUTATION_ID)) }.isFailure)
    }
}
