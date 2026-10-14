package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionWire
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors

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
    val deferred: Boolean = false
) {
    /** Whether the Mac may hold it, so its echo can stand in for it. */
    val mayHaveReachedMac: Boolean
        get() = frozen && (status != AidenBotOutgoingStatus.FAILED || keepsKey)

    /** Too old to send: "Couldn't send · Try again", keeping the key if the Mac may hold it. */
    fun expired(): AidenBotOutgoingMessage =
        copy(status = AidenBotOutgoingStatus.FAILED, keepsKey = frozen, deferred = false, echoed = false)

    /** As another visit or launch finds it: what that run saw is stale. */
    fun adopted(nowMs: Long): AidenBotOutgoingMessage {
        val fresh = copy(deferred = false, echoed = false, echoEntryId = null, echoSubmissionId = null, queuedId = null)
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
    private val report: (String) -> Unit = {}
) {
    private val transcripts = LinkedHashMap<AidenBotSessionKey, List<AidenBotSessionEntry>>(CAPACITY, 0.75f, true)
    private val outboxes = HashMap<AidenBotSessionKey, List<AidenBotOutgoingMessage>>()
    private val read = HashSet<AidenBotSessionKey>()
    private val owners = HashMap<AidenBotSessionKey, Any>()

    @Synchronized
    fun transcript(key: AidenBotSessionKey): List<AidenBotSessionEntry>? = transcripts[key]

    @Synchronized
    fun storeTranscript(key: AidenBotSessionKey, entries: List<AidenBotSessionEntry>) {
        transcripts[key] = entries
        while (transcripts.size > CAPACITY) transcripts.remove(transcripts.keys.first())
    }

    /** The chat's unsent messages, oldest first, now written by [owner] only. */
    @Synchronized
    fun adoptOutbox(key: AidenBotSessionKey, owner: Any): List<AidenBotOutgoingMessage> {
        owners[key] = owner
        if (read.add(key)) {
            val stored = load(key)
            if (stored.isNotEmpty()) outboxes[key] = stored
        }
        return outboxes[key].orEmpty()
    }

    /** Keeps [messages] when [owner] writes this chat; false when another controller does, or after an unpair. */
    @Synchronized
    fun storeOutbox(key: AidenBotSessionKey, owner: Any, messages: List<AidenBotOutgoingMessage>): Boolean {
        if (owners[key] !== owner) return false
        if (messages.isEmpty()) outboxes.remove(key) else outboxes[key] = messages
        val records = messages.map(Record::of)
        io.execute { write(key, records) }
        return true
    }

    /** This phone lost access to the chat (401/403, accessChanged): nothing of it is kept. */
    @Synchronized
    fun purge(key: AidenBotSessionKey) {
        transcripts.remove(key)
        outboxes.remove(key)
        read += key
        io.execute { fileFor(key)?.delete() }
    }

    /** The Mac was unpaired: every chat of it goes, and no controller still open may write again. */
    @Synchronized
    fun purgeInstance(instanceId: String) {
        transcripts.keys.removeAll { it.instanceId == instanceId }
        outboxes.keys.removeAll { it.instanceId == instanceId }
        owners.keys.removeAll { it.instanceId == instanceId }
        read.removeAll { it.instanceId == instanceId }
        val dir = root?.let { File(it, digest(instanceId)) }
        io.execute { dir?.deleteRecursively() }
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

    /**
     * One chat's messages from disk. Each record decodes on its own, so a bad one costs only
     * itself. One still unsent after 24 hours comes back as not sent; a taken one that old is
     * the Mac's now.
     */
    private fun load(key: AidenBotSessionKey): List<AidenBotOutgoingMessage> {
        val file = fileFor(key) ?: return emptyList()
        if (!file.exists()) return emptyList()
        val envelope = try {
            if (file.length() > MAX_BYTES) throw IllegalStateException("too large")
            json.decodeFromString(Envelope.serializer(), file.readText(Charsets.UTF_8))
                .takeIf { it.version == 1 && it.instanceId == key.instanceId && it.deviceId == key.deviceId && it.botId == key.botId }
        } catch (_: Exception) {
            null
        }
        if (envelope == null) {
            report("event=bot_outbox_unreadable outcome=dropped")
            file.delete()
            return emptyList()
        }
        val readable = envelope.messages.mapNotNull { element ->
            try {
                json.decodeFromJsonElement(Record.serializer(), element).message()
            } catch (_: Exception) {
                null
            }
        }
        if (readable.size != envelope.messages.size) {
            report("event=bot_outbox_record_unreadable outcome=dropped count=${envelope.messages.size - readable.size}")
        }
        val now = nowMs()
        val messages = readable.mapNotNull { message ->
            when {
                !message.isExpired(now) -> message
                message.status == AidenBotOutgoingStatus.SENT -> null
                message.status == AidenBotOutgoingStatus.SENDING -> message.expired()
                else -> message
            }
        }.take(MAX_MESSAGES)
        if (messages != readable) {
            val records = messages.map(Record::of)
            io.execute { write(key, records) }
        }
        return messages
    }

    private fun write(key: AidenBotSessionKey, records: List<Record>) {
        val file = fileFor(key) ?: return
        try {
            if (records.isEmpty()) {
                file.delete()
                return
            }
            val envelope = Envelope(1, key.instanceId, key.deviceId, key.botId, records.map { json.encodeToJsonElement(it) })
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.writeText(json.encodeToString(Envelope.serializer(), envelope), Charsets.UTF_8)
            if (!temp.renameTo(file)) {
                temp.delete()
                report("event=bot_outbox_write outcome=failed")
            }
        } catch (_: Exception) {
            report("event=bot_outbox_write outcome=failed")
        }
    }

    private fun fileFor(key: AidenBotSessionKey): File? = root?.let {
        File(File(File(it, digest(key.instanceId)), digest(key.deviceId)), "${digest(key.botId)}.json")
    }

    companion object {
        const val LIFETIME_MS = 24L * 60 * 60 * 1_000
        /** The most messages one chat may hold waiting; another is refused, visibly. */
        const val MAX_MESSAGES = 20
        const val CAPACITY = 16
        private const val MAX_BYTES = 4_000_000L
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
        private val defaultIo: Executor by lazy {
            Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "aiden-bot-outbox").apply { isDaemon = true } }
        }

        private fun digest(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
