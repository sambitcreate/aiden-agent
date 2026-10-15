package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentReference
import sbtbiswas.AidenOnTheGo.models.AidenTurnStart
import java.util.UUID
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
    @Serializable
    data class PendingSend(
        val deviceId: String,
        val request: AidenTurnStart,
        val key: String,
        val createdAtMillis: Long,
        val attachments: List<AidenAttachmentReference>,
        val streamId: String? = null,
        val inputMode: sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode? = null
    ) {
        fun canRetry(nowMillis: Long = System.currentTimeMillis()): Boolean =
            nowMillis >= createdAtMillis && nowMillis - createdAtMillis < 24 * 60 * 60 * 1000L
    }

    @Synchronized
    fun loadPendingSend(session: Session, deviceId: String): PendingSend? {
        if (!isCurrent(session)) return null
        val file = attemptFile(session)
        if (!file.exists()) return null
        check(file.length() <= maximumDraftBytes) { "The saved send needs review before another message can be sent." }
        val pending = json.decodeFromString<PendingSend>(file.readText())
        UUID.fromString(pending.key)
        check((pending.streamId == null) == (pending.inputMode == null))
        return pending.takeIf { it.deviceId == deviceId }
    }

    @Synchronized
    fun savePendingSend(pending: PendingSend?, session: Session) {
        check(isCurrent(session)) { "The pairing changed before the message could be saved." }
        val file = attemptFile(session)
        if (pending == null) { check(!file.exists() || file.delete()); return }
        val previous = loadPendingSend(session, pending.deviceId)
        check(previous == null || previous == pending) { "Resolve the saved send before sending another message." }
        val bytes = json.encodeToString(pending).toByteArray(Charsets.UTF_8)
        check(bytes.size <= maximumDraftBytes) { "The pending message is too large." }
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, file.name + ".tmp")
        temporary.outputStream().use { it.write(bytes); it.fd.sync() }
        check(temporary.renameTo(file)) { "Could not save the pending message." }
    }

    @Synchronized
    fun settlePendingSend(key: String, session: Session) {
        val file = attemptFile(session)
        if (!file.exists() || file.length() > maximumDraftBytes) return
        val pending = runCatching { json.decodeFromString<PendingSend>(file.readText()) }.getOrNull()
        if (pending?.key == key) file.delete()
    }

    private fun attemptFile(session: Session): File =
        File(fileURL(session.instanceId, session.chatId).parentFile, "${digest(session.chatId)}.attempt.json")

    data class Session(
        val instanceId: String,
        val chatId: String,
        val generation: Long
    )

    /**
     * Write authority over one pairing's drafts, captured before an async
     * request. [purge] retires it, so a request that settles after an unpair
     * cannot recreate the removed pairing's draft or staged attachments.
     */
    data class PurgeAuthority(
        val instanceId: String,
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
    private val stagedAttachments = ConcurrentHashMap<String, List<AidenAttachmentReference>>()
    private val purgeGenerations = ConcurrentHashMap<String, Long>()

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
    fun purgeAuthority(instanceId: String): PurgeAuthority =
        PurgeAuthority(instanceId, purgeGenerations[instanceId] ?: 0L)

    /** False once [purge] ran for the authority's pairing after it was captured. */
    @Synchronized
    fun isCurrent(authority: PurgeAuthority): Boolean =
        (purgeGenerations[authority.instanceId] ?: 0L) == authority.generation

    /** Saves [text] as [chatId]'s draft unless [authority] was purged. */
    @Synchronized
    fun setDraft(chatId: String, text: String, authority: PurgeAuthority): Boolean {
        if (!isCurrent(authority)) return false
        return save(text, beginSession(authority.instanceId, chatId))
    }

    /**
     * Hands server-staged attachments (an "Edit in fork" prefill) to the next
     * composer that opens [chatId], unless [authority] was purged. They are
     * only valid until their `expiresAt`, so they live in memory rather than
     * on disk.
     */
    @Synchronized
    fun stageAttachments(chatId: String, attachments: List<AidenAttachmentReference>, authority: PurgeAuthority): Boolean {
        if (!isCurrent(authority)) return false
        val key = sessionKey(authority.instanceId, chatId)
        if (attachments.isEmpty()) stagedAttachments.remove(key) else stagedAttachments[key] = attachments
        return true
    }

    /** Returns and forgets the attachments staged for [chatId]. */
    @Synchronized
    fun takeStagedAttachments(instanceId: String, chatId: String): List<AidenAttachmentReference> =
        stagedAttachments.remove(sessionKey(instanceId, chatId)).orEmpty()

    @Synchronized
    fun remove(instanceId: String, chatId: String) {
        attemptFile(Session(instanceId, chatId, 0)).delete()
        stagedAttachments.remove(sessionKey(instanceId, chatId))
        invalidate(instanceId, chatId)
        val file = fileURL(instanceId, chatId)
        if (file.exists()) file.delete()
    }

    @Synchronized
    fun purge(instanceId: String) {
        purgeGenerations.compute(instanceId) { _, current -> (current ?: 0L) + 1L }
        val prefix = "$instanceId\u001f"
        for (key in generations.keys) {
            if (key.startsWith(prefix)) {
                generations.compute(key) { _, current -> (current ?: 0L) + 1L }
            }
        }
        stagedAttachments.keys.removeAll { it.startsWith(prefix) }
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
