package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import sbtbiswas.AidenOnTheGo.models.AidenBotMemory
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryEdit
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryStore
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryTarget
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryWire
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.text.NumberFormat
import java.util.Locale
import java.util.UUID

/** The memory routes (`bot-memory-v1`). [AidenRemoteClient] provides them on a revision-27 Mac. */
interface AidenBotMemoryTransport {
    suspend fun memory(botId: String): AidenBotMemory
    suspend fun edit(botId: String, edit: AidenBotMemoryEdit, key: UUID): AidenBotMemory
}

/** The memory routes on [client]'s Mac, read at each request so the page needn't wait for the connection to open. */
class AidenRemoteBotMemoryTransport(private val client: () -> AidenRemoteClient?) : AidenBotMemoryTransport {
    private fun connected() = client() ?: throw AidenRemoteClientException.Disconnected()
    override suspend fun memory(botId: String) = connected().botMemory(botId)
    override suspend fun edit(botId: String, edit: AidenBotMemoryEdit, key: UUID) = connected().editBotMemory(botId, edit, key)
}

/** Why a memory write didn't land, in the terms the person sees. */
enum class AidenBotMemoryError {
    /** Looks like a password or an instruction to the Bot. */
    BLOCKED,
    /** The group would go over its character budget. */
    OVER_BUDGET,
    /** The entry changed or went away since the page loaded. */
    NOT_FOUND,
    /** Anything else, including no answer from the Mac. */
    FAILED
}

fun aidenBotMemoryError(error: Exception): AidenBotMemoryError {
    val server = error as? AidenRemoteClientException.Server ?: return AidenBotMemoryError.FAILED
    return when (server.body.code) {
        AidenRemoteErrorCode.MEMORY_BLOCKED -> AidenBotMemoryError.BLOCKED
        AidenRemoteErrorCode.MEMORY_OVER_BUDGET -> AidenBotMemoryError.OVER_BUDGET
        AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND -> AidenBotMemoryError.NOT_FOUND
        else -> AidenBotMemoryError.FAILED
    }
}

/** The quiet count on Profile → Memory. */
sealed class AidenBotMemorySummary {
    object Unreadable : AidenBotMemorySummary()
    object Empty : AidenBotMemorySummary()
    data class Things(val count: Int) : AidenBotMemorySummary()

    companion object {
        fun of(view: AidenBotMemory): AidenBotMemorySummary = when {
            !view.readable -> Unreadable
            view.entryCount == 0 -> Empty
            else -> Things(view.entryCount)
        }
    }
}

/** The usage meter's fill, from empty to full. */
fun aidenBotMemoryUsageFraction(store: AidenBotMemoryStore): Float =
    (store.usedChars.toFloat() / store.limitChars.toFloat()).coerceIn(0f, 1f)

/** The usage meter's two numbers, grouped for [locale] ("563", "1,375"). */
fun aidenBotMemoryUsageNumbers(store: AidenBotMemoryStore, locale: Locale = Locale.getDefault()): Pair<String, String> {
    val format = NumberFormat.getIntegerInstance(locale)
    return format.format(store.usedChars) to format.format(store.limitChars)
}

/** The open Edit dialog: one entry's draft text and how its last save went. */
data class AidenBotMemoryEditing(
    val target: AidenBotMemoryTarget,
    val entryId: String,
    val text: String,
    val isSaving: Boolean = false,
    val error: AidenBotMemoryError? = null
) {
    val trimmed: String get() = text.trim()
    val canSave: Boolean get() = !isSaving && trimmed.isNotEmpty() && trimmed.codePointCount(0, trimmed.length) <= AidenBotMemoryWire.MAX_ENTRY_LENGTH
}

data class AidenBotMemoryUiState(
    val view: AidenBotMemory? = null,
    val isLoading: Boolean = true,
    val loadFailed: Boolean = false,
    val editing: AidenBotMemoryEditing? = null,
    val isErasing: Boolean = false,
    /** Ids with a Delete in flight; their rows are disabled. */
    val deleting: Set<String> = emptySet(),
    /** A failed Delete, shown under the page. */
    val actionError: AidenBotMemoryError? = null,
    /** The last Erase didn't land. */
    val eraseFailed: Boolean = false
)

/**
 * Drives Profile → Memory: loads `GET /bots/{id}/memory` and saves edits through
 * `POST /bots/{id}/memory/edits`.
 *
 * Every edit applies at once (R15): Save closes the dialog with the new words in place, Delete
 * takes the row away, Erase empties both groups. The Mac's answer replaces that; a failure puts
 * back what was there (unless the Mac's own view has replaced it since), says why, reopens an
 * edit's dialog on the person's words, and reloads, because an error answer carries no view.
 * Nothing waits for the connection to show a change: a request waits for it, up to
 * [holdMillis], and is bounded by [limitMillis].
 */
class AidenBotMemoryController(
    val botId: String,
    private val transport: AidenBotMemoryTransport,
    private val keys: AidenBotActionKeys = AidenBotActionKeys(),
    private val waitForConnection: (suspend () -> Boolean)? = null,
    private val holdMillis: Long = AIDEN_BOT_SAVE_HOLD_MILLIS,
    private val limitMillis: Long = AIDEN_BOT_SAVE_LIMIT_MILLIS
) {
    private val _state = MutableStateFlow(AidenBotMemoryUiState())
    val state: StateFlow<AidenBotMemoryUiState> = _state.asStateFlow()

    /** How many views the Mac has answered with, so a failure rolls back only what nothing newer replaced. */
    private var macViews = 0

    private suspend fun <T : Any> request(block: suspend () -> T): T = aidenBotHeldRequest(waitForConnection, holdMillis, limitMillis, block)

    private fun macView(view: AidenBotMemory) {
        macViews += 1
        _state.update { it.copy(view = view) }
    }

    /** Reads the memory; returns false when it could not. Skeletons show until it does. */
    suspend fun load(): Boolean {
        _state.update { it.copy(isLoading = true) }
        return try {
            val view = request { transport.memory(botId) }
            macView(view)
            _state.update { it.copy(isLoading = false, loadFailed = false) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            _state.update { it.copy(isLoading = false, loadFailed = it.view == null) }
            false
        }
    }

    fun beginEdit(target: AidenBotMemoryTarget, entry: AidenBotMemoryEntry) {
        if (_state.value.view?.readable != true) return
        _state.update { it.copy(editing = AidenBotMemoryEditing(target, entry.id, entry.text)) }
    }

    fun updateDraft(text: String) {
        _state.update { current ->
            val editing = current.editing ?: return@update current
            current.copy(editing = editing.copy(text = aidenBotMemoryClamp(text), error = null))
        }
    }

    fun cancelEdit() {
        _state.update { if (it.editing?.isSaving == true) it else it.copy(editing = null) }
    }

    /**
     * Saves the open edit: the dialog closes with the new words in place at once. The Mac's view
     * replaces them; a failure puts the entry back and reopens the dialog on the person's words
     * with the reason, and reloads the page underneath.
     */
    suspend fun saveEdit(): Boolean {
        val editing = _state.value.editing ?: return false
        if (!editing.canSave) return false
        val before = _state.value.view ?: return false
        val edit = AidenBotMemoryEdit.Replace(editing.target, editing.entryId, editing.trimmed)
        val writes = macViews
        _state.update { it.copy(view = before.replacing(editing.target, editing.entryId, editing.trimmed), editing = null, actionError = null) }
        val action = "replace:${editing.entryId}:${editing.trimmed}"
        return try {
            val view = request { transport.edit(botId, edit, keys.key(action)) }
            keys.complete(action)
            macView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            _state.update { current ->
                current.copy(
                    view = if (macViews == writes) before else current.view,
                    // Another edit opened since keeps its dialog; the reason shows under the page then.
                    editing = current.editing ?: editing.copy(isSaving = false, error = aidenBotMemoryError(error)),
                    actionError = if (current.editing != null) aidenBotMemoryError(error) else current.actionError
                )
            }
            load()
            false
        }
    }

    /** Deletes one entry: the row goes at once (phones have no Undo). A failure brings it back and reloads. */
    suspend fun delete(target: AidenBotMemoryTarget, entryId: String): Boolean {
        val before = _state.value.view ?: return false
        if (!before.readable || entryId in _state.value.deleting) return false
        val action = "remove:$entryId"
        val writes = macViews
        _state.update {
            it.copy(view = before.without(target, entryId), deleting = it.deleting + entryId, actionError = null, eraseFailed = false)
        }
        return try {
            val view = request { transport.edit(botId, AidenBotMemoryEdit.Remove(target, entryId), keys.key(action)) }
            keys.complete(action)
            macView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            _state.update { it.copy(view = if (macViews == writes) before else it.view, actionError = aidenBotMemoryError(error)) }
            load()
            false
        } finally {
            _state.update { it.copy(deleting = it.deleting - entryId) }
        }
    }

    /** Erases both groups at once. It is also the only way out of an unreadable memory. A failure brings everything back. */
    suspend fun erase(): Boolean {
        val before = _state.value.view ?: return false
        if (_state.value.isErasing) return false
        val writes = macViews
        _state.update { it.copy(view = before.erased(), editing = null, isErasing = true, actionError = null, eraseFailed = false) }
        return try {
            val view = request { transport.edit(botId, AidenBotMemoryEdit.Clear, keys.key(ERASE)) }
            keys.complete(ERASE)
            macView(view)
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(ERASE, error)
            _state.update { it.copy(view = if (macViews == writes) before else it.view, eraseFailed = true) }
            load()
            false
        } finally {
            _state.update { it.copy(isErasing = false) }
        }
    }

    private companion object {
        const val ERASE = "clear"
    }
}

private fun AidenBotMemory.updating(target: AidenBotMemoryTarget, change: (AidenBotMemoryStore) -> AidenBotMemoryStore) = when (target) {
    AidenBotMemoryTarget.USER -> copy(user = change(user))
    AidenBotMemoryTarget.MEMORY -> copy(memory = change(memory))
}

private fun AidenBotMemoryStore.withUsed(used: Int) = copy(usedChars = used.coerceIn(0, AidenBotMemoryWire.MAX_CHARS))

/** [entryId] with [text] in place, as the page shows it until the Mac answers (the Mac gives it a new id). */
internal fun AidenBotMemory.replacing(target: AidenBotMemoryTarget, entryId: String, text: String) = updating(target) { store ->
    val old = store.entries.firstOrNull { it.id == entryId } ?: return@updating store
    store.copy(entries = store.entries.map { if (it.id == entryId) AidenBotMemoryEntry(entryId, text) else it })
        .withUsed(store.usedChars - old.text.length + text.length)
}

internal fun AidenBotMemory.without(target: AidenBotMemoryTarget, entryId: String) = updating(target) { store ->
    val old = store.entries.firstOrNull { it.id == entryId } ?: return@updating store
    store.copy(entries = store.entries - old).withUsed(store.usedChars - old.text.length)
}

internal fun AidenBotMemory.erased() = copy(
    readable = true,
    user = user.copy(entries = emptyList(), usedChars = 0, overBudget = false),
    memory = memory.copy(entries = emptyList(), usedChars = 0, overBudget = false)
)

/** Keeps a draft within the 500-character entry limit, counting code points. */
fun aidenBotMemoryClamp(text: String): String {
    val limit = AidenBotMemoryWire.MAX_ENTRY_LENGTH
    if (text.codePointCount(0, text.length) <= limit) return text
    return text.substring(0, text.offsetByCodePoints(0, limit))
}
