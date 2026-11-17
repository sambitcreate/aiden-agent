package sbtbiswas.AidenOnTheGo

import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotOpenWork

class AidenBotOpenWorkClientTest {
    private lateinit var server:MockWebServer
    private lateinit var client:AidenRemoteClient
    @Before fun setup(){server=MockWebServer();server.start();client=AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'),"test-credential",OkHttpClient.Builder().build())}
    @After fun close(){server.shutdown()}
    private fun ok(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(value.toString())
    @Test fun bareSnapshotTypedRefusalAndOwnedEvidenceUseTheExactRoutes()=runBlocking {
        val fixture=openWorkFixture();server.enqueue(ok(fixture.getValue("snapshot")))
        assertEquals("snapshot-2",client.botOpenWork("bot_fixture").revision)
        assertEquals("/api/aiden/v1/bots/bot_fixture/open-work",server.takeRequest().path)
        server.enqueue(ok(fixture.getValue("stale")))
        val mutation=AidenBotWireJson.json.decodeFromJsonElement(AidenOpenWorkMutation.serializer(),fixture.getValue("mutations").jsonObject.getValue("edit"))
        val result=client.mutateBotOpenWork("bot_fixture",mutation)
        assertFalse(result.ok);assertEquals(AidenOpenWorkErrorCode.STALE,result.code)
        val post=server.takeRequest();assertEquals("POST",post.method)
        val payload=Json.parseToJsonElement(post.body.readUtf8()).jsonObject
        assertEquals(setOf("mutationId","action","expectedRevision","id","patch"),payload.keys)
        assertEquals(OPEN_NONCE,payload.getValue("mutationId").jsonPrimitive.content)
        server.enqueue(ok(fixture.getValue("evidenceResult")))
        val itemId=openWorkSnapshot().items.single().id
        assertEquals("The brief is reviewed. Two assumptions need follow-up.",client.botOpenWorkEvidence("bot_fixture",itemId,AidenOpenWorkEvidenceKind.RESULT).text)
        val evidence=server.takeRequest();assertEquals("GET",evidence.method);assertEquals("/api/aiden/v1/bots/bot_fixture/open-work/$itemId/evidence/result",evidence.path)
        assertEquals(3,server.requestCount)
    }
    @Test fun lostMutationIsNotRetriedAndWrongBotOrNonceOrEvidenceIsRejected()=runBlocking {
        val mutation=AidenOpenWorkMutation(OPEN_NONCE,AidenOpenWorkAction.ADD,"snapshot-1",title="Task")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertTrue(runCatching{client.mutateBotOpenWork("bot_fixture",mutation)}.isFailure)
        assertEquals(1,server.requestCount);server.takeRequest()
        val fixture=openWorkFixture()
        server.enqueue(ok(fixture.getValue("snapshot")))
        assertTrue(runCatching{client.botOpenWork("other_bot")}.isFailure);server.takeRequest()
        server.enqueue(ok(fixture.getValue("result")))
        assertTrue(runCatching{client.mutateBotOpenWork("bot_fixture",mutation)}.isFailure);server.takeRequest()
        server.enqueue(ok(fixture.getValue("evidenceResult")))
        assertTrue(runCatching{client.botOpenWorkEvidence("bot_fixture","other_item",AidenOpenWorkEvidenceKind.RESULT)}.isFailure)
    }
    @Test fun unknownPrivateFieldsAndOversizedEvidenceNeverReachTheUi()=runBlocking {
        val fixture=openWorkFixture();val raw=fixture.getValue("evidenceSource").jsonObject
        server.enqueue(ok(JsonObject(raw+("credentials" to JsonPrimitive("private")))))
        assertTrue(runCatching{client.botOpenWorkEvidence("bot_fixture",openWorkSnapshot().items.single().id,AidenOpenWorkEvidenceKind.SOURCE)}.isFailure)
        server.enqueue(ok(JsonObject(raw+("text" to JsonPrimitive("x".repeat(32769))))))
        assertTrue(runCatching{client.botOpenWorkEvidence("bot_fixture",openWorkSnapshot().items.single().id,AidenOpenWorkEvidenceKind.SOURCE)}.isFailure)
    }
    @Test fun capabilityNegotiatesAloneWithoutAddingAFeatureTokenAndOldHostsMayRefuse()=runBlocking {
        val base=listOf(AidenRemoteCapability.BOT_READ,AidenRemoteCapability.BOT_WRITE,AidenRemoteCapability.CHAT_READ)
        val installation=AidenInstallation(instanceId="test",deviceId="phone",name="Host",endpoint=server.url("/api/aiden/v1").toString(),serverSpkiSha256="sha256/test",deviceCapabilities=base,serverCapabilities=base,createdAt=Instant.EPOCH)
        val old=AidenServer(instanceId="test",name="Host",capabilities=base,serverCapabilities=base)
        assertNull(aidenRequestBotOpenWork(client,old,installation));assertEquals(0,server.requestCount)
        val offered=old.copy(serverCapabilities=base+AidenRemoteCapability.BOT_OPEN_WORK)
        val names=JsonArray((base+AidenRemoteCapability.BOT_OPEN_WORK).map{JsonPrimitive(it.rawValue)})
        server.enqueue(ok(buildJsonObject{put("capabilities",names)}))
        server.enqueue(ok(buildJsonObject{put("instanceId","test");put("name","Host");put("capabilities",names);put("serverCapabilities",names)}))
        assertTrue(requireNotNull(aidenRequestBotOpenWork(client,offered,installation)).server.supportsBotOpenWork)
        val ask=server.takeRequest();assertEquals(listOf("bot:open-work"),Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map{it.jsonPrimitive.content});server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":"invalid_request","message":"Unsupported","requestId":"req_1","retryable":false}}"""))
        assertNull(aidenRequestBotOpenWork(client,offered,installation))
    }
}
