package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*

internal fun routineModelFixture():JsonObject=requireNotNull(AidenBotRoutineModelsContractTest::class.java.classLoader?.getResourceAsStream("bot-routine-models.json")).bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
internal fun routineModelSettings()=AidenRoutineModelWire.decode(AidenRoutineModelSettings.serializer(),routineModelFixture().getValue("settings").toString())
internal fun routineModelCatalog()=AidenRoutineModelWire.decode(AidenRoutineModelCatalog.serializer(),routineModelFixture().getValue("catalog").toString())
internal const val COST_RECEIPT_A="cost_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
internal const val COST_RECEIPT_B="cost_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
internal const val MODEL_NONCE="9d70736e-eae9-4cad-a042-48f614d499d3"
class AidenBotRoutineModelsContractTest {
    @Test fun canonicalRevision56IncludesAllRoutineKindsExactRunIdsAndCostConsent() {
        val f=routineModelFixture();assertEquals(56,f.getValue("contractRevision").jsonPrimitive.int)
        val dir=AidenRoutineModelWire.decode(AidenRoutineModelDirectory.serializer(),f.getValue("directory").toString())
        assertEquals(listOf(AidenRoutineModelKind.SCHEDULED,AidenRoutineModelKind.EVENT,AidenRoutineModelKind.WATCH),dir.routines.map{it.kind})
        val settings=routineModelSettings();assertEquals(AidenRoutineThinkingLevel.HIGH,settings.selection.primary!!.thinkingLevel)
        assertEquals("provider_2",settings.selection.fallback!!.providerId)
        assertEquals(AidenRoutineModelMode.INHERIT,AidenRoutineModelWire.decode(AidenRoutineModelSettings.serializer(),f.getValue("inherit").toString()).selection.mode)
        val save=AidenRoutineModelWire.decode(AidenRoutineModelSave.serializer(),f.getValue("save").toString());assertEquals("model_settings_1",save.expectedRevision)
        assertTrue(AidenRoutineModelWire.decode(AidenRoutineModelResult.serializer(),f.getValue("result").toString()).ok)
        assertEquals(AidenRoutineModelError.CONFLICT,AidenRoutineModelWire.decode(AidenRoutineModelResult.serializer(),f.getValue("conflict").toString()).code)
        val run=AidenRoutineModelWire.runs(AidenRoutineModelWire.decode(ListSerializer(AidenRoutineModelRun.serializer()),f.getValue("runs").toString())).single()
        assertEquals("9007199254740993",run.submissionId);assertEquals("America/New_York",run.timezone)
        assertEquals(3601000L,run.startedAt!!-run.scheduledFor!!)
        assertEquals("Reasoner",run.model.chosenModelLabel);assertEquals("Writer",run.model.modelLabel)
        assertEquals("9007199254740993",AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),f.getValue("resumeStatus").toString()).interruptedSubmissionId)
        val resumeStatus=AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),f.getValue("resumeStatus").toString())
        assertEquals(COST_RECEIPT_A,resumeStatus.costReceiptId)
        val acknowledgement=AidenRoutineModelWire.decode(AidenBotResumeRequest.serializer(),f.getValue("resume").toString())
        assertEquals(true,acknowledgement.acknowledgeUnknownCost);assertEquals(COST_RECEIPT_A,acknowledgement.expectedCostReceiptId)
        assertEquals("{}",AidenBotWireJson.json.encodeToString(AidenBotResumeRequest.serializer(),AidenBotResumeRequest()))
    }
    @Test fun catalogOnlyAdmitsAvailableExactModelAndHostSupportedThinking() {
        val catalog=routineModelCatalog();val high=routineModelSettings().selection.primary!!
        assertTrue(catalog.admits(high));assertFalse(catalog.admits(high.copy(thinkingLevel=AidenRoutineThinkingLevel.MAX)))
        assertFalse(catalog.admits(high.copy(modelId="other")))
        assertFalse(catalog.copy(providers=catalog.providers.map{it.copy(available=false)}).admits(high))
        assertFalse(catalog.copy(providers=catalog.providers.map{it.copy(models=it.models.map{m->m.copy(available=false)})}).admits(high))
        assertTrue(runCatching{catalog.copy(providers=catalog.providers+catalog.providers.first())}.isFailure)
        assertTrue(runCatching{catalog.providers.first().models.first().copy(thinkingLevels=listOf(AidenRoutineThinkingLevel.HIGH,AidenRoutineThinkingLevel.HIGH))}.isFailure)
    }
    @Test fun strictLabelsIdsUnicodeNullsAndUnsafeNumbersAreRejected() {
        val catalog=routineModelCatalog();val provider=catalog.providers.first()
        assertEquals(320,provider.copy(label="😀".repeat(160)).label.length)
        listOf("😀".repeat(161),"bad\u0000text","bad\uD800","bad\uDC00").forEach { assertTrue(runCatching{provider.copy(label=it)}.isFailure) }
        listOf("bad/id","bad id","id".repeat(81)).forEach{assertTrue(runCatching{provider.copy(id=it)}.isFailure)}
        val raw=routineModelFixture().getValue("settings").jsonObject
        listOf(raw+("credentials" to JsonPrimitive("secret")),raw+("lastMutationId" to JsonNull),raw+("updatedAt" to JsonPrimitive("1793741400000")),raw+("updatedAt" to JsonPrimitive(9007199254740992L))).forEach {
            assertTrue(runCatching{AidenRoutineModelWire.decode(AidenRoutineModelSettings.serializer(),JsonObject(it).toString())}.isFailure)
        }
        val selected=raw.getValue("selection").jsonObject
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenRoutineModelSelection.serializer(),JsonObject(selected+("mode" to JsonPrimitive("inherit"))).toString())}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenRoutineModelCatalog.serializer(),routineModelFixture().getValue("catalog").toString().replace("true","\"true\""))}.isFailure)
    }
    @Test fun resumeRequiresExactPositiveDecimalStringAndPairedAcknowledgement() {
        listOf("0","01","-1","90071992547409931234567890123456789","other").forEach { id -> assertTrue(runCatching{AidenBotResumeStatus(true,id,COST_RECEIPT_A)}.isFailure) }
        assertTrue(runCatching{AidenBotResumeStatus(true)}.isFailure)
        assertTrue(runCatching{AidenBotResumeRequest(true)}.isFailure)
        assertTrue(runCatching{AidenBotResumeRequest(null,"12")}.isFailure)
        assertTrue(runCatching{AidenBotResumeRequest(false,"12")}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),"""{"requiresUnknownCostAcknowledgement":true,"interruptedSubmissionId":9007199254740993}""")}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),"""{"requiresUnknownCostAcknowledgement":"true","interruptedSubmissionId":"12"}""")}.isFailure)
    }
    @Test fun unknownCostStatusAndAcknowledgementRequireExactLowercaseReceiptTokenAndFalseForbidsIt() {
        val bad=listOf("", "cost_"+"a".repeat(63), "cost_"+"a".repeat(65), "cost_"+"A".repeat(64), "COST_"+"a".repeat(64), "cost_"+"z".repeat(64))
        for(token in bad) {
            assertTrue(runCatching{AidenBotResumeStatus(true,"12",token)}.isFailure)
            assertTrue(runCatching{AidenBotResumeRequest(true,"12",token)}.isFailure)
        }
        assertTrue(runCatching{AidenBotResumeStatus(false,"12",COST_RECEIPT_A)}.isFailure)
        assertTrue(runCatching{AidenBotResumeRequest(null,null,COST_RECEIPT_A)}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),"""{"requiresUnknownCostAcknowledgement":true,"interruptedSubmissionId":"12"}""")}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenBotResumeRequest.serializer(),"""{"acknowledgeUnknownCost":true,"expectedSubmissionId":"12"}""")}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.decode(AidenBotResumeStatus.serializer(),"""{"requiresUnknownCostAcknowledgement":true,"interruptedSubmissionId":"12","costReceiptId":null}""")}.isFailure)
    }
    @Test fun runsRemainBoundedAndScheduledFactsRequireValidTimezone() {
        val run=AidenRoutineModelWire.decode(ListSerializer(AidenRoutineModelRun.serializer()),routineModelFixture().getValue("runs").toString()).single()
        assertEquals(60L,sbtbiswas.AidenOnTheGo.features.bots.aidenRoutineRunDelayMinutes(run))
        assertNull(sbtbiswas.AidenOnTheGo.features.bots.aidenRoutineRunDelayMinutes(run.copy(startedAt=null)))
        assertNull(sbtbiswas.AidenOnTheGo.features.bots.aidenRoutineRunDelayMinutes(run.copy(startedAt=run.scheduledFor!!+30_000)))
        assertTrue(runCatching{run.copy(timezone=null)}.isFailure)
        assertTrue(runCatching{run.copy(timezone="MadeUp/Place")}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.runs(listOf(run,run))}.isFailure)
        assertTrue(runCatching{AidenRoutineModelWire.runs((1..65).map{run.copy(runId="run:$it")})}.isFailure)
    }
    @Test fun routineModelsNeedBothReadGrantsAndNegotiatedCapabilityWithoutNewPairingToken() {
        val caps=listOf(AidenRemoteCapability.BOT_ROUTINE_MODELS,AidenRemoteCapability.BOT_READ,AidenRemoteCapability.CHAT_READ)
        val host=AidenServer(instanceId="host",name="Host",capabilities=caps,serverCapabilities=caps)
        assertTrue(host.supportsBotRoutineModels)
        assertFalse(host.copy(capabilities=caps-AidenRemoteCapability.CHAT_READ).supportsBotRoutineModels)
        assertFalse(host.copy(capabilities=caps-AidenRemoteCapability.BOT_READ).supportsBotRoutineModels)
        assertFalse(host.copy(capabilities=caps-AidenRemoteCapability.BOT_ROUTINE_MODELS,serverCapabilities=caps-AidenRemoteCapability.BOT_ROUTINE_MODELS).supportsBotRoutineModels)
        assertTrue(AidenRemoteCapability.NEGOTIABLE.contains(AidenRemoteCapability.BOT_ROUTINE_MODELS))
        assertFalse(AidenRemoteCapability.V1_KNOWN.contains(AidenRemoteCapability.BOT_ROUTINE_MODELS))
    }
}
