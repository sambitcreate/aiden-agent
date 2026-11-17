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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private class AidenRemotePeersTransport(val coordinator:AidenRemoteCoordinator,val pairing:AidenPairingIdentity,val botId:String):AidenBotPeersTransport {
    private suspend fun <T> request(content:Boolean=false,write:Boolean=false,action:suspend(AidenRemoteClient)->T):T {
        fun allowed()=coordinator.holdsPairing(pairing) && coordinator.serverInfo.value?.supportsBotPeers==true &&
            (!content || coordinator.serverInfo.value?.supportsBotPeerExchanges==true) && (!write || coordinator.installationStore.activeInstallation?.canWriteBots==true)
        val client=coordinator.client.value ?: throw AidenRemoteClientException.Disconnected()
        check(allowed() && coordinator.holdsReadAuthority(client,pairing.instanceId))
        val value=action(client)
        check(allowed() && coordinator.holdsReadAuthority(client,pairing.instanceId))
        return value
    }
    override suspend fun settings()=request{it.botPeers(botId)}
    override suspend fun catalog()=request{it.botPeerCatalog(botId)}
    override suspend fun mutate(request:AidenPeerMutation)=request(write=true){it.mutateBotPeers(request)}
    override suspend fun exchanges()=request(content=true){it.botPeerExchanges(botId)}
    override suspend fun detail(id:String)=request(content=true){it.botPeerExchange(botId,id)}
    override suspend fun stop(request:AidenPeerStopMutation)=request(content=true,write=true){it.stopBotPeerExchange(request)}
    override suspend fun evidence(exchange:AidenPeerExchange,kind:AidenOpenWorkEvidenceKind)=request(content=true){it.botPeerEvidence(botId,exchange,kind)}
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotPeersScreen(botId:String,coordinator:AidenRemoteCoordinator,onNavigateBack:()->Unit,exchangeId:String?=null) {
    val client by coordinator.client.collectAsStateWithLifecycle();val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val pairing=coordinator.activePairing;val scope=rememberCoroutineScope()
    var ownerName by remember(pairing,botId){mutableStateOf<String?>(null)}
    fun readable()=pairing!=null && coordinator.holdsPairing(pairing) && coordinator.serverInfo.value?.supportsBotPeers==true
    fun content()=readable() && coordinator.serverInfo.value?.supportsBotPeerExchanges==true
    fun writable()=readable() && coordinator.installationStore.activeInstallation?.canWriteBots==true
    val controller=remember(pairing,botId){pairing?.let{p->coordinator.pairingMemo("peers:$botId"){
        AidenBotPeersController(botId,AidenRemotePeersTransport(coordinator,p,botId),::readable,::content,::writable,
            coordinator.botPeerJournals.journal(p.instanceId,p.deviceId,p.pairedAt,"$botId|settings"){coordinator.holdsPairing(p)},
            {id->coordinator.botPeerJournals.journal(p.instanceId,p.deviceId,p.pairedAt,"$botId|stop|$id"){coordinator.holdsPairing(p)}})
    }}}
    suspend fun refreshOwnerName(){
        val cl=coordinator.client.value
        if(readable() && cl!=null)try {val rows=cl.bots();if(readable() && coordinator.holdsReadAuthority(cl,pairing?.instanceId))ownerName=rows.bots.find{it.id==botId}?.name}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(_:Exception){}
    }
    val ui=controller?.state?.collectAsStateWithLifecycle()?.value ?: AidenBotPeersUiState()
    LifecycleResumeEffect(controller,client,server?.supportsBotPeers,server?.supportsBotPeerExchanges,exchangeId){
        val job=scope.launch{
            if(exchangeId!=null && content())controller?.openExchange(exchangeId)
            while(isActive){refreshOwnerName();controller?.load();delay(15_000)}
        }
        onPauseOrDispose{job.cancel()}
    }
    val palette=AidenTheme.palette
    Scaffold(containerColor=palette.canvas,topBar={TopAppBar(title={Text(stringResource(R.string.bot_peers_title))},navigationIcon={IconButton(onClick={if(exchangeId==null && ui.detail!=null && !ui.busy)controller?.closeExchange() else onNavigateBack()}){Icon(Icons.AutoMirrored.Filled.ArrowBack,stringResource(R.string.action_back))}},colors=TopAppBarDefaults.topAppBarColors(containerColor=palette.canvas))}) { padding->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            if(!readable())Text(stringResource(R.string.bot_peers_old_host),color=palette.secondary)
            else if(controller!=null)AidenBotPeersContent(ui,controller,ownerName,content(),writable(),{scope.launch{it()}},refresh={refreshOwnerName();controller.load()})
        }
    }
    if(content())ui.evidence?.let{evidence->ModalBottomSheet(onDismissRequest={controller?.closeEvidence()},containerColor=palette.canvas){
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text(evidence.title,style=MaterialTheme.typography.titleLarge);Text(evidence.text)
            if(evidence.truncated)Text(stringResource(R.string.bot_open_work_truncated),color=palette.secondary)
            Spacer(Modifier.height(24.dp))
        }
    }}
}
private data class PeerApproval(val ownerName:String,val peer:AidenPeerOption,val settingsRevision:String,val catalogRevision:String)
private data class PeerRevocation(val pair:AidenPeerPair,val settingsRevision:String)
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AidenBotPeersContent(ui:AidenBotPeersUiState,controller:AidenBotPeersController,ownerName:String?,content:Boolean,writable:Boolean,launch:(suspend()->Unit)->Unit,refresh:suspend()->Unit={controller.load()}) {
    val palette=AidenTheme.palette;var approval by remember(controller){mutableStateOf<PeerApproval?>(null)};var revocation by remember(controller){mutableStateOf<PeerRevocation?>(null)}
    val editable=writable && controller.editable()
    if(!writable)Text(stringResource(R.string.bot_open_work_read_only),color=palette.secondary)
    ui.problem?.let{Text(stringResource(when(it){AidenRoutineControlProblem.FAILED->R.string.bot_peers_failed;AidenRoutineControlProblem.UNCERTAIN->R.string.bot_peers_uncertain;AidenRoutineControlProblem.STORAGE->R.string.bot_routine_models_storage;AidenRoutineControlProblem.EXPIRED->R.string.bot_routine_models_expired}),color=palette.secondary)}
    ui.message?.let{Text(it,color=palette.secondary)}
    AidenTonalButton(stringResource(R.string.bot_open_work_refresh),enabled=!ui.busy && !ui.loading,onClick={launch{refresh()}})
    if(ui.loading && ui.settings==null)AidenSkeletonBlock(height=100.dp,shape=MaterialTheme.shapes.large)
    val detail=ui.detail.takeIf{content}
    if(detail!=null) {
        Text(detail.title,style=MaterialTheme.typography.titleLarge,modifier=Modifier.semantics{heading()})
        Text("${detail.sender.name} → ${detail.recipient.name}",style=MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.bot_peers_exchange_status,detail.kind.name.lowercase(),detail.state.name.lowercase(),detail.returnState.name.lowercase()),color=palette.secondary)
        Text(peerTime(detail.updatedAt),style=MaterialTheme.typography.bodySmall,color=palette.secondary)
        detail.blockedReason?.let{Text(it,color=palette.secondary)}
        Text(stringResource(R.string.bot_peers_request),style=MaterialTheme.typography.titleMedium);Text(detail.request!!.text)
        detail.result?.let{Text(stringResource(R.string.bot_peers_result),style=MaterialTheme.typography.titleMedium);Text(it.text);if(it.truncated)Text(stringResource(R.string.bot_open_work_truncated),color=palette.secondary)}
        detail.lastStop?.let{Text(AidenBotPeersController.stopMessage(it),color=palette.secondary)}
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            AidenTonalButton(stringResource(R.string.bot_open_work_source),enabled=!ui.loading && !ui.busy,onClick={launch{controller.showEvidence(AidenOpenWorkEvidenceKind.SOURCE)}})
            AidenTonalButton(stringResource(R.string.bot_open_work_result),enabled=!ui.loading && !ui.busy,onClick={launch{controller.showEvidence(AidenOpenWorkEvidenceKind.RESULT)}})
            if(ui.pendingStop!=null)AidenTonalButton(stringResource(R.string.bot_peers_check_stop),enabled=writable && !ui.busy,onClick={launch{controller.retryStop()}})
            else if(detail.canStop && !detail.hasPendingStop)AidenTonalButton(stringResource(R.string.bot_open_work_stop),enabled=writable && controller.stopAllowed(),onClick={launch{controller.stop()}})
        }
        return
    }
    Text(stringResource(R.string.bot_peers_description),color=palette.secondary)
    if(ui.pending!=null)AidenTonalButton(stringResource(R.string.bot_watch_retry),enabled=writable && !ui.busy && controller.retryAllowed(),onClick={launch{controller.retry()}})
    if(ui.needsReview){
        Text(stringResource(R.string.bot_peers_conflict),color=palette.secondary)
        ui.settings?.let{Text(it.routingDescription,color=palette.secondary)}
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){
            AidenTonalButton(stringResource(R.string.bot_routine_models_keep_draft),enabled=editable,onClick=controller::reviewKeepingDraft)
            AidenTonalButton(stringResource(R.string.bot_routine_models_use_saved),enabled=editable,onClick=controller::useSaved)
        }
    }
    ui.draft?.let{draft->
        TextField(value=draft,onValueChange=controller::setDraft,label={Text(stringResource(R.string.bot_peers_routing))},enabled=editable,minLines=3,colors=aidenTextFieldColors(),shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth())
        AidenTonalButton(stringResource(R.string.action_save),enabled=writable && controller.saveAllowed(),onClick={launch{controller.saveDescription()}})
    }
    Text(stringResource(R.string.bot_peers_approved),style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
    if(ui.settings?.pairs?.isEmpty()==true)Text(stringResource(R.string.bot_peers_no_pairs),color=palette.secondary)
    ui.settings?.pairs?.forEach{pair->
        Surface(color=palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()){
            Row(Modifier.padding(16.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)){
                Column(Modifier.weight(1f)){Text(pair.peer.name,style=MaterialTheme.typography.titleMedium);Text(stringResource(R.string.bot_peers_bidirectional),color=palette.secondary)}
                AidenTonalButton(stringResource(R.string.bot_peers_revoke),enabled=editable && !ui.needsReview,onClick={revocation=PeerRevocation(pair,ui.settings.revision)})
            }
        }
    }
    if(ownerName==null)Text(stringResource(R.string.bot_peers_names_missing),color=palette.secondary)
    Text(stringResource(R.string.bot_peers_available),style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
    ui.catalog?.bots?.filter{bot->ui.settings?.pairs?.none{it.peer.botId==bot.botId}==true}?.forEach{peer->
        Surface(color=palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()){
            Row(Modifier.padding(16.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)){
                Column(Modifier.weight(1f)){Text(peer.name,style=MaterialTheme.typography.titleMedium);if(!peer.available)Text(stringResource(R.string.bot_routine_models_unavailable),color=palette.secondary)}
                AidenTonalButton(stringResource(R.string.bot_peers_approve),enabled=editable && !ui.needsReview && peer.available && ownerName!=null,onClick={approval=PeerApproval(ownerName!!,peer,ui.settings!!.revision,ui.catalog.revision)})
            }
        }
    }
    if(content){
        Text(stringResource(R.string.bot_peers_exchanges),style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
        if(ui.exchanges.isEmpty())Text(stringResource(R.string.bot_peers_no_exchanges),color=palette.secondary)
        ui.exchanges.forEach{exchange->
            Surface(onClick={launch{controller.openExchange(exchange.id)}},enabled=!ui.busy,color=palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()){
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){Text(exchange.title,style=MaterialTheme.typography.titleMedium);Text("${exchange.sender.name} → ${exchange.recipient.name}");Text(exchange.state.name.lowercase(),color=palette.secondary);Text(stringResource(R.string.bot_peers_view_exchange),color=palette.secondary)}
            }
        }
    }else Text(stringResource(R.string.bot_peers_chat_access),color=palette.secondary)
    approval?.let{review->
        AlertDialog(onDismissRequest={approval=null},title={Text(stringResource(R.string.bot_peers_approve_title))},text={Text(stringResource(R.string.bot_peers_approve_body,review.ownerName,review.peer.name))},
            confirmButton={TextButton(enabled=editable && !ui.needsReview && ui.settings?.revision==review.settingsRevision && ui.catalog?.revision==review.catalogRevision,onClick={approval=null;launch{controller.approve(review.peer,review.settingsRevision,review.catalogRevision)}}){Text(stringResource(R.string.bot_peers_approve))}},dismissButton={TextButton(onClick={approval=null}){Text(stringResource(R.string.action_cancel))}})
    }
    revocation?.let{review->AlertDialog(onDismissRequest={revocation=null},title={Text(stringResource(R.string.bot_peers_revoke))},text={Text(stringResource(R.string.bot_peers_revoke_body,review.pair.peer.name))},confirmButton={TextButton(enabled=editable && !ui.needsReview && ui.settings?.revision==review.settingsRevision,onClick={revocation=null;launch{controller.revoke(review.pair,review.settingsRevision)}}){Text(stringResource(R.string.bot_peers_revoke))}},dismissButton={TextButton(onClick={revocation=null}){Text(stringResource(R.string.action_cancel))}})}
}
private fun peerTime(at:Long)=DateTimeFormatter.ofPattern("MMM d, yyyy HH:mm:ss z").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(at))
