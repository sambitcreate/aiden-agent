package sbtbiswas.AidenOnTheGo.features.bots

import java.io.IOException
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.COST_RECEIPT_A
import sbtbiswas.AidenOnTheGo.COST_RECEIPT_B
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.*

class AidenBotResumeControllerTest {
    private val nonce=UUID.fromString("44444444-4444-4444-8444-444444444444")
    private val source="90071992547409931234567890123456"
    private class Host:AidenBotResumeTransport {
        var view=AidenBotResumeStatus(false);var reads=0
        val writes=mutableListOf<Pair<UUID,AidenBotResumeRequest>>()
        var statusAnswer:suspend()->AidenBotResumeStatus={view}
        var answer:suspend()->AidenBotSessionStateView={AidenBotSessionStateView(AidenBotSessionState.RUNNING,false)}
        override suspend fun status():AidenBotResumeStatus{reads++;return statusAnswer()}
        override suspend fun resume(key:UUID,request:AidenBotResumeRequest):AidenBotSessionStateView{writes+=key to request;return answer()}
    }
    private fun journal(secure:InMemoryAidenSecureStore=InMemoryAidenSecureStore())=AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).journal("host","phone",Instant.EPOCH,"bot|resume"){true}
    private fun controller(host:Host,journal:AidenBotWatchJournal=journal(),supported:()->Boolean={true},version:()->String={"v1"},may:()->Boolean={true},now:()->Long={1000})=AidenBotResumeController(host,may,supported,version,journal,{nonce},now)
    @Test fun preflightIsPassiveAndPositiveUnknownCostRequiresExactExplicitConsent()=runTest {
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A);val c=controller(host)
        assertEquals(0,host.reads);assertTrue(host.writes.isEmpty());assertNull(c.request())
        assertEquals(1,host.reads);assertTrue(host.writes.isEmpty());assertEquals(source,c.state.value.consentSubmissionId)
        assertEquals(AidenBotSessionState.RUNNING,c.confirm()!!.state)
        assertEquals(nonce,host.writes.single().first);assertEquals(source,host.writes.single().second.expectedSubmissionId)
        assertEquals(COST_RECEIPT_A,host.writes.single().second.expectedCostReceiptId);assertEquals(true,host.writes.single().second.acknowledgeUnknownCost);assertNull(c.state.value.pending)
    }
    @Test fun staleConsentOrPreflightCannotAuthorizeNewInterruptedSubmission()=runTest {
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A);var version="v1";val c=controller(host,version={version})
        c.request();version="v2";assertNull(c.confirm());assertTrue(host.writes.isEmpty());assertNull(c.state.value.consentSubmissionId)
        host.view=AidenBotResumeStatus(true,"12",COST_RECEIPT_A);c.request();assertEquals("12",c.state.value.consentSubmissionId)
        c.cancelConsent();assertTrue(host.writes.isEmpty())
        val gate=CompletableDeferred<AidenBotResumeStatus>();host.statusAnswer={gate.await()};val job=launch{c.request()}
        testScheduler.runCurrent();version="v3";gate.complete(AidenBotResumeStatus(true,"13",COST_RECEIPT_A));job.join()
        assertNull(c.state.value.consentSubmissionId);assertTrue(host.writes.isEmpty())
    }
    @Test fun delayedOrdinaryPreflightCannotResumeAfterSessionChangesOrForegroundRelease()=runTest {
        for(changeSession in listOf(true,false)) {
            val host=Host();val gate=CompletableDeferred<AidenBotResumeStatus>();host.statusAnswer={gate.await()}
            var version="workA";var active=true
            val c=controller(host,version={version},may={active})
            val job=launch{c.request()};testScheduler.runCurrent()
            if(changeSession)version="workB" else active=false
            gate.complete(AidenBotResumeStatus(false,"12"));job.join()
            assertTrue(host.writes.isEmpty());assertNull(c.state.value.pending);assertNull(c.state.value.consentSubmissionId)
        }
    }
    @Test fun costConsentCannotSurviveBackgroundAndReturnToAnotherForegroundVisit()=runTest {
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A)
        var active=true;var visit="visit1";val c=controller(host,version={visit},may={active})
        c.request();assertEquals(source,c.state.value.consentSubmissionId)
        active=false;visit="visit2";active=true
        assertNull(c.confirm());assertTrue(host.writes.isEmpty());assertNull(c.state.value.pending)
    }
    @Test fun lostConfirmedResumeRestoresExactUuidAndConsentAcrossRestartAndLaterDenial()=runTest {
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A);val secure=InMemoryAidenSecureStore();val c=controller(host,journal(secure))
        c.request();host.answer={throw IOException("Response lost")};c.confirm();assertNotNull(c.state.value.pending)
        val restored=AidenBotResumeController(host,{true},{true},{"v9"},journal(secure),{error("Cannot mint another identity")},{1000})
        host.view=AidenBotResumeStatus(true,"12",COST_RECEIPT_A)
        host.answer={throw AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req",false))}
        restored.request();assertNotNull(restored.state.value.pending);assertEquals(1,host.reads)
        host.answer={AidenBotSessionStateView(AidenBotSessionState.RUNNING,false)};assertNotNull(restored.request())
        assertEquals(3,host.writes.size);assertTrue(host.writes.all{it.first==nonce && it.second.expectedSubmissionId==source && it.second.acknowledgeUnknownCost==true && it.second.expectedCostReceiptId==COST_RECEIPT_A})
        assertNull(restored.state.value.pending)
    }
    @Test fun sameSubmissionWithNewCostReceiptRejectsUnsubmittedOldConsentUntilFreshReview()=runTest {
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A)
        val keys=ArrayDeque(listOf(nonce,UUID.fromString("55555555-5555-4555-8555-555555555555")))
        val c=AidenBotResumeController(host,{true},{true},{"same visible submission"},journal(),{keys.removeFirst()},{1000})
        c.request();assertEquals(COST_RECEIPT_A,c.state.value.consentCostReceiptId)
        // Another device acknowledged A and caused a new unknown receipt B for the same input.
        host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_B)
        var accepted=0
        host.answer={
            if(host.writes.last().second.expectedCostReceiptId!=COST_RECEIPT_B)
                throw AidenRemoteClientException.Server(409,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.OPERATION_STALE,"Review the current cost receipt","req",false))
            accepted++;AidenBotSessionStateView(AidenBotSessionState.RUNNING,false)
        }
        assertNull(c.confirm());assertEquals(0,accepted);assertEquals(1,host.reads)
        assertEquals(COST_RECEIPT_A,host.writes.single().second.expectedCostReceiptId);assertNull(c.state.value.pending)
        c.request();assertEquals(COST_RECEIPT_B,c.state.value.consentCostReceiptId);assertNotNull(c.confirm())
        assertEquals(1,accepted);assertEquals(2,host.reads);assertEquals(COST_RECEIPT_B,host.writes.last().second.expectedCostReceiptId)
        assertNotEquals(host.writes.first().first,host.writes.last().first)
    }
    @Test fun firstTypedUnknownOutcomeRetainsExactReceiptUuidAcrossRestartCapabilityLossAndLaterRefusal()=runTest {
        for((status,code,retryable) in listOf(Triple(409,"idempotency_in_flight",false),Triple(409,"idempotency_in_flight",true),
            Triple(409,"internal_error",false),Triple(409,"new_resume_recovery",true),Triple(400,"outcome_unknown",false))) {
            val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A)
            val secure=InMemoryAidenSecureStore();val c=controller(host,journal(secure));c.request()
            host.answer={throw AidenRemoteClientException.Server(status,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode(code),"Outcome not safely recorded","req",retryable))}
            c.confirm();assertEquals(nonce.toString(),c.state.value.pending!!.key)
            assertEquals(COST_RECEIPT_A,c.state.value.pending!!.request.expectedCostReceiptId)
            var supported=false;var active=true;var visit="after restart"
            val restored=AidenBotResumeController(host,{active},{supported},{visit},journal(secure),{error("Never replace an unknown UUID")},{1000})
            host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_B)
            restored.request();assertEquals(1,host.writes.size);assertNotNull(restored.state.value.pending)
            supported=true;active=false;visit="background";restored.request();assertEquals(1,host.writes.size)
            active=true;visit="next foreground"
            host.answer={throw AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Refused","req",false))}
            restored.request();assertNotNull(restored.state.value.pending)
            host.answer={AidenBotSessionStateView(AidenBotSessionState.RUNNING,false)};assertNotNull(restored.request())
            assertEquals(1,host.reads);assertEquals(3,host.writes.size)
            assertTrue(host.writes.all{it.first==nonce && it.second.expectedSubmissionId==source && it.second.expectedCostReceiptId==COST_RECEIPT_A})
            assertNull(restored.state.value.pending);assertNull(journal(secure).read())
        }
    }
    @Test fun oldOrMalformedAcknowledgedJournalFailsClosedWhileOldOrdinaryRequestRemainsReplayable()=runTest {
        for(receipt in listOf("",",\"expectedCostReceiptId\":\"bad\"",",\"expectedCostReceiptId\":null")) {
            val host=Host();val disk=journal()
            val raw="""{"key":"$nonce","request":{"acknowledgeUnknownCost":true,"expectedSubmissionId":"$source"$receipt},"startedAt":1000}"""
            disk.write(raw);val restored=controller(host,disk);restored.request();restored.confirm()
            assertEquals(AidenRoutineControlProblem.STORAGE,restored.state.value.problem)
            assertEquals(0,host.reads);assertTrue(host.writes.isEmpty());assertEquals(raw,disk.read())
        }
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_B);val disk=journal()
        disk.write("""{"key":"$nonce","request":{},"startedAt":1000}""")
        val ordinary=controller(host,disk);assertNotNull(ordinary.request())
        assertEquals(0,host.reads);assertEquals(nonce,host.writes.single().first);assertEquals(AidenBotResumeRequest(),host.writes.single().second)
    }
    @Test fun capabilityLossDuringPreflightOrBeforeConfirmationNeverPostsOrUpgradesConsent()=runTest {
        for(needsConsent in listOf(true,false)) {
            val host=Host();val gate=CompletableDeferred<AidenBotResumeStatus>();host.statusAnswer={gate.await()}
            var supported=true;val c=controller(host,supported={supported})
            val request=launch{c.request()};testScheduler.runCurrent();supported=false
            gate.complete(if(needsConsent)AidenBotResumeStatus(true,source,COST_RECEIPT_A) else AidenBotResumeStatus(false,source));request.join()
            assertTrue(host.writes.isEmpty());assertNull(c.state.value.pending);assertNull(c.state.value.consentCostReceiptId)
        }
        val host=Host();host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A);var supported=true
        val c=controller(host,supported={supported});c.request();supported=false;c.confirm()
        assertTrue(host.writes.isEmpty());assertNull(c.state.value.pending);assertNull(c.state.value.consentCostReceiptId)
    }
    @Test fun ordinaryResumeRetainsEmptyBodyWhenCapabilityArrivesDuringUnknownOutcome()=runTest {
        val host=Host();var supported=false;val c=controller(host,supported={supported})
        host.answer={throw IOException("Lost")};c.request();assertEquals(0,host.reads)
        supported=true;host.view=AidenBotResumeStatus(true,source,COST_RECEIPT_A);c.request()
        assertEquals(0,host.reads);assertEquals(2,host.writes.size);assertTrue(host.writes.all{it.second==AidenBotResumeRequest()})
        assertNull(c.state.value.consentSubmissionId)
    }
    @Test fun unknownRequestsExpireWithoutNewIdentityAndPairingPurgeFencesStaleControllers()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore();var time=1000L;val c=controller(host,journal(secure),now={time})
        host.answer={throw IOException("Lost")};c.request();time+=24*60*60*1000L;c.request()
        assertEquals(1,host.writes.size);assertNotNull(c.state.value.pending);assertEquals(AidenRoutineControlProblem.EXPIRED,c.state.value.problem)
        AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).purge("host","phone",Instant.EPOCH)
        val restored=controller(host,journal(secure));assertNull(restored.state.value.pending)
        restored.request();assertEquals(1,host.writes.size);assertNull(restored.state.value.pending)
    }
    @Test fun firstDefinitiveDenialClearsButStorageFailureAndSecondWindowForbidTransmission()=runTest {
        val host=Host();host.answer={throw AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req",false))}
        val c=controller(host);c.request();assertNull(c.state.value.pending);assertEquals(AidenRoutineControlProblem.FAILED,c.state.value.problem)
        val secure=InMemoryAidenSecureStore();val one=controller(host,journal(secure));val two=controller(host,journal(secure))
        host.answer={throw IOException("Lost")};one.request();two.request()
        assertEquals(2,host.writes.size);assertEquals(AidenRoutineControlProblem.STORAGE,two.state.value.problem)
        val failed=controller(host,object:AidenBotWatchJournal{override fun read():String?=null;override fun write(record:String?){error("disk")}})
        failed.request();assertEquals(2,host.writes.size);assertEquals(AidenRoutineControlProblem.STORAGE,failed.state.value.problem)
    }
    @Test fun failedPreflightAndReadOnlyAccessNeverSendResume()=runTest {
        val host=Host();val c=controller(host);host.statusAnswer={throw IOException("Offline")};assertNull(c.request());assertTrue(host.writes.isEmpty());assertNull(c.state.value.pending)
        val readOnly=controller(host,may={false});readOnly.request();readOnly.confirm();assertEquals(1,host.reads);assertTrue(host.writes.isEmpty())
    }
}
