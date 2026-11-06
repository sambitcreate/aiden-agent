package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import java.util.UUID

interface AidenBotRoutineModelsTransport {
    suspend fun settings(): AidenRoutineModelSettings
    suspend fun catalog(): AidenRoutineModelCatalog
    suspend fun runs(): List<AidenRoutineModelRun>
    suspend fun save(request: AidenRoutineModelSave): AidenRoutineModelResult
}
@Serializable data class AidenRoutineModelAttempt(val request: AidenRoutineModelSave, val startedAt: Long)
enum class AidenRoutineControlProblem { FAILED, UNCERTAIN, STORAGE, EXPIRED }
data class AidenBotRoutineModelsUiState(val settings: AidenRoutineModelSettings? = null,
    val baseline: AidenRoutineModelSettings? = null, val draft: AidenRoutineModelSelection? = null,
    val catalog: AidenRoutineModelCatalog? = null, val runs: List<AidenRoutineModelRun> = emptyList(),
    val pending: AidenRoutineModelAttempt? = null, val loading: Boolean = false, val busy: Boolean = false,
    val needsReview: Boolean = false, val problem: AidenRoutineControlProblem? = null)

/** Scoped to one host/device/Bot/routine; every write freezes a UUID and full payload before transport. */
class AidenBotRoutineModelsController(val botId: String, private val routineId: String,
    private val transport: AidenBotRoutineModelsTransport, private val canRead: () -> Boolean,
    private val canWrite: () -> Boolean, private val journal: AidenBotWatchJournal,
    private val uuid: () -> String = { UUID.randomUUID().toString() }, private val now: () -> Long = System::currentTimeMillis) {
    @Serializable private data class Saved(val baseline: AidenRoutineModelSettings, val draft: AidenRoutineModelSelection, val pending: AidenRoutineModelAttempt? = null)
    private val _state = MutableStateFlow(AidenBotRoutineModelsUiState())
    val state = _state.asStateFlow()
    private var persisted: String? = null
    private var storageBlocked = false
    private var generation = 0
    private var invalidated = false
    init {
        try {
            persisted = journal.read()
            persisted?.let { raw ->
                val saved = AidenRoutineModelWire.decode(Saved.serializer(),raw)
                check(saved.baseline.botId == botId && saved.baseline.routineId == routineId)
                saved.pending?.let { check(it.request.botId == botId && it.request.routineId == routineId && it.startedAt >= 0) }
                _state.value = AidenBotRoutineModelsUiState(baseline=saved.baseline,draft=saved.draft,pending=saved.pending,
                    problem=if(saved.pending!=null) AidenRoutineControlProblem.UNCERTAIN else null)
            }
        } catch(_: Exception) { storageBlocked=true; _state.value=AidenBotRoutineModelsUiState(problem=AidenRoutineControlProblem.STORAGE) }
        journal.onInvalidated(::invalidate)
    }
    private fun invalidate() {
        invalidated=true; generation++; persisted=null
        _state.value=AidenBotRoutineModelsUiState()
    }
    private fun current(): Boolean {
        if(!journal.isCurrent && !invalidated) invalidate()
        return !invalidated
    }
    private fun retain(next: AidenBotRoutineModelsUiState): Boolean {
        if(!current() || storageBlocked) return false
        return try {
            val encoded=next.baseline?.let { base -> AidenBotWireJson.json.encodeToString(Saved.serializer(),Saved(base,requireNotNull(next.draft),next.pending)) }
            check(journal.replace(persisted,encoded)); persisted=encoded; _state.value=next; true
        } catch(_: Exception) { storageBlocked=true; _state.update { it.copy(problem=AidenRoutineControlProblem.STORAGE) }; false }
    }
    fun editable()=current() && canRead() && canWrite() && !storageBlocked && !_state.value.busy && _state.value.pending==null && _state.value.settings!=null
    fun saveAllowed(): Boolean {
        val ui=_state.value; val draft=ui.draft ?: return false; val catalog=ui.catalog ?: return false
        return editable() && !ui.needsReview && draft!=ui.baseline?.selection && listOfNotNull(draft.primary,draft.fallback).all(catalog::admits)
    }
    private fun apply(settings: AidenRoutineModelSettings) {
        check(settings.botId==botId && settings.routineId==routineId)
        val ui=_state.value
        if(ui.pending!=null && settings.lastMutationId==ui.pending.request.mutationId) {
            retain(ui.copy(settings=settings,baseline=settings,draft=settings.selection,pending=null,needsReview=false,problem=null))
        } else if(ui.baseline==null) retain(ui.copy(settings=settings,baseline=settings,draft=settings.selection))
        else _state.update { it.copy(settings=settings,needsReview=it.baseline?.revision!=settings.revision) }
    }
    suspend fun load() {
        if(!current() || !canRead() || _state.value.busy) return
        val read=++generation; _state.update { it.copy(loading=true) }
        try {
            val settings=transport.settings()
            if(!current() || !canRead() || read!=generation) return
            apply(settings)
            val runs=AidenRoutineModelWire.runs(transport.runs())
            if(!current() || !canRead() || read!=generation) return
            _state.update { it.copy(runs=runs) }
            val catalog=if(canWrite())transport.catalog() else null
            if(!current() || !canRead() || read!=generation) return
            _state.update { it.copy(catalog=if(canWrite())catalog else null) }
        } catch(e: CancellationException) { throw e }
        catch(_: Exception) { if(current() && canRead() && read==generation) _state.update { it.copy(problem=it.problem ?: AidenRoutineControlProblem.FAILED) } }
        finally { if(read==generation) _state.update { it.copy(loading=false) } }
    }
    suspend fun refreshWhileActive() { while(currentCoroutineContext().isActive) { load(); delay(15_000) } }
    fun select(choice: AidenRoutineModelChoice, fallback: Boolean) {
        if(!editable() || _state.value.catalog?.admits(choice)!=true) return
        val draft=_state.value.draft ?: return
        val next=if(fallback) draft.primary?.let { AidenRoutineModelSelection(AidenRoutineModelMode.SELECTED,it,choice) } ?: return
            else AidenRoutineModelSelection(AidenRoutineModelMode.SELECTED,choice,draft.fallback)
        retain(_state.value.copy(draft=next))
    }
    fun inherit() { if(editable()) retain(_state.value.copy(draft=AidenRoutineModelSelection.Inherit)) }
    fun clearFallback() { val ui=_state.value; if(editable() && ui.draft?.primary!=null) retain(ui.copy(draft=ui.draft.copy(fallback=null))) }
    fun reviewKeepingDraft() { val ui=_state.value; if(editable() && ui.settings!=null) retain(ui.copy(baseline=ui.settings,needsReview=false,problem=null)) }
    fun useSaved() { val ui=_state.value; if(editable() && ui.settings!=null) retain(ui.copy(baseline=ui.settings,draft=ui.settings.selection,needsReview=false,problem=null)) }
    suspend fun save() {
        if(!saveAllowed()) return
        val ui=_state.value
        val attempt=AidenRoutineModelAttempt(AidenRoutineModelSave(botId,routineId,uuid(),ui.baseline!!.revision,ui.catalog!!.revision,ui.draft!!),now())
        if(retain(ui.copy(pending=attempt))) send(attempt,false)
    }
    fun retryAllowed()=_state.value.pending?.let { now()-it.startedAt in 0 until 23*60*60*1000L }==true
    suspend fun retry() {
        val attempt=_state.value.pending ?: return
        if(!retryAllowed()) { _state.update { it.copy(problem=AidenRoutineControlProblem.EXPIRED) }; return }
        send(attempt,true)
    }
    private suspend fun send(attempt: AidenRoutineModelAttempt, previouslyUnknown: Boolean) {
        if(!current() || !canRead() || !canWrite() || storageBlocked || _state.value.busy) return
        if(previouslyUnknown && !retain(_state.value.copy(pending=attempt))) return
        generation++; _state.update { it.copy(busy=true,loading=false,problem=null) }
        try {
            val result=transport.save(attempt.request)
            if(!current() || !canRead()) return
            result.settings?.let { check(it.botId==botId && it.routineId==routineId) }
            if(result.ok) {
                check(result.mutationId==attempt.request.mutationId)
                val saved=requireNotNull(result.settings)
                retain(_state.value.copy(settings=saved,baseline=saved,draft=saved.selection,pending=null,needsReview=false,problem=null))
            } else {
                result.settings?.let(::apply)
                if(_state.value.pending!=null) {
                    val unknown=previouslyUnknown || result.code==AidenRoutineModelError.UNAVAILABLE
                    retain(_state.value.copy(pending=if(unknown)attempt else null,
                        needsReview=_state.value.needsReview || result.code==AidenRoutineModelError.CONFLICT,
                        problem=if(unknown)AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED))
                }
            }
        } catch(e: CancellationException) { if(current()) _state.update { it.copy(problem=AidenRoutineControlProblem.UNCERTAIN) }; throw e }
        catch(e: Exception) {
            if(current() && canRead()) retain(_state.value.copy(pending=if(previouslyUnknown || aidenBotMessageFailureIsAmbiguous(e))attempt else null,
                problem=if(previouslyUnknown || aidenBotMessageFailureIsAmbiguous(e))AidenRoutineControlProblem.UNCERTAIN else AidenRoutineControlProblem.FAILED))
        } finally { _state.update { it.copy(busy=false) } }
    }
}
