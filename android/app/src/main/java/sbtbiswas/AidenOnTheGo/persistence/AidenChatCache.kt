package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentImageValidation
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticArea
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticCode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticEvent
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticOutcome
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnostics
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Date

class AidenChatCache(
    private val storageDir: File? = null,
    root: File? = null,
    legacyRoots: List<File>? = null
) {
    @Serializable
    data class ActiveStream(
        val deviceId: String,
        val streamId: String,
        val turnId: String,
        var lastSequence: Int
    )

    @Serializable
    private data class ChatListEnvelope(
        val instanceId: String,
        val workspaceId: String,
        val chats: List<AidenChat>
    )

    @Serializable
    private data class ChatEnvelope(
        val instanceId: String,
        val chat: AidenChat
    )

    @Serializable
    private data class StreamEnvelope(
        val instanceId: String,
        val chatId: String,
        val stream: ActiveStream
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }
    private val maxCacheFileBytes = 10 * 1024 * 1024
    private val maxAttachmentImageCacheBytes = 96 * 1024 * 1024L

    val root: File
    val legacyRoots: List<File>

    private val _chats = MutableStateFlow<Map<String, AidenChat>>(emptyMap())
    val chats: StateFlow<Map<String, AidenChat>> = _chats.asStateFlow()

    init {
        if (root != null) {
            this.root = root
            this.legacyRoots = legacyRoots ?: emptyList()
        } else {
            val base = storageDir ?: File(System.getProperty("java.io.tmpdir"), "AidenOnTheGo")
            val namespaceRoot = File(base, "AidenOnTheGo")
            this.root = File(namespaceRoot, "RemoteChatCache-v2")
            this.legacyRoots = legacyRoots ?: listOf(File(namespaceRoot, "RemoteChatCache-v1"))
        }
        this.root.mkdirs()
    }

    @Synchronized
    fun loadChats(instanceId: String, workspaceId: String): List<AidenChat>? {
        val file = fileURL("lists", instanceId, workspaceId)
        val envelope = loadEnvelope<ChatListEnvelope>(file) ?: return null
        if (envelope.instanceId != instanceId || envelope.workspaceId != workspaceId) return null
        return envelope.chats
    }

    @Synchronized
    fun saveChats(chats: List<AidenChat>, instanceId: String, workspaceId: String) {
        val envelope = ChatListEnvelope(instanceId = instanceId, workspaceId = workspaceId, chats = chats)
        saveEnvelope(envelope, fileURL("lists", instanceId, workspaceId))
        val map = _chats.value.toMutableMap()
        for (chat in chats) {
            map[chat.id] = chat
        }
        _chats.value = map
    }

    @Synchronized
    fun loadChat(instanceId: String, chatId: String): AidenChat? {
        val file = fileURL("chats", instanceId, chatId)
        val envelope = loadEnvelope<ChatEnvelope>(file) ?: return null
        if (envelope.instanceId != instanceId || envelope.chat.id != chatId) return null
        return envelope.chat
    }

    @Synchronized
    fun saveChat(chat: AidenChat, instanceId: String) {
        val envelope = ChatEnvelope(instanceId = instanceId, chat = chat)
        saveEnvelope(envelope, fileURL("chats", instanceId, chat.id))
        val map = _chats.value.toMutableMap()
        map[chat.id] = chat
        _chats.value = map
    }

    @Synchronized
    fun loadActiveStream(instanceId: String, chatId: String): ActiveStream? {
        val file = fileURL("streams", instanceId, chatId)
        val envelope = loadEnvelope<StreamEnvelope>(file) ?: return null
        if (envelope.instanceId != instanceId || envelope.chatId != chatId) return null
        return envelope.stream
    }

    @Synchronized
    fun saveActiveStream(stream: ActiveStream, instanceId: String, chatId: String) {
        val envelope = StreamEnvelope(instanceId = instanceId, chatId = chatId, stream = stream)
        saveEnvelope(envelope, fileURL("streams", instanceId, chatId))
    }

    @Synchronized
    fun removeActiveStream(instanceId: String, chatId: String) {
        val file = fileURL("streams", instanceId, chatId)
        if (file.exists()) file.delete()
    }

    @Synchronized
    fun removeActiveStream(instanceId: String, chatId: String, ifStreamId: String): Boolean {
        val current = loadActiveStream(instanceId, chatId)
        if (current?.streamId != ifStreamId) return false
        removeActiveStream(instanceId, chatId)
        return true
    }

    @Synchronized
    fun removeChat(instanceId: String, chatId: String) {
        val chatFile = fileURL("chats", instanceId, chatId)
        if (chatFile.exists()) chatFile.delete()
        removeActiveStream(instanceId, chatId)
        val attachDir = attachmentChatDirectory(instanceId, chatId)
        if (attachDir.exists()) attachDir.deleteRecursively()
        val map = _chats.value.toMutableMap()
        map.remove(chatId)
        _chats.value = map
    }

    @Synchronized
    fun purge(instanceId: String) {
        purgeNamespace(root, instanceId)
        for (legacy in legacyRoots) {
            if (legacy.canonicalPath != root.canonicalPath) {
                purgeNamespace(legacy, instanceId)
            }
        }
        _chats.value = emptyMap()
    }

    @Synchronized
    fun removeActiveStreams(instanceId: String) {
        purgeFiles(root, "streams", instanceId, StreamEnvelope::class.java) { it.instanceId }
    }

    @Synchronized
    fun attachmentImage(
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachment: AidenMessageAttachment
    ): ByteArray? {
        if (attachment.kind != sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind.IMAGE) return null
        val file = attachmentImageFile(instanceId, deviceId, chatId, attachment.id)
        if (!file.exists()) return null
        if (file.length() !in 1..AidenAttachmentImageValidation.MAXIMUM_BYTES.toLong()) {
            AidenDiagnostics.record(AidenDiagnosticArea.CACHE, AidenDiagnosticEvent.CACHE_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.CORRUPT_DATA)
            file.delete()
            return null
        }
        val data = try { file.readBytes() } catch (_: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CACHE, AidenDiagnosticEvent.CACHE_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.CORRUPT_DATA)
            file.delete()
            return null
        }
        val validated = AidenAttachmentImageValidation.validatedData(
            data,
            attachment.mimeType,
            attachment.size
        )
        if (validated == null) {
            AidenDiagnostics.record(AidenDiagnosticArea.CACHE, AidenDiagnosticEvent.CACHE_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.CORRUPT_DATA)
            file.delete()
            return null
        }
        file.setLastModified(System.currentTimeMillis())
        return validated
    }

    @Synchronized
    fun saveAttachmentImage(
        data: ByteArray,
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachment: AidenMessageAttachment
    ) {
        if (attachment.kind != sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind.IMAGE) {
            throw IllegalArgumentException("Only image attachments can be cached")
        }
        val validated = AidenAttachmentImageValidation.validatedData(
            data,
            attachment.mimeType,
            attachment.size
        ) ?: throw IllegalArgumentException("Corrupt image data")

        val file = attachmentImageFile(instanceId, deviceId, chatId, attachment.id)
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".${file.name}.${java.util.UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(validated)
                stream.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        pruneAttachmentImages(instanceId, preserving = file)
    }

    @Synchronized
    fun removeAttachmentImage(instanceId: String, deviceId: String, chatId: String, attachmentId: String) {
        val file = attachmentImageFile(instanceId, deviceId, chatId, attachmentId)
        if (file.exists()) file.delete()
    }

    // Compatibility methods
    @Synchronized
    fun getChat(id: String): AidenChat? = _chats.value[id]

    @Synchronized
    fun putChat(chat: AidenChat) {
        val map = _chats.value.toMutableMap()
        map[chat.id] = chat
        _chats.value = map
    }

    @Synchronized
    fun removeChat(id: String) {
        val map = _chats.value.toMutableMap()
        map.remove(id)
        _chats.value = map
    }

    private fun fileURL(kind: String, vararg parts: String): File {
        val combined = parts.joinToString("\u001f")
        val name = digest(combined)
        val dir = File(root, kind).apply { mkdirs() }
        return File(dir, "$name.json")
    }

    private fun digest(value: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val hash = md.digest(value.toByteArray(Charsets.UTF_8))
        return hash.joinToString("") { "%02x".format(it) }
    }

    private fun attachmentInstanceDirectory(cacheRoot: File? = null, instanceId: String): File {
        val base = cacheRoot ?: root
        return File(File(base, "attachment-images"), digest(instanceId))
    }

    private fun attachmentChatDirectory(instanceId: String, chatId: String): File {
        return File(attachmentInstanceDirectory(root, instanceId), digest(chatId))
    }

    private fun attachmentImageFile(
        instanceId: String,
        deviceId: String,
        chatId: String,
        attachmentId: String
    ): File {
        val chatDir = attachmentChatDirectory(instanceId, chatId)
        val deviceDir = File(chatDir, digest(deviceId))
        return File(deviceDir, "${digest(attachmentId)}.image")
    }

    private fun pruneAttachmentImages(instanceId: String, preserving: File) {
        val dir = attachmentInstanceDirectory(root, instanceId)
        if (!dir.exists()) return
        val allFiles = dir.walkTopDown().filter { it.isFile }.toList()
        val sorted = allFiles.sortedWith { a, b ->
            if (a.canonicalPath == preserving.canonicalPath) return@sortedWith -1
            if (b.canonicalPath == preserving.canonicalPath) return@sortedWith 1
            b.lastModified().compareTo(a.lastModified())
        }
        var retainedBytes = 0L
        for (f in sorted) {
            val len = f.length()
            if (retainedBytes + len <= maxAttachmentImageCacheBytes) {
                retainedBytes += len
            } else {
                f.delete()
            }
        }
    }

    private inline fun <reified T> loadEnvelope(file: File): T? {
        if (!file.exists() || file.length() > maxCacheFileBytes) return null
        return try {
            val content = file.readText(Charsets.UTF_8)
            json.decodeFromString<T>(content)
        } catch (_: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CACHE, AidenDiagnosticEvent.CACHE_FAILED, AidenDiagnosticOutcome.DEGRADED, AidenDiagnosticCode.CORRUPT_DATA)
            null
        }
    }

    private inline fun <reified T> saveEnvelope(envelope: T, file: File) {
        val content = json.encodeToString(envelope)
        val bytes = content.toByteArray(Charsets.UTF_8)
        if (bytes.size > maxCacheFileBytes) throw IllegalStateException("Cache file exceeds maximum size")
        file.parentFile?.mkdirs()
        file.writeBytes(bytes)
    }

    private fun purgeNamespace(cacheRoot: File, instanceId: String) {
        purgeFiles(cacheRoot, "lists", instanceId, ChatListEnvelope::class.java) { it.instanceId }
        purgeFiles(cacheRoot, "chats", instanceId, ChatEnvelope::class.java) { it.instanceId }
        purgeFiles(cacheRoot, "streams", instanceId, StreamEnvelope::class.java) { it.instanceId }
        val attachDir = attachmentInstanceDirectory(cacheRoot, instanceId)
        if (attachDir.exists()) attachDir.deleteRecursively()
    }

    private fun <T> purgeFiles(
        cacheRoot: File,
        kind: String,
        instanceId: String,
        clazz: Class<T>,
        instanceExtractor: (T) -> String
    ) {
        val dir = File(cacheRoot, kind)
        if (!dir.exists()) return
        val files = dir.listFiles { _, name -> name.endsWith(".json") } ?: return
        for (file in files) {
            val content = try { file.readText(Charsets.UTF_8) } catch (_: Exception) { null } ?: continue
            try {
                if (clazz == StreamEnvelope::class.java) {
                    val envelope = json.decodeFromString<StreamEnvelope>(content)
                    if (envelope.instanceId == instanceId) {
                        file.delete()
                        continue
                    }
                } else if (clazz == ChatEnvelope::class.java) {
                    val envelope = json.decodeFromString<ChatEnvelope>(content)
                    if (envelope.instanceId == instanceId) {
                        file.delete()
                        continue
                    }
                } else if (clazz == ChatListEnvelope::class.java) {
                    val envelope = json.decodeFromString<ChatListEnvelope>(content)
                    if (envelope.instanceId == instanceId) {
                        file.delete()
                        continue
                    }
                }
            } catch (_: Exception) {}

            // If envelope decoding failed due to schema changes, check JSON text for instanceId
            if (content.contains("\"instanceId\":\"$instanceId\"")) {
                file.delete()
            }
        }
    }

    companion object {
        val shared = AidenChatCache()
    }
}
