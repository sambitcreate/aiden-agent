package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*

internal fun peerFixture():JsonObject=requireNotNull(AidenBotPeersContractTest::class.java.classLoader?.getResourceAsStream("bot-peers.json")).bufferedReader().use{Json.parseToJsonElement(it.readText()).jsonObject}
internal fun peerSettings()=AidenPeerWire.decode(AidenPeerSettings.serializer(),peerFixture().getValue("settings").toString())
internal fun peerCatalog()=AidenPeerWire.decode(AidenPeerCatalog.serializer(),peerFixture().getValue("catalog").toString())
internal fun peerDetail(key:String="detail")=AidenPeerWire.decode(AidenPeerExchange.serializer(),peerFixture().getValue(key).toString()).detail()
internal const val PEER_NONCE="55555555-5555-4555-8555-555555555555"
class AidenBotPeersContractTest {
    private fun <T> rejects(serializer:KSerializer<T>,value:JsonElement)=assertTrue("Rejected $value",runCatching{AidenPeerWire.decode(serializer,value.toString())}.isFailure)
    @Test fun canonical57ClosedOwnerCommandsResultsAndExchangeEvidence(){
        val f=peerFixture();assertEquals(59,f.getValue("contractRevision").jsonPrimitive.int);assertEquals("bot:peers",f.getValue("capability").jsonPrimitive.content)
        val s=peerSettings();assertEquals("Researcher",s.pairs.single().peer.name);assertEquals("bot_planner",peerCatalog().botId)
        assertEquals(listOf(AidenPeerAction.DESCRIBE,AidenPeerAction.APPROVE,AidenPeerAction.REVOKE),listOf("describe","approve","revoke").map{AidenPeerWire.decode(AidenPeerMutation.serializer(),f.getValue(it).toString()).action})
        assertTrue(AidenPeerWire.decode(AidenPeerMutationResult.serializer(),f.getValue("accepted").toString()).ok)
        assertEquals(AidenPeerError.CONFLICT,AidenPeerWire.decode(AidenPeerMutationResult.serializer(),f.getValue("conflict").toString()).code)
        assertEquals(AidenPeerExchangeState.COMPLETED,AidenPeerWire.decode(AidenPeerExchangeList.serializer(),f.getValue("exchanges").toString()).exchanges.single().state)
        val d=peerDetail();assertEquals("Researcher",d.peer.name);assertEquals("Planner",d.copy(direction=AidenPeerDirection.RECEIVED).peer.name)
        assertEquals("9007199254740993",AidenPeerWire.decode(AidenPeerEvidence.serializer(),f.getValue("evidence").toString()).submissionId)
        val stop=AidenPeerWire.decode(AidenPeerStopMutation.serializer(),f.getValue("stop").toString());assertEquals("exchange_v1",stop.expectedRevision)
        assertFalse(AidenPeerWire.decode(AidenPeerStopResult.serializer(),f.getValue("stopAccepted").toString()).exchange!!.lastStop!!.state.terminal)
        assertEquals(AidenPeerStopState.STOPPED,AidenPeerWire.decode(AidenPeerStopResult.serializer(),f.getValue("stopped").toString()).exchange!!.lastStop!!.state)
    }
    @Test fun malformedPrivacyAndCrossRoleRecordsFailClosed(){
        val f=peerFixture();val settings=f.getValue("settings").jsonObject
        for(extra in listOf("credentials","grant","path","unexpected"))rejects(AidenPeerSettings.serializer(),JsonObject(settings+(extra to JsonPrimitive("secret"))))
        rejects(AidenPeerSettings.serializer(),JsonObject(settings+("routingDescription" to JsonNull)))
        rejects(AidenPeerSettings.serializer(),JsonObject(settings+("updatedAt" to JsonPrimitive(1.5))))
        rejects(AidenPeerSettings.serializer(),JsonObject(settings+("botId" to JsonPrimitive("../bot"))))
        val catalog=f.getValue("catalog").jsonObject;val option=catalog.getValue("bots").jsonArray.single().jsonObject
        rejects(AidenPeerCatalog.serializer(),JsonObject(catalog+("bots" to JsonArray(listOf(JsonObject(option+("available" to JsonPrimitive("true"))))))))
        rejects(AidenPeerSettings.serializer(),JsonObject(settings+("pairs" to JsonArray(List(129){settings.getValue("pairs").jsonArray.single()}))))
        val list=f.getValue("exchanges").jsonObject
        rejects(AidenPeerExchangeList.serializer(),JsonObject(list+("botId" to JsonPrimitive("other"))))
        rejects(AidenPeerExchangeList.serializer(),JsonObject(list+("exchanges" to JsonArray(listOf(f.getValue("detail"))))))
        val command=f.getValue("describe").jsonObject
        rejects(AidenPeerMutation.serializer(),JsonObject(command+("peerBotId" to JsonPrimitive("another"))))
        for(bad in listOf(JsonPrimitive(9007199254740993L),JsonPrimitive("0"),JsonPrimitive("01"),JsonPrimitive("1".repeat(33))))rejects(AidenPeerEvidence.serializer(),JsonObject(f.getValue("evidence").jsonObject+("entryId" to bad)))
    }
    @Test fun unicodeBoundsCountScalarsAndUtf8WithoutSplitting(){
        val s=peerSettings();assertEquals(1024,s.copy(routingDescription="😀".repeat(512)).routingDescription.length)
        assertTrue(runCatching{s.copy(routingDescription="😀".repeat(513))}.isFailure)
        assertTrue(runCatching{s.copy(routingDescription="a".repeat(1001))}.isFailure)
        for(bad in listOf("\uD800","\uDC00","bad\u0000text"))assertTrue(runCatching{s.copy(routingDescription=bad)}.isFailure)
        assertEquals("😀".repeat(512),AidenOpenWorkWire.clamp("😀".repeat(513),1000,2048))
        assertEquals("😀".repeat(160),AidenPeerIdentity("bot","😀".repeat(160)).name)
        assertTrue(runCatching{AidenPeerIdentity("bot","😀".repeat(161))}.isFailure)
        val e=AidenPeerWire.decode(AidenPeerEvidence.serializer(),peerFixture().getValue("evidence").toString())
        assertTrue(runCatching{e.copy(text="😀".repeat(8193))}.isFailure)
    }
    @Test fun quietPeerTranscriptFinalIsDisplayOnlyAndStrict(){
        val f=peerFixture();val entry=AidenBotWireJson.json.decodeFromJsonElement(AidenBotSessionEntry.serializer(),f.getValue("peerEntry")) as AidenBotSessionEntry.Peer
        assertEquals("Researcher",entry.peerName);assertEquals(AidenPeerDirection.SENT,entry.direction);assertNull(entry.isFinal)
        val final=AidenBotWireJson.json.decodeFromJsonElement(AidenBotSessionEntry.serializer(),f.getValue("peerFinalEntry")) as AidenBotSessionEntry.Peer
        assertTrue(final.isFinal==true);assertEquals(AidenPeerMessageKind.RESULT,final.messageKind)
        for(patch in listOf(mapOf("final" to JsonPrimitive(false)),mapOf("final" to JsonNull),mapOf("final" to JsonPrimitive(true),"messageKind" to JsonPrimitive("request")),mapOf("createdAt" to JsonPrimitive(1000)))) {
            assertTrue(runCatching{AidenBotWireJson.json.decodeFromJsonElement(AidenBotSessionEntry.serializer(),JsonObject(f.getValue("peerFinalEntry").jsonObject+patch))}.isFailure)
        }
        val notification=AidenBotWireJson.json.decodeFromJsonElement(AidenBotRoutineNotification.serializer(),f.getValue("peerNotification"));assertEquals(AidenBotNotificationKind.PEER,notification.kind);assertNull(notification.routineId);assertNull(notification.status)
        assertTrue(runCatching{notification.copy(routineId="fake")}.isFailure)
    }
    @Test fun privacyExceptionAllowsOnlyOwnedPeerResultFields(){
        AidenBotPrivateResponseValidator.validate(peerFixture().getValue("detail"),AidenBotPrivateResponseScope.Root("botPeers"))
        AidenBotPrivateResponseValidator.validate(peerFixture().getValue("stopped"),AidenBotPrivateResponseScope.Root("botPeers"))
        for(key in listOf("credentials","arguments","secret","instructions"))assertTrue(runCatching{AidenBotPrivateResponseValidator.validate(JsonObject(peerFixture().getValue("detail").jsonObject+(key to JsonPrimitive("private"))),AidenBotPrivateResponseScope.Root("botPeers"))}.isFailure)
    }
    @Test fun peerOpenWorkSourcesAndLinksPreserveOpaqueProvenance(){
        val source=AidenBotWireJson.json.decodeFromString(AidenOpenWorkSource.serializer(),"""{"kind":"peer","exchangeId":"exchange_one","role":"incoming","peerBotId":"peer","submissionId":"9007199254740993","entryId":"9007199254740995"}""")
        assertEquals(AidenOpenWorkSourceKind.PEER,source.kind);assertEquals("9007199254740993",source.submissionId)
        assertTrue(runCatching{source.copy(entryId=null)}.isFailure);assertTrue(runCatching{source.copy(role=null)}.isFailure);assertTrue(runCatching{source.copy(routineId="routine")}.isFailure)
        val link=AidenOpenWorkLink(AidenOpenWorkLinkKind.PEER,exchangeId="exchange_one",peerBotId="peer");assertEquals("exchange_one",link.exchangeId);assertTrue(runCatching{link.copy(issueId="issue")}.isFailure)
    }
    @Test fun finalPeerLiveEntryStaysQuietAndDoesNotCompleteOrConsumeCurrentAnswer(){
        val raw=requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use{Json.parseToJsonElement(it.readText()).jsonObject}
        val session=AidenBotWireJson.json.decodeFromJsonElement(AidenBotSession.serializer(),raw.getValue("botSession")).copy(seq=10,state=AidenBotSessionState.RUNNING,interrupted=false,blocked=null,partial="Current streaming answer")
        val frame=buildJsonObject{put("protocolVersion",1);put("botId",session.botId);put("epoch",session.epoch);put("seq",11);put("type","entry");put("payload",buildJsonObject{put("entry",peerFixture().getValue("peerFinalEntry"))})}
        val event=AidenBotWireJson.json.decodeFromJsonElement(AidenBotSessionEvent.serializer(),frame)
        val applied=sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent(session,event) as sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome.Applied
        assertEquals(AidenBotSessionState.RUNNING,applied.session.state);assertEquals(session.interrupted,applied.session.interrupted);assertEquals("Current streaming answer",applied.session.partial)
        assertEquals(11L,applied.session.seq);assertEquals(1,applied.session.entries.count{it.id=="peer_entry_final"})
        assertTrue(sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent(applied.session,event) is sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome.Ignored)
    }

}
