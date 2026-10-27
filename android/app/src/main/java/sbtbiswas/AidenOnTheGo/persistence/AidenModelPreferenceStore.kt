package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenChatModelSelection
import java.io.File

/**
 * Device-local memory of the last provider, model and thinking level the user
 * explicitly chose in a new Workspace chat's composer (the choice new chats
 * start with), an unsent pick in an existing chat until that chat's next send,
 * and the last few distinct provider/model routes chosen (the model picker's
 * Recent section), kept separately for each paired Mac. Only opaque catalog
 * identifiers are stored — never prompts, credentials or chat content — and all
 * of it is removed with the pairing.
 *
 * The stored choice is a preference, not an authority: callers validate it
 * against the host's current model inventory before using it.
 */
class AidenModelPreferenceStore(private val storageDir: File) {
    @Serializable
    private data class Entry(
        val providerId: String,
        val modelId: String,
        val thinkingLevel: String? = null
    )

    @Serializable
    private data class Route(val providerId: String, val modelId: String)

    @Serializable
    private data class ChatEntry(val chatId: String, val entry: Entry)

    @Serializable
    private data class Snapshot(
        val version: Int = VERSION,
        val selections: Map<String, Entry> = emptyMap(),
        val recents: Map<String, List<Route>> = emptyMap(),
        /** Unsent picks in existing chats, newest first, per paired Mac. */
        val chats: Map<String, List<ChatEntry>> = emptyMap()
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val storeFile = File(storageDir, FILE_NAME)
    private var snapshot = Snapshot()

    init {
        load()
    }

    @Synchronized
    fun selection(instanceId: String): AidenChatModelSelection? {
        if (!isSafeId(instanceId)) return null
        val entry = snapshot.selections[instanceId] ?: return null
        return AidenChatModelSelection(entry.providerId, entry.modelId, entry.thinkingLevel)
    }

    /** Distinct provider/model routes explicitly chosen on [instanceId], newest first. */
    @Synchronized
    fun recentRoutes(instanceId: String): List<AidenChatModelSelection> {
        if (!isSafeId(instanceId)) return emptyList()
        return snapshot.recents[instanceId].orEmpty().map { AidenChatModelSelection(it.providerId, it.modelId, null) }
    }

    /**
     * Records [selection] in [instanceId]'s Recent routes and, when [asDefault]
     * (a pick in a new chat), as the choice later new chats start with.
     */
    @Synchronized
    fun remember(instanceId: String, selection: AidenChatModelSelection, asDefault: Boolean = true) {
        if (!isSafeId(instanceId)) return
        val providerId = selection.providerId?.takeIf(::isSafeId) ?: return
        val modelId = selection.modelId?.takeIf(::isSafeId) ?: return
        val thinkingLevel = selection.thinkingLevel?.takeIf(::isSafeId)
        val entry = Entry(providerId, modelId, thinkingLevel)
        val route = Route(providerId, modelId)
        val existing = snapshot.recents[instanceId].orEmpty()
        val recents = (listOf(route) + existing.filter { it != route }).take(MAXIMUM_RECENTS)
        val selections = if (asDefault) snapshot.selections + (instanceId to entry) else snapshot.selections
        if (snapshot.selections == selections && existing == recents) return
        save(snapshot.copy(selections = selections, recents = snapshot.recents + (instanceId to recents)))
    }

    /** The unsent pick in an existing chat, kept so reopening the chat shows it. */
    @Synchronized
    fun chatSelection(instanceId: String, chatId: String): AidenChatModelSelection? {
        val entry = snapshot.chats[instanceId]?.firstOrNull { it.chatId == chatId }?.entry ?: return null
        return AidenChatModelSelection(entry.providerId, entry.modelId, entry.thinkingLevel)
    }

    /**
     * Keeps a pick in an existing chat until that chat's next send. It never
     * changes the choice new chats start with.
     */
    @Synchronized
    fun rememberChat(instanceId: String, chatId: String, selection: AidenChatModelSelection) {
        if (!isSafeId(instanceId) || !isSafeId(chatId)) return
        val providerId = selection.providerId?.takeIf(::isSafeId) ?: return
        val modelId = selection.modelId?.takeIf(::isSafeId) ?: return
        val entry = ChatEntry(chatId, Entry(providerId, modelId, selection.thinkingLevel?.takeIf(::isSafeId)))
        val existing = snapshot.chats[instanceId].orEmpty()
        val updated = (listOf(entry) + existing.filter { it.chatId != chatId }).take(MAXIMUM_CHAT_SELECTIONS)
        if (updated == existing) return
        save(snapshot.copy(chats = snapshot.chats + (instanceId to updated)))
    }

    /** Drops a chat's unsent pick once the Mac accepts a send with it: the Mac then holds it as the chat's own model. */
    @Synchronized
    fun forgetChat(instanceId: String, chatId: String, matching: AidenChatModelSelection? = null) {
        val existing = snapshot.chats[instanceId] ?: return
        val stored = existing.firstOrNull { it.chatId == chatId }?.entry ?: return
        // A newer pick made while a send was pending stays.
        if (matching != null &&
            (stored.providerId != matching.providerId || stored.modelId != matching.modelId ||
                stored.thinkingLevel != matching.thinkingLevel?.takeIf(::isSafeId))
        ) return
        val remaining = existing.filter { it.chatId != chatId }
        save(snapshot.copy(chats = if (remaining.isEmpty()) snapshot.chats - instanceId else snapshot.chats + (instanceId to remaining)))
    }

    @Synchronized
    fun purge(instanceId: String) {
        if (!snapshot.selections.containsKey(instanceId) && !snapshot.recents.containsKey(instanceId) &&
            !snapshot.chats.containsKey(instanceId)
        ) return
        save(
            snapshot.copy(
                selections = snapshot.selections - instanceId,
                recents = snapshot.recents - instanceId,
                chats = snapshot.chats - instanceId
            )
        )
    }

    private fun load() {
        if (!storeFile.exists() || storeFile.length() > MAXIMUM_BYTES) return
        val decoded = try {
            json.decodeFromString<Snapshot>(storeFile.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            return
        }
        if (decoded.version != VERSION) return
        snapshot = Snapshot(
            selections = decoded.selections.filter { (instanceId, entry) ->
                isSafeId(instanceId) && isSafeId(entry.providerId) && isSafeId(entry.modelId) &&
                    (entry.thinkingLevel == null || isSafeId(entry.thinkingLevel))
            },
            recents = decoded.recents
                .filterKeys(::isSafeId)
                .mapValues { (_, routes) ->
                    routes.filter { isSafeId(it.providerId) && isSafeId(it.modelId) }.distinct().take(MAXIMUM_RECENTS)
                }
                .filterValues { it.isNotEmpty() },
            chats = decoded.chats
                .filterKeys(::isSafeId)
                .mapValues { (_, entries) ->
                    entries.filter { isSafeId(it.chatId) && isSafeEntry(it.entry) }
                        .distinctBy { it.chatId }
                        .take(MAXIMUM_CHAT_SELECTIONS)
                }
                .filterValues { it.isNotEmpty() }
        )
    }

    private fun save(next: Snapshot) {
        val encoded = runCatching { json.encodeToString(next) }.getOrNull() ?: return
        if (encoded.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) return
        try {
            storageDir.mkdirs()
            val temporary = File(storageDir, "$FILE_NAME.tmp")
            temporary.writeText(encoded, Charsets.UTF_8)
            if (!temporary.renameTo(storeFile)) {
                storeFile.writeText(encoded, Charsets.UTF_8)
                temporary.delete()
            }
            snapshot = next
        } catch (_: Exception) {}
    }

    private fun isSafeEntry(entry: Entry): Boolean =
        isSafeId(entry.providerId) && isSafeId(entry.modelId) &&
            (entry.thinkingLevel == null || isSafeId(entry.thinkingLevel))

    private fun isSafeId(value: String): Boolean =
        value.isNotEmpty() && value.length <= MAXIMUM_ID_LENGTH && value.none { it.isISOControl() }

    private companion object {
        const val VERSION = 1
        const val FILE_NAME = "model_preferences.json"
        const val MAXIMUM_ID_LENGTH = 256
        const val MAXIMUM_BYTES = 256L * 1024L
        const val MAXIMUM_RECENTS = 5
        const val MAXIMUM_CHAT_SELECTIONS = 50
    }
}
