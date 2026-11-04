@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
package sbtbiswas.AidenOnTheGo

import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.resetMain
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.bots.*
import sbtbiswas.AidenOnTheGo.features.remote.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.*

/** Exercises the same accepted-delete coordinator path that Profile and chat invoke. */
class AidenBotRoutineDeletionTest {
    @get:Rule val temp=TemporaryFolder()
    private class Host(botId:String="bot_model"):AidenBotRoutineModelsTransport,AidenBotResumeTransport {
        val initial=routineModelSettings().copy(botId=botId,revision="r1",selection=AidenRoutineModelSelection.Inherit,lastMutationId=null)
        var modelWrites=0;var resumes=0
        var saveGate:CompletableDeferred<Unit>?=null;var resumeGate:CompletableDeferred<Unit>?=null
        override suspend fun settings()=initial
        override suspend fun catalog()=routineModelCatalog()
        override suspend fun runs()=emptyList<AidenRoutineModelRun>()
        override suspend fun save(request:AidenRoutineModelSave):AidenRoutineModelResult {
            modelWrites++;val gate=saveGate ?: throw IOException("Lost model reply")
            gate.await()
            return AidenRoutineModelResult(true,initial.copy(revision="r2",selection=request.selection,lastMutationId=request.mutationId),request.mutationId,true)
        }
        override suspend fun status()=AidenBotResumeStatus(false)
        override suspend fun resume(key:UUID,request:AidenBotResumeRequest):AidenBotSessionStateView {
            resumes++;val gate=resumeGate ?: throw IOException("Lost Resume reply")
            gate.await();return AidenBotSessionStateView(AidenBotSessionState.RUNNING,false)
        }
    }
    private fun pairing(instance:String="host",device:String="device")=AidenPairingExchange(instanceId=instance,deviceId=device,
        endpoint="https://$instance.test/api/aiden/v1",serverSpkiSha256="sha256/test",credential="test-credential",
        capabilities=listOf(AidenRemoteCapability.BOT_READ,AidenRemoteCapability.BOT_WRITE,AidenRemoteCapability.CHAT_READ))
    private fun phone():AidenRemoteCoordinator {
        val installations=AidenInstallationStore(temp.root,InMemoryAidenSecureStore());installations.addInstallation(pairing(),null)
        return AidenRemoteCoordinator(installations,temp.root,scope=CoroutineScope(Dispatchers.Unconfined+Job().apply{cancel()})).also{it.refreshClient()}
    }
    private fun journal(phone:AidenRemoteCoordinator,key:String,owner:AidenPairingIdentity=phone.activePairing!!)=phone.botRoutineControlJournals.journal(owner.instanceId,owner.deviceId,owner.pairedAt,key){true}
    private fun model(phone:AidenRemoteCoordinator,host:Host,botId:String="bot_model")=phone.pairingMemo("routine-models:$botId|routine_model") {
        AidenBotRoutineModelsController(botId,"routine_model",host,{true},{true},journal(phone,"$botId|routine|routine_model"),{MODEL_NONCE},{1000})
    }
    private fun resume(phone:AidenRemoteCoordinator,host:Host)=AidenBotResumeController(host,{true},{true},{"work"},journal(phone,"bot_model|resume"),{UUID.fromString(OPEN_NONCE)},{1000})
    @Test fun acceptedDeletePurgesOnlyItsBotsPendingControlsAndFencesBothHeldReplies()=runTest {
        val phone=phone();val host=Host();val model=model(phone,host);val resume=resume(phone,host)
        model.load();model.select(routineModelSettings().selection.primary!!,false);model.save();resume.request()
        assertNotNull(model.state.value.pending);assertNotNull(resume.state.value.pending)
        val peer=journal(phone,"bot_model:peer|routine|routine_model")
        val peerMemo=model(phone,Host("bot_model:peer"),"bot_model:peer")
        peerMemo.load();peerMemo.select(routineModelSettings().selection.primary!!,false);peerMemo.save()
        val peerRaw=peer.read();assertNotNull(peerRaw);assertNotNull(peerMemo.state.value.pending)
        val elsewhere=AidenPairingIdentity("other-host","device",phone.activePairing!!.pairedAt)
        val otherHost=journal(phone,"bot_model|resume",elsewhere);otherHost.write("Same Bot ID on another host")
        val otherDevice=journal(phone,"bot_model|resume",phone.activePairing!!.copy(deviceId="another-device"));otherDevice.write("Another paired device")
        host.saveGate=CompletableDeferred();host.resumeGate=CompletableDeferred()
        val save=launch{model.retry()};val retry=launch{resume.request()};testScheduler.runCurrent()
        assertEquals(2,host.modelWrites);assertEquals(2,host.resumes)
        phone.deleteBot(phone.client.value!!,"bot_model",AidenBotDeleter{_,_->})
        assertNull(journal(phone,"bot_model|routine|routine_model").read());assertNull(journal(phone,"bot_model|resume").read())
        assertNull(model.state.value.pending);assertNull(model.state.value.draft);assertNull(model.state.value.settings)
        assertNull(resume.state.value.pending);assertNull(resume.state.value.consentSubmissionId)
        assertNotSame(model,phone.pairingMemo("routine-models:bot_model|routine_model"){Any()})
        assertSame(peerMemo,phone.pairingMemo("routine-models:bot_model:peer|routine_model"){Any()})
        assertEquals(peerRaw,peer.read());assertNotNull(peerMemo.state.value.pending);assertEquals("Same Bot ID on another host",otherHost.read());assertEquals("Another paired device",otherDevice.read())
        host.saveGate!!.complete(Unit);host.resumeGate!!.complete(Unit);save.join();retry.join()
        assertNull(model.state.value.pending);assertNull(model.state.value.settings);assertNull(resume.state.value.pending)
        assertNull(journal(phone,"bot_model|routine|routine_model").read());assertNull(journal(phone,"bot_model|resume").read())
        model.load();model.select(routineModelSettings().selection.primary!!,false);model.save();model.retry();resume.request();resume.confirm()
        assertEquals(2,host.modelWrites);assertEquals(2,host.resumes)
    }
    @Test fun failedOrUnknownDeleteKeepsExactPendingRequestsAndMemoizedModel()=runTest {
        val phone=phone();val host=Host();val model=model(phone,host);val resume=resume(phone,host)
        model.load();model.select(routineModelSettings().selection.primary!!,false);model.save();resume.request()
        val modelRaw=journal(phone,"bot_model|routine|routine_model").read();val resumeRaw=journal(phone,"bot_model|resume").read()
        for(failure in listOf(IOException("Delete response lost"),AidenRemoteClientException.Server(403,AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED,"Denied","req",false)))) {
            assertTrue(runCatching{phone.deleteBot(phone.client.value!!,"bot_model",AidenBotDeleter{_,_->throw failure})}.isFailure)
            assertEquals(modelRaw,journal(phone,"bot_model|routine|routine_model").read());assertEquals(resumeRaw,journal(phone,"bot_model|resume").read())
            assertNotNull(model.state.value.pending);assertNotNull(resume.state.value.pending)
            assertSame(model,phone.pairingMemo("routine-models:bot_model|routine_model"){Any()})
        }
    }
    @Test fun botsListDeletionAlsoPurgesOnlyAfterTheHostConfirms()=runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val owners=androidx.lifecycle.ViewModelStore()
        try {
            val phone=phone();val host=Host();val model=model(phone,host);val resume=resume(phone,host)
            model.load();model.select(routineModelSettings().selection.primary!!,false);model.save();resume.request()
            val list=AidenBotsViewModel(phone).also{owners.put("bots",it)}
            assertNotNull(list.deleteBot("bot_model",AidenBotDeleter{_,_->throw IOException("Lost deletion response")}))
            assertNotNull(model.state.value.pending);assertNotNull(resume.state.value.pending)
            assertNull(list.deleteBot("bot_model",AidenBotDeleter{_,_->}))
            assertNull(model.state.value.pending);assertNull(resume.state.value.pending)
            assertNull(journal(phone,"bot_model|routine|routine_model").read());assertNull(journal(phone,"bot_model|resume").read())
        } finally { owners.clear();testScheduler.runCurrent();Dispatchers.resetMain() }
    }
    @Test fun acceptedDeleteAfterPairingSwitchPurgesOriginalPairingAndNeverTheNewOne()=runTest {
        val phone=phone();val original=phone.activePairing!!;val key="bot_model|resume"
        journal(phone,key).write("Original host pending request")
        val gate=CompletableDeferred<Unit>();val deletion=launch{phone.deleteBot(phone.client.value!!,"bot_model",AidenBotDeleter{_,_->gate.await()})}
        testScheduler.runCurrent()
        phone.installationStore.addInstallation(pairing("other-host","other-device"),null);phone.refreshClient()
        val current=journal(phone,key);current.write("New host pending request")
        gate.complete(Unit);deletion.join()
        assertNull(journal(phone,key,original).read());assertEquals("New host pending request",current.read())
    }
}
