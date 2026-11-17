@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
package sbtbiswas.AidenOnTheGo.features.bots

import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.*

class AidenBotOpenWorkControllerTest {
    private class Host:AidenBotOpenWorkTransport {
        var view=openWorkSnapshot(); var reads=0; var readFailure=false
        val writes=mutableListOf<AidenOpenWorkMutation>()
        var answer:suspend(AidenOpenWorkMutation)->AidenOpenWorkResult={m->AidenOpenWorkResult(true,m.mutationId,false,m.id,view)}
        override suspend fun snapshot():AidenOpenWorkSnapshot {reads++;if(readFailure)throw IOException("Disconnected");return view}
        override suspend fun mutate(mutation:AidenOpenWorkMutation):AidenOpenWorkResult {writes+=mutation;return answer(mutation)}
        override suspend fun evidence(id:String,kind:AidenOpenWorkEvidenceKind)=AidenOpenWorkEvidence(id,kind,"9007199254740993123456","12","Owned evidence","Actual evidence text",false)
    }
    private fun journal(secure:InMemoryAidenSecureStore,paired:()->Boolean={true})=AidenBotWatchJournalStore(secure,"bot-open-work").journal("host","phone",Instant.EPOCH,"bot_fixture",paired)
    private fun controller(host:Host,secure:InMemoryAidenSecureStore=InMemoryAidenSecureStore(),now:()->Long={1000L},write:()->Boolean={true})=AidenBotOpenWorkController(host,{true},write,journal(secure),{OPEN_NONCE},now)
    @Test fun firstUnavailableAndLaterTypedOrHttpRefusalsKeepTheOriginalAttemptAcrossRestart()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore();val first=controller(host,secure)
        first.load();first.begin(host.view.items.single());first.edit{it.copy(title="Keep my words")}
        host.answer={AidenOpenWorkResult(false,code=AidenOpenWorkErrorCode.UNAVAILABLE,error="Publication may have committed.")}
        first.save();assertNotNull(first.state.value.pending)
        val restored=AidenBotOpenWorkController(host,{true},{true},journal(secure),{error("Must never mint a replacement UUID")},{1000L})
        assertEquals("Keep my words",restored.state.value.draft!!.title)
        host.answer={throw AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req_1",false))}
        restored.retry();assertNotNull(restored.state.value.pending)
        host.answer={AidenOpenWorkResult(false,code=AidenOpenWorkErrorCode.STALE,error="Changed",snapshot=host.view)}
        restored.retry();restored.state(host.view.items.single(),AidenOpenWorkState.DONE)
        assertEquals(3,host.writes.size)
        assertEquals(listOf(OPEN_NONCE,OPEN_NONCE,OPEN_NONCE),host.writes.map{it.mutationId})
        host.answer={m->AidenOpenWorkResult(true,m.mutationId,true,m.id,host.view)}
        restored.retry();assertNull(restored.state.value.pending);assertNull(restored.state.value.draft)
    }
    @Test fun exactUndoNonceSettlesOrdinaryWriteButNoContentMatchOrDisappearingUndoDoes()=runTest {
        val host=Host();val c=controller(host);c.load();c.begin();c.edit{it.copy(title="Task")}
        host.answer={throw IOException("Lost")};c.save();assertNotNull(c.state.value.pending)
        host.view=host.view.copy(items=listOf(host.view.items.single().copy(title="Task")))
        c.load();assertNotNull(c.state.value.pending)
        host.view=host.view.copy(undo=listOf(host.view.undo.single().copy(mutationId=OPEN_NONCE)))
        c.load();assertNull(c.state.value.pending)
        host.answer={throw IOException("Undo response lost")};c.undo(host.view.undo.single());assertNotNull(c.state.value.pending)
        host.view=host.view.copy(undo=emptyList());c.load();assertNotNull(c.state.value.pending)
    }
    @Test fun stopAndDismissWaitsForMatchingAcknowledgementIncludingEqualRevisionSnapshots()=runTest {
        val host=Host();val c=controller(host);c.load()
        host.answer={m->val stop=AidenOpenWorkStopReceipt(m.mutationId,AidenOpenWorkStopState.REQUESTED,1000);AidenOpenWorkResult(true,m.mutationId,false,m.id,host.view,stop=stop)}
        c.stop(host.view.items.single(),true)
        assertNotNull(c.state.value.pending);assertEquals(AidenOpenWorkState.OPEN,c.state.value.snapshot!!.items.single().state)
        host.view=host.view.copy(items=listOf(host.view.items.single().copy(execution=AidenOpenWorkExecution(AidenOpenWorkExecutionState.STOPPING,false),lastStop=AidenOpenWorkStopReceipt("33333333-3333-4333-8333-333333333333",AidenOpenWorkStopState.STOPPED,1000))))
        c.load();assertNotNull(c.state.value.pending)
        assertEquals(AidenOpenWorkExecutionState.STOPPING,c.state.value.snapshot!!.items.single().execution.state)
        host.view=host.view.copy(items=listOf(host.view.items.single().copy(state=AidenOpenWorkState.DISMISSED,lastStop=AidenOpenWorkStopReceipt(OPEN_NONCE,AidenOpenWorkStopState.STOPPED,1000,2000))))
        c.load();assertNull(c.state.value.pending);assertEquals(AidenOpenWorkState.DISMISSED,c.state.value.snapshot!!.items.single().state)
    }
    @Test fun blockedStopIsAnAcknowledgedRefusalAndLeavesWorkUnfinished()=runTest {
        val host=Host();val c=controller(host);c.load();host.answer={m->AidenOpenWorkResult(true,m.mutationId,false,m.id,host.view,stop=AidenOpenWorkStopReceipt(m.mutationId,AidenOpenWorkStopState.BLOCKED,1000,2000,AidenOpenWorkStopReason.MIXED_INPUTS))}
        c.stop(host.view.items.single(),true)
        assertNull(c.state.value.pending);assertEquals(AidenOpenWorkProblem.BLOCKED,c.state.value.problem)
        assertEquals(AidenOpenWorkState.OPEN,c.state.value.snapshot!!.items.single().state)
        host.view=host.view.copy(items=listOf(host.view.items.single().copy(execution=AidenOpenWorkExecution(AidenOpenWorkExecutionState.RUNNING,false,AidenOpenWorkBlockedReason.MIXED_INPUTS))))
        c.load();c.stop(host.view.items.single(),false);assertEquals(1,host.writes.size)
    }
    @Test fun staleFirstWriteKeepsDraftAndNeedsExplicitNewRevisionReview()=runTest {
        val host=Host();val c=controller(host);c.load();c.begin(host.view.items.single());c.edit{it.copy(title="My draft")}
        host.view=host.view.copy(items=listOf(host.view.items.single().copy(revision="item-3",title="Desktop words")),undo=emptyList())
        host.answer={AidenOpenWorkResult(false,code=AidenOpenWorkErrorCode.STALE,error="Changed",snapshot=host.view)}
        c.save();assertNull(c.state.value.pending);assertEquals("item-2",c.state.value.draft!!.expectedRevision)
        assertEquals("My draft",c.state.value.draft!!.title);c.useLatestRevision();assertEquals("item-3",c.state.value.draft!!.expectedRevision)
    }
    @Test fun restoredStopCanCheckAfter24HoursWhileOrdinaryUnknownCannot()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore();var clock=1000L
        val c=controller(host,secure,now={clock});c.load();host.answer={throw IOException("Lost")};c.stop(host.view.items.single(),false)
        clock+=48*60*60*1000L
        val restarted=controller(host,secure,now={clock});assertTrue(restarted.retryAllowed());restarted.retry();assertEquals(2,host.writes.size)
        val ordinaryHost=Host();val ordinary=controller(ordinaryHost,now={clock});ordinary.load();ordinaryHost.answer={throw IOException("Lost")};ordinary.state(ordinaryHost.view.items.single(),AidenOpenWorkState.DONE)
        clock+=24*60*60*1000L;ordinary.retry();assertEquals(1,ordinaryHost.writes.size);assertNotNull(ordinary.state.value.pending)
        assertEquals(AidenOpenWorkProblem.EXPIRED,ordinary.state.value.problem)
    }
    @Test fun durableCommitFailureAndCrossWindowClaimPreventAnyTransmission()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore()
        val first=controller(host,secure);val other=controller(host,secure)
        first.load();other.load();first.begin();first.edit{it.copy(title="One window")}
        host.answer={throw IOException("Lost")};first.save()
        other.begin();other.edit{it.copy(title="Other window")};other.save()
        assertEquals(1,host.writes.size);assertEquals(AidenOpenWorkProblem.STORAGE,other.state.value.problem)
        val unavailable=object:AidenBotWatchJournal{override fun read():String?=null;override fun write(record:String?){throw IOException("No secure storage")}}
        val blocked=AidenBotOpenWorkController(host,{true},{true},unavailable,{OPEN_NONCE})
        blocked.load();blocked.begin();blocked.edit{it.copy(title="Draft")};blocked.save();assertEquals(1,host.writes.size)
    }
    @Test fun foregroundReadsNeverResendPendingAndStopAfterLifecycleCancellation()=runTest {
        val host=Host();val c=controller(host);c.load();host.answer={throw IOException("Lost")};c.stop(host.view.items.single(),false)
        val refresh=launch{c.refreshWhileActive()};testScheduler.runCurrent();val reads=host.reads
        testScheduler.advanceTimeBy(15000);testScheduler.runCurrent();assertEquals(reads+1,host.reads);assertEquals(1,host.writes.size)
        refresh.cancelAndJoin();val stopped=host.reads;testScheduler.advanceTimeBy(30000);assertEquals(stopped,host.reads)
    }
    @Test fun anotherDevicesPendingStopBlocksAllNewItemChangesAndJournalWritesUntilAck()=runTest {
        val base=openWorkSnapshot().items.single()
        val anotherNonce="33333333-3333-4333-8333-333333333333"
        val pendingStates=listOf(
            base.copy(lastStop=AidenOpenWorkStopReceipt(anotherNonce,AidenOpenWorkStopState.REQUESTED,1000)),
            base.copy(lastStop=AidenOpenWorkStopReceipt(anotherNonce,AidenOpenWorkStopState.UNCERTAIN,1000)),
            base.copy(execution=AidenOpenWorkExecution(AidenOpenWorkExecutionState.STOPPING,false))
        )
        for(pendingItem in pendingStates) {
            val host=Host();var journalWrites=0;var saved:String?=null;var minted=0
            val journal=object:AidenBotWatchJournal {
                override fun read()=saved
                override fun write(record:String?){journalWrites++;saved=record}
            }
            val c=AidenBotOpenWorkController(host,{true},{true},journal,{minted++;OPEN_NONCE},{1000L})
            c.load();c.begin(base);c.edit{it.copy(title="Keep the already-open draft")}
            val before=journalWrites
            host.view=host.view.copy(items=listOf(pendingItem))
            c.load()
            c.begin(base);c.edit{it.copy(title="Must not replace the draft")};c.useLatestRevision();c.save()
            c.state(base,AidenOpenWorkState.DONE);c.state(base,AidenOpenWorkState.DISMISSED)
            c.stop(base,false);c.stop(base,true);c.undo(host.view.undo.single())
            assertTrue("no new mutation while another device's Stop is unresolved",host.writes.isEmpty())
            assertEquals("blocked actions cannot create a journal attempt",before,journalWrites)
            assertEquals("blocked actions cannot mint another UUID",0,minted)
            assertEquals("Keep the already-open draft",c.state.value.draft!!.title)
            assertNull(c.state.value.pending)
            host.view=host.view.copy(items=listOf(base.copy(execution=AidenOpenWorkExecution(AidenOpenWorkExecutionState.IDLE,false),
                lastStop=AidenOpenWorkStopReceipt(anotherNonce,AidenOpenWorkStopState.STOPPED,1000,2000))))
            c.load();c.save()
            assertEquals("acknowledgement allows the preserved draft to save",1,host.writes.size)
            assertEquals("Keep the already-open draft",host.writes.single().patch!!.title)
            assertEquals(1,minted)
        }
    }

    @Test fun readOnlyGuardsAndOwnedEvidenceRemainIndependentOfMutations()=runTest {
        val host=Host();val c=controller(host,write={false});c.load();c.begin();c.stop(host.view.items.single(),false)
        assertNull(c.state.value.draft);assertTrue(host.writes.isEmpty())
        c.evidence(host.view.items.single(),AidenOpenWorkEvidenceKind.SOURCE)
        assertEquals("Actual evidence text",c.state.value.evidence!!.text)
        assertEquals("9007199254740993123456",c.state.value.evidence!!.submissionId)
        c.closeEvidence();assertNull(c.state.value.evidence)
    }
}
