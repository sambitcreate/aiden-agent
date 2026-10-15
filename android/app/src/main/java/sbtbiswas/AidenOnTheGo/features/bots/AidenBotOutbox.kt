package sbtbiswas.AidenOnTheGo.features.bots

import androidx.core.util.AtomicFile
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import sbtbiswas.AidenOnTheGo.models.AidenBotCreateRequest
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotWireJson
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionWire
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Names one Bot chat across controllers and launches: its Mac, this pairing's device and the
 * Bot. The pairing's `deviceId` is part of it, so a re-paired phone never sees the old
 * pairing's messages.
 */
data class AidenBotSessionKey(val instanceId: String, val deviceId: String, val botId: String)

/** Where a message this phone sent stands (R14). */
enum class AidenBotOutgoingStatus {
    /** Waiting for a connection, or on its way to the Mac. */
    SENDING,
    /** The Mac took it ([AidenBotOutgoingMessage.submissionId]); its entry or Queued bubble is on the way. */
    SENT,
    /** It didn't reach the Mac: "Couldn't send · Try again". */
    FAILED
}

/**
 * A message the person sent that the Mac's transcript doesn't show yet (R14, R17). It shows at
 * once and gives way to the Mac's own entry or Queued bubble.
 */
data class AidenBotOutgoingMessage(
    /** The bubble's identity; it never changes, even when Try again needs a new key. */
    val id: String,
    /** The Idempotency-Key: every attempt uses it unless the Mac definitely refused it. */
    val key: UUID,
    val text: String,
    /** Steer or Queue, when it was sent while the Bot worked on a Mac that offers them. */
    val mode: AidenStreamInputMode?,
    /** Sent while the Bot worked: it reads as Queued until the turn takes it in. */
    val enqueuedWhileRunning: Boolean,
    /** The failed turn this message sends again (R18), or null. */
    val retryOf: String?,
    val createdAtMs: Long,
    val status: AidenBotOutgoingStatus = AidenBotOutgoingStatus.SENDING,
    /** The Mac's id for it, once [status] is [AidenBotOutgoingStatus.SENT]. */
    val submissionId: String? = null,
    /** The first attempt fixed the request body; later attempts under the same key resend it unchanged. */
    val frozen: Boolean = false,
    /** The `whenBusy` the first attempt sent. */
    val sentMode: AidenStreamInputMode? = null,
    /** Entry ids the transcript held at the first attempt: the Mac's echo is a newer entry. */
    val baseline: Set<String> = emptySet(),
    val connectionAttempts: Int = 0,
    /** The last failure may have reached the Mac, so Try again keeps the key. */
    val keepsKey: Boolean = false,
    // What this run of the controller has seen; never stored.
    /** The Mac's Queued bubble for it; while that shows, this copy is hidden. */
    val queuedId: String? = null,
    /** A transcript entry already stands for it while its request is unsettled: hidden until it settles. */
    val echoed: Boolean = false,
    val echoEntryId: String? = null,
    /** The submission that entry names, if any: only a receipt with that id settles it. */
    val echoSubmissionId: String? = null,
    /** Waits for the next connection or backoff before trying again. */
    val deferred: Boolean = false,
    /** Taken, but a snapshot found nothing on the Mac showing it: it goes on the next, or after a grace period. */
    val unheld: Boolean = false
) {
    /** Whether the Mac may hold it, so its echo can stand in for it. */
    val mayHaveReachedMac: Boolean
        get() = frozen && (status != AidenBotOutgoingStatus.FAILED || keepsKey)

    /** Too old to send: "Couldn't send · Try again", keeping the key if the Mac may hold it. */
    fun expired(): AidenBotOutgoingMessage =
        copy(status = AidenBotOutgoingStatus.FAILED, keepsKey = frozen, deferred = false, echoed = false)

    /** As another visit or launch finds it: what that run saw is stale. */
    fun adopted(nowMs: Long): AidenBotOutgoingMessage {
        val fresh = copy(deferred = false, echoed = false, echoEntryId = null, echoSubmissionId = null, queuedId = null, unheld = false)
        return if (fresh.status == AidenBotOutgoingStatus.SENDING && fresh.isExpired(nowMs)) fresh.expired() else fresh
    }

    fun isExpired(nowMs: Long): Boolean = nowMs - createdAtMs >= AidenBotSessionStore.LIFETIME_MS

    companion object {
        fun create(
            text: String,
            mode: AidenStreamInputMode?,
            enqueuedWhileRunning: Boolean,
            retryOf: String?,
            nowMs: Long,
            key: UUID = UUID.randomUUID()
        ) = AidenBotOutgoingMessage(
            id = "outgoing:${UUID.randomUUID()}",
            key = key,
            text = text,
            mode = mode,
            enqueuedWhileRunning = enqueuedWhileRunning,
            retryOf = retryOf,
            createdAtMs = nowMs
        )
    }
}

/** A chat's unsent messages read back from disk, and whether some of them couldn't be (FR-I2). */
data class AidenBotOutboxRestore(val messages: List<AidenBotOutgoingMessage>, val unreadable: Boolean)

/**
 * A New Bot on its way for one pairing (R15), kept on disk so a process death mid-create
 * brings it back: the person's [draft], the [request] exactly as it went out and its
 * idempotency [key] (null when nothing that could reach the Mac was sent), and when it began.
 */
data class AidenBotPendingCreate(
    val draft: AidenBotCreateDraft,
    val request: AidenBotCreateRequest? = null,
    val key: UUID? = null,
    val createdAtMs: Long
)

/** How the chat draws an outgoing message (R14). */
sealed class AidenBotOutgoingLook {
    /** Faded, "Sending…". */
    object Sending : AidenBotOutgoingLook()
    /** The Mac took it; its own entry replaces it shortly. */
    object Sent : AidenBotOutgoingLook()
    /** The Bot is working: Queued, as Steer or Queue. */
    data class Queued(val mode: AidenStreamInputMode) : AidenBotOutgoingLook()
    /** "Couldn't send · Try again". */
    object Failed : AidenBotOutgoingLook()
}

/**
 * What each Bot chat last showed in this run of the app, and its unsent messages (R14, R17).
 * Transcripts live in memory only (the last [CAPACITY] chats). Outboxes also live on disk under
 * [root], which the app puts in `noBackupFilesDir`, so they survive leaving the chat, a Bot
 * switch and process death but never reach a backup. Each chat's outbox has one writer at a
 * time ([adoptOutbox]); an older controller left behind can't overwrite it, and nothing written
 * after an unpair ([purgeInstance]) is kept. Disk writes run in order on [io], so a purge always
 * lands after the writes before it.
 */
class AidenBotSessionStore(
    private val root: File?,
    private val io: Executor = defaultIo,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val report: (String) -> Unit = {},
    /**
     * The most one chat's outbox may hold; a message past it is refused at enqueue. A later
     * launch reads back up to twice this, so a restore that merged two full outboxes still reads.
     */
    private val maxBytes: Int = MAX_BYTES
) {
    private val transcripts = LinkedHashMap<AidenBotSessionKey, List<AidenBotSessionEntry>>(CAPACITY, 0.75f, true)
    private val outboxes = HashMap<AidenBotSessionKey, List<AidenBotOutgoingMessage>>()
    private val read = HashSet<AidenBotSessionKey>()
    private val owners = HashMap<AidenBotSessionKey, Any>()
    /** Chats whose unreadable file couldn't be moved aside: it is never written over. */
    private val stuck = HashSet<AidenBotSessionKey>()
    /** Pairings (instance, device) whose New Bot on its way this run of the app has touched. */
    private val createPairings = HashSet<Pair<String, String>>()
    /** Pairings an unpair purged: no New Bot is kept for them again. */
    private val revokedCreates = HashSet<Pair<String, String>>()

    @Synchronized
    fun transcript(key: AidenBotSessionKey): List<AidenBotSessionEntry>? = transcripts[key]

    @Synchronized
    fun storeTranscript(key: AidenBotSessionKey, entries: List<AidenBotSessionEntry>) {
        transcripts[key] = entries
        while (transcripts.size > CAPACITY) transcripts.remove(transcripts.keys.first())
    }

    /**
     * Makes [owner] the only writer of the chat's outbox. Returns its messages when this run of
     * the app already read them (no disk access), or null when [restoreOutbox] must read the disk.
     */
    @Synchronized
    fun adoptOutbox(key: AidenBotSessionKey, owner: Any): List<AidenBotOutgoingMessage>? {
        owners[key] = owner
        return if (key in read) outboxes[key].orEmpty() else null
    }

    /**
     * The chat's messages, oldest first, read from disk on [io] (never the caller's thread) the
     * first time in this run of the app, and whether some couldn't be read back (FR-I2). Disk
     * reads, writes and purges all run in order on [io], so a purge that came first leaves
     * nothing to read. The read itself runs outside the store's lock: messages sent meanwhile
     * wait in memory and follow the older disk copy. Empty once [owner] no longer writes it.
     * The caller always resumes, with the store's answer or with the error that stopped it.
     */
    suspend fun restoreOutbox(key: AidenBotSessionKey, owner: Any): AidenBotOutboxRestore =
        suspendCancellableCoroutine { continuation ->
            val task = Runnable { continuation.resumeWith(runCatching { restoreNow(key, owner) }) }
            try {
                io.execute(task)
            } catch (error: RejectedExecutionException) {
                continuation.resumeWith(Result.failure(error))
            }
        }

    private fun restoreNow(key: AidenBotSessionKey, owner: Any): AidenBotOutboxRestore {
        synchronized(this) {
            if (owners[key] !== owner) return AidenBotOutboxRestore(emptyList(), unreadable = false)
            if (key in read) return AidenBotOutboxRestore(outboxes[key].orEmpty(), unreadable = false)
        }
        val disk = load(key)
        val merged: List<AidenBotOutgoingMessage>
        val rewrite: Boolean
        synchronized(this) {
            // Another controller took the chat, or a purge or unpair came while the disk was read.
            if (owners[key] !== owner || !read.add(key)) {
                return AidenBotOutboxRestore(if (owners[key] === owner) outboxes[key].orEmpty() else emptyList(), disk.unreadable)
            }
            val known = disk.messages.mapTo(HashSet()) { it.key }
            val pending = outboxes[key].orEmpty().filterNot { it.key in known }
            merged = disk.messages + pending
            if (merged.isEmpty()) outboxes.remove(key) else outboxes[key] = merged
            rewrite = pending.isNotEmpty() || disk.changed
        }
        // Still on [io]: a write or purge queued after this read lands after this write.
        if (rewrite) write(key, merged.map(Record::of))
        return AidenBotOutboxRestore(merged, disk.unreadable)
    }

    /**
     * Keeps [messages] when [owner] writes this chat; false when another controller does, or
     * after an unpair. Until the disk copy was read ([restoreOutbox]) they wait in memory, so they
     * never overwrite what a previous launch left.
     */
    @Synchronized
    fun storeOutbox(key: AidenBotSessionKey, owner: Any, messages: List<AidenBotOutgoingMessage>): Boolean {
        if (owners[key] !== owner) return false
        if (messages.isEmpty()) outboxes.remove(key) else outboxes[key] = messages
        if (key in read) {
            val records = messages.map(Record::of)
            io.execute { write(key, records) }
        }
        return true
    }

    /** Whether [messages] fit the file a later launch will read back; a message past that is refused, never stored. */
    fun fits(key: AidenBotSessionKey, messages: List<AidenBotOutgoingMessage>): Boolean =
        messages.size <= MAX_MESSAGES && encode(key, messages.map(Record::of)).size <= maxBytes

    /** This phone lost access to the chat (401/403, accessChanged): nothing of it is kept. */
    @Synchronized
    fun purge(key: AidenBotSessionKey) {
        transcripts.remove(key)
        outboxes.remove(key)
        read += key
        stuck -= key
        io.execute { fileFor(key)?.let { AtomicFile(it).delete() } }
    }

    /**
     * The Mac was unpaired: every chat of it goes, and no controller still open may write or
     * restore again. Its chats stay marked read (and empty), and the files go on [io] after any
     * write already queued.
     */
    @Synchronized
    fun purgeInstance(instanceId: String) {
        transcripts.keys.removeAll { it.instanceId == instanceId }
        outboxes.keys.removeAll { it.instanceId == instanceId }
        owners.keys.removeAll { it.instanceId == instanceId }
        stuck.removeAll { it.instanceId == instanceId }
        revokedCreates += createPairings.filter { it.first == instanceId }
        val dir = root?.let { File(it, digest(instanceId)) }
        io.execute { dir?.deleteRecursively() }
    }

    // --- A New Bot on its way (R15) ---

    /**
     * The New Bot an earlier launch left on its way for this pairing, read on [io] (after any
     * write or purge queued before it), or null. A file this build can't read is set aside as
     * `.unreadable`, never deleted. Its age is the caller's to judge (see [AidenBotCreateFlow]).
     */
    suspend fun pendingCreate(instanceId: String, deviceId: String): AidenBotPendingCreate? =
        suspendCancellableCoroutine { continuation ->
            synchronized(this) { createPairings += instanceId to deviceId }
            val task = Runnable { continuation.resumeWith(runCatching { loadCreate(instanceId, deviceId) }) }
            try {
                io.execute(task)
            } catch (error: RejectedExecutionException) {
                continuation.resumeWith(Result.failure(error))
            }
        }

    /** Keeps the pairing's New Bot on its way, before anything of it goes out; never for a pairing an unpair purged. */
    fun savePendingCreate(instanceId: String, deviceId: String, create: AidenBotPendingCreate) {
        val pairing = instanceId to deviceId
        synchronized(this) {
            createPairings += pairing
            if (pairing in revokedCreates) return
        }
        val record = CreateRecord.of(instanceId, deviceId, create)
        io.execute { writeCreate(instanceId, deviceId, record) }
    }

    /** The New Bot was made, let go of, or this phone lost access: nothing of it is kept. */
    fun removePendingCreate(instanceId: String, deviceId: String) {
        io.execute { createFileFor(instanceId, deviceId)?.let { AtomicFile(it).delete() } }
    }

    @Serializable
    private data class CreateRecord(
        val version: Int,
        val instanceId: String,
        val deviceId: String,
        val name: String,
        val help: String,
        val providerId: String? = null,
        val modelId: String? = null,
        /** The request body exactly as it went out, in the wire's own JSON. */
        val body: String? = null,
        val key: String? = null,
        val createdAt: Long
    ) {
        fun create(): AidenBotPendingCreate {
            val route = if (providerId != null && modelId != null) {
                sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute(providerId, modelId)
            } else {
                null
            }
            val request = body?.let { AidenBotWireJson.json.decodeFromString(AidenBotCreateRequest.serializer(), it) }
            val idempotencyKey = key?.let(UUID::fromString)
            require((request == null) == (idempotencyKey == null))
            return AidenBotPendingCreate(AidenBotCreateDraft(name, help, route), request, idempotencyKey, createdAt)
        }

        companion object {
            fun of(instanceId: String, deviceId: String, create: AidenBotPendingCreate) = CreateRecord(
                version = 1,
                instanceId = instanceId,
                deviceId = deviceId,
                name = create.draft.name,
                help = create.draft.help,
                providerId = create.draft.model?.providerId,
                modelId = create.draft.model?.modelId,
                body = create.request?.let { AidenBotWireJson.json.encodeToString(AidenBotCreateRequest.serializer(), it) },
                key = create.key?.toString(),
                createdAt = create.createdAtMs
            )
        }
    }

    private fun loadCreate(instanceId: String, deviceId: String): AidenBotPendingCreate? {
        val file = createFileFor(instanceId, deviceId) ?: return null
        if (!file.exists() && !File(file.path + ".bak").exists()) return null
        val create = try {
            val bytes = AtomicFile(file).readFully()
            if (bytes.size > MAX_CREATE_BYTES) throw IllegalStateException("too large")
            json.decodeFromString(CreateRecord.serializer(), String(bytes, Charsets.UTF_8))
                .takeIf { it.version == 1 && it.instanceId == instanceId && it.deviceId == deviceId }
                ?.create()
        } catch (_: Exception) {
            null
        }
        if (create == null) {
            report("event=bot_create_unreadable outcome=set_aside")
            val aside = File(file.parentFile, "create.${UUID.randomUUID()}.unreadable")
            if (!file.renameTo(aside)) report("event=bot_create_set_aside outcome=failed")
        }
        return create
    }

    private fun writeCreate(instanceId: String, deviceId: String, record: CreateRecord) {
        val file = createFileFor(instanceId, deviceId) ?: return
        if (synchronized(this) { (instanceId to deviceId) in revokedCreates }) return
        val atomic = AtomicFile(file)
        var stream: java.io.FileOutputStream? = null
        try {
            val data = json.encodeToString(CreateRecord.serializer(), record).toByteArray(Charsets.UTF_8)
            file.parentFile?.mkdirs()
            stream = atomic.startWrite()
            stream.write(data)
            atomic.finishWrite(stream)
        } catch (_: Exception) {
            stream?.let { atomic.failWrite(it) }
            report("event=bot_create_write outcome=failed")
        }
    }

    /** Beside the pairing's chat outboxes (named by 64-character digests, so never this name), and purged with them. */
    internal fun createFileFor(instanceId: String, deviceId: String): File? = root?.let {
        File(File(File(it, digest(instanceId)), digest(deviceId)), "create.json")
    }

    // --- Disk ---

    @Serializable
    private data class Record(
        val id: String,
        val key: String,
        val text: String,
        val mode: AidenStreamInputMode? = null,
        val enqueuedWhileRunning: Boolean = false,
        val retryOf: String? = null,
        val createdAt: Long,
        val submissionId: String? = null,
        val failed: Boolean = false,
        val frozen: Boolean = false,
        val sentMode: AidenStreamInputMode? = null,
        val baseline: List<String> = emptyList(),
        val connectionAttempts: Int = 0,
        val keepsKey: Boolean = false
    ) {
        fun message(): AidenBotOutgoingMessage {
            require(text.isNotBlank() && text.codePointCount(0, text.length) <= AidenBotSessionWire.MAX_MESSAGE_LENGTH)
            require(id.startsWith("outgoing:") && id.length <= 80 && connectionAttempts >= 0)
            return AidenBotOutgoingMessage(
                id = id,
                key = UUID.fromString(key),
                text = text,
                mode = mode,
                enqueuedWhileRunning = enqueuedWhileRunning,
                retryOf = retryOf,
                createdAtMs = createdAt,
                status = when {
                    failed -> AidenBotOutgoingStatus.FAILED
                    submissionId != null -> AidenBotOutgoingStatus.SENT
                    else -> AidenBotOutgoingStatus.SENDING
                },
                submissionId = submissionId,
                frozen = frozen,
                sentMode = sentMode,
                baseline = baseline.toSet(),
                connectionAttempts = connectionAttempts,
                keepsKey = keepsKey
            )
        }

        companion object {
            fun of(message: AidenBotOutgoingMessage) = Record(
                id = message.id,
                key = message.key.toString(),
                text = message.text,
                mode = message.mode,
                enqueuedWhileRunning = message.enqueuedWhileRunning,
                retryOf = message.retryOf,
                createdAt = message.createdAtMs,
                submissionId = message.submissionId.takeIf { message.status == AidenBotOutgoingStatus.SENT },
                failed = message.status == AidenBotOutgoingStatus.FAILED,
                frozen = message.frozen,
                sentMode = message.sentMode,
                baseline = message.baseline.toList(),
                connectionAttempts = message.connectionAttempts,
                keepsKey = message.keepsKey
            )
        }
    }

    @Serializable
    private data class Envelope(
        val version: Int,
        val instanceId: String,
        val deviceId: String,
        val botId: String,
        val messages: List<JsonElement>
    )

    private class Loaded(val messages: List<AidenBotOutgoingMessage>, val changed: Boolean, val unreadable: Boolean)

    /**
     * One chat's messages from disk. Each record decodes on its own, so a bad one costs only
     * itself. A file this build can't read (unopenable, oversized, damaged, a newer version or
     * another pairing's) is set aside beside it as `.unreadable`, never deleted; when only some
     * records are bad, the file as it was is copied aside and the readable ones written back.
     * One still unsent after 24 hours comes back as not sent; a taken one that old is the Mac's
     * now. Nothing is dropped to fit: the size limit is checked when a message is sent.
     */
    private fun load(key: AidenBotSessionKey): Loaded {
        val nothing = Loaded(emptyList(), changed = false, unreadable = false)
        val file = fileFor(key) ?: return nothing
        val atomic = AtomicFile(file)
        // AtomicFile keeps the last good copy as `.bak` until a write finishes.
        if (!file.exists() && !File(file.path + ".bak").exists()) return nothing
        val envelope = try {
            val bytes = atomic.readFully()
            // A chat never writes one this large: two full outboxes merged on a restore at most.
            if (bytes.size > 2 * maxBytes) throw IllegalStateException("too large")
            json.decodeFromString(Envelope.serializer(), String(bytes, Charsets.UTF_8))
                .takeIf { it.version == 1 && it.instanceId == key.instanceId && it.deviceId == key.deviceId && it.botId == key.botId }
        } catch (_: Exception) {
            null
        }
        if (envelope == null) {
            report("event=bot_outbox_unreadable outcome=set_aside")
            setAside(key, file, keepOriginal = false)
            return Loaded(emptyList(), changed = false, unreadable = true)
        }
        val readable = envelope.messages.mapNotNull { element ->
            try {
                json.decodeFromJsonElement(Record.serializer(), element).message()
            } catch (_: Exception) {
                null
            }
        }
        val lostSome = readable.size != envelope.messages.size
        if (lostSome) {
            report("event=bot_outbox_record_unreadable outcome=set_aside count=${envelope.messages.size - readable.size}")
            setAside(key, file, keepOriginal = true)
        }
        val now = nowMs()
        val messages = readable.mapNotNull { message ->
            when {
                !message.isExpired(now) -> message
                message.status == AidenBotOutgoingStatus.SENT -> null
                message.status == AidenBotOutgoingStatus.SENDING -> message.expired()
                else -> message
            }
        }
        return Loaded(messages, changed = lostSome || messages != readable, unreadable = lostSome)
    }

    /**
     * Moves (or, with [keepOriginal], copies) a file this build can't fully read out of the
     * chat's way, as `<name>.<uuid>.unreadable`. One that can't be moved is never written over.
     */
    private fun setAside(key: AidenBotSessionKey, file: File, keepOriginal: Boolean) {
        val aside = File(file.parentFile, "${file.nameWithoutExtension}.${UUID.randomUUID()}.unreadable")
        val moved = try {
            if (keepOriginal) {
                file.copyTo(aside)
                true
            } else {
                file.renameTo(aside)
            }
        } catch (_: Exception) {
            false
        }
        if (!moved) {
            report("event=bot_outbox_set_aside outcome=failed")
            if (!keepOriginal) synchronized(this) { stuck += key }
            return
        }
        // A backup left beside it belongs to the same unreadable file.
        if (!keepOriginal) File(file.path + ".bak").takeIf { it.exists() }?.renameTo(File(aside.path + ".bak"))
    }

    private fun encode(key: AidenBotSessionKey, records: List<Record>): ByteArray {
        val envelope = Envelope(1, key.instanceId, key.deviceId, key.botId, records.map { json.encodeToJsonElement(it) })
        return json.encodeToString(Envelope.serializer(), envelope).toByteArray(Charsets.UTF_8)
    }

    /** Atomic and synced before it replaces the old file, so a crash leaves the old or the new outbox, never half of one. */
    private fun write(key: AidenBotSessionKey, records: List<Record>) {
        val file = fileFor(key) ?: return
        if (synchronized(this) { key in stuck }) return
        val atomic = AtomicFile(file)
        if (records.isEmpty()) {
            atomic.delete()
            return
        }
        var stream: java.io.FileOutputStream? = null
        try {
            val data = encode(key, records)
            file.parentFile?.mkdirs()
            stream = atomic.startWrite()
            stream.write(data)
            atomic.finishWrite(stream)
        } catch (_: Exception) {
            stream?.let { atomic.failWrite(it) }
            report("event=bot_outbox_write outcome=failed")
        }
    }

    /** Where [key]'s outbox lives on disk; null for a memory-only store. */
    internal fun fileFor(key: AidenBotSessionKey): File? = root?.let {
        File(File(File(it, digest(key.instanceId)), digest(key.deviceId)), "${digest(key.botId)}.json")
    }

    companion object {
        const val LIFETIME_MS = 24L * 60 * 60 * 1_000
        /** The most messages one chat may hold waiting; another is refused, visibly. */
        const val MAX_MESSAGES = 20
        const val CAPACITY = 16
        const val MAX_BYTES = 4_000_000
        /** A New Bot's answers and request are far smaller; anything past this is damage. */
        private const val MAX_CREATE_BYTES = 1_000_000
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
        private val defaultIo: Executor by lazy {
            Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "aiden-bot-outbox").apply { isDaemon = true } }
        }

        private fun digest(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
