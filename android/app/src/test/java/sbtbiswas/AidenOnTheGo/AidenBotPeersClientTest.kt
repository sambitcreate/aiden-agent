package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.*
import sbtbiswas.AidenOnTheGo.features.remote.*
import java.time.Instant

class AidenBotPeersClientTest {
    private lateinit var server:MockWebServer;private lateinit var client:AidenRemoteClient
    @Before fun setup(){server=MockWebServer();server.start();client=AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'),"test-credential",OkHttpClient.Builder().build())}
    @After fun close(){server.shutdown()}
    private fun ok(key:String)=MockResponse().setHeader("Content-Type","application/json").setBody(peerFixture().getValue(key).toString())
    @Test fun exactBareRoutesAndFlatBodiesForEveryOwnerActionAndStop()=runBlocking {
        server.enqueue(ok("settings"));assertEquals("peers_v2",client.botPeers("bot_planner").revision);assertEquals("/api/aiden/v1/bots/bot_planner/peers",server.takeRequest().path)
        server.enqueue(ok("catalog"));assertEquals(1,client.botPeerCatalog("bot_planner").bots.size);assertTrue(server.takeRequest().path!!.endsWith("/peers/catalog"))
        for(action in listOf("describe","approve","revoke")) {
            val request=AidenPeerWire.decode(AidenPeerMutation.serializer(),peerFixture().getValue(action).toString())
            server.enqueue(ok("conflict"));assertFalse(client.mutateBotPeers(request).ok)
            val post=server.takeRequest();assertEquals("POST",post.method);assertTrue(post.path!!.endsWith("/bot_planner/peers"))
            val body=Json.parseToJsonElement(post.body.readUtf8()).jsonObject
            assertEquals("bot_planner",body.getValue("botId").jsonPrimitive.content);assertEquals(action,body.getValue("action").jsonPrimitive.content)
            assertEquals(peerFixture().getValue(action).jsonObject.keys,body.keys)
        }
        server.enqueue(ok("exchanges"));assertEquals(1,client.botPeerExchanges("bot_planner").exchanges.size);assertTrue(server.takeRequest().path!!.endsWith("/bot_planner/peer-exchanges"))
        server.enqueue(ok("detail"));val detail=client.botPeerExchange("bot_planner","exchange_one");assertNotNull(detail.result);assertTrue(server.takeRequest().path!!.endsWith("/peer-exchanges/exchange_one"))
        server.enqueue(ok("evidence"));assertEquals("9007199254740993",client.botPeerEvidence("bot_planner",detail,AidenOpenWorkEvidenceKind.SOURCE).submissionId);assertTrue(server.takeRequest().path!!.endsWith("/exchange_one/evidence/source"))
        val stop=AidenPeerWire.decode(AidenPeerStopMutation.serializer(),peerFixture().getValue("stop").toString());server.enqueue(ok("stopAccepted"));assertEquals(AidenPeerStopState.REQUESTED,client.stopBotPeerExchange(stop).exchange!!.lastStop!!.state)
        val post=server.takeRequest();assertTrue(post.path!!.endsWith("/exchange_one/stop"));val body=Json.parseToJsonElement(post.body.readUtf8()).jsonObject
        assertEquals(setOf("botId","exchangeId","mutationId","expectedRevision"),body.keys);assertEquals("exchange_v1",body.getValue("expectedRevision").jsonPrimitive.content)
    }
    @Test fun validatesPathOwnerDirectionNonceEvidenceRolesAndPrivateFields()=runBlocking {
        server.enqueue(ok("settings"));assertTrue(runCatching{client.botPeers("wrong")}.isFailure);server.takeRequest()
        server.enqueue(ok("exchanges"));assertTrue(runCatching{client.botPeerExchanges("bot_researcher")}.isFailure);server.takeRequest()
        server.enqueue(ok("detail"));assertTrue(runCatching{client.botPeerExchange("bot_planner","different_exchange")}.isFailure);server.takeRequest()
        val request=AidenPeerMutation(AidenPeerAction.DESCRIBE,"bot_planner",PEER_NONCE,"peers_v1",routingDescription="Coordinate reviews")
        server.enqueue(ok("accepted"));assertTrue(runCatching{client.mutateBotPeers(request)}.isFailure);server.takeRequest()
        val received=peerDetail().copy(direction=AidenPeerDirection.RECEIVED)
        server.enqueue(ok("evidence"));assertEquals("bot_planner",client.botPeerEvidence("bot_researcher",received,AidenOpenWorkEvidenceKind.SOURCE).botId);server.takeRequest()
        server.enqueue(ok("evidence"));assertTrue(runCatching{client.botPeerEvidence("bot_researcher",received,AidenOpenWorkEvidenceKind.RESULT)}.isFailure);server.takeRequest()
        server.enqueue(MockResponse().setBody(JsonObject(peerFixture().getValue("detail").jsonObject+("arguments" to JsonPrimitive("private"))).toString()))
        assertTrue(runCatching{client.botPeerExchange("bot_planner","exchange_one")}.isFailure)
        val count=server.requestCount;assertTrue(runCatching{client.botPeers("../bot")}.isFailure);assertEquals(count,server.requestCount)
    }
    @Test fun lostPostNeverAutomaticallyRetriesAndOversizeOrSummaryAsDetailFails()=runBlocking {
        val command=AidenPeerMutation(AidenPeerAction.DESCRIBE,"bot_planner",PEER_NONCE,"v1",routingDescription="Reviews")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));assertTrue(runCatching{client.mutateBotPeers(command)}.isFailure);assertEquals(1,server.requestCount);server.takeRequest()
        server.enqueue(MockResponse().setBody(" ".repeat(AidenPeerWire.PUBLIC_BYTES+1)));assertTrue(runCatching{client.botPeerCatalog("bot_planner")}.isFailure);server.takeRequest()
        server.enqueue(MockResponse().setBody(peerFixture().getValue("exchanges").jsonObject.getValue("exchanges").jsonArray.single().toString()));assertTrue(runCatching{client.botPeerExchange("bot_planner","exchange_one")}.isFailure)
    }
    @Test fun continuityAndShippingMessagingCapabilitiesNegotiateTogetherWithoutDroppingEarlierGrants() = runBlocking {
        val base = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.CHAT_READ)
        val tokens = listOf("bot:watches", "bot:open-work", "bot:routine-models", "bot:peers", "bot:messaging", "bot:access-requests", "bot:plans", "bot:allowed")
        val offered = base + tokens.map(::AidenRemoteCapability)
        val installation = AidenInstallation(instanceId="test", deviceId="phone", name="Host", endpoint=server.url("/api/aiden/v1").toString(), serverSpkiSha256="sha256/test", deviceCapabilities=base, serverCapabilities=offered, createdAt=Instant.EPOCH)
        var host = AidenServer(protocolVersion=1, instanceId="test", name="Host", capabilities=base, serverCapabilities=offered)
        var grants = base
        val requests = listOf(::aidenRequestBotWatches, ::aidenRequestBotOpenWork, ::aidenRequestBotRoutineModels, ::aidenRequestBotPeers, ::aidenRequestBotMessaging, ::aidenRequestBotAccessRequests, ::aidenRequestBotPlans, ::aidenRequestBotAllowed)
        for ((index, request) in requests.withIndex()) {
            grants = grants + AidenRemoteCapability(tokens[index])
            val wireGrants = JsonArray(grants.map { JsonPrimitive(it.rawValue) })
            server.enqueue(MockResponse().setBody(JsonObject(mapOf("capabilities" to wireGrants)).toString()))
            server.enqueue(MockResponse().setBody(JsonObject(mapOf("instanceId" to JsonPrimitive("test"), "name" to JsonPrimitive("Host"), "capabilities" to wireGrants, "serverCapabilities" to JsonArray(offered.map { JsonPrimitive(it.rawValue) }))).toString()))
            host = requireNotNull(request(client, host, installation) { true }).server
            val post = server.takeRequest()
            assertEquals("/api/aiden/v1/device/capabilities", post.path)
            assertEquals(listOf(tokens[index]), Json.parseToJsonElement(post.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content })
            assertEquals("/api/aiden/v1/server", server.takeRequest().path)
        }
        assertTrue(host.supportsBotPeers)
        assertTrue(host.supportsBotPeerExchanges)
        assertEquals((base.map { it.rawValue } + tokens).toSet(), host.capabilities.map { it.rawValue }.toSet())
    }

    @Test fun peerCapabilityNegotiatesAloneAndMetadataDoesNotNeedChatOrWrite()=runBlocking {
        val grants=listOf(AidenRemoteCapability.BOT_READ)
        val installation=AidenInstallation(instanceId="test",deviceId="phone",name="Host",endpoint=server.url("/api/aiden/v1").toString(),serverSpkiSha256="sha256/test",deviceCapabilities=grants,serverCapabilities=grants,createdAt=Instant.EPOCH)
        val host=AidenServer(protocolVersion=1,instanceId="test",name="Host",capabilities=grants,serverCapabilities=grants+ AidenRemoteCapability.BOT_PEERS)
        server.enqueue(MockResponse().setBody("""{"capabilities":["bot:read","bot:peers"]}"""))
        server.enqueue(MockResponse().setBody("""{"instanceId":"test","name":"Host","capabilities":["bot:read","bot:peers"],"serverCapabilities":["bot:read","bot:peers"]}"""))
        assertNotNull(aidenRequestBotPeers(client,host,installation));val body=Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(listOf("bot:peers"),body.getValue("accepts").jsonArray.map{it.jsonPrimitive.content})
        server.takeRequest()
        assertFalse(host.supportsBotPeers);val granted=host.copy(capabilities=grants+AidenRemoteCapability.BOT_PEERS)
        assertTrue(granted.supportsBotPeers);assertFalse(granted.supportsBotPeerExchanges)
        assertTrue(granted.copy(capabilities=granted.capabilities+AidenRemoteCapability.CHAT_READ,serverCapabilities=granted.serverCapabilities!!+AidenRemoteCapability.CHAT_READ).supportsBotPeerExchanges)
        val count=server.requestCount;assertNull(aidenRequestBotPeers(client,host.copy(serverCapabilities=grants),installation));assertEquals(count,server.requestCount)
    }
}
