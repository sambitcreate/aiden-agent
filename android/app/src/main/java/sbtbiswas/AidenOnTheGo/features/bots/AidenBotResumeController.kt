package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.util.UUID

interface AidenBotResumeTransport {
    suspend fun status(): AidenBotResumeStatus
    suspend fun resume(key: UUID, request: AidenBotResumeRequest): AidenBotSessionStateView
}
/** A status or retryable flag alone cannot prove that Resume had no effect. */
internal fun aidenBotResumeFailureIsAmbiguous(error: Exception): Boolean {
    if(error is AidenRemoteClientException.Server) {
        val beforeEffectCodes=setOf("invalid_request","payload_too_large","authentication_required","credential_revoked",
            "capability_denied","server_identity_changed","not_found","bot_archived","operation_stale","bot_paused",
            "idempotency_conflict","idempotency_capacity","rate_limited")
        if(error.body.code.rawValue !in beforeEffectCodes) return true
    }
    if(error is AidenRemoteClientException.UnexpectedStatus) return true
    return aidenBotMessageFailureIsAmbiguous(error)
}
@Serializable data class AidenBotResumeAttempt(val key: String, val request: AidenBotResumeRequest, val startedAt: Long) {
    init { AidenOpenWorkWire.uuid(key); check(startedAt>=0) }
}
data class AidenBotResumeUiState(val pending: AidenBotResumeAttempt? = null, val consentSubmissionId: String? = null, val consentCostReceiptId: String? = null,
    val busy: Boolean = false, val problem: AidenRoutineControlProblem? = null)

/** Passive preflight runs only on explicit Resume; consent never attaches to another interrupted source. */
class AidenBotResumeController(private val transport: AidenBotResumeTransport, private val mayResume: () -> Boolean,
    private val supportsPreflight: () -> Boolean, private val version: () -> String, private val journal: AidenBotWatchJournal,
    private val uuid: () -> UUID = UUID::randomUUID, private val now: () -> Long = System::currentTimeMillis) {
    private val _state=MutableStateFlow(AidenBotResumeUiState()); val state=_state.asStateFlow()
    private var persisted: String?=null; private var storageBlocked=false; private var consentVersion: String?=null; private var invalidated=false
    init { try { persisted=journal.read(); persisted?.let { _state.value=AidenBotResumeUiState(pending=AidenRoutineModelWire.decode(AidenBotResumeAttempt.serializer(),it),problem=AidenRoutineControlProblem.UNCERTAIN) } }
        catch(_: Exception) { storageBlocked=true; _state.value=AidenBotResumeUiState(problem=AidenRoutineControlProblem.STORAGE) }
        journal.onInvalidated(::invalidate)
    }
    private fun invalidate() { invalidated=true; persisted=null; consentVersion=null; _state.value=AidenBotResumeUiState() }
    private fun current(): Boolean { if(!journal.isCurrent && !invalidated)invalidate();return !invalidated }
    internal fun hasCurrentScope(): Boolean = current()
    private fun retain(attempt: AidenBotResumeAttempt?): Boolean {
        if(!current()) return false
        return try {
        check(!storageBlocked)
        val raw=attempt?.let { AidenBotWireJson.json.encodeToString(AidenBotResumeAttempt.serializer(),it) }
        check(journal.replace(persisted,raw)); persisted=raw; _state.update { it.copy(pending=attempt) }; true
        } catch(_: Exception) { storageBlocked=true; _state.update { it.copy(problem=AidenRoutineControlProblem.STORAGE) }; false }
    }
    fun cancelConsent() { consentVersion=null; _state.update { it.copy(consentSubmissionId=null,consentCostReceiptId=null) } }
    suspend fun request(): AidenBotSessionStateView? {
        if(!current() || !mayResume() || _state.value.busy || storageBlocked) return null
        _state.value.pending?.let { return send(it,true) }
        cancelConsent()
        if(supportsPreflight()) {
            val before=version(); _state.update { it.copy(busy=true,problem=null) }
            try {
                val status=transport.status()
                if(!current() || !mayResume() || !supportsPreflight() || version()!=before) return null
                if(status.requiresUnknownCostAcknowledgement) { consentVersion=before; _state.update { it.copy(consentSubmissionId=status.interruptedSubmissionId,consentCostReceiptId=status.costReceiptId) }; return null }
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { if(current()) _state.update { it.copy(problem=AidenRoutineControlProblem.FAILED) }; return null }
            finally { _state.update { it.copy(busy=false) } }
        }
        return begin(AidenBotResumeRequest())
    }
    suspend fun confirm(): AidenBotSessionStateView? {
        val source=_state.value.consentSubmissionId
        val receipt=_state.value.consentCostReceiptId
        if(source==null || receipt==null || !current() || consentVersion!=version() || !mayResume() || !supportsPreflight() || _state.value.busy || _state.value.pending!=null || storageBlocked) { cancelConsent(); return null }
        cancelConsent()
        return begin(AidenBotResumeRequest(true,source,receipt))
    }
    private suspend fun begin(request: AidenBotResumeRequest): AidenBotSessionStateView? {
        val attempt=AidenBotResumeAttempt(uuid().toString(),request,now())
        if(!retain(attempt)) return null
        return send(attempt,false)
    }
    private suspend fun send(attempt: AidenBotResumeAttempt, previouslyUnknown: Boolean): AidenBotSessionStateView? {
        if(!current() || !mayResume() || _state.value.busy || storageBlocked) return null
        if(attempt.request.acknowledgeUnknownCost==true && !supportsPreflight()) {
            _state.update{it.copy(problem=AidenRoutineControlProblem.UNCERTAIN)};return null
        }
        if(now()-attempt.startedAt !in 0 until 23*60*60*1000L) { _state.update { it.copy(problem=AidenRoutineControlProblem.EXPIRED) }; return null }
        if(previouslyUnknown && !retain(attempt)) return null
        _state.update { it.copy(busy=true,problem=null) }
        try {
            val reply=transport.resume(UUID.fromString(attempt.key),attempt.request)
            if(!current() || !mayResume()) return null
            if(retain(null)) return reply
        } catch(e: CancellationException) { if(current()) _state.update { it.copy(problem=AidenRoutineControlProblem.UNCERTAIN) }; throw e }
        catch(e: Exception) {
            if(!current()) return null
            val unknown=previouslyUnknown || aidenBotResumeFailureIsAmbiguous(e)
            if(!unknown) retain(null)
            _state.update { it.copy(problem=if(storageBlocked)AidenRoutineControlProblem.STORAGE else if(unknown)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED) }
        } finally { _state.update { it.copy(busy=false) } }
        return null
    }
}
