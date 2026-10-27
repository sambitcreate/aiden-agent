package sbtbiswas.AidenOnTheGo.models

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.KeepGeneratedSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer
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
// addressed by Bot id rather than chat id. Revision 27 adds the `memory_update` and
// `routine_proposal` entries (`bot:cards` devices only) and skips entry types this build
// can't read instead of refusing the whole session.

/**
 * Refuses an optional key the host sent as the literal null: the host leaves an absent value
 * out, and TypeScript and iOS refuse `null` (fixture `botActivityPrivacy.rejectedNullLiterals`).
 * The wire JSON's `explicitNulls = false` would otherwise read it as absent.
 */
internal fun JsonElement.refusingNullLiterals(field: String, vararg keys: String): JsonElement {
    val body = this as? JsonObject ?: return this
    for (key in keys) if (body[key] is JsonNull) throw AidenBotContractException.InvalidField("$field.$key")
    return this
}

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
    const val MAX_ROUTINE_ID_LENGTH = 160
    private val PLUGIN_ID = Regex("^[a-z0-9][a-z0-9._-]*$")
    private val EPOCH = Regex("^[A-Za-z0-9_-]+$")
    private val PROPOSAL_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    /** A routine proposal id: a lowercase UUID minted by the host. */
    fun validateProposalId(value: String, field: String) {
        if (!PROPOSAL_ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }

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

    @OptIn(ExperimentalSerializationApi::class)
    @KeepGeneratedSerializer
    @Serializable(with = AidenBotSessionMessageSerializer::class)
    @SerialName("message")
    data class Message(
        override val id: String,
        val role: AidenBotMessageRole,
        val text: String,
        @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null,
        /** Routine name shown above a routine's user turn. */
        val label: String? = null,
        /** An assistant answer that was cut off. */
        @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean? = null,
        /**
         * Revision 30 (`bot:activity` devices only): the id the Mac gave this person's own
         * message when it was sent. It lets a phone settle its optimistic bubble exactly.
         */
        val submissionId: String? = null
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
            AidenBotWire.validateString(text, "entry.text", AidenBotSessionWire.MAX_TEXT_LENGTH, allowEmpty = true)
            label?.let { AidenBotWire.validateString(it, "entry.label", AidenBotSessionWire.MAX_LABEL_LENGTH) }
            // The host only ever marks an assistant answer, and only as `true`.
            if (interrupted != null && (!interrupted || role != AidenBotMessageRole.ASSISTANT)) {
                throw AidenBotContractException.InvalidField("entry.interrupted")
            }
            // Only the person's own message is tagged, and never a routine turn (which has a label).
            submissionId?.let {
                if (role != AidenBotMessageRole.USER || label != null || !AidenBotWire.isSubmissionId(it)) {
                    throw AidenBotContractException.InvalidField("entry.submissionId")
                }
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

    /**
     * A turn that ended without a reply. While it is the newest entry, Retry posts
     * [retryText] as a new message with a new key; [retryText] is absent when there is
     * nothing to resend.
     */
    @Serializable
    @SerialName("failed_turn")
    data class FailedTurn(
        override val id: String,
        @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null,
        val retryText: String? = null
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
            retryText?.let { AidenBotWire.validateString(it, "entry.retryText", AidenBotSessionWire.MAX_TEXT_LENGTH) }
        }
    }

    /** Revision 27 (`bot:cards` devices only): the Bot saved something to its memory. */
    @Serializable
    @SerialName("memory_update")
    data class MemoryUpdate(
        override val id: String,
        @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
        }
    }

    /**
     * Revision 27 (`bot:cards` devices only): a routine the Bot suggested. A pending card is
     * answered through `POST /bots/{botId}/routine-proposals/{proposalId}/respond`; only an
     * accepted one names its [routineId].
     */
    @Serializable
    @SerialName("routine_proposal")
    data class RoutineProposal(
        override val id: String,
        val proposalId: String,
        val name: String,
        val prompt: String,
        val label: String,
        val status: AidenBotRoutineProposalStatus,
        val routineId: String? = null,
        @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
    ) : AidenBotSessionEntry() {
        init {
            AidenBotWire.validateIdentifier(id, "entry.id")
            AidenBotSessionWire.validateProposalId(proposalId, "entry.proposalId")
            AidenBotWire.validateString(name, "entry.name", AidenBotSessionWire.MAX_NAME_LENGTH)
            AidenBotWire.validateString(prompt, "entry.prompt", AidenBotSessionWire.MAX_TEXT_LENGTH)
            AidenBotWire.validateString(label, "entry.label", AidenBotSessionWire.MAX_LABEL_LENGTH)
            routineId?.let { AidenBotWire.validateString(it, "entry.routineId", AidenBotSessionWire.MAX_ROUTINE_ID_LENGTH) }
            if (routineId != null && status != AidenBotRoutineProposalStatus.ACCEPTED) {
                throw AidenBotContractException.InvalidCombination("routine proposal routineId")
            }
        }
    }

    companion object {
        /** The entry types this build reads. Any other `type` is skipped (revision 27). */
        val KNOWN_TYPES: Set<String> = setOf(
            "message", "connect_card", "notice", "failed_turn", "memory_update", "routine_proposal"
        )

        /**
         * The entry's `type` when this build can't read it, or null when it can. A missing or
         * non-string `type` is malformed, not unknown, and fails closed.
         */
        fun unknownType(element: JsonElement): String? {
            val obj = element as? JsonObject ?: throw AidenBotContractException.InvalidField("entry")
            val type = (obj["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AidenBotContractException.InvalidField("entry.type")
            return type.takeUnless { it in KNOWN_TYPES }
        }
    }
}

/**
 * A message entry, decoded strictly: `label` and `submissionId` may be left out but never sent
 * as null. The discriminator is the sealed class's to read, so it is set aside here.
 */
object AidenBotSessionMessageSerializer :
    JsonTransformingSerializer<AidenBotSessionEntry.Message>(AidenBotSessionEntry.Message.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement {
        element.refusingNullLiterals("entry", "label", "submissionId")
        val body = element as? JsonObject ?: return element
        return if ("type" in body) JsonObject(body - "type") else body
    }
}

@Serializable
enum class AidenBotRoutineProposalStatus {
    @SerialName("pending") PENDING,
    @SerialName("accepted") ACCEPTED,
    @SerialName("dismissed") DISMISSED
}

/**
 * A Bot's waiting A–E question (`question` on the session and on `question`
 * events). The card is the shared `ask_user_question` card; the answer is posted
 * once by [waitId].
 */
data class AidenBotQuestion(
    val waitId: String,
    val toolCallId: String,
    val questions: List<AidenRemoteQuestion>
) {
    init {
        AidenBotWire.validateIdentifier(waitId, "waitId", 64)
        AidenBotWire.validateIdentifier(toolCallId, "toolCallId", 128)
        if (questions.size !in 1..AidenRemoteProtocol.MAX_QUESTION_COUNT) {
            throw AidenBotContractException.InvalidField("questions")
        }
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("waitId", JsonPrimitive(waitId))
        put("toolCallId", JsonPrimitive(toolCallId))
        put(
            "questions",
            JsonArray(
                questions.map { question ->
                    buildJsonObject {
                        put("question", JsonPrimitive(question.question))
                        put("header", JsonPrimitive(question.header))
                        put("multiSelect", JsonPrimitive(question.multiSelect))
                        put(
                            "options",
                            JsonArray(
                                question.options.map { option ->
                                    buildJsonObject {
                                        put("label", JsonPrimitive(option.label))
                                        put("description", JsonPrimitive(option.description))
                                    }
                                }
                            )
                        )
                    }
                }
            )
        )
    }

    companion object {
        fun parse(element: JsonElement): AidenBotQuestion {
            val obj = element as? JsonObject ?: throw AidenBotContractException.InvalidField("question")
            if (obj.keys != setOf("waitId", "toolCallId", "questions")) {
                throw AidenBotContractException.InvalidField("question")
            }
            val waitId = (obj["waitId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AidenBotContractException.InvalidField("waitId")
            val toolCallId = (obj["toolCallId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AidenBotContractException.InvalidField("toolCallId")
            val questions = obj["questions"] as? JsonArray ?: throw AidenBotContractException.InvalidField("questions")
            return AidenBotQuestion(
                waitId = waitId,
                toolCallId = toolCallId,
                questions = AidenQuestionContractCodec.parseQuestions(questions, "Bot question")
            )
        }
    }
}

/**
 * A tool approval a Bot is waiting on (`approval` on the session and on `approval`
 * events). It is answered once through the generic `POST /approvals/{waitId}/respond`.
 * [canAllow] false (Computer Use) means this phone may only deny it.
 */
data class AidenBotApproval(
    val waitId: String,
    val toolCallId: String,
    val toolName: String,
    val summary: String,
    val canAllow: Boolean
) {
    init {
        AidenBotWire.validateString(waitId, "waitId", MAX_WAIT_ID_LENGTH)
        if (!WAIT_ID.matches(waitId)) throw AidenBotContractException.InvalidField("waitId")
        AidenBotWire.validateString(toolCallId, "toolCallId", MAX_TOOL_CALL_ID_LENGTH)
        AidenBotWire.validateString(toolName, "toolName", MAX_TOOL_NAME_LENGTH)
        AidenBotWire.validateString(summary, "summary", MAX_SUMMARY_LENGTH)
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("waitId", JsonPrimitive(waitId))
        put("toolCallId", JsonPrimitive(toolCallId))
        put("toolName", JsonPrimitive(toolName))
        put("summary", JsonPrimitive(summary))
        put("canAllow", JsonPrimitive(canAllow))
    }

    companion object {
        const val MAX_WAIT_ID_LENGTH = 64
        const val MAX_TOOL_CALL_ID_LENGTH = 128
        const val MAX_TOOL_NAME_LENGTH = 120
        const val MAX_SUMMARY_LENGTH = 2_000
        private val WAIT_ID = Regex("^[A-Za-z0-9-]{1,64}$")
        private val KEYS = setOf("waitId", "toolCallId", "toolName", "summary", "canAllow")

        fun parse(element: JsonElement): AidenBotApproval {
            val obj = element as? JsonObject ?: throw AidenBotContractException.InvalidField("approval")
            if (obj.keys != KEYS) throw AidenBotContractException.InvalidField("approval")
            fun string(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AidenBotContractException.InvalidField(key)
            val canAllow = (obj["canAllow"] as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.content
            return AidenBotApproval(
                waitId = string("waitId"),
                toolCallId = string("toolCallId"),
                toolName = string("toolName"),
                summary = string("summary"),
                canAllow = when (canAllow) {
                    "true" -> true
                    "false" -> false
                    else -> throw AidenBotContractException.InvalidField("canAllow")
                }
            )
        }
    }
}

/** `POST /bots/{botId}/questions/{waitId}/answer` receipt: the same wait id on every repeat. */
@Serializable
data class AidenBotQuestionAnswerReceipt(val waitId: String) {
    init {
        AidenBotWire.validateIdentifier(waitId, "waitId", 64)
    }
}

/** Contract revision 37 (`bot:handoffs`): the bounds and grammars the Mac's hand-off parsers use. */
object AidenBotHandoffWire {
    const val MAX_ACTION_LENGTH = 160
    const val MAX_WHY_LENGTH = 400
    const val MAX_NOTE_LENGTH = 4_000
    const val MAX_URL_LENGTH = 2_048
    private val WAIT_ID = Regex("^[A-Za-z0-9-]{1,64}$")
    /** What a URL's host may never hold (the WHATWG forbidden host code points, less the delimiters). */
    private const val FORBIDDEN_HOST_CHARACTERS = " <>^|%"

    /** `^[A-Za-z0-9-]{1,64}$`, the Mac's Bot wait id grammar. */
    fun validateWaitId(value: String, field: String = "waitId") {
        if (!WAIT_ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }

    /**
     * An https page with a host and no user name or password, with nothing around it, at most
     * 2,048 characters: what the Mac's own parser accepts. It errs strict: a control character,
     * an `@` in the authority, or a scheme without `//` is refused.
     */
    fun isOpenUrl(value: String): Boolean {
        if (value.isEmpty() || value.length > MAX_URL_LENGTH || value.trim() != value) return false
        if (value.any { it < ' ' || it == '\u007F' }) return false
        if (!value.startsWith(HTTPS_PREFIX, ignoreCase = true)) return false
        val rest = value.substring(HTTPS_PREFIX.length)
        val end = rest.indexOfFirst { it == '/' || it == '\\' || it == '?' || it == '#' }
        val authority = if (end < 0) rest else rest.substring(0, end)
        if ('@' in authority) return false
        val host: String
        val port: String?
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            if (close < 2) return false
            host = authority.substring(0, close + 1)
            val tail = authority.substring(close + 1)
            if (tail.isNotEmpty() && !tail.startsWith(":")) return false
            port = if (tail.isEmpty()) null else tail.substring(1)
        } else {
            host = authority.substringBefore(':')
            port = if (':' in authority) authority.substringAfter(':') else null
            if (host.any { it in FORBIDDEN_HOST_CHARACTERS || it == '[' || it == ']' }) return false
        }
        if (host.isEmpty()) return false
        // An empty port is the default one; any other is decimal and at most 65535.
        if (port != null && port.isNotEmpty() &&
            (!port.all { it in '0'..'9' } || port.trimStart('0').length > 5 || (port.trimStart('0').toIntOrNull() ?: 0) > 65_535)
        ) {
            return false
        }
        return true
    }

    private const val HTTPS_PREFIX = "https://"
}

/** What a hand-off asks for: a step the person does, or signing in to a site in the Bot's browser on the Mac. */
enum class AidenBotHandoffKind(val wireValue: String) {
    ACTION("action"),
    SIGN_IN("sign_in");

    companion object {
        fun fromWire(value: String): AidenBotHandoffKind? = values().firstOrNull { it.wireValue == value }
    }
}

/**
 * Contract revision 37 (`bot:handoffs` devices only): a step the Bot hands back to the person
 * ("Your turn: …"), on the session's `handoff` and on `handoff` frames. It is answered once by
 * [waitId] through `POST /bots/{botId}/handoffs/{waitId}/answer` with Done or Skip. A sign-in
 * is finished in the Bot's own browser on the Mac, so a phone offers Finish on your Mac and Skip.
 * Revision 40: a card a password-or-code rule opened carries `takesNote: false` ([takesNote]).
 */
data class AidenBotHandoff(
    val waitId: String,
    val kind: AidenBotHandoffKind,
    /** The card's title after "Your turn: ". */
    val action: String,
    val why: String? = null,
    /** The https page the step happens on, opened in the phone's browser. */
    val openUrl: String? = null,
    /**
     * Revision 40: false on a card whose answer may carry no note (a password-or-code rule opened
     * it), so the composer holds instead of sending a code to the Bot as Done's note.
     */
    val takesNote: Boolean = true
) {
    init {
        AidenBotHandoffWire.validateWaitId(waitId, "handoff.waitId")
        AidenBotWire.validateString(action, "handoff.action", AidenBotHandoffWire.MAX_ACTION_LENGTH)
        if (action.isBlank()) throw AidenBotContractException.InvalidField("handoff.action")
        why?.let { AidenBotWire.validateString(it, "handoff.why", AidenBotHandoffWire.MAX_WHY_LENGTH) }
        openUrl?.let { if (!AidenBotHandoffWire.isOpenUrl(it)) throw AidenBotContractException.InvalidField("handoff.open.url") }
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("waitId", JsonPrimitive(waitId))
        put("kind", JsonPrimitive(kind.wireValue))
        put("action", JsonPrimitive(action))
        why?.let { put("why", JsonPrimitive(it)) }
        openUrl?.let { url -> put("open", buildJsonObject { put("url", JsonPrimitive(url)) }) }
        if (!takesNote) put("takesNote", JsonPrimitive(false))
    }

    companion object {
        private val REQUIRED = setOf("waitId", "kind", "action")
        private val ALLOWED = REQUIRED + setOf("why", "open", "takesNote")

        /**
         * Exact keys, as the Mac's parser reads them: `why`, `open` and `takesNote` may be left
         * out, never null, and `takesNote` is only ever `false`.
         */
        fun parse(element: JsonElement): AidenBotHandoff {
            val obj = element as? JsonObject ?: throw AidenBotContractException.InvalidField("handoff")
            if (!obj.keys.containsAll(REQUIRED) || !ALLOWED.containsAll(obj.keys)) {
                throw AidenBotContractException.InvalidField("handoff")
            }
            fun string(value: JsonElement?, field: String) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AidenBotContractException.InvalidField(field)
            val openUrl = obj["open"]?.let { open ->
                val body = open as? JsonObject ?: throw AidenBotContractException.InvalidField("handoff.open")
                if (body.keys != setOf("url")) throw AidenBotContractException.InvalidField("handoff.open")
                string(body["url"], "handoff.open.url")
            }
            val kind = AidenBotHandoffKind.fromWire(string(obj["kind"], "handoff.kind"))
                ?: throw AidenBotContractException.InvalidField("handoff.kind")
            obj["takesNote"]?.let { value ->
                val flag = value as? JsonPrimitive
                if (flag == null || flag.isString || flag.content != "false") {
                    throw AidenBotContractException.InvalidField("handoff.takesNote")
                }
            }
            return AidenBotHandoff(
                waitId = string(obj["waitId"], "handoff.waitId"),
                kind = kind,
                action = string(obj["action"], "handoff.action"),
                why = obj["why"]?.let { string(it, "handoff.why") },
                openUrl = openUrl,
                takesNote = !obj.containsKey("takesNote")
            )
        }
    }
}

@Serializable
enum class AidenBotHandoffOutcome {
    @SerialName("done") DONE,
    @SerialName("skipped") SKIPPED
}

/**
 * The body of `POST /bots/{botId}/handoffs/{waitId}/answer`: Done or Skip, with an optional
 * note the Bot reads. A note is never blank and at most 4,000 characters; a sign-in can only be
 * skipped from a phone (the Mac answers Done for it with a 400).
 */
@Serializable
data class AidenBotHandoffAnswerRequest(
    val outcome: AidenBotHandoffOutcome,
    val note: String? = null
) {
    init {
        note?.let {
            AidenBotWire.validateString(it, "note", AidenBotHandoffWire.MAX_NOTE_LENGTH)
            if (it.isBlank()) throw AidenBotContractException.InvalidField("note")
        }
    }
}

/** The answer's receipt: the same wait id on every repeat. */
@Serializable
data class AidenBotHandoffAnswerReceipt(val waitId: String) {
    init {
        AidenBotHandoffWire.validateWaitId(waitId)
    }
}

/** `POST /bots/{botId}/handoffs/{waitId}/open-on-mac`: whether the Mac brought the Bot's browser forward. */
@Serializable
data class AidenBotHandoffOpenOnMacReceipt(
    val waitId: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val opened: Boolean
) {
    init {
        AidenBotHandoffWire.validateWaitId(waitId)
    }
}

/**
 * Contract revision 30 (`bot-activity-v1`, `bot:activity`): what a Bot in a running turn is
 * doing. Exactly `phase`, `app` and `startedAt` cross the wire; the strict wire JSON refuses
 * any other key. An unknown phase id still decodes and reads as Working.
 */
@OptIn(ExperimentalSerializationApi::class)
@KeepGeneratedSerializer
@Serializable(with = AidenBotSessionActivitySerializer::class)
data class AidenBotSessionActivity(
    val phase: String,
    val app: String? = null,
    /** When the turn started: the Mac's clock, milliseconds since 1970. */
    @Serializable(with = AidenStrictLongSerializer::class) val startedAt: Long
) {
    init {
        if (!PHASE_ID.matches(phase)) throw AidenBotContractException.InvalidField("activity.phase")
        app?.let { AidenBotWire.validateString(it, "activity.app", MAX_APP_LENGTH) }
        if (startedAt < 0 || startedAt > AidenRemoteProtocol.MAX_SAFE_INTEGER) {
            throw AidenBotContractException.InvalidField("activity.startedAt")
        }
    }

    companion object {
        const val MAX_APP_LENGTH = 40
        private val PHASE_ID = Regex("^[a-z][a-z_]{0,31}$")
    }
}

/** `app` is left out for every phase but `app`, never sent as null. */
object AidenBotSessionActivitySerializer :
    JsonTransformingSerializer<AidenBotSessionActivity>(AidenBotSessionActivity.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement = element.refusingNullLiterals("activity", "app")
}

// Contract revision 41 (`bot:issues`): the Bot's host-owned "Needs you" cards.

/** The bounds the Mac's own issue parsers use. */
object AidenRemoteIssueWire {
    /** Open cards plus retained settled ones: the most a session may carry. */
    const val MAX_CARDS = 58
    const val MAX_TITLE_LENGTH = 80
    const val MAX_BODY_LENGTH = 280
    const val MAX_ID_LENGTH = 160
    const val MAX_ACTIONS = 2

    private val ID = Regex("^[A-Za-z0-9._:-]{1,160}$")

    /** A card, routine or issue id: `^[A-Za-z0-9._:-]{1,160}$`. */
    fun validateId(value: String, field: String) {
        if (!ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }
}

/** The four kinds of card the host raises. */
@Serializable
enum class AidenBotIssueKind {
    @SerialName("preflight_failed") PREFLIGHT_FAILED,
    @SerialName("routine_failed") ROUTINE_FAILED,
    @SerialName("routine_paused") ROUTINE_PAUSED,
    @SerialName("run_stalled") RUN_STALLED
}

/**
 * What a phone may do with a card. `open_settings` is the Mac's own surface and never crosses
 * the wire: a card that offered only that arrives with no actions.
 */
@Serializable
enum class AidenBotIssueActionKind {
    @SerialName("open_chat") OPEN_CHAT,
    @SerialName("resume_routine") RESUME_ROUTINE,
    @SerialName("stop_run") STOP_RUN,
    @SerialName("keep_waiting") KEEP_WAITING
}

/** One action a card offers, exactly as the host sends it. `routineId` only on RESUME_ROUTINE. */
@Serializable
data class AidenBotIssueAction(
    val kind: AidenBotIssueActionKind,
    val routineId: String? = null
) {
    init {
        when (kind) {
            AidenBotIssueActionKind.RESUME_ROUTINE -> {
                val id = routineId ?: throw AidenBotContractException.InvalidField("issue.action.routineId")
                AidenRemoteIssueWire.validateId(id, "issue.action.routineId")
            }
            else -> if (routineId != null) throw AidenBotContractException.InvalidField("issue.action.routineId")
        }
    }
}

/**
 * Contract revision 41 (`bot:issues` devices only): one host-owned "Needs you" card. A settled
 * card (`resolved`) offers nothing a phone may take.
 */
@Serializable
data class AidenBotIssue(
    val id: String,
    val kind: AidenBotIssueKind,
    val title: String,
    val body: String,
    val routineId: String? = null,
    /** In card order, at most two; the last one is primary. */
    val actions: List<AidenBotIssueAction>,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = AidenStrictBooleanSerializer::class) val resolved: Boolean
) {
    init {
        AidenRemoteIssueWire.validateId(id, "issue.id")
        AidenBotWire.validateString(title, "issue.title", AidenRemoteIssueWire.MAX_TITLE_LENGTH)
        AidenBotWire.validateString(body, "issue.body", AidenRemoteIssueWire.MAX_BODY_LENGTH, allowEmpty = true)
        routineId?.let { AidenRemoteIssueWire.validateId(it, "issue.routineId") }
        if (actions.size > AidenRemoteIssueWire.MAX_ACTIONS) throw AidenBotContractException.InvalidField("issue.actions")
        if (resolved && actions.isNotEmpty()) {
            throw AidenBotContractException.InvalidCombination("settled issue with actions")
        }
    }

    companion object {
        /** At most [AidenRemoteIssueWire.MAX_CARDS] cards, each with its own id. */
        fun validateList(issues: List<AidenBotIssue>) {
            if (issues.size > AidenRemoteIssueWire.MAX_CARDS || issues.map { it.id }.toSet().size != issues.size) {
                throw AidenBotContractException.InvalidField("issues")
            }
        }

        /** One session's list; present only for a device holding `bot:issues`. */
        fun parseList(element: JsonElement): List<AidenBotIssue> {
            val array = element as? JsonArray ?: throw AidenBotContractException.InvalidField("issues")
            val issues = array.map {
                AidenBotWireJson.json.decodeFromJsonElement(AidenBotIssue.serializer(), it)
            }
            validateList(issues)
            return issues
        }
    }
}

/** `POST /bots/{botId}/issues/{issueId}/act`: one action the card offers. */
@Serializable
data class AidenBotIssueActRequest(val action: AidenBotIssueAction)

@Serializable
enum class AidenBotIssueActResult {
    @SerialName("done") DONE,
    /** Nothing is open under that id: the card should be dropped. */
    @SerialName("not_open") NOT_OPEN
}

/** The act route's receipt: `{ result: "done" | "not_open" }`. */
@Serializable
data class AidenBotIssueActReceipt(val result: AidenBotIssueActResult)

/** A message waiting for the running turn: STEER joins it, QUEUE runs after it. */
@Serializable
data class AidenBotQueuedMessage(
    val submissionId: String,
    val mode: AidenStreamInputMode,
    val text: String
) {
    init {
        if (!AidenBotWire.isSubmissionId(submissionId)) throw AidenBotContractException.InvalidField("queued.submissionId")
        AidenBotWire.validateString(text, "queued.text", AidenBotSessionWire.MAX_MESSAGE_LENGTH)
    }

    companion object {
        const val MAX_COUNT = 20

        /** At most [MAX_COUNT] messages, each with its own id. */
        fun validateList(queued: List<AidenBotQueuedMessage>) {
            if (queued.size > MAX_COUNT || queued.map { it.submissionId }.toSet().size != queued.size) {
                throw AidenBotContractException.InvalidField("queued")
            }
        }
    }
}

/** `GET /bots/{botId}/session`: the newest entries plus the in-flight partial. */
@Serializable(with = AidenBotSessionSerializer::class)
data class AidenBotSession(
    val botId: String,
    val epoch: String,
    val seq: Long,
    val state: AidenBotSessionState,
    val interrupted: Boolean,
    val blocked: AidenBotSessionBlock? = null,
    val partial: String? = null,
    val entries: List<AidenBotSessionEntry>,
    val hasOlder: Boolean,
    /** The question the Bot is waiting on, or null. Always on the wire, as `null` when nothing waits. */
    val question: AidenBotQuestion?,
    /** The tool approval the Bot is waiting on, or null. Always on the wire, as `null` when nothing waits. */
    val approval: AidenBotApproval?,
    /** Revision 30 (`bot:activity` devices only): what the running turn is doing. */
    val activity: AidenBotSessionActivity? = null,
    /** Revision 30 (`bot:activity` devices only): the person's messages still waiting for the turn. */
    val queued: List<AidenBotQueuedMessage>? = null,
    /**
     * Revision 37 (`bot:handoffs` devices only): the step the Bot handed back, or null. A holder is
     * always sent the key, as `null` when nothing waits; an older phone never is.
     */
    val handoff: AidenBotHandoff? = null,
    /**
     * Revision 41 (`bot:issues` devices only): the Bot's "Needs you" cards, oldest first. Null
     * from an older Mac or a device without the grant; an empty list means no card is open.
     */
    val issues: List<AidenBotIssue>? = null
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
        queued?.let { AidenBotQueuedMessage.validateList(it) }
        issues?.let { AidenBotIssue.validateList(it) }
    }
}

/** Every session field except `question`, `approval` and `handoff`, which the Bot wire's omitted-null rule would drop. */
@Serializable
private data class AidenBotSessionFields(
    val botId: String,
    val epoch: String,
    @Serializable(with = AidenStrictLongSerializer::class) val seq: Long,
    val state: AidenBotSessionState,
    @Serializable(with = AidenStrictBooleanSerializer::class) val interrupted: Boolean,
    val blocked: AidenBotSessionBlock? = null,
    val partial: String? = null,
    val entries: List<AidenBotSessionEntry>,
    @Serializable(with = AidenStrictBooleanSerializer::class) val hasOlder: Boolean,
    val activity: AidenBotSessionActivity? = null,
    val queued: List<AidenBotQueuedMessage>? = null
)

/** Writes `question` and `approval` explicitly (`null` when nothing waits) and requires them on read. */
object AidenBotSessionSerializer : KSerializer<AidenBotSession> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AidenBotSession")

    override fun serialize(encoder: Encoder, value: AidenBotSession) {
        val jsonEncoder = encoder as? JsonEncoder ?: throw SerializationException("Bot sessions are JSON only")
        val fields = AidenBotSessionFields(
            value.botId, value.epoch, value.seq, value.state, value.interrupted,
            value.blocked, value.partial, value.entries, value.hasOlder, value.activity, value.queued
        )
        val body = jsonEncoder.json.encodeToJsonElement(AidenBotSessionFields.serializer(), fields).jsonObject
        // A hand-off is written only when one waits, so an older Mac's session reads back as it came.
        val handoff = value.handoff?.let { mapOf("handoff" to it.toJson()) } ?: emptyMap()
        // Revision 41: the list is written only when this session carries one at all.
        val issues = value.issues?.let {
            mapOf("issues" to jsonEncoder.json.encodeToJsonElement(ListSerializer(AidenBotIssue.serializer()), it))
        } ?: emptyMap()
        jsonEncoder.encodeJsonElement(
            JsonObject(
                body + ("question" to (value.question?.toJson() ?: JsonNull)) +
                    ("approval" to (value.approval?.toJson() ?: JsonNull)) + handoff + issues
            )
        )
    }

    override fun deserialize(decoder: Decoder): AidenBotSession {
        val jsonDecoder = decoder as? JsonDecoder ?: throw SerializationException("Bot sessions are JSON only")
        val body = jsonDecoder.decodeJsonElement() as? JsonObject ?: throw AidenBotContractException.InvalidField("session")
        // `activity` is null when nothing runs; `queued` is left out, never null.
        body.refusingNullLiterals("session", "queued")
        val question = body["question"] ?: throw AidenBotContractException.InvalidField("question")
        val approval = body["approval"] ?: throw AidenBotContractException.InvalidField("approval")
        // Revision 27: entry types this build can't read are dropped; known ones stay strict.
        val rawEntries = body["entries"] as? JsonArray ?: throw AidenBotContractException.InvalidField("entries")
        if (rawEntries.size > AidenBotSessionWire.MAX_ENTRIES) throw AidenBotContractException.InvalidField("entries")
        val readable = JsonArray(rawEntries.filter { AidenBotSessionEntry.unknownType(it) == null })
        // Revision 37: `handoff` reaches only `bot:handoffs` devices, as `null` when nothing waits.
        val handoff = body["handoff"]?.let { if (it is JsonNull) null else AidenBotHandoff.parse(it) }
        // Revision 41: `issues` reaches only `bot:issues` devices; absent from every other session.
        val issues = body["issues"]?.let { if (it is JsonNull) null else AidenBotIssue.parseList(it) }
        val fields = jsonDecoder.json.decodeFromJsonElement(
            AidenBotSessionFields.serializer(),
            JsonObject(body - "question" - "approval" - "handoff" - "issues" + ("entries" to readable))
        )
        return AidenBotSession(
            botId = fields.botId,
            epoch = fields.epoch,
            seq = fields.seq,
            state = fields.state,
            interrupted = fields.interrupted,
            blocked = fields.blocked,
            partial = fields.partial,
            entries = fields.entries,
            hasOlder = fields.hasOlder,
            question = if (question is JsonNull) null else AidenBotQuestion.parse(question),
            approval = if (approval is JsonNull) null else AidenBotApproval.parse(approval),
            activity = fields.activity,
            queued = fields.queued,
            handoff = handoff,
            issues = issues
        )
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
data class AidenBotSessionSendRequest(
    val text: String,
    /** Revision 30 (`bot-activity-v1`): Steer joins the running turn, Queue runs after it. */
    val whenBusy: AidenStreamInputMode? = null
) {
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
    /**
     * An `entry` frame whose entry type this build can't read (revision 27). It only advances
     * `seq`; [raw] is kept so the frame re-encodes unchanged.
     */
    data class SkippedEntry(val raw: JsonObject) : AidenBotSessionEventPayload()
    data class State(val view: AidenBotSessionStateView) : AidenBotSessionEventPayload()
    /** The waiting question appeared (non-null) or was settled (null). */
    data class Question(val question: AidenBotQuestion?) : AidenBotSessionEventPayload()
    /** The waiting tool approval appeared (non-null) or was settled or withdrawn (null). */
    data class Approval(val approval: AidenBotApproval?) : AidenBotSessionEventPayload()
    /** Revision 30: what the running turn is doing now, or null when none runs. */
    data class Activity(val activity: AidenBotSessionActivity?) : AidenBotSessionEventPayload()
    /** Revision 37: the step the Bot handed back appeared (non-null) or was settled (null). */
    data class Handoff(val handoff: AidenBotHandoff?) : AidenBotSessionEventPayload()
    /** Revision 41: the Bot's issue cards, oldest first; an empty list clears them. */
    data class Issues(val issues: List<AidenBotIssue>) : AidenBotSessionEventPayload() {
        init {
            AidenBotIssue.validateList(issues)
        }
    }
    /** Revision 30: the person's messages still waiting for the turn. */
    data class Queued(val queued: List<AidenBotQueuedMessage>) : AidenBotSessionEventPayload() {
        init {
            AidenBotQueuedMessage.validateList(queued)
        }
    }
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
            is AidenBotSessionEventPayload.SkippedEntry -> "entry"
            is AidenBotSessionEventPayload.State -> "state"
            is AidenBotSessionEventPayload.Question -> "question"
            is AidenBotSessionEventPayload.Approval -> "approval"
            is AidenBotSessionEventPayload.Activity -> "activity"
            is AidenBotSessionEventPayload.Queued -> "queued"
            is AidenBotSessionEventPayload.Handoff -> "handoff"
            is AidenBotSessionEventPayload.Issues -> "issues"
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
            is AidenBotSessionEventPayload.SkippedEntry -> buildJsonObject { put("entry", p.raw) }
            is AidenBotSessionEventPayload.State ->
                wire.encodeToJsonElement(AidenBotSessionStateView.serializer(), p.view).jsonObject
            is AidenBotSessionEventPayload.Question -> buildJsonObject {
                put("question", p.question?.toJson() ?: JsonNull)
            }
            is AidenBotSessionEventPayload.Approval -> buildJsonObject {
                put("approval", p.approval?.toJson() ?: JsonNull)
            }
            is AidenBotSessionEventPayload.Activity -> buildJsonObject {
                put("activity", p.activity?.let { wire.encodeToJsonElement(AidenBotSessionActivity.serializer(), it) } ?: JsonNull)
            }
            is AidenBotSessionEventPayload.Queued -> buildJsonObject {
                put("queued", wire.encodeToJsonElement(ListSerializer(AidenBotQueuedMessage.serializer()), p.queued))
            }
            is AidenBotSessionEventPayload.Handoff -> buildJsonObject {
                put("handoff", p.handoff?.toJson() ?: JsonNull)
            }
            is AidenBotSessionEventPayload.Issues -> buildJsonObject {
                put("issues", wire.encodeToJsonElement(ListSerializer(AidenBotIssue.serializer()), p.issues))
            }
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
                val entry = payload.getValue("entry")
                // Revision 27: a newer entry type is ignored rather than tearing the feed down.
                if (AidenBotSessionEntry.unknownType(entry) != null) {
                    AidenBotSessionEventPayload.SkippedEntry(entry.jsonObject)
                } else {
                    AidenBotSessionEventPayload.Entry(
                        wire.decodeFromJsonElement(AidenBotSessionEntry.serializer(), entry)
                    )
                }
            }
            "state" -> AidenBotSessionEventPayload.State(
                wire.decodeFromJsonElement(AidenBotSessionStateView.serializer(), payload)
            )
            "question" -> {
                payload.requireKeys(setOf("question"))
                val element = payload.getValue("question")
                AidenBotSessionEventPayload.Question(if (element is JsonNull) null else AidenBotQuestion.parse(element))
            }
            "approval" -> {
                payload.requireKeys(setOf("approval"))
                val element = payload.getValue("approval")
                AidenBotSessionEventPayload.Approval(if (element is JsonNull) null else AidenBotApproval.parse(element))
            }
            "activity" -> {
                payload.requireKeys(setOf("activity"))
                val element = payload.getValue("activity")
                AidenBotSessionEventPayload.Activity(
                    if (element is JsonNull) null else wire.decodeFromJsonElement(AidenBotSessionActivity.serializer(), element)
                )
            }
            "queued" -> {
                payload.requireKeys(setOf("queued"))
                AidenBotSessionEventPayload.Queued(
                    wire.decodeFromJsonElement(ListSerializer(AidenBotQueuedMessage.serializer()), payload.getValue("queued"))
                )
            }
            "handoff" -> {
                payload.requireKeys(setOf("handoff"))
                val element = payload.getValue("handoff")
                AidenBotSessionEventPayload.Handoff(if (element is JsonNull) null else AidenBotHandoff.parse(element))
            }
            "issues" -> {
                payload.requireKeys(setOf("issues"))
                AidenBotSessionEventPayload.Issues(AidenBotIssue.parseList(payload.getValue("issues")))
            }
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
