package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*

internal fun openWorkFixture(): JsonObject = requireNotNull(AidenBotOpenWorkContractTest::class.java.classLoader?.getResourceAsStream("bot-open-work.json")).bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
internal fun openWorkSnapshot() = AidenBotWireJson.json.decodeFromJsonElement(AidenOpenWorkSnapshot.serializer(),openWorkFixture().getValue("snapshot"))
internal const val OPEN_NONCE="44444444-4444-4444-8444-444444444444"
class AidenBotOpenWorkContractTest {
    @Test fun canonicalRevision55DtosAndEveryMutationDecode() {
        val fixture=openWorkFixture(); val wire=AidenBotWireJson.json
        assertEquals(55,fixture.getValue("contractRevision").jsonPrimitive.int)
        assertEquals("bot:open-work",fixture.getValue("capability").jsonPrimitive.content)
        val snapshot=openWorkSnapshot()
        assertEquals("10",snapshot.items.single().source.submissionId)
        assertTrue(snapshot.items.single().execution.canStop)
        assertTrue(wire.decodeFromJsonElement(AidenOpenWorkResult.serializer(),fixture.getValue("result")).ok)
        assertEquals(AidenOpenWorkErrorCode.STALE,wire.decodeFromJsonElement(AidenOpenWorkResult.serializer(),fixture.getValue("stale")).code)
        assertEquals(AidenOpenWorkStopState.STOPPED,wire.decodeFromJsonElement(AidenOpenWorkStopReceipt.serializer(),fixture.getValue("stop")).state)
        assertEquals(AidenOpenWorkEvidenceKind.RESULT,wire.decodeFromJsonElement(AidenOpenWorkEvidence.serializer(),fixture.getValue("evidenceResult")).kind)
        fixture.getValue("mutations").jsonObject.values.forEach { assertNotNull(wire.decodeFromJsonElement(AidenOpenWorkMutation.serializer(),it)) }
    }
    @Test fun scalarAndUtf8BoundsRejectMalformedUnicodeAndClampWithoutSplitting() {
        val item=openWorkSnapshot().items.single()
        assertEquals(160,item.copy(title="😀".repeat(160)).title.codePointCount(0,320))
        assertTrue(runCatching{item.copy(title="😀".repeat(161))}.isFailure)
        assertEquals(2048,item.copy(note="😀".repeat(512)).note.toByteArray().size)
        assertTrue(runCatching{item.copy(note="😀".repeat(513))}.isFailure)
        assertTrue(runCatching{item.copy(note="€".repeat(683))}.isFailure)
        listOf("bad\u0000text","bad\uD800","bad\uDC00").forEach { assertTrue(runCatching{item.copy(title=it)}.isFailure) }
        assertEquals("€".repeat(682),AidenOpenWorkWire.clamp("€".repeat(683),1000,2048))
        assertEquals("😀".repeat(160),AidenOpenWorkWire.clamp("😀".repeat(161),160,640))
        assertEquals("good",AidenOpenWorkWire.clamp("good\uD800",160,640))
    }
    @Test fun waitingExecutionCapacityAndStrictFieldsAreValidated() {
        val snapshot=openWorkSnapshot(); val item=snapshot.items.single()
        assertTrue(runCatching{item.copy(state=AidenOpenWorkState.WAITING)}.isFailure)
        assertTrue(runCatching{AidenOpenWorkExecution(AidenOpenWorkExecutionState.IDLE,true)}.isFailure)
        assertTrue(runCatching{snapshot.copy(items=listOf(item,item))}.isFailure)
        assertTrue(runCatching{snapshot.copy(undo=listOf(snapshot.undo.single().copy(expectedRevision="other")))}.isFailure)
        val raw=AidenBotWireJson.json.encodeToJsonElement(AidenOpenWorkItem.serializer(),item).jsonObject
        listOf(raw+("path" to JsonPrimitive("/private")),raw+("createdAt" to JsonPrimitive("1793718000000"))).forEach { assertTrue(runCatching{AidenBotWireJson.json.decodeFromJsonElement(AidenOpenWorkItem.serializer(),JsonObject(it))}.isFailure) }
        assertTrue(runCatching{AidenOpenWorkMutation(OPEN_NONCE,AidenOpenWorkAction.ADD,"snapshot-1",id="invented",title="Task")}.isFailure)
    }
    @Test fun evidenceAndTranscriptIdentifiersStayExactAndBounded() {
        val raw=openWorkFixture().getValue("evidenceSource").jsonObject
        val large="9007199254740993123456"
        val evidence=AidenBotWireJson.json.decodeFromJsonElement(AidenOpenWorkEvidence.serializer(),JsonObject(raw+("submissionId" to JsonPrimitive(large))))
        assertEquals(large,evidence.submissionId)
        assertEquals(32768,evidence.copy(text="😀".repeat(8192)).text.toByteArray().size)
        assertTrue(runCatching{evidence.copy(text="😀".repeat(8193))}.isFailure)
        assertTrue(runCatching{AidenBotWireJson.json.decodeFromJsonElement(AidenOpenWorkEvidence.serializer(),JsonObject(raw+("entryId" to JsonPrimitive(12))))}.isFailure)
    }
    @Test fun privacyAllowsOnlyOwnedCompletionMetadataAndRejectsCredentials() {
        val item=openWorkSnapshot().items.single().copy(state=AidenOpenWorkState.DONE,completion=AidenOpenWorkCompletion(AidenOpenWorkCompletedBy.BOT,1,AidenOpenWorkSubmission("10","12")))
        val snapshot=openWorkSnapshot().copy(items=listOf(item))
        val wire=AidenBotWireJson.json
        AidenBotPrivateResponseValidator.validate(wire.encodeToString(AidenOpenWorkSnapshot.serializer(),snapshot),AidenBotPrivateResponseScope.Root("botOpenWork"))
        assertTrue(runCatching{AidenBotPrivateResponseValidator.validate("""{"result":{"secret":"private"}}""",AidenBotPrivateResponseScope.Root("botOpenWork"))}.isFailure)
    }
    @Test fun openWorkNeedsChatReadBotReadAndNegotiatedCapability() {
        val grants=listOf(AidenRemoteCapability.BOT_OPEN_WORK,AidenRemoteCapability.BOT_READ,AidenRemoteCapability.CHAT_READ)
        val server=AidenServer(instanceId="host",name="Host",capabilities=grants,serverCapabilities=grants)
        assertTrue(server.supportsBotOpenWork)
        assertFalse(server.copy(capabilities=grants-AidenRemoteCapability.CHAT_READ).supportsBotOpenWork)
        assertFalse(server.copy(capabilities=grants-AidenRemoteCapability.BOT_OPEN_WORK).supportsBotOpenWork)
        assertFalse(AidenServer(instanceId="old",name="Old",capabilities=listOf(AidenRemoteCapability.BOT_READ)).supportsBotOpenWork)
    }
}
