package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentImageValidation
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
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
    legacyRoots: List<File>? = null,
    private val maximumSummaryCacheBytes: Int = 64 * 1024 * 1024
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
    private data class ChatSummaryListEnvelope(
        val instanceId: String,
        val summaries: List<AidenChatSummary>
    )

    @Serializable
    private data class ChatSummaryChunkEnvelope(
        val instanceId: String,
        val summaries: List<AidenChatSummary>
    )

    @Serializable
    private data class ChatSummaryManifestEnvelope(
        val instanceId: String,
        val summaryCount: Int,
        val chunks: List<String>
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
    private val maxSummaryCount = 10_000
    private val summaryChunkSize = 200
    private val maxSummaryChunkBytes = 2 * 1024 * 1024
    private val maxAttachmentImageCacheBytes = 96 * 1024 * 1024L

    val root: File
    val legacyRoots: List<File>

    private val _chats = MutableStateFlow<Map<String, AidenChat>>(emptyMap())
    val chats: StateFlow<Map<String, AidenChat>> = _chats.asStateFlow()
    private val _summaries = MutableStateFlow<Map<String, Map<String, AidenChatSummary>>>(emptyMap())
    val summaries: StateFlow<Map<String, Map<String, AidenChatSummary>>> = _summaries.asStateFlow()

    init {
        require(maximumSummaryCacheBytes > 0) { "Summary cache limit must be positive" }
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
    fun loadSummaries(instanceId: String): List<AidenChatSummary>? {
        val manifestFile = fileURL("summary-manifests", instanceId)
        val manifest = loadEnvelope<ChatSummaryManifestEnvelope>(manifestFile)
        if (manifest == null) {
            // Compatibility with pre-chunk Phase 2 development caches.
            val legacy = loadEnvelope<ChatSummaryListEnvelope>(
                fileURL("summaries", instanceId),
                maximumSummaryCacheBytes
            ) ?: return null
            if (!isValidSummarySet(legacy.summaries, legacy.instanceId, instanceId)) return null
            publishSummaries(instanceId, legacy.summaries)
            return legacy.summaries
        }
        if (manifest.instanceId != instanceId || manifest.summaryCount !in 0..maxSummaryCount ||
            manifest.chunks.size != (manifest.summaryCount + summaryChunkSize - 1) / summaryChunkSize ||
            manifest.chunks.toSet().size != manifest.chunks.size ||
            manifest.chunks.any { !it.matches(Regex("^[0-9a-f]{64}$")) }
        ) return null

        val summaries = mutableListOf<AidenChatSummary>()
        var aggregateBytes = manifestFile.length()
        val chunkDirectory = summaryChunkInstanceDirectory(instanceId)
        for (chunkId in manifest.chunks) {
            val file = File(chunkDirectory, "$chunkId.json")
            if (!file.isFile || file.length() !in 1..maxSummaryChunkBytes.toLong()) return null
            aggregateBytes += file.length()
            if (aggregateBytes > maximumSummaryCacheBytes) return null
            val bytes = try { file.readBytes() } catch (_: Exception) { return null }
            if (digest(bytes) != chunkId) return null
            val chunk = try {
                json.decodeFromString<ChatSummaryChunkEnvelope>(String(bytes, Charsets.UTF_8))
            } catch (_: Exception) {
                return null
            }
            if (chunk.instanceId != instanceId || chunk.summaries.size !in 1..summaryChunkSize) return null
            summaries += chunk.summaries
        }
        if (summaries.size != manifest.summaryCount || !isValidSummarySet(summaries, instanceId, instanceId)) {
            return null
        }
        publishSummaries(instanceId, summaries)
        return summaries
    }

    @Synchronized
    fun saveSummaries(
        summaries: List<AidenChatSummary>,
        instanceId: String,
        unchangedPrefixCount: Int = 0
    ) {
        if (summaries.size > maxSummaryCount || summaries.map { it.id }.toSet().size != summaries.size) {
            throw IllegalArgumentException("Chat summary cache must contain at most 10,000 unique IDs")
        }
        if (unchangedPrefixCount !in 0..summaries.size) {
            throw IllegalArgumentException("Unchanged summary prefix is invalid")
        }
        val manifestFile = fileURL("summary-manifests", instanceId)
        val existing = loadEnvelope<ChatSummaryManifestEnvelope>(manifestFile)
        val cachedPrefixMatches = unchangedPrefixCount == 0 ||
            _summaries.value[instanceId]?.values?.toList()?.let { cached ->
                cached.size == unchangedPrefixCount &&
                    cached == summaries.take(unchangedPrefixCount)
            } == true
        val existingManifestIsReusable = existing?.let { manifest ->
            manifest.instanceId == instanceId &&
                manifest.summaryCount == unchangedPrefixCount &&
                manifest.chunks.size == (manifest.summaryCount + summaryChunkSize - 1) / summaryChunkSize &&
                manifest.chunks.toSet().size == manifest.chunks.size &&
                manifest.chunks.all { it.matches(Regex("^[0-9a-f]{64}$")) }
        } == true
        val previouslyCommittedChunks = if (existingManifestIsReusable ||
            existing?.let { manifest ->
                manifest.instanceId == instanceId &&
                    manifest.summaryCount in 0..maxSummaryCount &&
                    manifest.chunks.size ==
                        (manifest.summaryCount + summaryChunkSize - 1) / summaryChunkSize &&
                    manifest.chunks.toSet().size == manifest.chunks.size &&
                    manifest.chunks.all { it.matches(Regex("^[0-9a-f]{64}$")) }
            } == true
        ) requireNotNull(existing).chunks.toSet() else emptySet()
        val reusableChunks = if (existingManifestIsReusable && cachedPrefixMatches
        ) {
            minOf(requireNotNull(existing).chunks.size, unchangedPrefixCount / summaryChunkSize)
        } else 0
        val chunkIds = existing?.chunks?.take(reusableChunks)?.toMutableList() ?: mutableListOf()
        var aggregateBytes = manifestFile.takeIf { it.isFile }?.length() ?: 0L
        val chunkDirectory = summaryChunkInstanceDirectory(instanceId).apply { mkdirs() }
        cleanupSummaryChunks(chunkDirectory, previouslyCommittedChunks)
        var physicalChunkBytes = chunkDirectory.listFiles()
            ?.filter(File::isFile)
            ?.sumOf(File::length)
            ?: 0L
        val maximumTransactionalDiskBytes = maximumSummaryCacheBytes.toLong() * 2
        var committed = false
        try {
            for ((index, summariesChunk) in summaries.chunked(summaryChunkSize).withIndex()) {
                if (index < reusableChunks) {
                    val reusableFile = File(chunkDirectory, "${chunkIds[index]}.json")
                    if (!reusableFile.isFile || reusableFile.length() !in 1..maxSummaryChunkBytes.toLong()) {
                        throw IllegalStateException("Reusable summary cache chunk is unavailable")
                    }
                    if (runCatching { digest(reusableFile.readBytes()) }.getOrNull() != chunkIds[index]) {
                        throw IllegalStateException("Reusable summary cache chunk is corrupt")
                    }
                    aggregateBytes += reusableFile.length()
                    continue
                }
                val envelope = ChatSummaryChunkEnvelope(instanceId, summariesChunk)
                val bytes = json.encodeToString(envelope).toByteArray(Charsets.UTF_8)
                if (bytes.size > maxSummaryChunkBytes) {
                    throw IllegalStateException("Summary cache chunk exceeds maximum size")
                }
                aggregateBytes += bytes.size
                if (aggregateBytes > maximumSummaryCacheBytes) {
                    throw IllegalStateException("Cache file exceeds maximum size")
                }
                val chunkId = digest(bytes)
                val file = File(chunkDirectory, "$chunkId.json")
                val alreadyValid = file.isFile && file.length() == bytes.size.toLong() &&
                    runCatching { digest(file.readBytes()) == chunkId }.getOrDefault(false)
                if (!alreadyValid) {
                    if (physicalChunkBytes + bytes.size > maximumTransactionalDiskBytes) {
                        throw IllegalStateException("Summary cache transaction exceeds disk limit")
                    }
                    writeAtomically(bytes, file)
                    physicalChunkBytes += bytes.size
                }
                chunkIds += chunkId
            }
            val manifest = ChatSummaryManifestEnvelope(instanceId, summaries.size, chunkIds)
            val manifestBytes = json.encodeToString(manifest).toByteArray(Charsets.UTF_8)
            if (aggregateBytes + manifestBytes.size > maximumSummaryCacheBytes) {
                throw IllegalStateException("Cache file exceeds maximum size")
            }
            writeAtomically(manifestBytes, manifestFile)
            committed = true
            File(root, "summaries").takeIf { it.isDirectory }?.let {
                fileURL("summaries", instanceId).takeIf(File::exists)?.delete()
            }
        } finally {
            cleanupSummaryChunks(
                chunkDirectory,
                if (committed) chunkIds.toSet() else previouslyCommittedChunks
            )
        }
        publishSummaries(instanceId, summaries)
    }

    private fun cleanupSummaryChunks(directory: File, retainedChunkIds: Set<String>) {
        val retainedNames = retainedChunkIds.mapTo(mutableSetOf()) { "$it.json" }
        directory.listFiles()?.forEach { file ->
            if (file.isFile && file.name !in retainedNames) file.delete()
        }
    }

    private fun isValidSummarySet(
        summaries: List<AidenChatSummary>,
        envelopeInstanceId: String,
        expectedInstanceId: String
    ): Boolean = envelopeInstanceId == expectedInstanceId &&
        summaries.size <= maxSummaryCount &&
        summaries.map { it.id }.toSet().size == summaries.size

    @Synchronized
    fun upsertSummary(summary: AidenChatSummary, instanceId: String) {
        val current = summariesForInstance(instanceId).associateBy { it.id }.toMutableMap()
        current[summary.id] = summary
        saveSummaries(current.values.toList(), instanceId)
    }

    @Synchronized
    fun removeSummary(instanceId: String, chatId: String) {
        val current = summariesForInstance(instanceId)
        if (current.none { it.id == chatId }) return
        saveSummaries(current.filterNot { it.id == chatId }, instanceId)
    }

    @Synchronized
    fun updateSummaryActivity(
        instanceId: String,
        chatId: String,
        activity: AidenChatSummaryActivity
    ) {
        val current = summariesForInstance(instanceId)
        val existing = current.firstOrNull { it.id == chatId } ?: return
        if (existing.activity == activity) return
        saveSummaries(current.map { if (it.id == chatId) it.copy(activity = activity) else it }, instanceId)
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
        if (chat.isBotChat) {
            removeSummary(instanceId, chat.id)
        } else {
            val activity = summariesForInstance(instanceId)
                .firstOrNull { it.id == chat.id }
                ?.activity
                ?: AidenChatSummaryActivity.IDLE
            upsertSummary(AidenChatSummary.fromChat(chat, activity), instanceId)
        }
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
        updateSummaryActivity(instanceId, chatId, AidenChatSummaryActivity.ACTIVE)
    }

    @Synchronized
    fun removeActiveStream(instanceId: String, chatId: String) {
        val file = fileURL("streams", instanceId, chatId)
        if (file.exists()) file.delete()
        updateSummaryActivity(instanceId, chatId, AidenChatSummaryActivity.IDLE)
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
        removeSummary(instanceId, chatId)
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
        _summaries.value = _summaries.value - instanceId
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

    private fun summaryChunkInstanceDirectory(instanceId: String): File =
        File(File(root, "summary-chunks"), digest(instanceId))

    private fun summariesForInstance(instanceId: String): List<AidenChatSummary> =
        _summaries.value[instanceId]?.values?.toList()
            ?: loadSummaries(instanceId).orEmpty()

    private fun publishSummaries(instanceId: String, summaries: List<AidenChatSummary>) {
        _summaries.value = _summaries.value + (instanceId to summaries.associateBy { it.id })
    }

    private fun digest(value: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val hash = md.digest(value.toByteArray(Charsets.UTF_8))
        return hash.joinToString("") { "%02x".format(it) }
    }

    private fun digest(value: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(value)
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

    private inline fun <reified T> loadEnvelope(
        file: File,
        maximumBytes: Int = maxCacheFileBytes
    ): T? {
        if (!file.exists() || file.length() > maximumBytes) return null
        return try {
            val content = file.readText(Charsets.UTF_8)
            json.decodeFromString<T>(content)
        } catch (_: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CACHE, AidenDiagnosticEvent.CACHE_FAILED, AidenDiagnosticOutcome.DEGRADED, AidenDiagnosticCode.CORRUPT_DATA)
            null
        }
    }

    private inline fun <reified T> saveEnvelope(
        envelope: T,
        file: File,
        maximumBytes: Int = maxCacheFileBytes
    ) {
        val content = json.encodeToString(envelope)
        val bytes = content.toByteArray(Charsets.UTF_8)
        if (bytes.size > maximumBytes) throw IllegalStateException("Cache file exceeds maximum size")
        writeAtomically(bytes, file)
    }

    private fun writeAtomically(bytes: ByteArray, file: File) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".${file.name}.${java.util.UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
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
    }

    private fun purgeNamespace(cacheRoot: File, instanceId: String) {
        purgeFiles(cacheRoot, "lists", instanceId, ChatListEnvelope::class.java) { it.instanceId }
        purgeFiles(cacheRoot, "summaries", instanceId, ChatSummaryListEnvelope::class.java) { it.instanceId }
        fileURL("summary-manifests", instanceId).takeIf(File::exists)?.delete()
        summaryChunkInstanceDirectory(instanceId).takeIf(File::exists)?.deleteRecursively()
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
                } else if (clazz == ChatSummaryListEnvelope::class.java) {
                    val envelope = json.decodeFromString<ChatSummaryListEnvelope>(content)
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
