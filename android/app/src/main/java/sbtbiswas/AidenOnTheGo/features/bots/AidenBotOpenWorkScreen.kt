package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.*

private class AidenRemoteOpenWorkTransport(val coordinator: AidenRemoteCoordinator,val pairing: AidenPairingIdentity,val botId:String) : AidenBotOpenWorkTransport {
    private suspend fun <T> request(action:suspend(AidenRemoteClient)->T):T {
        val client=coordinator.client.value ?: throw AidenRemoteClientException.Disconnected()
        if (!coordinator.holdsPairing(pairing) || !coordinator.holdsReadAuthority(client,pairing.instanceId)) throw AidenRemoteClientException.Disconnected()
        val result=action(client)
        if (!coordinator.holdsPairing(pairing) || !coordinator.holdsReadAuthority(client,pairing.instanceId)) throw AidenRemoteClientException.Disconnected()
        return result
    }
    override suspend fun snapshot()=request { it.botOpenWork(botId) }
    override suspend fun mutate(mutation:AidenOpenWorkMutation)=request { it.mutateBotOpenWork(botId,mutation) }
    override suspend fun evidence(id:String,kind:AidenOpenWorkEvidenceKind)=request { it.botOpenWorkEvidence(botId,id,kind) }
}
@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable
fun AidenBotOpenWorkScreen(botId:String,coordinator:AidenRemoteCoordinator,onNavigateBack:()->Unit,onOpenBotChat:()->Unit,onOpenPeerExchange:(String)->Unit={}) {
    val palette=AidenTheme.palette
    val client by coordinator.client.collectAsStateWithLifecycle()
    val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val pairing=coordinator.activePairing
    fun readable()=coordinator.holdsPairing(pairing) && coordinator.serverInfo.value?.supportsBotOpenWork==true
    fun writable()=readable() && coordinator.serverInfo.value?.capabilities?.contains(AidenRemoteCapability.BOT_WRITE)==true && coordinator.installationStore.activeInstallation?.canWriteBots==true
    if (pairing==null) {
        Scaffold(containerColor=palette.canvas,topBar={TopAppBar(title={Text(stringResource(R.string.bot_open_work_title))},navigationIcon={IconButton(onClick=onNavigateBack){Icon(Icons.AutoMirrored.Filled.ArrowBack,stringResource(R.string.action_back))}})}) { padding ->
            Text(stringResource(R.string.bot_open_work_offline),Modifier.padding(padding).padding(AidenUi.ScreenGutter))
        }
        return
    }
    val controller=remember(pairing,botId) { coordinator.pairingMemo("bot-open-work:$botId") {
        AidenBotOpenWorkController(AidenRemoteOpenWorkTransport(coordinator,pairing,botId),::readable,::writable,
            coordinator.botOpenWorkJournals.journal(pairing.instanceId,pairing.deviceId,pairing.pairedAt,botId){coordinator.holdsPairing(pairing)})
    } }
    val ui by controller.state.collectAsStateWithLifecycle()
    val scope=rememberCoroutineScope()
    LifecycleResumeEffect(controller,client,server?.supportsBotOpenWork) {
        val refresh=scope.launch { controller.refreshWhileActive() }
        onPauseOrDispose { refresh.cancel() }
    }
    val editable=writable() && !ui.busy && ui.pending==null
    val draft=ui.draft
    val draftStopPending=draft?.id?.let { id -> ui.snapshot?.items?.any { it.id==id && it.hasPendingStop } }==true
    val draftEditable=editable && !draftStopPending
    Scaffold(containerColor=palette.canvas,topBar={TopAppBar(title={Text(stringResource(if(draft==null)R.string.bot_open_work_title else if(draft.id==null)R.string.bot_open_work_add else R.string.bot_open_work_edit))},
        navigationIcon={IconButton(onClick={if(draft!=null && ui.pending==null && !ui.busy)controller.closeDraft() else onNavigateBack()}){Icon(Icons.AutoMirrored.Filled.ArrowBack,stringResource(R.string.action_back))}},
        colors=TopAppBarDefaults.topAppBarColors(containerColor=palette.canvas))}) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal=AidenUi.ScreenGutter,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.bot_open_work_description),style=MaterialTheme.typography.bodyMedium,color=palette.secondary)
            if(!readable()) Text(stringResource(if(client==null || server==null)R.string.bot_open_work_offline else R.string.bot_open_work_old_host),color=palette.secondary)
            else {
                if(!writable()) Text(stringResource(R.string.bot_open_work_read_only),color=palette.secondary)
                ui.problem?.let { problem ->
                    Surface(color=if(problem in listOf(AidenOpenWorkProblem.UNCERTAIN,AidenOpenWorkProblem.UNAVAILABLE))MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.errorContainer,shape=MaterialTheme.shapes.large) {
                        Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(when(problem){
                                AidenOpenWorkProblem.UNCERTAIN,AidenOpenWorkProblem.UNAVAILABLE->R.string.bot_open_work_uncertain
                                AidenOpenWorkProblem.STALE->R.string.bot_open_work_stale
                                AidenOpenWorkProblem.STORAGE->R.string.bot_open_work_storage
                                AidenOpenWorkProblem.PERMISSION->R.string.bot_open_work_read_only
                                AidenOpenWorkProblem.EXPIRED->R.string.bot_open_work_expired
                                AidenOpenWorkProblem.BLOCKED->R.string.bot_open_work_blocked
                                AidenOpenWorkProblem.FAILED->R.string.bot_open_work_failed
                            }))
                            ui.businessError?.let { Text(it,style=MaterialTheme.typography.bodySmall) }
                            if(problem==AidenOpenWorkProblem.STALE && draft!=null) {
                                ui.snapshot?.items?.find { it.id==draft.id }?.let { current -> Text(stringResource(R.string.bot_open_work_current,current.title,current.note,openWorkState(current.state)),style=MaterialTheme.typography.bodySmall) }
                                AidenTonalButton(stringResource(R.string.bot_watch_review_revision),enabled=draftEditable,onClick=controller::useLatestRevision)
                            }
                        }
                    }
                }
                ui.pending?.let { pending ->
                    Text(stringResource(if(pending.mutation.action.isStop)R.string.bot_open_work_stop_pending else R.string.bot_open_work_pending),style=MaterialTheme.typography.bodyMedium,color=palette.secondary)
                    AidenTonalButton(stringResource(if(pending.mutation.action.isStop)R.string.bot_open_work_check_stop else R.string.bot_watch_retry),
                        enabled=writable() && !ui.busy && controller.retryAllowed(),onClick={scope.launch{controller.retry()}})
                    if(!controller.retryAllowed()) Text(stringResource(R.string.bot_open_work_expired),color=palette.secondary)
                }
                AidenTonalButton(stringResource(R.string.bot_open_work_refresh),enabled=!ui.busy && !ui.loading,onClick={scope.launch{controller.load()}})
                if(ui.loading && ui.snapshot==null) { AidenSkeletonBlock(height=112.dp,shape=MaterialTheme.shapes.large); AidenSkeletonBlock(height=112.dp,shape=MaterialTheme.shapes.large) }
                val snapshot=ui.snapshot
                if(snapshot!=null) {
                    if(draft!=null) {
                        if(draftStopPending)Text(stringResource(R.string.bot_open_work_remote_stop_pending),style=MaterialTheme.typography.bodyMedium,color=palette.secondary)
                        AidenOpenWorkEditor(draft,draftEditable,controller::edit)
                        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            AidenTonalButton(stringResource(R.string.action_save),enabled=draftEditable && draft.valid,onClick={scope.launch{controller.save()}})
                            AidenTonalButton(stringResource(R.string.action_cancel),enabled=!ui.busy && ui.pending==null,onClick=controller::closeDraft)
                        }
                    } else {
                        AidenTonalButton(stringResource(R.string.bot_open_work_add),enabled=editable,onClick={controller.begin()})
                        if(snapshot.items.isEmpty())Text(stringResource(R.string.bot_open_work_empty),color=palette.secondary)
                        snapshot.items.forEach { item ->
                            val itemEditable=editable && !item.hasPendingStop
                            Surface(color=palette.raised,shape=MaterialTheme.shapes.large) {
                                Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                                    Text(item.title,style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
                                    if(item.note.isNotEmpty())Text(item.note,style=MaterialTheme.typography.bodyMedium)
                                    Text(openWorkState(item.state),style=MaterialTheme.typography.labelLarge,color=palette.secondary)
                                    item.waitingReason?.let{Text(it,style=MaterialTheme.typography.bodyMedium,color=palette.secondary)}
                                    Text(stringResource(when(item.execution.state){AidenOpenWorkExecutionState.IDLE->R.string.bot_open_work_idle;AidenOpenWorkExecutionState.RUNNING->R.string.bot_open_work_running;AidenOpenWorkExecutionState.QUEUED->R.string.bot_open_work_queued;AidenOpenWorkExecutionState.INTERRUPTED->R.string.bot_open_work_interrupted;AidenOpenWorkExecutionState.STOPPING->R.string.bot_open_work_stopping}),style=MaterialTheme.typography.bodySmall,color=palette.secondary)
                                    item.completion?.let{Text(stringResource(if(it.by==AidenOpenWorkCompletedBy.PERSON)R.string.bot_open_work_done_person else R.string.bot_open_work_done_bot),style=MaterialTheme.typography.bodySmall,color=palette.secondary)}
                                    if(item.execution.blockedReason!=null)Text(stringResource(if(item.execution.blockedReason==AidenOpenWorkBlockedReason.MIXED_INPUTS)R.string.bot_open_work_mixed else R.string.bot_open_work_stop_unavailable),style=MaterialTheme.typography.bodySmall,color=palette.secondary)
                                    item.lastStop?.let{OpenWorkStopStatus(it)}
                                    if(item.hasPendingStop)Text(stringResource(R.string.bot_open_work_remote_stop_pending),style=MaterialTheme.typography.bodySmall,color=palette.secondary)
                                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                                        AidenTonalButton(stringResource(R.string.action_edit),enabled=itemEditable,onClick={controller.begin(item)})
                                        AidenTonalButton(stringResource(if(item.state in listOf(AidenOpenWorkState.DONE,AidenOpenWorkState.DISMISSED))R.string.bot_open_work_reopen else R.string.bot_open_work_done),enabled=itemEditable,onClick={scope.launch{controller.state(item,if(item.state in listOf(AidenOpenWorkState.DONE,AidenOpenWorkState.DISMISSED))AidenOpenWorkState.OPEN else AidenOpenWorkState.DONE)}})
                                        if(item.state!=AidenOpenWorkState.DISMISSED) AidenTonalButton(stringResource(R.string.bot_open_work_dismiss),enabled=itemEditable,onClick={scope.launch{controller.state(item,AidenOpenWorkState.DISMISSED)}})
                                        if(item.execution.canStop) {
                                            AidenTonalButton(stringResource(R.string.bot_open_work_stop),enabled=itemEditable,onClick={scope.launch{controller.stop(item,false)}})
                                            AidenTonalButton(stringResource(R.string.bot_open_work_stop_dismiss),enabled=itemEditable,onClick={scope.launch{controller.stop(item,true)}})
                                        }
                                        snapshot.undo.find{it.itemId==item.id}?.let{undo->AidenTonalButton(stringResource(R.string.bot_open_work_undo),enabled=itemEditable && undo.expiresAt>System.currentTimeMillis(),onClick={scope.launch{controller.undo(undo)}})}
                                        if(item.source.submissionId!=null || item.links.any{it.kind==AidenOpenWorkLinkKind.SOURCE}) AidenTonalButton(stringResource(R.string.bot_open_work_source),onClick={scope.launch{controller.evidence(item,AidenOpenWorkEvidenceKind.SOURCE)}})
                                        if(item.completion?.result!=null || item.links.any{it.kind==AidenOpenWorkLinkKind.RESULT}) AidenTonalButton(stringResource(R.string.bot_open_work_result),onClick={scope.launch{controller.evidence(item,AidenOpenWorkEvidenceKind.RESULT)}})
                                        if(coordinator.serverInfo.value?.supportsBotPeerExchanges==true) {
                                            (item.links.filter{it.kind==AidenOpenWorkLinkKind.PEER}.mapNotNull{it.exchangeId}+listOfNotNull(item.source.exchangeId)).distinct().forEach{id->AidenTonalButton(stringResource(R.string.bot_peers_view_exchange),onClick={onOpenPeerExchange(id)})}
                                        }
                                        if(item.links.any{it.kind in listOf(AidenOpenWorkLinkKind.ISSUE,AidenOpenWorkLinkKind.ROUTINE)}) AidenTonalButton(stringResource(R.string.bot_open_work_chat),onClick=onOpenBotChat)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if(ui.evidenceTarget!=null && readable()) ModalBottomSheet(onDismissRequest=controller::closeEvidence,containerColor=palette.raised) {
        Column(Modifier.fillMaxWidth().heightIn(max=640.dp).verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text(stringResource(if(ui.evidenceTarget?.second==AidenOpenWorkEvidenceKind.SOURCE)R.string.bot_open_work_source else R.string.bot_open_work_result),style=MaterialTheme.typography.titleLarge,modifier=Modifier.semantics{heading()})
            when {ui.evidenceLoading->AidenSkeletonBlock(height=112.dp,shape=MaterialTheme.shapes.large)
                ui.evidenceFailed->Text(stringResource(R.string.bot_open_work_evidence_missing),color=palette.secondary)
                else->ui.evidence?.let { evidence->Text(evidence.title,style=MaterialTheme.typography.titleMedium);Text(evidence.text,style=MaterialTheme.typography.bodyMedium);if(evidence.truncated)Text(stringResource(R.string.bot_open_work_truncated),style=MaterialTheme.typography.bodySmall,color=palette.secondary)} }
            AidenTonalButton(stringResource(R.string.action_back),onClick=controller::closeEvidence)
        }
    }
}
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun AidenOpenWorkEditor(draft:AidenOpenWorkDraft,enabled:Boolean,onChange:((AidenOpenWorkDraft)->AidenOpenWorkDraft)->Unit) {
    Surface(color=AidenTheme.palette.raised,shape=MaterialTheme.shapes.large) {
        Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            TextField(draft.title,{value->onChange{it.copy(title=AidenOpenWorkWire.clamp(value,160,640))}},enabled=enabled,label={Text(stringResource(R.string.bot_open_work_field_title))},colors=aidenTextFieldColors(),shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth())
            TextField(draft.note,{value->onChange{it.copy(note=AidenOpenWorkWire.clamp(value,1000,2048))}},enabled=enabled,label={Text(stringResource(R.string.bot_open_work_note))},minLines=3,colors=aidenTextFieldColors(),shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth())
            if(draft.id!=null) {
                FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) { AidenOpenWorkState.entries.forEach{state->AidenTonalButton(openWorkState(state),enabled=enabled,modifier=Modifier.semantics{selected=draft.state==state},onClick={onChange{it.copy(state=state)}})} }
                if(draft.state==AidenOpenWorkState.WAITING)TextField(draft.waitingReason,{value->onChange{it.copy(waitingReason=AidenOpenWorkWire.clamp(value,160,640))}},enabled=enabled,label={Text(stringResource(R.string.bot_open_work_reason))},colors=aidenTextFieldColors(),shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth())
            }
        }
    }
}
@Composable private fun OpenWorkStopStatus(stop:AidenOpenWorkStopReceipt) { Text(stringResource(when(stop.state){AidenOpenWorkStopState.REQUESTED,AidenOpenWorkStopState.UNCERTAIN->R.string.bot_open_work_stop_pending;AidenOpenWorkStopState.STOPPED->R.string.bot_open_work_stopped;AidenOpenWorkStopState.ALREADY_FINISHED->R.string.bot_open_work_already_finished;AidenOpenWorkStopState.NOT_RUNNING->R.string.bot_open_work_not_running;AidenOpenWorkStopState.BLOCKED->R.string.bot_open_work_blocked}),style=MaterialTheme.typography.bodySmall,color=AidenTheme.palette.secondary) }
@Composable private fun openWorkState(state:AidenOpenWorkState)=stringResource(when(state){AidenOpenWorkState.OPEN->R.string.bot_open_work_open;AidenOpenWorkState.WAITING->R.string.bot_open_work_waiting;AidenOpenWorkState.DONE->R.string.bot_open_work_done;AidenOpenWorkState.DISMISSED->R.string.bot_open_work_dismissed})
