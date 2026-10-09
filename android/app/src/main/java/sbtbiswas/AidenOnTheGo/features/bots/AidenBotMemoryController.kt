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

class AidenRemoteBotMemoryTransport(private val client: AidenRemoteClient) : AidenBotMemoryTransport {
    override suspend fun memory(botId: String) = client.botMemory(botId)
    override suspend fun edit(botId: String, edit: AidenBotMemoryEdit, key: UUID) = client.editBotMemory(botId, edit, key)
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
 * Drives Profile → Memory: loads `GET /bots/{id}/memory`, saves one edit at a time through
 * `POST /bots/{id}/memory/edits`, and refetches after every failed write because an error
 * answer carries no view.
 */
class AidenBotMemoryController(
    val botId: String,
    private val transport: AidenBotMemoryTransport,
    private val keys: AidenBotActionKeys = AidenBotActionKeys()
) {
    private val _state = MutableStateFlow(AidenBotMemoryUiState())
    val state: StateFlow<AidenBotMemoryUiState> = _state.asStateFlow()

    /** Reads the memory; returns false when it could not. */
    suspend fun load(): Boolean {
        _state.update { it.copy(isLoading = true) }
        return try {
            val view = transport.memory(botId)
            _state.update { it.copy(view = view, isLoading = false, loadFailed = false) }
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
     * Saves the open edit. Success closes the dialog with the Mac's fresh view; a failure keeps
     * it open with the person-facing reason and reloads the page underneath.
     */
    suspend fun saveEdit(): Boolean {
        val editing = _state.value.editing ?: return false
        if (!editing.canSave) return false
        val edit = AidenBotMemoryEdit.Replace(editing.target, editing.entryId, editing.trimmed)
        _state.update { it.copy(editing = editing.copy(isSaving = true, error = null)) }
        val action = "replace:${editing.entryId}:${editing.trimmed}"
        return try {
            val view = transport.edit(botId, edit, keys.key(action))
            keys.complete(action)
            _state.update { it.copy(view = view, editing = null, actionError = null) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            _state.update { current ->
                current.copy(editing = current.editing?.copy(isSaving = false, error = aidenBotMemoryError(error)))
            }
            load()
            false
        }
    }

    /** Deletes one entry right away (phones have no Undo). A failure reloads the page. */
    suspend fun delete(target: AidenBotMemoryTarget, entryId: String): Boolean {
        if (_state.value.view?.readable != true || entryId in _state.value.deleting) return false
        val action = "remove:$entryId"
        _state.update { it.copy(deleting = it.deleting + entryId, actionError = null, eraseFailed = false) }
        return try {
            val view = transport.edit(botId, AidenBotMemoryEdit.Remove(target, entryId), keys.key(action))
            keys.complete(action)
            _state.update { it.copy(view = view) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            _state.update { it.copy(actionError = aidenBotMemoryError(error)) }
            load()
            false
        } finally {
            _state.update { it.copy(deleting = it.deleting - entryId) }
        }
    }

    /** Erases both groups. It is also the only way out of an unreadable memory. */
    suspend fun erase(): Boolean {
        if (_state.value.isErasing || _state.value.view == null) return false
        _state.update { it.copy(isErasing = true, actionError = null, eraseFailed = false) }
        return try {
            val view = transport.edit(botId, AidenBotMemoryEdit.Clear, keys.key(ERASE))
            keys.complete(ERASE)
            _state.update { it.copy(view = view, editing = null) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(ERASE, error)
            _state.update { it.copy(eraseFailed = true) }
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

/** Keeps a draft within the 500-character entry limit, counting code points. */
fun aidenBotMemoryClamp(text: String): String {
    val limit = AidenBotMemoryWire.MAX_ENTRY_LENGTH
    if (text.codePointCount(0, text.length) <= limit) return text
    return text.substring(0, text.offsetByCodePoints(0, limit))
}
