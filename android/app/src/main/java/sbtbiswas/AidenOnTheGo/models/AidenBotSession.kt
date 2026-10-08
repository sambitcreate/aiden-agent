package sbtbiswas.AidenOnTheGo.models

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.AidenSSEParserException
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.time.Instant

// Contract revision 25 (`bot-durable-session-v1`): one durable conversation per Bot,
// addressed by Bot id rather than chat id.

/** Strict codec for the revision-25 Bot DTOs: exact keys, no unknown fields, nulls omitted. */
object AidenBotWireJson {
    val json: Json = Json {
        ignoreUnknownKeys = false
        encodeDefaults = true
        explicitNulls = false
        classDiscriminator = "type"
    }
}

/** Bounds and grammars shared with the host parsers in `aiden-remote-protocol.ts`. */
/**
 * kotlinx accepts `"12"` for a number and `"true"` for a boolean; the host's parsers do not.
 * These read the raw JSON token and refuse quoted values.
 */
private fun JsonDecoder.unquotedPrimitive(field: String): JsonPrimitive {
    val element = decodeJsonElement()
    if (element !is JsonPrimitive || element.isString || element is kotlinx.serialization.json.JsonNull) {
        throw AidenBotContractException.InvalidField(field)
    }
    return element
}

object AidenStrictLongSerializer : KSerializer<Long> {
    override val descriptor: SerialDescriptor =
        kotlinx.serialization.descriptors.PrimitiveSerialDescriptor("AidenStrictLong", kotlinx.serialization.descriptors.PrimitiveKind.LONG)
    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
    override fun deserialize(decoder: Decoder): Long {
        val json = decoder as? JsonDecoder ?: return decoder.decodeLong()
        return json.unquotedPrimitive("integer").longOrNull ?: throw AidenBotContractException.InvalidField("integer")
    }
}

object AidenStrictIntSerializer : KSerializer<Int> {
    override val descriptor: SerialDescriptor =
        kotlinx.serialization.descriptors.PrimitiveSerialDescriptor("AidenStrictInt", kotlinx.serialization.descriptors.PrimitiveKind.INT)
    override fun serialize(encoder: Encoder, value: Int) = encoder.encodeInt(value)
    override fun deserialize(decoder: Decoder): Int {
        val json = decoder as? JsonDecoder ?: return decoder.decodeInt()
        return json.unquotedPrimitive("integer").intOrNull ?: throw AidenBotContractException.InvalidField("integer")
    }
}

object AidenStrictBooleanSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor =
        kotlinx.serialization.descriptors.PrimitiveSerialDescriptor("AidenStrictBoolean", kotlinx.serialization.descriptors.PrimitiveKind.BOOLEAN)
    override fun serialize(encoder: Encoder, value: Boolean) = encoder.encodeBoolean(value)
    override fun deserialize(decoder: Decoder): Boolean {
        val json = decoder as? JsonDecoder ?: return decoder.decodeBoolean()
        return when (json.unquotedPrimitive("boolean").content) {
            "true" -> true
            "false" -> false
            else -> throw AidenBotContractException.InvalidField("boolean")
        }
    }
}

object AidenBotSessionWire {
    const val MAX_ENTRIES = 200
    const val MAX_TEXT_LENGTH = 100_000
    const val MAX_MESSAGE_LENGTH = 32_000
    const val MAX_LABEL_LENGTH = 120
    const val MAX_NAME_LENGTH = 120
    const val MAX_REASON_LENGTH = 280
    const val MAX_EPOCH_LENGTH = 64
    const val MAX_SUBMISSION_ID_LENGTH = 64
    const val MAX_PLUGIN_ID_LENGTH = 80
    private val PLUGIN_ID = Regex("^[a-z0-9][a-z0-9._-]*$")
    private val EPOCH = Regex("^[A-Za-z0-9_-]+$")

    /** Connection, icon and preset ids: lowercase, `^[a-z0-9][a-z0-9._-]*$`, at most 80 characters. */
    fun validatePluginId(value: String, field: String) {
        AidenBotWire.validateString(value, field, MAX_PLUGIN_ID_LENGTH)
        if (!PLUGIN_ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }

    fun validateEpoch(value: String) {
        AidenBotWire.validateString(value, "epoch", MAX_EPOCH_LENGTH)
        if (!EPOCH.matches(value)) throw AidenBotContractException.InvalidField("epoch")
    }
}

@Serializable
enum class AidenBotSessionBlock {
    @SerialName("access_changed") ACCESS_CHANGED,
    @SerialName("bot_missing") BOT_MISSING
}

@Serializable
enum class AidenBotMessageRole {
    @SerialName("user") USER,
    @SerialName("assistant") ASSISTANT
}

@Serializable
enum class AidenBotConnectCardStatus {
    @SerialName("pending") PENDING,
    @SerialName("connected") CONNECTED,
    @SerialName("dismissed") DISMISSED
}

@Serializable
enum class AidenBotSessionNoticeKind {
    @SerialName("session_reset") SESSION_RESET
}

private fun validateState(state: AidenBotSessionState, interrupted: Boolean, blocked: AidenBotSessionBlock?) {
    if (interrupted != (state == AidenBotSessionState.INTERRUPTED) || (blocked != null && !interrupted)) {
        throw AidenBotContractException.InvalidCombination("bot session state")
    }
}

/** One durable session entry, discriminated by `type`. */
@Serializable
sealed class AidenBotSessionEntry {
    abstract val id: String

    @Serializable
    @SerialName("message")
    data class Message(
        override val id: String,
        val role: AidenBotMessageRole,
        val text: String,
        @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null,
        /** Routine name shown above a routine's user turn. */
        val label: String? = null,
        /** An assistant answer that was cut off. */
        @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean? = null
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
            AidenBotWire.validateString(text, "entry.text", AidenBotSessionWire.MAX_TEXT_LENGTH, allowEmpty = true)
            label?.let { AidenBotWire.validateString(it, "entry.label", AidenBotSessionWire.MAX_LABEL_LENGTH) }
            // The host only ever marks an assistant answer, and only as `true`.
            if (interrupted != null && (!interrupted || role != AidenBotMessageRole.ASSISTANT)) {
                throw AidenBotContractException.InvalidField("entry.interrupted")
            }
        }
    }

    @Serializable
    @SerialName("connect_card")
    data class ConnectCard(
        override val id: String,
        val pluginId: String,
        val name: String,
        val iconId: String,
        val reason: String,
        val status: AidenBotConnectCardStatus
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
            AidenBotSessionWire.validatePluginId(pluginId, "entry.pluginId")
            AidenBotWire.validateString(name, "entry.name", AidenBotSessionWire.MAX_NAME_LENGTH)
            AidenBotSessionWire.validatePluginId(iconId, "entry.iconId")
            AidenBotWire.validateString(reason, "entry.reason", AidenBotSessionWire.MAX_REASON_LENGTH)
        }
    }

    @Serializable
    @SerialName("notice")
    data class Notice(
        override val id: String,
        val notice: AidenBotSessionNoticeKind
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
        }
    }
}

/** `GET /bots/{botId}/session`: the newest entries plus the in-flight partial. */
@Serializable
data class AidenBotSession(
    val botId: String,
    val epoch: String,
    @Serializable(with = AidenStrictLongSerializer::class) val seq: Long,
    val state: AidenBotSessionState,
    @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean,
    val blocked: AidenBotSessionBlock? = null,
    val partial: String? = null,
    val entries: List<AidenBotSessionEntry>,
    @Serializable(with = AidenStrictBooleanSerializer::class) val hasOlder: Boolean
) {
    init {
        AidenBotWire.validateIdentifier(botId, "botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotSessionWire.validateEpoch(epoch)
        if (seq < 0 || seq > AidenRemoteProtocol.MAX_SAFE_INTEGER) throw AidenBotContractException.InvalidField("seq")
        validateState(state, interrupted, blocked)
        partial?.let { AidenBotWire.validateString(it, "partial", AidenBotSessionWire.MAX_TEXT_LENGTH, allowEmpty = true) }
        if (entries.size > AidenBotSessionWire.MAX_ENTRIES || entries.map { it.id }.toSet().size != entries.size) {
            throw AidenBotContractException.InvalidField("entries")
        }
    }
}

/** Resume, Dismiss and Stop answer with the session's state view. */
@Serializable
data class AidenBotSessionStateView(
    val state: AidenBotSessionState,
    @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean,
    val blocked: AidenBotSessionBlock? = null
) {
    init {
        validateState(state, interrupted, blocked)
    }
}

@Serializable
data class AidenBotSessionSendRequest(val text: String) {
    init {
        AidenBotWire.validateString(text, "text", AidenBotSessionWire.MAX_MESSAGE_LENGTH)
        if (text.isBlank()) throw AidenBotContractException.InvalidField("text")
    }
}

@Serializable
data class AidenBotSessionSendResponse(
    val submissionId: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val deduped: Boolean,
    val state: AidenBotSessionState,
    @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean,
    val blocked: AidenBotSessionBlock? = null
) {
    init {
        AidenBotWire.validateString(submissionId, "submissionId", AidenBotSessionWire.MAX_SUBMISSION_ID_LENGTH)
        validateState(state, interrupted, blocked)
    }

    val stateView: AidenBotSessionStateView get() = AidenBotSessionStateView(state, interrupted, blocked)
}

/** The `{}` body Resume, Dismiss and Stop send. */
@Serializable
class AidenBotEmptyRequest {
    override fun equals(other: Any?): Boolean = other is AidenBotEmptyRequest
    override fun hashCode(): Int = 0
}

@Serializable
data class AidenBotConnectionRequest(val pluginId: String) {
    init {
        AidenBotSessionWire.validatePluginId(pluginId, "pluginId")
    }
}

@Serializable
enum class AidenBotConnectionRequestStatus {
    @SerialName("sent") SENT
}

@Serializable
data class AidenBotConnectionRequestReceipt(
    val pluginId: String,
    val name: String,
    val status: AidenBotConnectionRequestStatus
) {
    init {
        AidenBotSessionWire.validatePluginId(pluginId, "pluginId")
        AidenBotWire.validateString(name, "name", AidenBotSessionWire.MAX_NAME_LENGTH)
    }
}

/** What one session event frame carries. */
sealed class AidenBotSessionEventPayload {
    /** Always the first frame of a connection: replace everything. */
    data class Snapshot(val session: AidenBotSession) : AidenBotSessionEventPayload()
    /** The full current partial text; `""` clears it. */
    data class Partial(val text: String) : AidenBotSessionEventPayload() {
        init {
            AidenBotWire.validateString(text, "partial", AidenBotSessionWire.MAX_TEXT_LENGTH, allowEmpty = true)
        }
    }
    /** Append, or replace by id; clears the partial. */
    data class Entry(val entry: AidenBotSessionEntry) : AidenBotSessionEventPayload()
    data class State(val view: AidenBotSessionStateView) : AidenBotSessionEventPayload()
    /** The host closed this Bot's session; reconnect for a new epoch. */
    object Closed : AidenBotSessionEventPayload() {
        override fun toString(): String = "Closed"
    }
}

/** One `data:` frame of `GET /bots/{botId}/session/events`. */
@Serializable(with = AidenBotSessionEventSerializer::class)
data class AidenBotSessionEvent(
    val botId: String,
    val epoch: String,
    val seq: Long,
    val payload: AidenBotSessionEventPayload
) {
    init {
        AidenBotWire.validateIdentifier(botId, "botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotSessionWire.validateEpoch(epoch)
        if (seq < 0 || seq > AidenRemoteProtocol.MAX_SAFE_INTEGER) throw AidenBotContractException.InvalidField("seq")
        if (payload is AidenBotSessionEventPayload.Snapshot &&
            (payload.session.botId != botId || payload.session.epoch != epoch || payload.session.seq != seq)
        ) {
            throw AidenBotContractException.InvalidCombination("bot session snapshot identity")
        }
    }

    val type: String
        get() = when (payload) {
            is AidenBotSessionEventPayload.Snapshot -> "snapshot"
            is AidenBotSessionEventPayload.Partial -> "partial"
            is AidenBotSessionEventPayload.Entry -> "entry"
            is AidenBotSessionEventPayload.State -> "state"
            AidenBotSessionEventPayload.Closed -> "closed"
        }
}

object AidenBotSessionEventSerializer : KSerializer<AidenBotSessionEvent> {
    private val ENVELOPE_KEYS = setOf("protocolVersion", "botId", "epoch", "seq", "type", "payload")

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AidenBotSessionEvent")

    override fun serialize(encoder: Encoder, value: AidenBotSessionEvent) {
        val jsonEncoder = encoder as? JsonEncoder ?: throw SerializationException("Bot session events are JSON only")
        val wire = AidenBotWireJson.json
        val payload: JsonObject = when (val p = value.payload) {
            is AidenBotSessionEventPayload.Snapshot -> buildJsonObject {
                put("session", wire.encodeToJsonElement(AidenBotSession.serializer(), p.session))
            }
            is AidenBotSessionEventPayload.Partial -> buildJsonObject { put("text", JsonPrimitive(p.text)) }
            is AidenBotSessionEventPayload.Entry -> buildJsonObject {
                put("entry", wire.encodeToJsonElement(AidenBotSessionEntry.serializer(), p.entry))
            }
            is AidenBotSessionEventPayload.State ->
                wire.encodeToJsonElement(AidenBotSessionStateView.serializer(), p.view).jsonObject
            AidenBotSessionEventPayload.Closed -> JsonObject(emptyMap())
        }
        jsonEncoder.encodeJsonElement(buildJsonObject {
            put("protocolVersion", JsonPrimitive(AidenRemoteProtocol.VERSION))
            put("botId", JsonPrimitive(value.botId))
            put("epoch", JsonPrimitive(value.epoch))
            put("seq", JsonPrimitive(value.seq))
            put("type", JsonPrimitive(value.type))
            put("payload", payload)
        })
    }

    override fun deserialize(decoder: Decoder): AidenBotSessionEvent {
        val jsonDecoder = decoder as? JsonDecoder ?: throw SerializationException("Bot session events are JSON only")
        val root = jsonDecoder.decodeJsonElement() as? JsonObject
            ?: throw AidenRemoteContractException.InvalidJson("Expected Bot session event object")
        return decode(root)
    }

    fun decode(root: JsonObject): AidenBotSessionEvent {
        if (root.keys != ENVELOPE_KEYS) throw AidenBotContractException.InvalidField("bot session event")
        if ((root["protocolVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull != AidenRemoteProtocol.VERSION) {
            throw AidenRemoteContractException.InvalidProtocolVersion
        }
        val botId = root.string("botId")
        val epoch = root.string("epoch")
        val seq = (root["seq"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            ?: throw AidenBotContractException.InvalidField("seq")
        val payload = root["payload"] as? JsonObject ?: throw AidenBotContractException.InvalidField("payload")
        val wire = AidenBotWireJson.json
        val decoded: AidenBotSessionEventPayload = when (root.string("type")) {
            "snapshot" -> {
                payload.requireKeys(setOf("session"))
                AidenBotSessionEventPayload.Snapshot(
                    wire.decodeFromJsonElement(AidenBotSession.serializer(), payload.getValue("session"))
                )
            }
            "partial" -> {
                payload.requireKeys(setOf("text"))
                AidenBotSessionEventPayload.Partial(payload.string("text"))
            }
            "entry" -> {
                payload.requireKeys(setOf("entry"))
                AidenBotSessionEventPayload.Entry(
                    wire.decodeFromJsonElement(AidenBotSessionEntry.serializer(), payload.getValue("entry"))
                )
            }
            "state" -> AidenBotSessionEventPayload.State(
                wire.decodeFromJsonElement(AidenBotSessionStateView.serializer(), payload)
            )
            "closed" -> {
                payload.requireKeys(emptySet())
                AidenBotSessionEventPayload.Closed
            }
            else -> throw AidenBotContractException.InvalidField("type")
        }
        return AidenBotSessionEvent(botId = botId, epoch = epoch, seq = seq, payload = decoded)
    }

    private fun JsonObject.string(key: String): String =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw AidenBotContractException.InvalidField(key)

    private fun JsonObject.requireKeys(expected: Set<String>) {
        if (keys != expected) throw AidenBotContractException.InvalidField("payload")
    }
}

/** Frames `GET /bots/{botId}/session/events`. Only `data:` lines carry content. */
object AidenBotSessionEventStream {
    fun decodeFrame(rawBytes: ByteArray, expectedBotId: String): AidenBotSessionEvent {
        if (rawBytes.size > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) throw AidenRemoteContractException.PayloadTooLarge
        AidenRawJsonDuplicateKeyScanner.validate(rawBytes)
        AidenBotPrivateResponseValidator.validate(rawBytes, AidenBotPrivateResponseScope.Root("botSessionEvents"))
        val root = try {
            AidenBotWireJson.json.parseToJsonElement(String(rawBytes, Charsets.UTF_8))
        } catch (_: Exception) {
            throw AidenRemoteContractException.InvalidJson("Invalid JSON in Bot session event")
        } as? JsonObject ?: throw AidenRemoteContractException.InvalidJson("Expected Bot session event object")
        val event = AidenBotSessionEventSerializer.decode(root)
        if (event.botId != expectedBotId) throw AidenRemoteContractException.InvalidStreamIdentity
        return event
    }

    fun parse(inputStream: InputStream, expectedBotId: String): Flow<AidenBotSessionEvent> = flow {
        val reader = BufferedReader(InputStreamReader(inputStream, Charsets.UTF_8))
        val dataLines = mutableListOf<String>()
        var frameBytes = 0
        var line = reader.readLine()
        while (line != null) {
            frameBytes += line.toByteArray(Charsets.UTF_8).size + 1
            if (frameBytes > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) throw AidenSSEParserException.FrameTooLarge
            if (line.isEmpty()) {
                if (dataLines.isNotEmpty()) {
                    val raw = dataLines.joinToString("\n").toByteArray(Charsets.UTF_8)
                    dataLines.clear()
                    frameBytes = 0
                    emit(decodeFrame(raw, expectedBotId))
                } else {
                    frameBytes = 0
                }
            } else if (!line.startsWith(":")) {
                val colon = line.indexOf(':')
                val field = if (colon == -1) line else line.substring(0, colon)
                var value = if (colon == -1) "" else line.substring(colon + 1)
                if (value.startsWith(" ")) value = value.substring(1)
                if (field == "data") dataLines.add(value)
            }
            line = reader.readLine()
        }
        // EOF is not a frame delimiter: a truncated frame never applies.
    }
}
