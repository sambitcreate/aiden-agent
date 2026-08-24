package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

@Serializable
data class AidenChatDraft(
    val text: String = "",
    val thinkingLevel: String? = null,
    val attachmentIds: List<String> = emptyList()
)

class AidenChatDraftStore(
    private val storageDir: File? = null,
    root: File? = null
) {
    data class Session(
        val instanceId: String,
        val chatId: String,
        val generation: Long
    )

    @Serializable
    private data class Envelope(
        val version: Int = 1,
        val instanceId: String,
        val chatId: String,
        val text: String
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }
    private val maximumDraftScalars = 100_000
    private val maximumDraftBytes = 400_000
    private val generations = ConcurrentHashMap<String, Long>()

    val root: File

    private val _drafts = MutableStateFlow<Map<String, AidenChatDraft>>(emptyMap())
    val drafts: StateFlow<Map<String, AidenChatDraft>> = _drafts.asStateFlow()

    init {
        if (root != null) {
            this.root = root
        } else {
            val base = storageDir ?: File(System.getProperty("java.io.tmpdir"), "AidenOnTheGo")
            this.root = File(File(base, "AidenOnTheGo"), "ChatDrafts-v1")
        }
        this.root.mkdirs()
    }

    @Synchronized
    fun beginSession(instanceId: String, chatId: String): Session {
        val key = sessionKey(instanceId, chatId)
        val generation = (generations[key] ?: 0L) + 1L
        generations[key] = generation
        return Session(instanceId = instanceId, chatId = chatId, generation = generation)
    }

    @Synchronized
    fun load(session: Session): String? {
        if (!isCurrent(session)) return null
        val file = fileURL(session.instanceId, session.chatId)
        if (!file.exists() || file.length() > maximumDraftBytes) return null
        val content = try { file.readText(Charsets.UTF_8) } catch (_: Exception) { return null }
        if (content.toByteArray(Charsets.UTF_8).size > maximumDraftBytes) return null
        val envelope = try { json.decodeFromString<Envelope>(content) } catch (_: Exception) { return null }
        if (envelope.version != 1 || envelope.instanceId != session.instanceId ||
            envelope.chatId != session.chatId || !isBounded(envelope.text)
        ) {
            return null
        }
        return envelope.text
    }

    @Synchronized
    fun save(text: String, session: Session): Boolean {
        if (!isCurrent(session) || !isBounded(text)) return false
        val file = fileURL(session.instanceId, session.chatId)
        if (text.isEmpty()) {
            if (file.exists()) file.delete()
            return true
        }
        val envelope = Envelope(
            version = 1,
            instanceId = session.instanceId,
            chatId = session.chatId,
            text = text
        )
        val data = json.encodeToString(envelope).toByteArray(Charsets.UTF_8)
        if (data.size > maximumDraftBytes) return false
        file.parentFile?.mkdirs()
        if (!isCurrent(session)) return false
        file.writeBytes(data)
        return true
    }

    @Synchronized
    fun remove(instanceId: String, chatId: String) {
        invalidate(instanceId, chatId)
        val file = fileURL(instanceId, chatId)
        if (file.exists()) file.delete()
    }

    @Synchronized
    fun purge(instanceId: String) {
        val prefix = "$instanceId\u001f"
        for (key in generations.keys) {
            if (key.startsWith(prefix)) {
                generations.compute(key) { _, current -> (current ?: 0L) + 1L }
            }
        }
        val dir = instanceDirectory(instanceId)
        if (dir.exists()) dir.deleteRecursively()
        _drafts.value = emptyMap()
    }

    // Compatibility methods for existing codebase
    @Synchronized
    fun setDraft(instanceId: String, chatId: String, text: String) {
        val session = beginSession(instanceId, chatId)
        save(text, session)
    }

    @Synchronized
    fun getDraft(instanceId: String, chatId: String): String? {
        val session = beginSession(instanceId, chatId)
        return load(session)
    }

    @Synchronized
    fun getDraft(chatId: String): AidenChatDraft = _drafts.value[chatId] ?: AidenChatDraft()

    @Synchronized
    fun saveDraft(chatId: String, draft: AidenChatDraft) {
        val map = _drafts.value.toMutableMap()
        if (draft.text.isEmpty() && draft.attachmentIds.isEmpty()) {
            map.remove(chatId)
        } else {
            map[chatId] = draft
        }
        _drafts.value = map
    }

    @Synchronized
    fun clearDraft(chatId: String) {
        val map = _drafts.value.toMutableMap()
        map.remove(chatId)
        _drafts.value = map
    }

    private fun invalidate(instanceId: String, chatId: String) {
        generations.compute(sessionKey(instanceId, chatId)) { _, current -> (current ?: 0L) + 1L }
    }

    private fun isCurrent(session: Session): Boolean {
        return generations[sessionKey(session.instanceId, session.chatId)] == session.generation
    }

    private fun isBounded(text: String): Boolean {
        return text.codePointCount(0, text.length) <= maximumDraftScalars &&
                text.toByteArray(Charsets.UTF_8).size <= maximumDraftBytes
    }

    private fun sessionKey(instanceId: String, chatId: String): String {
        return "$instanceId\u001f$chatId"
    }

    private fun fileURL(instanceId: String, chatId: String): File {
        return File(instanceDirectory(instanceId), "${digest(chatId)}.json")
    }

    private fun instanceDirectory(instanceId: String): File {
        return File(root, digest(instanceId))
    }

    private fun digest(value: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val hash = md.digest(value.toByteArray(Charsets.UTF_8))
        return hash.joinToString("") { "%02x".format(it) }
    }

    companion object {
        val shared = AidenChatDraftStore()
    }
}
