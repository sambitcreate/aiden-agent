package sbtbiswas.AidenOnTheGo.features.bots

import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Test
import org.junit.Assert.*
import sbtbiswas.AidenOnTheGo.*
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.*

@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotPeersControllerTest {
    private class Host:AidenBotPeersTransport {
        var settings=peerSettings().copy(lastMutationId=null);var catalog=peerCatalog();var detail=peerDetail("waiting").copy(state=AidenPeerExchangeState.RUNNING,lastStop=null)
        var reads=0;var catalogReads=0;var exchangeReads=0;var evidenceReads=0;var detailReads=0;val writes=mutableListOf<AidenPeerMutation>();val stops=mutableListOf<AidenPeerStopMutation>()
        var write:suspend(AidenPeerMutation)->AidenPeerMutationResult={throw IOException("reply lost")}
        var stopping:suspend(AidenPeerStopMutation)->AidenPeerStopResult={throw IOException("Stop reply lost")}
        var gate:CompletableDeferred<Unit>?=null
        override suspend fun settings():AidenPeerSettings{reads++;gate?.await();return settings}
        override suspend fun catalog():AidenPeerCatalog{catalogReads++;return catalog}
        override suspend fun mutate(request:AidenPeerMutation):AidenPeerMutationResult{writes+=request;return write(request)}
        override suspend fun exchanges():AidenPeerExchangeList{exchangeReads++;return AidenPeerExchangeList(settings.botId,"list",listOf(detail.copy(request=null,result=null)))}
        override suspend fun detail(id:String):AidenPeerExchange{detailReads++;return detail}
        override suspend fun stop(request:AidenPeerStopMutation):AidenPeerStopResult{stops+=request;return stopping(request)}
        override suspend fun evidence(exchange:AidenPeerExchange,kind:AidenOpenWorkEvidenceKind):AidenPeerEvidence{evidenceReads++;return AidenPeerEvidence(exchange.id,kind,if(kind==AidenOpenWorkEvidenceKind.SOURCE)exchange.sender.botId else exchange.recipient.botId,"9007199254740993","9007199254740995","Actual source","Source text 😀",false)}
    }
    private class Phone {
        val secure=InMemoryAidenSecureStore();val store=AidenBotWatchJournalStore(secure,"bot-peers",1088);val host=Host()
        var readable=true;var content=true;var writable=true;var clock=1000L;var nonces=0
        fun journal(key:String="bot_planner|settings")=store.journal("host","device",Instant.EPOCH,key){true}
        fun controller()=AidenBotPeersController("bot_planner",host,{readable},{readable && content},{writable},journal(),{id->journal("bot_planner|stop|$id")},{nonces++;"55555555-5555-4555-8555-${nonces.toString().padStart(12,'0')}"},{clock})
    }
    private fun denied()=AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req",false))
    @Test fun lostDescriptionRestartsExactUuidPayloadAcrossChangedCatalogPermissionAndLaterRefusal()=runTest {
        val p=Phone();val c=p.controller();c.load();c.setDraft("Owner routing only");c.saveDescription();assertEquals(1,p.nonces);assertNotNull(c.state.value.pending)
        val frozen=p.host.writes.single();val raw=p.journal().read();assertNotNull(raw)
        p.host.settings=p.host.settings.copy(revision="settings_new");p.host.catalog=p.host.catalog.copy(revision="catalog_new")
        val restored=p.controller();restored.load();assertEquals("Owner routing only",restored.state.value.draft);assertTrue(restored.state.value.needsReview)
        p.readable=false;restored.retry();assertEquals(1,p.host.writes.size);assertEquals(raw,p.journal().read())
        p.readable=true;p.writable=false;restored.retry();assertEquals(1,p.host.writes.size)
        p.writable=true;p.host.write={throw denied()};restored.retry();assertEquals(frozen,p.host.writes.last());assertNotNull(restored.state.value.pending)
        p.host.write={AidenPeerMutationResult(false,code=AidenPeerError.CONFLICT,error="Review current settings",snapshot=p.host.settings)};restored.retry();assertNotNull(restored.state.value.pending)
        restored.setDraft("new unrelated request");restored.saveDescription();assertEquals(1,p.nonces);assertEquals("Owner routing only",restored.state.value.draft)
        p.host.settings=p.host.settings.copy(lastMutationId=frozen.mutationId,routingDescription="Owner routing only");restored.load();assertNull(restored.state.value.pending);assertEquals("Owner routing only",restored.state.value.baseline!!.routingDescription)
    }
    @Test fun firstUnavailableOrTypedInFlightRetainsButFirstDefinitiveRefusalPermitsExplicitReview()=runTest {
        for(failure in listOf<Any>(AidenPeerError.UNAVAILABLE,AidenRemoteClientException.Server(409,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT,"In flight","req",false)))){
            val p=Phone();val c=p.controller();c.load();c.setDraft("Draft")
            p.host.write={if(failure is AidenPeerError)AidenPeerMutationResult(false,code=failure,error="Publication unconfirmed") else throw failure as Exception};c.saveDescription();assertNotNull(c.state.value.pending)
        }
        val p=Phone();val c=p.controller();c.load();c.setDraft("Draft");p.host.write={AidenPeerMutationResult(false,code=AidenPeerError.CONFLICT,error="Changed",snapshot=p.host.settings.copy(revision="next"))};c.saveDescription()
        assertNull(c.state.value.pending);assertTrue(c.state.value.needsReview);assertEquals("Draft",c.state.value.draft);assertFalse(c.saveAllowed())
        c.reviewKeepingDraft();assertEquals("next",c.state.value.baseline!!.revision);assertTrue(c.saveAllowed())
    }
    @Test fun approvalAndRevocationAreExplicitNamedReviewedRevisionsAndPreserveDescriptionDraft()=runTest {
        val p=Phone();p.host.settings=p.host.settings.copy(pairs=emptyList());val c=p.controller();c.load();c.setDraft("Unsaved owner description")
        val option=p.host.catalog.bots.single();c.approve(option,"old",p.host.catalog.revision);assertTrue(p.host.writes.isEmpty());assertEquals(0,p.nonces)
        p.host.write={r->AidenPeerMutationResult(true,r.mutationId,false,p.host.settings.copy(revision="approved",lastMutationId=r.mutationId,pairs=peerSettings().pairs))}
        c.approve(option,p.host.settings.revision,p.host.catalog.revision)
        val approved=p.host.writes.single();assertEquals(AidenPeerAction.APPROVE,approved.action);assertEquals("bot_researcher",approved.peerBotId);assertNull(approved.routingDescription)
        assertEquals("Unsaved owner description",c.state.value.draft)
        val pair=c.state.value.settings!!.pairs.single();c.revoke(pair.copy(revision="outdated"),"approved");assertEquals(1,p.host.writes.size)
        p.host.write={r->AidenPeerMutationResult(true,r.mutationId,false,c.state.value.settings!!.copy(revision="revoked",pairs=emptyList()))}
        c.revoke(pair,"approved");assertEquals(2,p.host.writes.size);assertEquals("pair_v1",p.host.writes.last().pairRevision);assertEquals("Unsaved owner description",c.state.value.draft)
    }
    @Test fun readOnlyMetadataCatalogNeedsNoChatAndRefreshNeverMutatesOrReadsEvidence()=runTest {
        val p=Phone();p.writable=false;p.content=false;val c=p.controller();c.load()
        assertNotNull(c.state.value.settings);assertNotNull(c.state.value.catalog);assertEquals(0,p.host.exchangeReads)
        c.setDraft("not permitted");c.saveDescription();c.approve(p.host.catalog.bots.single(),p.host.settings.revision,p.host.catalog.revision);c.openExchange("exchange_one")
        assertEquals(0,p.nonces);assertTrue(p.host.writes.isEmpty());assertTrue(p.host.stops.isEmpty())
        val active=launch{c.refreshWhileActive()};runCurrent();advanceTimeBy(30_001);runCurrent();active.cancelAndJoin();val reads=p.host.reads;advanceTimeBy(30_000);runCurrent();assertEquals(reads,p.host.reads)
        assertTrue(reads>=3);assertEquals(0,p.host.evidenceReads);assertTrue(p.host.writes.isEmpty())
    }
    @Test fun pairRetryCannotSilentlyRebaseDraftOverAnotherDevicesDescription()=runTest {
        val p=Phone();p.host.settings=p.host.settings.copy(pairs=emptyList());val c=p.controller();c.load();c.setDraft("My local draft")
        c.approve(p.host.catalog.bots.single(),p.host.settings.revision,p.host.catalog.revision)
        val frozen=p.host.writes.single();assertNotNull(c.state.value.pending)
        p.host.settings=p.host.settings.copy(revision="phone_description",routingDescription="Description from another phone",pairs=peerSettings().pairs,lastMutationId="99999999-9999-4999-8999-999999999999")
        p.host.write={AidenPeerMutationResult(true,frozen.mutationId,true,p.host.settings)}
        c.retry();assertNull(c.state.value.pending);assertEquals("My local draft",c.state.value.draft)
        assertTrue(c.state.value.needsReview);assertFalse(c.saveAllowed())
        c.saveDescription();assertEquals(2,p.host.writes.size)
        val restored=p.controller();restored.load();assertTrue(restored.state.value.needsReview);assertFalse(restored.saveAllowed());assertEquals("My local draft",restored.state.value.draft)
        restored.reviewKeepingDraft();p.host.write={r->AidenPeerMutationResult(true,r.mutationId,false,p.host.settings.copy(routingDescription=r.routingDescription!!,lastMutationId=r.mutationId))};restored.saveDescription()
        assertEquals("phone_description",p.host.writes.last().expectedRevision);assertEquals("My local draft",restored.state.value.settings!!.routingDescription)
    }
    @Test fun pendingStopRetainsSuccessReceiptAcrossRestartUntilMatchingTerminalAck()=runTest {
        val p=Phone();val c=p.controller();c.openExchange("exchange_one")
        p.host.stopping={r->AidenPeerStopResult(true,r.mutationId,false,p.host.detail.copy(state=AidenPeerExchangeState.STOPPING,lastStop=AidenPeerStopReceipt(r.mutationId,AidenPeerStopState.REQUESTED,p.clock)))}
        c.stop();assertNotNull(c.state.value.pendingStop);assertEquals(AidenRoutineControlProblem.UNCERTAIN,c.state.value.problem)
        val frozen=p.host.stops.single();assertEquals("exchange_v2",frozen.expectedRevision)
        val restored=p.controller();restored.openExchange("exchange_one");assertNotNull(restored.state.value.pendingStop);p.host.stopping={throw denied()};restored.retryStop();assertNotNull(restored.state.value.pendingStop);assertEquals(frozen,p.host.stops.last())
        restored.stop();assertEquals(2,p.host.stops.size);assertEquals(1,p.nonces)
        p.host.detail=p.host.detail.copy(lastStop=AidenPeerStopReceipt("99999999-9999-4999-8999-999999999999",AidenPeerStopState.STOPPED,p.clock));restored.load();assertNotNull(restored.state.value.pendingStop)
        p.host.detail=p.host.detail.copy(lastStop=AidenPeerStopReceipt(frozen.mutationId,AidenPeerStopState.BLOCKED,p.clock,AidenPeerStopReason.MIXED_INPUTS));restored.load();assertNull(restored.state.value.pendingStop);assertEquals(AidenPeerExchangeState.RUNNING,restored.state.value.detail!!.state);assertTrue(restored.state.value.message!!.contains("refused"))
        assertNull(p.journal("bot_planner|stop|exchange_one").read())
    }
    @Test fun expiredStopRetriesOnlyWithFreshMatchingProtectedPendingProofAndNeverReplacesIdentity()=runTest {
        val p=Phone();val c=p.controller();c.openExchange("exchange_one");c.stop();val frozen=p.host.stops.single()
        p.clock+=25*60*60*1000L
        c.retryStop();assertEquals(1,p.host.stops.size);assertEquals(AidenRoutineControlProblem.EXPIRED,c.state.value.problem)
        p.host.detail=p.host.detail.copy(lastStop=AidenPeerStopReceipt("99999999-9999-4999-8999-999999999999",AidenPeerStopState.REQUESTED,p.clock));c.retryStop();assertEquals(1,p.host.stops.size)
        p.host.detail=p.host.detail.copy(lastStop=AidenPeerStopReceipt(frozen.mutationId,AidenPeerStopState.UNCERTAIN,p.clock));c.retryStop();assertEquals(2,p.host.stops.size);assertEquals(frozen,p.host.stops.last());assertEquals(1,p.nonces)
        p.host.detail=p.host.detail.copy(lastStop=AidenPeerStopReceipt(frozen.mutationId,AidenPeerStopState.STOPPED,p.clock),state=AidenPeerExchangeState.CANCELLED);c.retryStop();assertEquals(2,p.host.stops.size);assertNull(c.state.value.pendingStop)
        assertTrue(p.host.detailReads>=5)
    }
    @Test fun otherDeviceStopBlocksNewNonceAndEqualRevisionRefreshAppliesNewExecution()=runTest {
        val p=Phone();p.host.detail=p.host.detail.copy(state=AidenPeerExchangeState.STOPPING,lastStop=AidenPeerStopReceipt(PEER_NONCE,AidenPeerStopState.REQUESTED,1000));val c=p.controller();c.openExchange("exchange_one");assertFalse(c.stopAllowed());c.stop();assertEquals(0,p.nonces)
        p.host.detail=p.host.detail.copy(state=AidenPeerExchangeState.RUNNING,lastStop=AidenPeerStopReceipt(PEER_NONCE,AidenPeerStopState.BLOCKED,1000,AidenPeerStopReason.MIXED_INPUTS));c.load();assertEquals(AidenPeerExchangeState.RUNNING,c.state.value.detail!!.state);assertTrue(c.stopAllowed())
        p.writable=false;c.stop();assertTrue(p.host.stops.isEmpty())
    }
    @Test fun actualEvidenceTextIsReadonlyAndLatePairingPurgeFencesHeldReplies()=runTest {
        val p=Phone();val c=p.controller();c.openExchange("exchange_one");c.showEvidence(AidenOpenWorkEvidenceKind.SOURCE);assertEquals("Source text 😀",c.state.value.evidence!!.text);assertEquals("9007199254740995",c.state.value.evidence!!.entryId);assertTrue(p.host.writes.isEmpty());assertTrue(p.host.stops.isEmpty())
        c.setDraft("Draft");p.host.write={r->delay(10);AidenPeerMutationResult(true,r.mutationId,false,p.host.settings.copy(routingDescription="Draft"))};val write=launch{c.saveDescription()};runCurrent()
        p.store.purgeBot("host","device",Instant.EPOCH,"bot_planner");assertNull(c.state.value.pending);assertNull(c.state.value.draft);advanceUntilIdle();write.join();assertNull(c.state.value.settings);assertNull(p.journal().read())
        c.load();c.stop();c.saveDescription();assertEquals(1,p.host.writes.size)
    }
    @Test fun storageFailureAndCompetingWindowCannotTransmitAndExpiryCannotMintReplacement()=runTest {
        val p=Phone();val one=p.controller();val two=p.controller();one.load();two.load();one.setDraft("First");two.setDraft("Second");two.saveDescription();assertTrue(p.host.writes.isEmpty());assertEquals(AidenRoutineControlProblem.STORAGE,two.state.value.problem)
        one.saveDescription();assertEquals(1,p.host.writes.size);p.clock+=AidenBotPeersController.RETRY_MS;one.retry();one.saveDescription();assertEquals(1,p.host.writes.size);assertEquals(1,p.nonces)
        val broken=object:AidenBotWatchJournal{override fun read():String?=null;override fun write(record:String?){throw IOException("disk full")}}
        val c=AidenBotPeersController("bot_planner",p.host,{true},{true},{true},broken,{broken});c.load();c.setDraft("No write");c.saveDescription();assertEquals(1,p.host.writes.size)
    }
    @Test fun firstTypedUnknownStopRestoresExactPayloadAndRejectsMalformedJournalWithoutPosting()=runTest {
        for(typed in listOf(true,false)){
            val p=Phone();val c=p.controller();c.openExchange("exchange_one")
            p.host.stopping={if(typed)AidenPeerStopResult(false,code=AidenPeerError.UNAVAILABLE,error="Stop publication is unconfirmed") else throw AidenRemoteClientException.Server(409,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT,"In flight","req",false))}
            c.stop();val frozen=p.host.stops.single();assertNotNull(c.state.value.pendingStop)
            val restored=p.controller();restored.openExchange("exchange_one");p.host.stopping={AidenPeerStopResult(false,code=AidenPeerError.NOT_FOUND,error="The exchange is unavailable")};restored.retryStop()
            assertEquals(frozen,p.host.stops.last());assertNotNull(restored.state.value.pendingStop);assertEquals(1,p.nonces)
        }
        val p=Phone();p.journal("bot_planner|stop|exchange_one").write("{malformed")
        val c=p.controller();c.openExchange("exchange_one");c.stop();c.retryStop();assertTrue(p.host.stops.isEmpty());assertEquals(0,p.nonces);assertEquals(AidenRoutineControlProblem.STORAGE,c.state.value.problem)
        assertEquals("{malformed",p.journal("bot_planner|stop|exchange_one").read())
    }

}
