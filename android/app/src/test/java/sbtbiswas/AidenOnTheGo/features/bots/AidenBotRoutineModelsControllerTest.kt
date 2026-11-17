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
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.*

class AidenBotRoutineModelsControllerTest {
    private class Host:AidenBotRoutineModelsTransport {
        var view=routineModelSettings().copy(revision="r1",selection=AidenRoutineModelSelection.Inherit,lastMutationId=null)
        var catalog=routineModelCatalog();var reads=0;var catalogs=0
        val writes=mutableListOf<AidenRoutineModelSave>()
        var read:suspend()->AidenRoutineModelSettings={view}
        var answer:suspend(AidenRoutineModelSave)->AidenRoutineModelResult={r->view=view.copy(revision="r2",selection=r.selection,lastMutationId=r.mutationId);AidenRoutineModelResult(true,view,r.mutationId,false)}
        override suspend fun settings():AidenRoutineModelSettings {reads++;return read()}
        override suspend fun catalog():AidenRoutineModelCatalog {catalogs++;return catalog}
        override suspend fun runs()=emptyList<AidenRoutineModelRun>()
        override suspend fun save(request:AidenRoutineModelSave):AidenRoutineModelResult {writes+=request;return answer(request)}
    }
    private fun journal(secure:InMemoryAidenSecureStore=InMemoryAidenSecureStore(),key:String="bot_model|routine|routine_model")=AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).journal("host","phone",Instant.EPOCH,key){true}
    private fun controller(host:Host,journal:AidenBotWatchJournal=journal(),write:()->Boolean={true},now:()->Long={1000})=AidenBotRoutineModelsController("bot_model","routine_model",host,{true},write,journal,{MODEL_NONCE},now)
    private val primary get()=routineModelSettings().selection.primary!!
    private val fallback get()=routineModelSettings().selection.fallback!!
    @Test fun modelAndThinkingSelectionAreExactAndFallbackRequiresAnExplicitChoice()=runTest {
        val host=Host();val c=controller(host);c.load()
        c.select(primary.copy(thinkingLevel=AidenRoutineThinkingLevel.MAX),false)
        assertEquals(AidenRoutineModelSelection.Inherit,c.state.value.draft);assertFalse(c.saveAllowed())
        c.select(primary,false);assertNull(c.state.value.draft!!.fallback)
        c.select(fallback,true);assertTrue(c.saveAllowed());c.save()
        assertEquals("provider_1",host.view.selection.primary!!.providerId);assertEquals("model_b",host.view.selection.fallback!!.modelId)
        assertEquals(AidenRoutineThinkingLevel.HIGH,host.view.selection.primary!!.thinkingLevel)
        assertEquals("r1",host.writes.single().expectedRevision)
        c.clearFallback();assertNull(c.state.value.draft!!.fallback)
        c.inherit();c.save();assertEquals(AidenRoutineModelMode.INHERIT,host.view.selection.mode)
        assertEquals(2,host.writes.size)
    }
    @Test fun unavailableFirstAndAnyLaterRefusalRetainExactPayloadAcrossProcessRestart()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore();val c=controller(host,journal(secure));c.load();c.select(primary,false)
        host.answer={AidenRoutineModelResult(false,code=AidenRoutineModelError.UNAVAILABLE,error="May have committed")};c.save()
        val frozen=host.writes.single();assertNotNull(c.state.value.pending)
        val restored=AidenBotRoutineModelsController("bot_model","routine_model",host,{true},{true},journal(secure),{error("A new identity is forbidden")},{1000})
        assertEquals(primary,restored.state.value.draft!!.primary)
        host.answer={throw AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req",false))};restored.retry()
        host.answer={AidenRoutineModelResult(false,code=AidenRoutineModelError.CONFLICT,error="Changed",settings=host.view.copy(revision="r3"))};restored.retry()
        restored.inherit();restored.save();assertEquals(3,host.writes.size)
        assertTrue(host.writes.all{it==frozen});assertNotNull(restored.state.value.pending)
        host.answer={r->AidenRoutineModelResult(true,host.view.copy(selection=r.selection,revision="r2",lastMutationId=r.mutationId),r.mutationId,true)}
        restored.retry();assertNull(restored.state.value.pending);assertEquals(primary,restored.state.value.settings!!.selection.primary)
    }
    @Test fun lostReplyIsSettledOnlyByMatchingLastMutationIdNeverChoiceOrRevisionMatching()=runTest {
        val host=Host();val c=controller(host);c.load();c.select(primary,false);host.answer={throw IOException("Lost")};c.save()
        val attempted=host.writes.single()
        host.view=host.view.copy(revision="r2",selection=attempted.selection,lastMutationId="33333333-3333-4333-8333-333333333333")
        c.load();assertNotNull(c.state.value.pending)
        host.view=host.view.copy(lastMutationId=attempted.mutationId);c.load()
        assertNull(c.state.value.pending);assertEquals(host.view.selection,c.state.value.draft);assertEquals(1,host.writes.size)
    }
    @Test fun definitiveFirstConflictPreservesDraftAndRequiresExplicitRevisionReview()=runTest {
        val host=Host();val c=controller(host);c.load();c.select(primary,false)
        host.view=host.view.copy(revision="r2",selection=AidenRoutineModelSelection(AidenRoutineModelMode.SELECTED,fallback))
        host.answer={AidenRoutineModelResult(false,settings=host.view,code=AidenRoutineModelError.CONFLICT,error="Changed")};c.save()
        assertNull(c.state.value.pending);assertTrue(c.state.value.needsReview);assertEquals(primary,c.state.value.draft!!.primary)
        c.save();assertEquals(1,host.writes.size)
        c.reviewKeepingDraft();assertTrue(c.saveAllowed());assertEquals("r2",c.state.value.baseline!!.revision)
        host.answer={r->AidenRoutineModelResult(true,host.view.copy(revision="r3",selection=r.selection,lastMutationId=r.mutationId),r.mutationId,false)};c.save()
        assertEquals("r2",host.writes.last().expectedRevision);assertEquals(primary,c.state.value.settings!!.selection.primary)
    }
    @Test fun liveRefreshKeepsDraftAndReadOnlyClientsNeverFetchCatalogOrWrite()=runTest {
        val host=Host();var writable=true;val c=controller(host,write={writable});c.load();c.select(primary,false)
        host.view=host.view.copy(revision="r2");c.load();assertTrue(c.state.value.needsReview);assertEquals(primary,c.state.value.draft!!.primary)
        writable=false;c.load();c.select(fallback,true);c.save();assertEquals(2,host.catalogs);assertTrue(host.writes.isEmpty());assertNull(c.state.value.catalog)
        val reads=host.reads;val job=launch{c.refreshWhileActive()};testScheduler.runCurrent();testScheduler.advanceTimeBy(15001);testScheduler.runCurrent()
        assertEquals(reads+2,host.reads);assertTrue(host.writes.isEmpty());job.cancelAndJoin()
        val after=host.reads;testScheduler.advanceTimeBy(30000);assertEquals(after,host.reads)
    }
    @Test fun failedDurableCommitCrossWindowCasAndPairingPurgeForbidTransmission()=runTest {
        val host=Host();val secure=InMemoryAidenSecureStore();val c=controller(host,journal(secure));val other=controller(host,journal(secure))
        c.load();other.load();assertEquals(AidenRoutineControlProblem.STORAGE,other.state.value.problem)
        c.select(primary,false);host.answer={throw IOException("Lost")};c.save()
        other.select(fallback,false);other.save();assertEquals(1,host.writes.size)
        AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).purge("host","phone",Instant.EPOCH)
        c.retry();assertEquals(1,host.writes.size);assertNull(c.state.value.pending);assertNull(c.state.value.draft);assertFalse(c.editable())
        val failed=controller(Host(),object:AidenBotWatchJournal{override fun read():String?=null;override fun write(record:String?){error("disk")}})
        failed.load();failed.select(primary,false);failed.save();assertEquals(AidenRoutineControlProblem.STORAGE,failed.state.value.problem)
    }
    @Test fun expiredUnknownRequestsStayFrozenWithoutNewSavesAndSlowReadsCannotOverwriteSavedReply()=runTest {
        val host=Host();var clock=1000L;val c=controller(host,now={clock});c.load();c.select(primary,false);host.answer={throw IOException("Lost")};c.save()
        clock+=24*60*60*1000L;c.retry();c.inherit();c.save()
        assertEquals(1,host.writes.size);assertNotNull(c.state.value.pending);assertEquals(AidenRoutineControlProblem.EXPIRED,c.state.value.problem)
        val fresh=Host();val d=controller(fresh);d.load();d.select(primary,false)
        val slow=CompletableDeferred<AidenRoutineModelSettings>();fresh.read={slow.await()};val job=launch{d.load()};testScheduler.runCurrent()
        d.save();slow.complete(fresh.view.copy(revision="old",selection=AidenRoutineModelSelection.Inherit));job.join()
        assertEquals("r2",d.state.value.settings!!.revision);assertEquals(primary,d.state.value.settings!!.selection.primary)
    }
}
