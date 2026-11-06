package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import java.util.UUID

interface AidenBotPeersTransport {
    suspend fun settings():AidenPeerSettings
    suspend fun catalog():AidenPeerCatalog
    suspend fun mutate(request:AidenPeerMutation):AidenPeerMutationResult
    suspend fun exchanges():AidenPeerExchangeList
    suspend fun detail(id:String):AidenPeerExchange
    suspend fun stop(request:AidenPeerStopMutation):AidenPeerStopResult
    suspend fun evidence(exchange:AidenPeerExchange,kind:AidenOpenWorkEvidenceKind):AidenPeerEvidence
}
@Serializable data class AidenPeerAttempt(val request:AidenPeerMutation,val startedAt:Long)
@Serializable data class AidenPeerStopAttempt(val request:AidenPeerStopMutation,val startedAt:Long)
data class AidenBotPeersUiState(val settings:AidenPeerSettings?=null,val baseline:AidenPeerSettings?=null,val draft:String?=null,val catalog:AidenPeerCatalog?=null,
    val pending:AidenPeerAttempt?=null,val needsReview:Boolean=false,val exchanges:List<AidenPeerExchange> = emptyList(),val detail:AidenPeerExchange?=null,val pendingStop:AidenPeerStopAttempt?=null,
    val evidence:AidenPeerEvidence?=null,val loading:Boolean=false,val busy:Boolean=false,val problem:AidenRoutineControlProblem?=null,val message:String?=null)

/** Only exact frozen requests may cross transport. Passive reads never send or replace a nonce. */
class AidenBotPeersController(val botId:String,private val transport:AidenBotPeersTransport,private val canRead:()->Boolean,private val canReadExchanges:()->Boolean,
    private val canWrite:()->Boolean,private val journal:AidenBotWatchJournal,private val stopJournal:(String)->AidenBotWatchJournal,
    private val uuid:()->String={UUID.randomUUID().toString()},private val now:()->Long=System::currentTimeMillis) {
    @Serializable private data class Saved(val baseline:AidenPeerSettings,val draft:String,val pending:AidenPeerAttempt?=null)
    private val _state=MutableStateFlow(AidenBotPeersUiState());val state=_state.asStateFlow()
    private var persisted:String?=null;private var stopPersisted:String?=null;private var stopStore:AidenBotWatchJournal?=null
    private var storageBlocked=false;private var invalidated=false;private var generation=0;private var selected:String?=null
    init {
        try { persisted=journal.read();persisted?.let{val s=AidenPeerWire.decode(Saved.serializer(),it);check(s.baseline.botId==botId);AidenOpenWorkWire.text(s.draft,1000,2048,true);s.pending?.let{p->check(p.request.botId==botId && p.startedAt>=0)};_state.value=AidenBotPeersUiState(baseline=s.baseline,draft=s.draft,pending=s.pending,problem=if(s.pending!=null)AidenRoutineControlProblem.UNCERTAIN else null)} }
        catch(_:Exception){storageBlocked=true;_state.value=AidenBotPeersUiState(problem=AidenRoutineControlProblem.STORAGE)}
        journal.onInvalidated(::invalidate)
    }
    private fun invalidate(){invalidated=true;generation++;persisted=null;stopPersisted=null;_state.value=AidenBotPeersUiState()}
    private fun current():Boolean { if(!journal.isCurrent && !invalidated)invalidate();return !invalidated }
    private fun retain(next:AidenBotPeersUiState):Boolean {
        if(!current() || storageBlocked)return false
        return try { val raw=next.baseline?.let{AidenBotWireJson.json.encodeToString(Saved.serializer(),Saved(it,requireNotNull(next.draft),next.pending))};check(journal.replace(persisted,raw));persisted=raw;_state.value=next;true }
        catch(_:Exception){storageBlocked=true;_state.update{it.copy(problem=AidenRoutineControlProblem.STORAGE)};false}
    }
    private fun retainStop(attempt:AidenPeerStopAttempt?):Boolean {
        if(!current() || storageBlocked)return false
        return try { val raw=attempt?.let{AidenBotWireJson.json.encodeToString(AidenPeerStopAttempt.serializer(),it)};check(requireNotNull(stopStore).replace(stopPersisted,raw));stopPersisted=raw;_state.update{it.copy(pendingStop=attempt)};true }
        catch(_:Exception){storageBlocked=true;_state.update{it.copy(problem=AidenRoutineControlProblem.STORAGE)};false}
    }
    fun editable()=current() && canRead() && canWrite() && !storageBlocked && !_state.value.busy && _state.value.pending==null && _state.value.settings!=null
    fun setDraft(value:String){if(editable())retain(_state.value.copy(draft=AidenOpenWorkWire.clamp(value,1000,2048)))}
    fun reviewKeepingDraft(){val s=_state.value;if(editable() && s.settings!=null)retain(s.copy(baseline=s.settings,needsReview=false,problem=null))}
    fun useSaved(){val s=_state.value;if(editable() && s.settings!=null)retain(s.copy(baseline=s.settings,draft=s.settings.routingDescription,needsReview=false,problem=null))}
    private fun settled(row:AidenPeerSettings,descriptionSaved:Boolean):AidenBotPeersUiState {
        val s=_state.value;val hasDraft=s.baseline!=null && s.draft!=null && s.draft!=s.baseline.routingDescription
        val overlappingDescription=!descriptionSaved && hasDraft && row.routingDescription!=s.baseline?.routingDescription
        return s.copy(settings=row,baseline=if(overlappingDescription)s.baseline else row,draft=if(descriptionSaved || !hasDraft)row.routingDescription else s.draft,pending=null,needsReview=overlappingDescription,problem=null,message=null)
    }
    private fun apply(row:AidenPeerSettings){
        check(row.botId==botId);val s=_state.value;val confirmed=s.pending?.request?.mutationId==row.lastMutationId
        if(confirmed){retain(settled(row,s.pending?.request?.action==AidenPeerAction.DESCRIBE))}
        else if(s.baseline==null || s.pending==null && s.draft==s.baseline.routingDescription)retain(s.copy(settings=row,baseline=row,draft=row.routingDescription,needsReview=false))
        else _state.update{it.copy(settings=row,needsReview=it.baseline?.revision!=row.revision)}
    }
    private fun applyDetail(row:AidenPeerExchange){
        check(row.id==selected && row.belongsTo(botId));row.detail();_state.update{it.copy(detail=row)}
        val p=_state.value.pendingStop
        if(p!=null && row.lastStop?.mutationId==p.request.mutationId && row.lastStop.state.terminal) {
            if(retainStop(null))_state.update{it.copy(problem=null,message=stopMessage(row.lastStop))}
        }
    }
    suspend fun load(){
        if(!current() || !canRead() || _state.value.busy)return
        val g=++generation;_state.update{it.copy(loading=true)}
        try {
            val settings=transport.settings();if(!current() || !canRead() || g!=generation)return;apply(settings)
            val catalog=transport.catalog();if(!current() || !canRead() || g!=generation)return;check(catalog.botId==botId);_state.update{it.copy(catalog=catalog)}
            if(canReadExchanges()) {
                val rows=transport.exchanges();if(!current() || !canReadExchanges() || g!=generation)return;check(rows.botId==botId);_state.update{it.copy(exchanges=rows.exchanges)}
                selected?.let{id->val row=transport.detail(id);if(current() && canReadExchanges() && g==generation && selected==id)applyDetail(row)}
            } else _state.update{it.copy(exchanges=emptyList(),detail=null,evidence=null)}
        }catch(e:CancellationException){throw e}catch(_:Exception){if(current() && canRead() && g==generation)_state.update{it.copy(problem=it.problem ?: AidenRoutineControlProblem.FAILED)}}
        finally{if(g==generation)_state.update{it.copy(loading=false)}}
    }
    suspend fun refreshWhileActive(){while(currentCoroutineContext().isActive){load();delay(15_000)}}
    fun saveAllowed()=editable() && !_state.value.needsReview && _state.value.draft?.trim()!=_state.value.baseline?.routingDescription
    suspend fun saveDescription(){if(!saveAllowed())return;val s=_state.value;start(AidenPeerMutation(AidenPeerAction.DESCRIBE,botId,uuid(),s.baseline!!.revision,routingDescription=s.draft!!.trim()))}
    suspend fun approve(peer:AidenPeerOption,revision:String,catalogRevision:String){
        val s=_state.value;if(!editable() || s.needsReview || s.settings?.revision!=revision || s.baseline?.revision!=revision || s.catalog?.revision!=catalogRevision || s.catalog.bots.none{it==peer && it.available} || s.settings.pairs.any{it.peer.botId==peer.botId})return
        start(AidenPeerMutation(AidenPeerAction.APPROVE,botId,uuid(),revision,catalogRevision=catalogRevision,peerBotId=peer.botId))
    }
    suspend fun revoke(pair:AidenPeerPair,revision:String){
        val s=_state.value;if(!editable() || s.needsReview || s.settings?.revision!=revision || s.baseline?.revision!=revision || pair !in s.settings.pairs)return
        start(AidenPeerMutation(AidenPeerAction.REVOKE,botId,uuid(),revision,pairId=pair.id,pairRevision=pair.revision))
    }
    private suspend fun start(request:AidenPeerMutation){val attempt=AidenPeerAttempt(request,now());if(retain(_state.value.copy(pending=attempt)))send(attempt,false)}
    fun retryAllowed()=_state.value.pending?.let{now()-it.startedAt in 0 until RETRY_MS}==true
    suspend fun retry(){val p=_state.value.pending ?: return;if(!retryAllowed()){_state.update{it.copy(problem=AidenRoutineControlProblem.EXPIRED)};return};send(p,true)}
    private suspend fun send(p:AidenPeerAttempt,unknown:Boolean){
        if(!current() || !canRead() || !canWrite() || storageBlocked || _state.value.busy)return
        if(unknown && !retain(_state.value.copy(pending=p)))return
        generation++;_state.update{it.copy(busy=true,loading=false,problem=null,message=null)}
        try {
            val r=transport.mutate(p.request);if(!current() || !canRead())return;r.snapshot?.let{check(it.botId==botId)}
            if(r.ok){check(r.mutationId==p.request.mutationId);retain(settled(requireNotNull(r.snapshot),p.request.action==AidenPeerAction.DESCRIBE))}
            else {r.snapshot?.let(::apply);if(_state.value.pending!=null){val keep=unknown || r.code==AidenPeerError.UNAVAILABLE;retain(_state.value.copy(pending=if(keep)p else null,needsReview=_state.value.needsReview || r.code==AidenPeerError.CONFLICT,problem=if(keep)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED,message=r.error))}}
        }catch(e:CancellationException){if(current())_state.update{it.copy(problem=AidenRoutineControlProblem.UNCERTAIN)};throw e}
        catch(e:Exception){if(current()){val keep=unknown || aidenBotResumeFailureIsAmbiguous(e);retain(_state.value.copy(pending=if(keep)p else null,problem=if(keep)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED))}}
        finally{if(current())_state.update{it.copy(busy=false)}}
    }
    suspend fun openExchange(id:String){
        if(!current() || !canReadExchanges() || _state.value.busy)return
        AidenPeerWire.id(id);generation++;selected=id;stopStore=stopJournal(id);stopStore!!.onInvalidated(::invalidate)
        try {stopPersisted=stopStore!!.read();val p=stopPersisted?.let{AidenPeerWire.decode(AidenPeerStopAttempt.serializer(),it)};check(p==null || p.request.botId==botId && p.request.exchangeId==id && p.startedAt>=0);_state.update{it.copy(detail=null,pendingStop=p,evidence=null,problem=if(p!=null)AidenRoutineControlProblem.UNCERTAIN else null)}}
        catch(_:Exception){storageBlocked=true;_state.update{it.copy(detail=null,pendingStop=null,problem=AidenRoutineControlProblem.STORAGE)}}
        load()
    }
    fun closeExchange(){if(_state.value.busy)return;generation++;selected=null;stopStore=null;stopPersisted=null;_state.update{it.copy(detail=null,pendingStop=null,evidence=null,loading=false)}}
    fun stopAllowed():Boolean {val s=_state.value;return current() && canReadExchanges() && canWrite() && !storageBlocked && !s.busy && s.pendingStop==null && s.detail?.let{it.canStop && !it.hasPendingStop}==true}
    suspend fun stop(){if(!stopAllowed())return;val row=_state.value.detail!!;val p=AidenPeerStopAttempt(AidenPeerStopMutation(botId,row.id,uuid(),row.revision),now());if(retainStop(p))sendStop(p,false)}
    suspend fun retryStop(){val p=_state.value.pendingStop ?: return;sendStop(p,true)}
    private suspend fun sendStop(p:AidenPeerStopAttempt,unknown:Boolean){
        if(!current() || !canReadExchanges() || !canWrite() || storageBlocked || _state.value.busy || selected!=p.request.exchangeId)return
        if(unknown && !retainStop(p))return
        val g=++generation;_state.update{it.copy(busy=true,loading=false,problem=null,message=null)}
        try {
            if(now()-p.startedAt !in 0 until RETRY_MS) {
                val row=transport.detail(p.request.exchangeId)
                if(!current() || !canReadExchanges() || !canWrite() || g!=generation)return
                applyDetail(row)
                if(_state.value.pendingStop==null)return
                if(row.lastStop?.mutationId!=p.request.mutationId || row.lastStop.state.terminal){_state.update{it.copy(problem=AidenRoutineControlProblem.EXPIRED)};return}
            }
            val r=transport.stop(p.request);if(!current() || !canReadExchanges())return
            r.exchange?.let{check(it.belongsTo(botId) && it.id==p.request.exchangeId)}
            if(r.ok){check(r.mutationId==p.request.mutationId);applyDetail(requireNotNull(r.exchange));if(_state.value.pendingStop!=null)_state.update{it.copy(problem=AidenRoutineControlProblem.UNCERTAIN,message="Stop is pending. Check again for the host’s acknowledgement.")}}
            else {r.exchange?.let(::applyDetail);if(_state.value.pendingStop!=null){val keep=unknown || r.code==AidenPeerError.UNAVAILABLE;if(!keep)retainStop(null);_state.update{it.copy(problem=if(keep)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED,message=r.error)}}}
        }catch(e:CancellationException){if(current())_state.update{it.copy(problem=AidenRoutineControlProblem.UNCERTAIN)};throw e}
        catch(e:Exception){if(current()){val keep=unknown || aidenBotResumeFailureIsAmbiguous(e);if(!keep)retainStop(null);_state.update{it.copy(problem=if(keep)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED)}}}
        finally{if(current())_state.update{it.copy(busy=false)}}
    }
    suspend fun showEvidence(kind:AidenOpenWorkEvidenceKind){
        val row=_state.value.detail ?: return;if(!current() || !canReadExchanges() || _state.value.busy)return
        val g=++generation;_state.update{it.copy(loading=true,evidence=null)}
        try {val result=transport.evidence(row,kind);if(current() && canReadExchanges() && g==generation && selected==row.id){val owner=if(kind==AidenOpenWorkEvidenceKind.SOURCE)row.sender.botId else row.recipient.botId;check(result.exchangeId==row.id && result.kind==kind && result.botId==owner);_state.update{it.copy(evidence=result)}}}
        catch(e:CancellationException){throw e}catch(_:Exception){if(current() && g==generation)_state.update{it.copy(message="This exchange’s evidence is unavailable.")}}
        finally{if(g==generation)_state.update{it.copy(loading=false)}}
    }
    fun closeEvidence(){generation++;_state.update{it.copy(evidence=null,loading=false)}}
    companion object {
        const val RETRY_MS=23*60*60*1000L
        fun stopMessage(receipt:AidenPeerStopReceipt)=when(receipt.state){AidenPeerStopState.STOPPED->"The host acknowledged Stop. Earlier effects may remain.";AidenPeerStopState.NOT_RUNNING->"The linked work is no longer running.";AidenPeerStopState.BLOCKED->"Stop was refused. The work remains unfinished.";else->"Stop is pending. Check again for the host’s acknowledgement."}
    }
}
