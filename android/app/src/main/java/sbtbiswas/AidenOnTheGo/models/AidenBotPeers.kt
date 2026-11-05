@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.*

/** Revision 58. Closed owner-facing records: no peer authority, tools, grants, or credentials. */
object AidenPeerWire {
    const val PUBLIC_BYTES=900*1024
    const val MUTATION_BYTES=16*1024
    fun id(value:String)=AidenOpenWorkWire.id(value)
    fun label(value:String)=AidenOpenWorkWire.text(value,160,640)
    fun <T> decode(serializer:KSerializer<T>,text:String):T=AidenRoutineModelWire.decode(serializer,text)
}
@Serializable data class AidenPeerIdentity(val botId:String,val name:String) { init { AidenPeerWire.id(botId);AidenPeerWire.label(name) } }
@Serializable data class AidenPeerPair(val id:String,val revision:String,val peer:AidenPeerIdentity,@Serializable(with=AidenBotWatchTimestampSerializer::class)val approvedAt:Long) { init { AidenPeerWire.id(id);AidenPeerWire.id(revision) } }
@Serializable data class AidenPeerSettings(val botId:String,val revision:String,val routingDescription:String,val pairs:List<AidenPeerPair>,@Serializable(with=AidenBotWatchTimestampSerializer::class)val updatedAt:Long,val lastMutationId:String?=null) {
    init { AidenPeerWire.id(botId);AidenPeerWire.id(revision);AidenOpenWorkWire.text(routingDescription,1000,2048,true);lastMutationId?.let(AidenOpenWorkWire::uuid);AidenOpenWorkWire.check(pairs.size<=128 && pairs.distinctBy{it.id}.size==pairs.size && pairs.distinctBy{it.peer.botId}.size==pairs.size && pairs.none{it.peer.botId==botId}) }
}
@Serializable data class AidenPeerOption(val botId:String,val name:String,@Serializable(with=AidenStrictBooleanSerializer::class)val available:Boolean) { init{AidenPeerWire.id(botId);AidenPeerWire.label(name)} }
@Serializable data class AidenPeerCatalog(val botId:String,val revision:String,val bots:List<AidenPeerOption>) { init{AidenPeerWire.id(botId);AidenPeerWire.id(revision);AidenOpenWorkWire.check(bots.size<=128 && bots.distinctBy{it.botId}.size==bots.size && bots.none{it.botId==botId})} }
@Serializable enum class AidenPeerAction { @SerialName("describe") DESCRIBE,@SerialName("approve") APPROVE,@SerialName("revoke") REVOKE }
@Serializable data class AidenPeerMutation(val action:AidenPeerAction,val botId:String,val mutationId:String,val expectedRevision:String,val routingDescription:String?=null,val catalogRevision:String?=null,val peerBotId:String?=null,val pairId:String?=null,val pairRevision:String?=null) {
    init {
        AidenPeerWire.id(botId);AidenOpenWorkWire.uuid(mutationId);AidenPeerWire.id(expectedRevision)
        when(action) {
            AidenPeerAction.DESCRIBE->{AidenOpenWorkWire.check(routingDescription!=null && catalogRevision==null && peerBotId==null && pairId==null && pairRevision==null);AidenOpenWorkWire.text(routingDescription!!,1000,2048,true)}
            AidenPeerAction.APPROVE->{AidenOpenWorkWire.check(routingDescription==null && catalogRevision!=null && peerBotId!=null && pairId==null && pairRevision==null);AidenPeerWire.id(catalogRevision!!);AidenPeerWire.id(peerBotId!!)}
            AidenPeerAction.REVOKE->{AidenOpenWorkWire.check(routingDescription==null && catalogRevision==null && peerBotId==null && pairId!=null && pairRevision!=null);AidenPeerWire.id(pairId!!);AidenPeerWire.id(pairRevision!!)}
        }
    }
}
@Serializable enum class AidenPeerError { @SerialName("invalid") INVALID,@SerialName("conflict") CONFLICT,@SerialName("unavailable") UNAVAILABLE,@SerialName("history_full") HISTORY_FULL,@SerialName("access_changed") ACCESS_CHANGED,@SerialName("not_found") NOT_FOUND }
@Serializable data class AidenPeerMutationResult(@Serializable(with=AidenStrictBooleanSerializer::class)val ok:Boolean,val mutationId:String?=null,@Serializable(with=AidenStrictBooleanSerializer::class)val replayed:Boolean?=null,val snapshot:AidenPeerSettings?=null,val code:AidenPeerError?=null,val error:String?=null) {
    init { if(ok){AidenOpenWorkWire.check(mutationId!=null && replayed!=null && snapshot!=null && code==null && error==null);AidenOpenWorkWire.uuid(mutationId!!)}else{AidenOpenWorkWire.check(mutationId==null && replayed==null && code!=null && error!=null);AidenOpenWorkWire.text(error!!,1000,2048)} }
}
@Serializable enum class AidenPeerDirection { @SerialName("sent") SENT,@SerialName("received") RECEIVED }
@Serializable enum class AidenPeerMessageKind { @SerialName("request") REQUEST,@SerialName("question") QUESTION,@SerialName("status") STATUS,@SerialName("fyi") FYI,@SerialName("result") RESULT }
@Serializable enum class AidenPeerExchangeState { @SerialName("waiting") WAITING,@SerialName("queued") QUEUED,@SerialName("running") RUNNING,@SerialName("interrupted") INTERRUPTED,@SerialName("stopping") STOPPING,@SerialName("completed") COMPLETED,@SerialName("failed") FAILED,@SerialName("cancelled") CANCELLED,@SerialName("expired") EXPIRED,@SerialName("uncertain") UNCERTAIN }
@Serializable enum class AidenPeerReturnState { @SerialName("reserved") RESERVED,@SerialName("waiting") WAITING,@SerialName("queued") QUEUED,@SerialName("delivered") DELIVERED,@SerialName("not_applicable") NOT_APPLICABLE }
@Serializable enum class AidenPeerStopState { @SerialName("requested") REQUESTED,@SerialName("uncertain") UNCERTAIN,@SerialName("stopped") STOPPED,@SerialName("not_running") NOT_RUNNING,@SerialName("blocked") BLOCKED; val terminal:Boolean get()=this!=REQUESTED && this!=UNCERTAIN }
@Serializable enum class AidenPeerStopReason { @SerialName("mixed_inputs") MIXED_INPUTS,@SerialName("host_unavailable") HOST_UNAVAILABLE,@SerialName("stale_source") STALE_SOURCE }
@Serializable data class AidenPeerStopReceipt(val mutationId:String,val state:AidenPeerStopState,@Serializable(with=AidenBotWatchTimestampSerializer::class)val at:Long,val reason:AidenPeerStopReason?=null) { init{AidenOpenWorkWire.uuid(mutationId)} }
@Serializable data class AidenPeerRequest(val text:String) { init{AidenOpenWorkWire.text(text,8192,8192)} }
@Serializable enum class AidenPeerOutcome { @SerialName("completed") COMPLETED,@SerialName("failed") FAILED,@SerialName("cancelled") CANCELLED,@SerialName("expired") EXPIRED }
@Serializable data class AidenPeerResult(val outcome:AidenPeerOutcome,val text:String,@Serializable(with=AidenStrictBooleanSerializer::class)val truncated:Boolean,@Serializable(with=AidenBotWatchTimestampSerializer::class)val createdAt:Long) { init{AidenOpenWorkWire.text(text,16384,16384,true)} }
/** Summary and detail share wire fields; detail() and list construction enforce their distinct shapes. */
@Serializable data class AidenPeerExchange(val id:String,val revision:String,val pairId:String,val sender:AidenPeerIdentity,val recipient:AidenPeerIdentity,val direction:AidenPeerDirection,val kind:AidenPeerMessageKind,val title:String,val state:AidenPeerExchangeState,
    @Serializable(with=AidenBotWatchTimestampSerializer::class)val createdAt:Long,@Serializable(with=AidenBotWatchTimestampSerializer::class)val updatedAt:Long,@Serializable(with=AidenBotWatchTimestampSerializer::class)val expiresAt:Long,
    @Serializable(with=AidenStrictBooleanSerializer::class)val canStop:Boolean,val returnState:AidenPeerReturnState,val parentExchangeId:String?=null,val rootExchangeId:String?=null,val blockedReason:String?=null,val lastStop:AidenPeerStopReceipt?=null,val request:AidenPeerRequest?=null,val result:AidenPeerResult?=null) {
    init { listOfNotNull(id,revision,pairId,parentExchangeId,rootExchangeId).forEach(AidenPeerWire::id);AidenPeerWire.label(title);blockedReason?.let{AidenOpenWorkWire.text(it,1000,2048)};AidenOpenWorkWire.check(sender.botId!=recipient.botId && kind!=AidenPeerMessageKind.RESULT && (request!=null || result==null)) }
    fun belongsTo(botId:String)=if(direction==AidenPeerDirection.SENT)sender.botId==botId else recipient.botId==botId
    fun detail()=also{AidenOpenWorkWire.check(request!=null)}
    val peer:AidenPeerIdentity get()=if(direction==AidenPeerDirection.SENT)recipient else sender
    val hasPendingStop:Boolean get()=state==AidenPeerExchangeState.STOPPING || lastStop?.state?.terminal==false
}
@Serializable data class AidenPeerExchangeList(val botId:String,val revision:String,val exchanges:List<AidenPeerExchange>) { init{AidenPeerWire.id(botId);AidenPeerWire.id(revision);AidenOpenWorkWire.check(exchanges.size<=128 && exchanges.distinctBy{it.id}.size==exchanges.size && exchanges.all{it.belongsTo(botId) && it.request==null && it.result==null})} }
@Serializable data class AidenPeerStopMutation(val botId:String,val exchangeId:String,val mutationId:String,val expectedRevision:String) { init{listOf(botId,exchangeId,expectedRevision).forEach(AidenPeerWire::id);AidenOpenWorkWire.uuid(mutationId)} }
@Serializable data class AidenPeerStopResult(@Serializable(with=AidenStrictBooleanSerializer::class)val ok:Boolean,val mutationId:String?=null,@Serializable(with=AidenStrictBooleanSerializer::class)val replayed:Boolean?=null,val exchange:AidenPeerExchange?=null,val code:AidenPeerError?=null,val error:String?=null) {
    init { exchange?.detail();if(ok){AidenOpenWorkWire.check(mutationId!=null && replayed!=null && exchange!=null && code==null && error==null);AidenOpenWorkWire.uuid(mutationId!!)}else{AidenOpenWorkWire.check(mutationId==null && replayed==null && code!=null && error!=null);AidenOpenWorkWire.text(error!!,1000,2048)} }
}
@Serializable data class AidenPeerEvidence(val exchangeId:String,val kind:AidenOpenWorkEvidenceKind,val botId:String,val submissionId:String,val entryId:String,val title:String,val text:String,@Serializable(with=AidenStrictBooleanSerializer::class)val truncated:Boolean,@Serializable(with=AidenBotWatchTimestampSerializer::class)val createdAt:Long?=null) { init{AidenPeerWire.id(exchangeId);AidenPeerWire.id(botId);AidenOpenWorkWire.decimal(submissionId);AidenOpenWorkWire.decimal(entryId);AidenPeerWire.label(title);AidenOpenWorkWire.text(text,32768,32768,true)} }
