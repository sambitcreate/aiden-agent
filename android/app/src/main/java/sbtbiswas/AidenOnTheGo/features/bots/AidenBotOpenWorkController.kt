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
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.util.UUID

interface AidenBotOpenWorkTransport {
    suspend fun snapshot(): AidenOpenWorkSnapshot
    suspend fun mutate(mutation: AidenOpenWorkMutation): AidenOpenWorkResult
    suspend fun evidence(id: String, kind: AidenOpenWorkEvidenceKind): AidenOpenWorkEvidence
}
@Serializable data class AidenOpenWorkDraft(val id: String? = null, val expectedRevision: String, val title: String = "", val note: String = "", val state: AidenOpenWorkState = AidenOpenWorkState.OPEN, val waitingReason: String = "") {
    val valid: Boolean get() = runCatching {
        AidenOpenWorkWire.text(title,160,640); AidenOpenWorkWire.text(note,1000,2048,true)
        if (state == AidenOpenWorkState.WAITING) AidenOpenWorkWire.text(waitingReason,160,640)
    }.isSuccess
}
@Serializable data class AidenOpenWorkAttempt(val mutation: AidenOpenWorkMutation, val startedAt: Long)
enum class AidenOpenWorkProblem { FAILED, UNCERTAIN, UNAVAILABLE, STALE, STORAGE, PERMISSION, EXPIRED, BLOCKED }
data class AidenBotOpenWorkUiState(val snapshot: AidenOpenWorkSnapshot? = null, val loading: Boolean = true, val busy: Boolean = false,
    val draft: AidenOpenWorkDraft? = null, val pending: AidenOpenWorkAttempt? = null, val problem: AidenOpenWorkProblem? = null,
    val businessError: String? = null, val stop: AidenOpenWorkStopReceipt? = null,
    val evidence: AidenOpenWorkEvidence? = null, val evidenceTarget: Pair<String,AidenOpenWorkEvidenceKind>? = null,
    val evidenceLoading: Boolean = false, val evidenceFailed: Boolean = false)

/** All attempted writes are frozen and durably committed before transmission, including Stop and Undo. */
class AidenBotOpenWorkController(private val transport: AidenBotOpenWorkTransport, private val canRead: () -> Boolean,
    private val canWrite: () -> Boolean, private val journal: AidenBotWatchJournal,
    private val uuid: () -> String = { UUID.randomUUID().toString() }, private val now: () -> Long = System::currentTimeMillis) {
    @Serializable private data class Saved(val draft: AidenOpenWorkDraft? = null, val pending: AidenOpenWorkAttempt? = null)
    private val _state = MutableStateFlow(AidenBotOpenWorkUiState())
    val state = _state.asStateFlow()
    private var persisted: String? = null
    private var storageBlocked = false
    private var generation = 0
    private var reads = 0
    private var evidenceReads = 0
    init {
        try {
            persisted = journal.read()
            persisted?.let { val saved = AidenBotWireJson.json.decodeFromString(Saved.serializer(), it)
                _state.value = AidenBotOpenWorkUiState(draft = saved.draft, pending = saved.pending,
                    problem = if (saved.pending != null) AidenOpenWorkProblem.UNCERTAIN else null) }
        } catch (_: Exception) { storageBlocked = true; _state.value = AidenBotOpenWorkUiState(problem = AidenOpenWorkProblem.STORAGE) }
    }
    private fun persist(draft: AidenOpenWorkDraft? = _state.value.draft, pending: AidenOpenWorkAttempt? = _state.value.pending): Boolean = try {
        check(!storageBlocked)
        val encoded = if (draft == null && pending == null) null else AidenBotWireJson.json.encodeToString(Saved.serializer(), Saved(draft,pending))
        check(journal.replace(persisted, encoded)) { "Another window changed the saved request" }
        persisted = encoded
        true
    } catch (_: Exception) { _state.update { it.copy(problem = AidenOpenWorkProblem.STORAGE) }; false }
    private fun settle(snapshot: AidenOpenWorkSnapshot): Boolean {
        val attempt = _state.value.pending ?: return false
        val mutation = attempt.mutation
        val stopped = if (mutation.action.isStop) snapshot.items.find { it.id == mutation.id }?.lastStop
            ?.takeIf { it.mutationId == mutation.mutationId && it.state.terminal } else null
        val ordinary = mutation.action in listOf(AidenOpenWorkAction.ADD,AidenOpenWorkAction.EDIT,AidenOpenWorkAction.DISMISS) && snapshot.undo.any { it.mutationId == mutation.mutationId }
        if (stopped == null && !ordinary) return false
        val draft = if (mutation.action in listOf(AidenOpenWorkAction.ADD,AidenOpenWorkAction.EDIT)) null else _state.value.draft
        if (!persist(draft, null)) return false
        _state.update { it.copy(pending = null, draft = draft, stop = stopped,
            problem = if (stopped?.state == AidenOpenWorkStopState.BLOCKED) AidenOpenWorkProblem.BLOCKED else null, businessError = null) }
        return true
    }
    suspend fun load() {
        if (_state.value.busy) return
        if (!canRead()) { _state.update { it.copy(snapshot = null, loading = false, problem = if (storageBlocked) AidenOpenWorkProblem.STORAGE else AidenOpenWorkProblem.PERMISSION) }; return }
        val read = ++reads; val started = generation
        _state.update { it.copy(loading = true) }
        try {
            val snapshot = transport.snapshot()
            if (!canRead() || started != generation || read != reads) return
            // Execution and Stop projection may change even when the persisted revision is equal.
            _state.update { it.copy(snapshot = snapshot, loading = false) }
            settle(snapshot)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (read == reads && generation == started) _state.update { it.copy(loading = false, problem = it.problem ?: AidenOpenWorkProblem.FAILED) } }
    }
    suspend fun refreshWhileActive() { while (currentCoroutineContext().isActive) { load(); delay(15_000) } }
    private fun hasPendingStop(id: String?): Boolean = id != null &&
        _state.value.snapshot?.items?.any { it.id == id && it.hasPendingStop } == true

    fun begin(item: AidenOpenWorkItem? = null) {
        val snapshot = _state.value.snapshot ?: return
        if (!canWrite() || _state.value.pending != null || _state.value.busy || item?.hasPendingStop == true || hasPendingStop(item?.id)) return
        val draft = item?.let { AidenOpenWorkDraft(it.id,it.revision,it.title,it.note,it.state,it.waitingReason.orEmpty()) }
            ?: AidenOpenWorkDraft(expectedRevision = snapshot.revision)
        _state.update { it.copy(draft = draft, problem = null, businessError = null, stop = null) }; persist()
    }
    fun edit(change: (AidenOpenWorkDraft) -> AidenOpenWorkDraft) {
        if (!canWrite() || _state.value.pending != null || _state.value.busy || hasPendingStop(_state.value.draft?.id)) return
        _state.update { it.copy(draft = it.draft?.let(change)) }; persist()
    }
    fun closeDraft() { if (!_state.value.busy && _state.value.pending == null && persist(draft = null)) _state.update { it.copy(draft = null) } }
    fun useLatestRevision() {
        if (!canWrite() || _state.value.pending != null || _state.value.busy || hasPendingStop(_state.value.draft?.id)) return
        val draft = _state.value.draft ?: return
        val snapshot = _state.value.snapshot ?: return
        val revision = if (draft.id == null) snapshot.revision else snapshot.items.find { it.id == draft.id }?.revision ?: return
        _state.update { it.copy(draft = draft.copy(expectedRevision = revision), problem = null, businessError = null) }; persist()
    }
    suspend fun save() {
        val draft = _state.value.draft ?: return
        if (!draft.valid || _state.value.pending != null || !canWrite() || hasPendingStop(draft.id)) return
        val mutation = if (draft.id == null) AidenOpenWorkMutation(uuid(),AidenOpenWorkAction.ADD,draft.expectedRevision,title = draft.title.trim(),note = draft.note)
            else AidenOpenWorkMutation(uuid(),AidenOpenWorkAction.EDIT,draft.expectedRevision,id = draft.id,
                patch = AidenOpenWorkPatch(draft.title.trim(),draft.note,draft.state,draft.waitingReason.trim().takeIf { draft.state == AidenOpenWorkState.WAITING }))
        perform(AidenOpenWorkAttempt(mutation,now()))
    }
    suspend fun state(item: AidenOpenWorkItem, state: AidenOpenWorkState) {
        if (_state.value.pending != null || !canWrite() || state == AidenOpenWorkState.WAITING || item.hasPendingStop || hasPendingStop(item.id)) return
        val mutation = if (state == AidenOpenWorkState.DISMISSED) AidenOpenWorkMutation(uuid(),AidenOpenWorkAction.DISMISS,item.revision,id=item.id)
            else AidenOpenWorkMutation(uuid(),AidenOpenWorkAction.EDIT,item.revision,id=item.id,patch=AidenOpenWorkPatch(state=state))
        perform(AidenOpenWorkAttempt(mutation,now()))
    }
    suspend fun stop(item: AidenOpenWorkItem, dismiss: Boolean) {
        if (_state.value.pending != null || !canWrite() || !item.execution.canStop || item.hasPendingStop || hasPendingStop(item.id)) return
        perform(AidenOpenWorkAttempt(AidenOpenWorkMutation(uuid(),if (dismiss) AidenOpenWorkAction.STOP_AND_DISMISS else AidenOpenWorkAction.STOP,item.revision,id=item.id),now()))
    }
    suspend fun undo(option: AidenOpenWorkUndo) {
        if (_state.value.pending != null || !canWrite() || now() >= option.expiresAt || _state.value.snapshot?.undo?.contains(option) != true || hasPendingStop(option.itemId)) return
        perform(AidenOpenWorkAttempt(AidenOpenWorkMutation(uuid(),AidenOpenWorkAction.UNDO,option.expectedRevision,undoOf=option.mutationId),now()))
    }
    fun retryAllowed(): Boolean = _state.value.pending?.let { it.mutation.action.isStop || now() - it.startedAt in 0 until 23 * 60 * 60 * 1000L } == true
    suspend fun retry() {
        val pending = _state.value.pending ?: return
        if (!retryAllowed()) { _state.update { it.copy(problem = AidenOpenWorkProblem.EXPIRED) }; return }
        perform(pending)
    }
    private suspend fun perform(attempt: AidenOpenWorkAttempt) {
        if (!canWrite() || _state.value.busy || storageBlocked) return
        val previous = _state.value.pending != null
        generation++
        if (!persist(pending = attempt)) return
        _state.update { it.copy(pending = attempt,busy = true,loading = false,problem = null,businessError = null,stop = null) }
        try {
            val result = transport.mutate(attempt.mutation)
            if (!canRead()) return
            result.snapshot?.let { snapshot -> _state.update { it.copy(snapshot = snapshot) } }
            if (result.ok) {
                val stop = result.stop
                if (attempt.mutation.action.isStop && (stop == null || !stop.state.terminal)) {
                    _state.update { it.copy(stop = stop, problem = AidenOpenWorkProblem.UNCERTAIN) }
                } else {
                    val draft = if (attempt.mutation.action in listOf(AidenOpenWorkAction.ADD,AidenOpenWorkAction.EDIT)) null else _state.value.draft
                    if (persist(draft,null)) _state.update { it.copy(pending = null,draft = draft,stop = stop,
                        problem = if (stop?.state == AidenOpenWorkStopState.BLOCKED) AidenOpenWorkProblem.BLOCKED else null) }
                }
            } else {
                val uncertain = previous || result.code == AidenOpenWorkErrorCode.UNAVAILABLE
                if (!uncertain && persist(pending=null)) _state.update { it.copy(pending=null) }
                _state.update { it.copy(businessError=result.error,problem=when {
                    uncertain -> if (result.code == AidenOpenWorkErrorCode.UNAVAILABLE) AidenOpenWorkProblem.UNAVAILABLE else AidenOpenWorkProblem.UNCERTAIN
                    it.problem == AidenOpenWorkProblem.STORAGE -> AidenOpenWorkProblem.STORAGE
                    result.code == AidenOpenWorkErrorCode.STALE -> AidenOpenWorkProblem.STALE
                    result.code == AidenOpenWorkErrorCode.MIXED_INPUTS -> AidenOpenWorkProblem.BLOCKED
                    else -> AidenOpenWorkProblem.FAILED
                }) }
                result.snapshot?.let { settle(it) }
            }
        } catch (e: CancellationException) { _state.update { it.copy(problem = AidenOpenWorkProblem.UNCERTAIN) }; throw e }
        catch (e: Exception) {
            val server = e as? AidenRemoteClientException.Server
            val definite = server?.statusCode in listOf(400,401,403,404,409,422)
            if (!previous && definite && persist(pending=null)) _state.update { it.copy(pending=null) }
            _state.update { it.copy(problem = if (it.pending != null) AidenOpenWorkProblem.UNCERTAIN else AidenOpenWorkProblem.FAILED) }
        } finally { _state.update { it.copy(busy=false) } }
        load()
    }
    fun closeEvidence() { evidenceReads++; _state.update { it.copy(evidence=null,evidenceTarget=null,evidenceLoading=false,evidenceFailed=false) } }
    suspend fun evidence(item: AidenOpenWorkItem, kind: AidenOpenWorkEvidenceKind) {
        if (!canRead()) return
        val sequence = ++evidenceReads
        _state.update { it.copy(evidence=null,evidenceTarget=item.id to kind,evidenceLoading=true,evidenceFailed=false) }
        try { val value = transport.evidence(item.id,kind); if (canRead() && sequence == evidenceReads) _state.update { it.copy(evidence=value,evidenceLoading=false) } }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (sequence == evidenceReads) _state.update { it.copy(evidenceLoading=false,evidenceFailed=true) } }
    }
}
