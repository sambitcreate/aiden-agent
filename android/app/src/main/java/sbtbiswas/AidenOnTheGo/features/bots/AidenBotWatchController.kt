@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.JsonClassDiscriminator
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.util.UUID

interface AidenBotWatchTransport {
    suspend fun list(): AidenBotWatchList
    suspend fun sources(): AidenBotWatchSourceList
    suspend fun save(id: String?, request: AidenBotWatchSaveRequest): AidenBotWatch
    suspend fun enable(id: String, request: AidenBotWatchMutation): AidenBotWatch
    suspend fun remove(id: String, request: AidenBotWatchMutation): AidenBotWatchRemoval
    suspend fun test(request: AidenBotWatchTestRequest): AidenBotWatchTestResult
    suspend fun run(id: String, request: AidenBotWatchMutation): AidenBotWatchRunResult
}

@Serializable
data class AidenBotWatchDraft(
    val id: String? = null, val revision: String? = null, val name: String = "", val prompt: String = "",
    val condition: AidenBotWatchCondition = AidenBotWatchCondition.Email(unreadOnly = false),
    val everyMinutes: Int = 30, val calendarTimezone: String? = null, val sourceChoiceId: String? = null, val sourceLabel: String? = null
) {
    val valid: Boolean get() = name.isNotBlank() && prompt.isNotBlank() && (id != null || sourceChoiceId != null) &&
        runCatching { AidenBotWatchWire.config(name, prompt, everyMinutes); configuredCondition() }.isSuccess
    fun configuredCondition(): AidenBotWatchCondition = when (condition) {
        is AidenBotWatchCondition.Email -> condition
        is AidenBotWatchCondition.Calendar -> condition.copy(timezone = (calendarTimezone ?: condition.timezone).also { java.time.ZoneId.of(it) })
    }
}

enum class AidenBotWatchError { FAILED, UNCERTAIN, CONFLICT, PERMISSION, STORAGE }

data class AidenBotWatchUiState(
    val view: AidenBotWatchList? = null, val loading: Boolean = true, val sources: AidenBotWatchSourceList? = null,
    val draft: AidenBotWatchDraft? = null, val busy: Boolean = false, val discovering: Boolean = false,
    val error: AidenBotWatchError? = null, val pending: Boolean = false,
    val testResult: AidenBotWatchTestResult? = null, val runAdmitted: Boolean? = null
)

/** A frozen mutation survives a lost response. Only an explicit Retry resends its original UUID/body. */
class AidenBotWatchController(private val transport: AidenBotWatchTransport, private val canRead: () -> Boolean,
    private val canWrite: () -> Boolean, private val uuid: () -> String = { UUID.randomUUID().toString() },
    private val journal: AidenBotWatchJournal? = null) {
    private val _state = MutableStateFlow(AidenBotWatchUiState())
    val state = _state.asStateFlow()
    @Serializable
    @JsonClassDiscriminator("operation")
    private sealed interface Write {
        @Serializable @SerialName("save")
        data class Save(val id: String?, val body: AidenBotWatchSaveRequest) : Write
        @Serializable @SerialName("enable")
        data class Enable(val id: String, val body: AidenBotWatchMutation) : Write
        @Serializable @SerialName("remove")
        data class Remove(val id: String, val body: AidenBotWatchMutation) : Write
        @Serializable @SerialName("run")
        data class Run(val id: String, val body: AidenBotWatchMutation) : Write
    }
    private var pending: Write? = null
    private var generation = 0
    private var readSequence = 0

    @Serializable
    private data class SavedState(val draft: AidenBotWatchDraft? = null, val pending: Write? = null)
    private var unreadableJournal = false
    init {
        try {
            journal?.read()?.let { raw ->
                val saved = AidenBotWireJson.json.decodeFromString(SavedState.serializer(), raw)
                pending = saved.pending
                _state.value = AidenBotWatchUiState(draft = saved.draft, pending = pending != null,
                    error = if (pending != null) AidenBotWatchError.UNCERTAIN else null)
            }
        } catch (_: Exception) {
            unreadableJournal = true
            _state.value = AidenBotWatchUiState(error = AidenBotWatchError.STORAGE)
        }
    }

    /** A successful durable commit is a prerequisite for sending or forgetting an identity. */
    private fun persist(draft: AidenBotWatchDraft? = _state.value.draft, attempt: Write? = pending): Boolean = try {
        check(!unreadableJournal) { "Saved watch request is unreadable" }
        val saved = if (draft == null && attempt == null) null else
            AidenBotWireJson.json.encodeToString(SavedState.serializer(), SavedState(draft, attempt))
        journal?.write(saved)
        true
    } catch (_: Exception) {
        _state.update { it.copy(error = AidenBotWatchError.STORAGE) }
        false
    }

    /** Foreground status-cache reads only; its owning lifecycle cancels this loop on pause. */
    suspend fun refreshWhileActive(intervalMillis: Long = 15_000) {
        while (currentCoroutineContext().isActive) {
            load()
            delay(intervalMillis)
        }
    }

    suspend fun load() {
        if (_state.value.busy) return
        if (!canRead()) { _state.update { it.copy(loading = false, view = null, error = if (unreadableJournal) AidenBotWatchError.STORAGE else AidenBotWatchError.PERMISSION) }; return }
        val sequence = ++readSequence
        val started = generation
        _state.update { it.copy(loading = true) }
        try {
            val list = transport.list()
            if (!canRead() || sequence != readSequence || started != generation) return
            // The host uses the create mutation UUID as its watch ID. No matching on labels/content.
            val create = pending as? Write.Save
            val created = create?.takeIf { it.id == null }?.let { write -> list.watches.find { it.id == write.body.mutationId } }
            val removed = list.supported && (pending as? Write.Remove)?.let { write -> list.watches.none { it.id == write.id } } == true
            val settled = (created != null || removed) && persist(draft = if (created != null) null else _state.value.draft, attempt = null)
            if (settled) pending = null
            _state.update { it.copy(view = list, loading = false, pending = pending != null,
                draft = if (settled && created != null) null else it.draft,
                error = if (pending == null && it.error == AidenBotWatchError.UNCERTAIN) null else it.error) }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (sequence == readSequence) _state.update { it.copy(loading = false, error = it.error ?: AidenBotWatchError.FAILED) } }
    }

    fun begin(watch: AidenBotWatch? = null) {
        if (!canWrite() || _state.value.view?.supported != true || _state.value.busy || pending != null) return
        _state.update { it.copy(draft = watch?.let { w -> AidenBotWatchDraft(w.id, w.revision, w.name, w.prompt, w.condition,
            w.everyMinutes, sourceLabel = "${w.source.accountLabel} · ${w.source.resourceLabel}") } ?: AidenBotWatchDraft(),
            testResult = null, error = null) }
        persist()
    }
    fun edit(change: (AidenBotWatchDraft) -> AidenBotWatchDraft) {
        if (!canWrite() || _state.value.busy || pending != null) return
        _state.update { it.copy(draft = it.draft?.let(change), testResult = null) }
        persist()
    }
    fun closeDraft() {
        if (!_state.value.busy && pending == null && persist(draft = null)) _state.update { it.copy(draft = null, testResult = null) }
    }
    fun choose(source: AidenBotWatchSourceChoice) {
        if (!source.available || _state.value.view?.templates?.find { it.id == source.templateId }?.available != true) return
        edit { it.copy(sourceChoiceId = source.id, sourceLabel = "${source.accountLabel} · ${source.resourceLabel}",
            condition = if (source.templateId == it.condition.templateId) it.condition else when (source.templateId) {
                AidenBotWatchTemplateId.MAIL -> AidenBotWatchCondition.Email(unreadOnly = false)
                AidenBotWatchTemplateId.CALENDAR -> AidenBotWatchCondition.Calendar(60, java.time.ZoneId.systemDefault().id)
            }) }
    }
    suspend fun discover() {
        if (!canWrite() || _state.value.discovering || _state.value.busy || pending != null) return
        _state.update { it.copy(discovering = true) }
        try { val sources = transport.sources(); if (canWrite()) _state.update { it.copy(sources = sources) } }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { _state.update { it.copy(error = AidenBotWatchError.FAILED) } }
        finally { _state.update { it.copy(discovering = false) } }
    }
    /** Keep the person's words; using a newer revision requires a deliberate review action. */
    fun useLatestRevision() {
        if (pending != null || _state.value.busy || !canWrite()) return
        val draft = _state.value.draft ?: return
        val current = _state.value.view?.watches?.find { it.id == draft.id } ?: return
        _state.update { it.copy(draft = draft.copy(revision = current.revision,
            sourceLabel = if (draft.sourceChoiceId == null) "${current.source.accountLabel} · ${current.source.resourceLabel}" else draft.sourceLabel), error = null) }
        persist()
    }
    suspend fun save() {
        val draft = _state.value.draft ?: return
        if (!draft.valid || pending != null) return
        perform(Write.Save(draft.id, AidenBotWatchSaveRequest(draft.name.trim(), draft.prompt.trim(), draft.configuredCondition(),
            draft.everyMinutes, uuid(), draft.sourceChoiceId, draft.revision)))
    }
    suspend fun setEnabled(watch: AidenBotWatch) { if (pending == null) perform(Write.Enable(watch.id, AidenBotWatchMutation(watch.revision, uuid(), !watch.enabled))) }
    suspend fun remove(watch: AidenBotWatch) { if (pending == null) perform(Write.Remove(watch.id, AidenBotWatchMutation(watch.revision, uuid()))) }
    suspend fun run(watch: AidenBotWatch) { if (pending == null) perform(Write.Run(watch.id, AidenBotWatchMutation(watch.revision, uuid()))) }
    suspend fun retry() { pending?.let { perform(it) } }

    suspend fun test(watch: AidenBotWatch? = null) {
        if (!canWrite() || _state.value.busy || pending != null) return
        val draft = _state.value.draft
        val request = if (watch != null) AidenBotWatchTestRequest(id = watch.id, expectedRevision = watch.revision)
            else draft?.sourceChoiceId?.let { AidenBotWatchTestRequest(sourceChoiceId = it, condition = runCatching { draft.configuredCondition() }.getOrNull() ?: return) } ?: return
        _state.update { it.copy(busy = true, testResult = null, error = null) }
        try { val result = transport.test(request); if (canWrite()) _state.update { it.copy(testResult = result) } }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { _state.update { it.copy(error = AidenBotWatchError.FAILED) } }
        finally { _state.update { it.copy(busy = false) } }
    }
    private suspend fun perform(write: Write) {
        if (!canWrite() || _state.value.busy || unreadableJournal) return
        val wasPending = pending != null
        generation++
        pending = write
        _state.update { it.copy(busy = true, pending = true, error = null, runAdmitted = null, loading = false) }
        if (!persist()) { _state.update { it.copy(busy = false) }; return }
        try {
            when (write) {
                is Write.Save -> transport.save(write.id, write.body).also { view -> if (canRead()) accept(view) }
                is Write.Enable -> transport.enable(write.id, write.body).also { view -> if (canRead()) accept(view) }
                is Write.Remove -> transport.remove(write.id, write.body).also { result ->
                    if (canRead() && result.removed) _state.update { it.copy(view = it.view?.let { list -> list.copy(watches = list.watches.filterNot { w -> w.id == result.id }) }) }
                }
                is Write.Run -> transport.run(write.id, write.body).also { result -> if (canRead()) _state.update { it.copy(runAdmitted = result.admitted) } }
            }
            val nextDraft = if (write is Write.Save) null else _state.value.draft
            if (!persist(draft = nextDraft, attempt = null)) return
            pending = null
            _state.update { it.copy(pending = false, draft = nextDraft) }
        } catch (e: CancellationException) {
            _state.update { it.copy(error = AidenBotWatchError.UNCERTAIN) }; throw e
        } catch (e: Exception) {
            val server = e as? AidenRemoteClientException.Server
            val conflict = server?.body?.code == AidenRemoteErrorCode.REVISION_CONFLICT
            val definite = conflict || (server != null && server.statusCode in listOf(400, 401, 403, 404, 422) &&
                server.body.code !in listOf(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT, AidenRemoteErrorCode.IDEMPOTENCY_CONFLICT))
            val permissionDenied = server?.statusCode in listOf(401, 403)
            // A later guard failure cannot establish whether the original lost request ran.
            val cleared = !wasPending && definite && persist(attempt = null)
            if (cleared) pending = null
            _state.update { it.copy(pending = pending != null, error = when {
                permissionDenied -> AidenBotWatchError.PERMISSION
                wasPending -> AidenBotWatchError.UNCERTAIN
                definite && !cleared -> AidenBotWatchError.STORAGE
                conflict -> AidenBotWatchError.CONFLICT
                definite -> AidenBotWatchError.FAILED
                else -> AidenBotWatchError.UNCERTAIN
            }) }
        } finally { _state.update { it.copy(busy = false) } }
        // Authoritative refresh settles safe create/delete outcomes. No mutation is retried here.
        load()
    }
    private fun accept(watch: AidenBotWatch) {
        _state.update { it.copy(view = it.view?.let { list -> list.copy(watches = list.watches.filterNot { w -> w.id == watch.id } + watch) }) }
    }
}
