package sbtbiswas.AidenOnTheGo

import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotRoutineModels

class AidenBotRoutineModelsClientTest {
    private lateinit var server:MockWebServer;private lateinit var client:AidenRemoteClient
    @Before fun setup(){server=MockWebServer();server.start();client=AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'),"test-credential",OkHttpClient.Builder().build())}
    @After fun close(){server.shutdown()}
    private fun ok(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(value.toString())
    @Test fun exactBareRoutesDirectoryReadCatalogRunsSaveAndResumeCostAcknowledgement()=runBlocking {
        val f=routineModelFixture();server.enqueue(ok(f.getValue("directory")))
        assertEquals(3,client.botRoutineModelDirectory("bot_model").routines.size);assertEquals("/api/aiden/v1/bots/bot_model/routine-models",server.takeRequest().path)
        server.enqueue(ok(f.getValue("settings")));assertEquals("model_settings_2",client.botRoutineModelSettings("bot_model","routine_model").revision)
        assertEquals("/api/aiden/v1/bots/bot_model/routine-models/routine_model",server.takeRequest().path)
        server.enqueue(ok(f.getValue("catalog")));assertEquals(2,client.botRoutineModelCatalog("bot_model","routine_model").providers.size)
        assertTrue(server.takeRequest().path!!.endsWith("/catalog"))
        server.enqueue(ok(f.getValue("runs")));assertEquals("9007199254740993",client.botRoutineModelRuns("bot_model","routine_model").single().submissionId)
        assertTrue(server.takeRequest().path!!.endsWith("/runs"))
        val request=AidenRoutineModelWire.decode(AidenRoutineModelSave.serializer(),f.getValue("save").toString())
        server.enqueue(ok(f.getValue("conflict")));assertFalse(client.saveBotRoutineModel(request).ok)
        val post=server.takeRequest();assertEquals("POST",post.method)
        val body=Json.parseToJsonElement(post.body.readUtf8()).jsonObject
        assertEquals(setOf("botId","routineId","mutationId","expectedRevision","catalogRevision","selection"),body.keys)
        assertEquals("model_settings_1",body.getValue("expectedRevision").jsonPrimitive.content)
        server.enqueue(ok(f.getValue("resumeStatus")));assertEquals("9007199254740993",client.botRoutineResumeStatus("bot_model").interruptedSubmissionId)
        assertEquals("/api/aiden/v1/bots/bot_model/routine-resume-status",server.takeRequest().path)
        server.enqueue(MockResponse().setBody("""{"state":"running","interrupted":false}"""))
        client.resumeBotSession("bot_model",UUID.fromString(MODEL_NONCE),AidenBotResumeRequest(true,"9007199254740993",COST_RECEIPT_A))
        val resume=server.takeRequest();assertEquals("/api/aiden/v1/bots/bot_model/resume",resume.path)
        assertEquals(MODEL_NONCE,resume.getHeader("Idempotency-Key"));val acknowledgement=Json.parseToJsonElement(resume.body.readUtf8()).jsonObject
        assertEquals(setOf("acknowledgeUnknownCost","expectedSubmissionId","expectedCostReceiptId"),acknowledgement.keys)
        assertEquals("9007199254740993",acknowledgement.getValue("expectedSubmissionId").jsonPrimitive.content)
        assertEquals(COST_RECEIPT_A,acknowledgement.getValue("expectedCostReceiptId").jsonPrimitive.content)
        server.enqueue(MockResponse().setBody("""{"state":"running","interrupted":false}"""));client.resumeBotSession("bot_model",UUID.randomUUID())
        assertEquals("{}",server.takeRequest().body.readUtf8())
    }
    @Test fun lostWritesNeverAutomaticallyRetryAndCrossBotOrNonceRepliesAreRejected()=runBlocking {
        val f=routineModelFixture();val request=AidenRoutineModelWire.decode(AidenRoutineModelSave.serializer(),f.getValue("save").toString())
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        assertTrue(runCatching{client.saveBotRoutineModel(request)}.isFailure);assertEquals(1,server.requestCount);server.takeRequest()
        server.enqueue(ok(f.getValue("settings")));assertTrue(runCatching{client.botRoutineModelSettings("other_bot","routine_model")}.isFailure);server.takeRequest()
        server.enqueue(ok(f.getValue("result")));assertTrue(runCatching{client.saveBotRoutineModel(request.copy(mutationId="33333333-3333-4333-8333-333333333333"))}.isFailure);server.takeRequest()
        server.enqueue(ok(JsonObject(f.getValue("catalog").jsonObject+("credentials" to JsonPrimitive("private")))))
        assertTrue(runCatching{client.botRoutineModelCatalog("bot_model","routine_model")}.isFailure)
    }
    @Test fun unsafeResumeSourcesAndOversizedResponsesAreRejected()=runBlocking {
        server.enqueue(MockResponse().setBody("""{"requiresUnknownCostAcknowledgement":true,"interruptedSubmissionId":9007199254740993}"""))
        assertTrue(runCatching{client.botRoutineResumeStatus("bot_model")}.isFailure)
        server.enqueue(MockResponse().setBody(" ".repeat(900*1024+1)))
        assertTrue(runCatching{client.botRoutineModelDirectory("bot_model")}.isFailure)
    }
    @Test fun malformedOrMissingCostReceiptIsRejectedAndUnknownTyped409RemainsAmbiguous()=runBlocking {
        val base=routineModelFixture().getValue("resumeStatus").jsonObject
        for(row in listOf(base-"costReceiptId",base+("costReceiptId" to JsonPrimitive("cost_bad")),base+("requiresUnknownCostAcknowledgement" to JsonPrimitive(false)))) {
            server.enqueue(ok(JsonObject(row)))
            assertTrue(runCatching{client.botRoutineResumeStatus("bot_model")}.isFailure);server.takeRequest()
        }
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"new_resume_recovery","message":"Outcome is unknown","requestId":"req_1","retryable":false}}"""))
        val failure=runCatching{client.resumeBotSession("bot_model",UUID.fromString(MODEL_NONCE),AidenBotResumeRequest(true,"9007199254740993",COST_RECEIPT_A))}.exceptionOrNull()
        assertTrue(failure is sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException.Server)
        failure as sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException.Server
        assertEquals(409,failure.statusCode)
        // The established Remote codec normalizes an unknown code; it remains an unknown outcome.
        assertEquals(sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode.INTERNAL_ERROR,failure.body.code);assertFalse(failure.body.retryable)
        assertTrue(sbtbiswas.AidenOnTheGo.features.bots.aidenBotResumeFailureIsAmbiguous(failure))
        val body=Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(COST_RECEIPT_A,body.getValue("expectedCostReceiptId").jsonPrimitive.content)
        assertEquals(4,server.requestCount)
    }
    @Test fun modelCapabilityNegotiatesAloneAndOlderHostsKeepTheirExistingGrants()=runBlocking {
        val base=listOf(AidenRemoteCapability.BOT_READ,AidenRemoteCapability.BOT_WRITE,AidenRemoteCapability.CHAT_READ)
        val installation=AidenInstallation(instanceId="test",deviceId="phone",name="Host",endpoint=server.url("/api/aiden/v1").toString(),serverSpkiSha256="sha256/test",deviceCapabilities=base,serverCapabilities=base,createdAt=Instant.EPOCH)
        val old=AidenServer(instanceId="test",name="Host",capabilities=base,serverCapabilities=base)
        assertNull(aidenRequestBotRoutineModels(client,old,installation));assertEquals(0,server.requestCount)
        val offered=old.copy(serverCapabilities=base+AidenRemoteCapability.BOT_ROUTINE_MODELS);val names=JsonArray((base+AidenRemoteCapability.BOT_ROUTINE_MODELS).map{JsonPrimitive(it.rawValue)})
        server.enqueue(ok(buildJsonObject{put("capabilities",names)}));server.enqueue(ok(buildJsonObject{put("instanceId","test");put("name","Host");put("capabilities",names);put("serverCapabilities",names)}))
        assertTrue(requireNotNull(aidenRequestBotRoutineModels(client,offered,installation)).server.supportsBotRoutineModels)
        assertEquals(listOf("bot:routine-models"),Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map{it.jsonPrimitive.content});server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":"invalid_request","message":"Unsupported","requestId":"req_1","retryable":false}}"""))
        assertNull(aidenRequestBotRoutineModels(client,offered,installation))
    }
}
