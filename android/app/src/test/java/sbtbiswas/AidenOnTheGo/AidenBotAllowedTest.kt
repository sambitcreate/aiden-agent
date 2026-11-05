package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import sbtbiswas.AidenOnTheGo.features.bots.*
import sbtbiswas.AidenOnTheGo.protocol.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotAllowed
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import java.time.Instant
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*

class AidenBotAllowedTest {
    private val fixture by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("botAllowed").jsonObject
    }
    @Test fun hostOfferedApprovalAndFolderCountsDecodeWithoutPrivateAuthority() {
        val approval = AidenBotApproval.parse(fixture.getValue("approval"))
        val access = AidenBotWireJson.json.decodeFromJsonElement(AidenBotAccessRequest.serializer(), fixture.getValue("accessRequest"))
        assertEquals(3, approval.toJson().getValue("alwaysCount").jsonPrimitive.int)
        assertEquals(3, AidenBotWireJson.json.encodeToJsonElement(AidenBotAccessRequest.serializer(), access).jsonObject.getValue("approvalCount").jsonPrimitive.int)
        assertFalse(approval.toJson().containsKey("always"))
    }

    private fun page(key: String) = AidenBotAllowedList.parse(if (key == "list") fixture.getValue(key) else fixture.getValue("paginated").jsonObject.getValue(key))
    private class Transport(var first: AidenBotAllowedList, val next: AidenBotAllowedList, val removed: AidenBotAllowedList, val removedNext: AidenBotAllowedList): AidenBotAllowedTransport {
        var didRemove = false; var removeFailure = false
        var gate: CompletableDeferred<Unit>? = null
        var entered: CompletableDeferred<Unit>? = null
        var pageGate: CompletableDeferred<Unit>? = null
        var pageEntered: CompletableDeferred<Unit>? = null
        var listFailure: Exception? = null
        val cursors = mutableListOf<String?>()
        override suspend fun list(botId: String, cursor: String?): AidenBotAllowedList {
            cursors += cursor
            val result=if (cursor == null) first else if (didRemove) removedNext else next
            if (cursor != null) { pageEntered?.complete(Unit); pageGate?.await(); listFailure?.let { listFailure=null; throw it } }
            return result
        }
        override suspend fun remove(botId: String, id: String): AidenBotAllowedList {
            entered?.complete(Unit); gate?.await()
            if (removeFailure) { removeFailure=false; throw IOException("lost") }
            didRemove=true; return removed
        }
    }
    @Test fun allPagesIncludeFoldersAndRemoveRepagesFreshView() = runTest {
        val t = Transport(page("firstPage"),page("nextPage"),page("afterRemove"),page("afterRemoveNextPage"))
        val model = AidenBotAllowedController(t.first.botId,t)
        model.load()
        assertEquals(53,model.state.value.entries.size)
        assertEquals(3,model.state.value.entries.count { it.kind == "folder" })
        assertEquals("53",model.state.value.countSummary)
        val id = model.state.value.entries.first().id
        model.remove(id)
        assertEquals(52,model.state.value.entries.size)
        assertEquals(3,model.state.value.entries.count { it.kind == "folder" })
        assertFalse(model.state.value.entries.any { it.id == id })
        assertEquals(2,t.cursors.filterNotNull().size)
    }
    @Test fun canonicalDisplayRowsPreserveHostStringsAndFolderHasNoUsage() {
        val list=page("list")
        assertEquals(listOf("Google Calendar · Create event","Click on amazon.com","Folder · ~/Documents/Reports 1"),list.entries.map { it.what })
        assertEquals(listOf(0L,12L,null),list.entries.map { it.uses })
        assertNull(list.entries[2].lastUsedAt)
    }
    @Test fun strictListRejectsPrivateFieldsNullsBoundsAndFolderUsage() {
        val original = fixture.getValue("list").jsonObject
        val row = original.getValue("entries").jsonArray.first().jsonObject
        fun rejects(r: JsonObject) {
            try { AidenBotAllowedList.parse(JsonObject(original + ("entries" to JsonArray(listOf(r))))); fail("invalid entry accepted: $r") } catch (_: IllegalArgumentException) {} catch (_: AidenBotContractException) {}
        }
        listOf("target" to JsonPrimitive("private"),"uses" to JsonNull,"uses" to JsonPrimitive(-1),"uses" to JsonPrimitive(1.5),"uses" to JsonPrimitive(true),"uses" to JsonPrimitive(9007199254740992L),"id" to JsonPrimitive("bad/id"),"id" to JsonPrimitive("valid\n"),"what" to JsonPrimitive("Safe\u202Ehidden"),"what" to JsonPrimitive("🧭".repeat(201)),"addedAt" to JsonPrimitive("yesterday"),"lastUsedAt" to JsonNull).forEach { (k,v) -> rejects(JsonObject(row + (k to v))) }
        rejects(JsonObject(row - "uses")); rejects(JsonObject(row + ("kind" to JsonPrimitive("folder"))))
        for (cursor in listOf(JsonNull,JsonPrimitive("cur_bad"),JsonPrimitive(3))) {
            try { AidenBotAllowedList.parse(JsonObject(original + ("nextCursor" to cursor))); fail("invalid cursor accepted") } catch (_: Exception) {}
        }
        val unicode = JsonObject(row + ("what" to JsonPrimitive("🧭".repeat(200))))
        assertEquals(200,AidenBotAllowedList.parse(JsonObject(original + ("entries" to JsonArray(listOf(unicode))))).entries[0].what.codePointCount(0,400))
    }
    @Test fun countsAreAbsentOnlyAndRequireAnOfferedAllow() {
        assertNull(AidenBotApproval.parse(fixture.getValue("legacyApproval")).alwaysCount)
        assertNull(AidenBotAccessRequest.parse(fixture.getValue("legacyAccessRequest")).approvalCount)
        for (v in listOf(JsonNull,JsonPrimitive(true),JsonPrimitive(2),JsonPrimitive(21),JsonPrimitive(3.5),JsonPrimitive("3"))) {
            try { AidenBotApproval.parse(JsonObject(fixture.getValue("approval").jsonObject + ("alwaysCount" to v))); fail("invalid count") } catch (_: Exception) {}
            try { AidenBotAccessRequest.parse(JsonObject(fixture.getValue("accessRequest").jsonObject + ("approvalCount" to v))); fail("invalid folder count") } catch (_: Exception) {}
        }
        try { AidenBotApproval.parse(JsonObject(fixture.getValue("approval").jsonObject + ("canAllow" to JsonPrimitive(false)))); fail("deny-only offer") } catch (_: Exception) {}
    }
    @Test fun expiredCursorRestartsFromFirstPageAndDeniedModelSendsNothing() = runTest {
        val t = Transport(page("firstPage"),page("nextPage"),page("afterRemove"),page("afterRemoveNextPage"))
        t.listFailure=AidenRemoteClientException.Server(400,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.INVALID_REQUEST,"Refresh","req",true))
        val model=AidenBotAllowedController(t.first.botId,t)
        model.load(); assertEquals(53,model.state.value.entries.size); assertEquals(4,t.cursors.size)
        val denied=AidenBotAllowedController(t.first.botId,t) { false }; denied.load()
        assertNull(denied.state.value.countSummary); assertEquals(4,t.cursors.size)
    }
    @Test fun cursorLoopNeverPublishesPartialCount() = runTest {
        val t = Transport(page("firstPage"),page("firstPage"),page("list"),page("nextPage"))
        val model = AidenBotAllowedController(t.first.botId,t)
        model.load(); assertFalse(model.state.value.loaded); assertNull(model.state.value.countSummary); assertNotNull(model.state.value.error)
    }
    @Test fun latePageCannotMixOldSnapshotIntoRefresh() = runTest {
        val t=Transport(page("firstPage"),page("nextPage"),page("afterRemove"),page("afterRemoveNextPage"))
        val gate=CompletableDeferred<Unit>(); t.pageGate=gate; t.pageEntered=CompletableDeferred()
        val model=AidenBotAllowedController(t.first.botId,t)
        val old=async { model.load() }; t.pageEntered!!.await()
        t.first=page("list"); t.pageGate=null
        model.load(); gate.complete(Unit); old.await()
        assertEquals(3,model.state.value.entries.size); assertEquals("3",model.state.value.countSummary); assertNull(model.state.value.error)
    }
    @Test fun failedRemoveKeepsRowAndLateRemoveCannotReplaceRefreshOrGrantLoss() = runTest {
        val t = Transport(page("list"),page("nextPage"),page("afterRemove"),page("afterRemoveNextPage"))
        var current = true
        val model = AidenBotAllowedController(t.first.botId,t) { current }
        model.load(); val before = model.state.value.entries
        t.removeFailure=true; model.remove(before[0].id)
        assertEquals(before,model.state.value.entries); assertNotNull(model.state.value.error)
        t.gate=CompletableDeferred(); t.entered=CompletableDeferred()
        val answer = async { model.remove(before[0].id) }; t.entered!!.await()
        assertEquals(before,model.state.value.entries); assertEquals(before[0].id,model.state.value.removing)
        model.load(); t.gate!!.complete(Unit); answer.await()
        assertEquals(before,model.state.value.entries)
        current=false; model.invalidate(); assertNull(model.state.value.countSummary)
    }
    @Test fun realClientRoutesBodiesIdentityAndCapabilityNegotiation() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'),"test_credential_123",customOkHttpClient=OkHttpClient())
            val bot = page("list").botId
            server.enqueue(MockResponse().setBody(fixture.getValue("list").toString()))
            assertEquals(3,client.botAllowed(bot).entries.size)
            assertEquals("/api/aiden/v1/bots/$bot/allowed",server.takeRequest().path)
            val cursor = page("firstPage").nextCursor!!
            server.enqueue(MockResponse().setBody(fixture.getValue("list").toString()))
            client.botAllowed(bot,cursor)
            assertEquals("/api/aiden/v1/bots/$bot/allowed?cursor=$cursor",server.takeRequest().path)
            server.enqueue(MockResponse().setBody(fixture.getValue("remove").jsonObject.getValue("response").toString()))
            assertEquals(2,client.removeBotAllowed(bot,"allowed-rule-01").entries.size)
            val remove=server.takeRequest(); assertEquals("POST",remove.method); assertEquals("{}",remove.body.readUtf8())
            assertEquals("/api/aiden/v1/bots/$bot/allowed/allowed-rule-01/remove",remove.path)
            val base = listOf(AidenRemoteCapability.BOT_READ,AidenRemoteCapability.BOT_WRITE)
            fun mac(offered: List<AidenRemoteCapability>) = AidenServer(protocolVersion=1,instanceId="fixture-mac",name="Mac",capabilities=base,serverCapabilities=offered,features=emptyList(),connectionMode=AidenConnectionMode.LAN,serverTime=Instant.parse("2026-11-04T12:00:00Z"))
            val installation=AidenInstallation(instanceId="fixture-mac",endpoint="http://localhost:4141/api/aiden/v1",name="Mac",deviceId="fixture-phone",serverSpkiSha256="sha256/test",createdAt=Instant.parse("2026-11-04T12:00:00Z"),deviceCapabilities=base,serverCapabilities=base)
            assertNull(aidenRequestBotAllowed(client,mac(base),installation)); assertEquals(3,server.requestCount)
            for (status in listOf(400,404)) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("{\"error\":{\"code\":\"invalid_request\",\"message\":\"Unknown capability\",\"requestId\":\"test\",\"retryable\":false}}"))
                assertNull(aidenRequestBotAllowed(client,mac(base+AidenRemoteCapability.BOT_ALLOWED),installation))
                assertEquals("{\"accepts\":[\"bot:allowed\"]}",server.takeRequest().body.readUtf8())
            }
            val granted=base+AidenRemoteCapability.BOT_ALLOWED
            server.enqueue(MockResponse().setBody("{\"capabilities\":[\"bot:read\",\"bot:write\",\"bot:allowed\"]}"))
            server.enqueue(MockResponse().setBody(AidenBotWireJson.json.encodeToString(AidenServer.serializer(),mac(granted).copy(capabilities=granted))))
            val result=aidenRequestBotAllowed(client,mac(granted),installation)
            assertTrue(requireNotNull(result).granted!!.contains(AidenRemoteCapability.BOT_ALLOWED))
            assertEquals("{\"accepts\":[\"bot:allowed\"]}",server.takeRequest().body.readUtf8())
            assertEquals("/api/aiden/v1/server",server.takeRequest().path)
            assertTrue(aidenBotAllowedSupported(installation.copy(deviceCapabilities=granted,serverCapabilities=granted)))
            assertFalse(aidenBotAllowedSupported(installation.copy(serverCapabilities=granted)))
            assertThrows(AidenRemoteContractException.InvalidJson::class.java) { installation.copy(deviceCapabilities=granted,serverCapabilities=base) }
            assertNull(aidenRequestBotAllowed(client,mac(granted),installation,stillCurrent={false}))
        } finally { server.shutdown() }
    }
}
