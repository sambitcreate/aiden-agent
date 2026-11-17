@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import java.util.UUID

/** Epoch milliseconds must be JSON integers, bounded to JavaScript's safe integer range. */
object AidenBotWatchTimestampSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("watchTimestamp", PrimitiveKind.LONG)
    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
    override fun deserialize(decoder: Decoder): Long {
        val primitive = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonPrimitive
        val value = primitive?.takeUnless { it.isString }?.longOrNull
        AidenBotWatchWire.require(value != null && value in 0..9_007_199_254_740_991L, "watch.timestamp")
        return value!!
    }
}

/** The host alone binds connectors, reads them and runs watches. Phones receive safe labels. */
object AidenBotWatchWire {
    const val MAX_NAME = 120
    const val MAX_PROMPT = 32_768
    const val MAX_FILTER = 200
    fun require(value: Boolean, field: String) { if (!value) throw AidenBotContractException.InvalidField(field) }
    /** Host bounds use JavaScript string.length: UTF-16 code units, not Unicode code points. */
    fun text(value: String, field: String, limit: Int, empty: Boolean = false) {
        require((empty || value.isNotEmpty()) && value.length <= limit, field)
    }
    /** Match the host bound while keeping a valid surrogate pair together at the editor edge. */
    fun clamp(value: String, limit: Int): String {
        require(limit >= 0, "watch.textLimit")
        if (value.length <= limit) return value
        val end = if (limit > 0 && Character.isHighSurrogate(value[limit - 1]) && Character.isLowSurrogate(value[limit])) limit - 1 else limit
        return value.substring(0, end)
    }
    fun uuid(value: String) { require(runCatching { UUID.fromString(value).toString().equals(value, true) }.getOrDefault(false), "watch.id") }
    fun revision(value: String) = require(Regex("^[1-9][0-9]{0,31}$").matches(value), "watch.revision")
    fun interval(value: Int) = require(value in listOf(15, 30, 60), "watch.everyMinutes")
    fun config(name: String, prompt: String, everyMinutes: Int) {
        text(name, "watch.name", MAX_NAME); require(name.isNotBlank(), "watch.name")
        text(prompt, "watch.prompt", MAX_PROMPT); require(prompt.isNotBlank(), "watch.prompt"); interval(everyMinutes)
    }
}

@Serializable
enum class AidenBotWatchTemplateId {
    @SerialName("mail_messages") MAIL,
    @SerialName("calendar_upcoming") CALENDAR
}

@Serializable
@JsonClassDiscriminator("kind")
sealed class AidenBotWatchCondition {
    @Serializable @SerialName("email")
    data class Email(val sender: String? = null, val subject: String? = null,
        @Serializable(with = AidenStrictBooleanSerializer::class) val unreadOnly: Boolean) : AidenBotWatchCondition() {
        init { sender?.let { AidenBotWatchWire.text(it, "sender", 200, true) }; subject?.let { AidenBotWatchWire.text(it, "subject", 200, true) } }
    }
    @Serializable @SerialName("calendar")
    data class Calendar(@Serializable(with = AidenStrictIntSerializer::class) val lookAheadMinutes: Int, val timezone: String) : AidenBotWatchCondition() {
        init { AidenBotWatchWire.require(lookAheadMinutes in 15..1440, "lookAheadMinutes"); AidenBotWatchWire.text(timezone, "timezone", 100) }
    }
    val templateId: AidenBotWatchTemplateId get() = when (this) { is Email -> AidenBotWatchTemplateId.MAIL; is Calendar -> AidenBotWatchTemplateId.CALENDAR }
}

@Serializable
data class AidenBotWatchTemplate(val id: AidenBotWatchTemplateId, val title: String, val description: String, val kind: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val available: Boolean, val unavailableReason: String? = null,
    val intervals: List<@Serializable(with = AidenStrictIntSerializer::class) Int>) {
    init {
        AidenBotWatchWire.text(title, "template.title", 500); AidenBotWatchWire.text(description, "template.description", 500)
        AidenBotWatchWire.require(kind == if (id == AidenBotWatchTemplateId.MAIL) "email" else "calendar", "template.kind")
        AidenBotWatchWire.require(intervals.isNotEmpty() && intervals.size <= 3 && intervals.distinct().size == intervals.size, "template.intervals")
        intervals.forEach(AidenBotWatchWire::interval); unavailableReason?.let { AidenBotWatchWire.text(it, "unavailableReason", 500) }
    }
}

@Serializable
data class AidenBotWatchSource(val providerLabel: String, val accountLabel: String, val resourceLabel: String) {
    init { listOf(providerLabel, accountLabel, resourceLabel).forEach { AidenBotWatchWire.text(it, "source.label", 500) } }
}

@Serializable
data class AidenBotWatchSourceChoice(val id: String, val templateId: AidenBotWatchTemplateId, val providerLabel: String,
    val accountLabel: String, val resourceLabel: String, @Serializable(with = AidenStrictBooleanSerializer::class) val available: Boolean,
    val unavailableReason: String? = null) {
    init { AidenBotWatchWire.uuid(id); AidenBotWatchSource(providerLabel, accountLabel, resourceLabel); unavailableReason?.let { AidenBotWatchWire.text(it, "source.unavailableReason", 500) } }
}

@Serializable
enum class AidenBotWatchState {
    @SerialName("waiting") WAITING, @SerialName("empty") EMPTY, @SerialName("unchanged") UNCHANGED,
    @SerialName("changed") CHANGED, @SerialName("error") ERROR, @SerialName("paused") PAUSED
}

@Serializable
data class AidenBotWatch(val id: String, val botId: String, val revision: String, val name: String, val prompt: String,
    val templateId: AidenBotWatchTemplateId, val condition: AidenBotWatchCondition,
    @Serializable(with = AidenStrictIntSerializer::class) val everyMinutes: Int, val source: AidenBotWatchSource,
    @Serializable(with = AidenStrictBooleanSerializer::class) val enabled: Boolean, val state: AidenBotWatchState,
    @Serializable(with = AidenBotWatchTimestampSerializer::class) val lastCheckAt: Long? = null, @Serializable(with = AidenBotWatchTimestampSerializer::class) val nextCheckAt: Long? = null, @Serializable(with = AidenBotWatchTimestampSerializer::class) val lastRunAt: Long? = null, val lastError: String? = null) {
    init {
        AidenBotWatchWire.uuid(id); AidenBotWire.validateIdentifier(botId, "botId", sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH); AidenBotWatchWire.revision(revision)
        AidenBotWatchWire.config(name, prompt, everyMinutes); AidenBotWatchWire.require(templateId == condition.templateId, "watch.condition")
        listOfNotNull(lastCheckAt, nextCheckAt, lastRunAt).forEach { AidenBotWatchWire.require(it >= 0, "watch.time") }
        lastError?.let { AidenBotWatchWire.text(it, "watch.lastError", 200) }
    }
}

@Serializable
data class AidenBotWatchList(@Serializable(with = AidenStrictBooleanSerializer::class) val supported: Boolean,
    val unavailableReason: String? = null, val templates: List<AidenBotWatchTemplate>, val watches: List<AidenBotWatch>) {
    init {
        AidenBotWatchWire.require(templates.size <= 2 && templates.distinctBy { it.id }.size == templates.size, "templates")
        AidenBotWatchWire.require(watches.size <= 16 && watches.distinctBy { it.id }.size == watches.size, "watches")
        unavailableReason?.let { AidenBotWatchWire.text(it, "unavailableReason", 500) }
    }
}

@Serializable
data class AidenBotWatchSourceList(val choices: List<AidenBotWatchSourceChoice>, val unavailableReasons: List<String>) {
    init {
        AidenBotWatchWire.require(choices.size <= 500 && choices.distinctBy { it.id }.size == choices.size, "choices")
        AidenBotWatchWire.require(unavailableReasons.size <= 500, "unavailableReasons")
        unavailableReasons.forEach { AidenBotWatchWire.text(it, "unavailableReason", 500) }
    }
}

/** Create and edit share config; an edit omits sourceChoiceId to retain its host binding. */
@Serializable
data class AidenBotWatchSaveRequest(val name: String, val prompt: String, val condition: AidenBotWatchCondition,
    @Serializable(with = AidenStrictIntSerializer::class) val everyMinutes: Int, val mutationId: String,
    val sourceChoiceId: String? = null, val expectedRevision: String? = null) {
    init { AidenBotWatchWire.config(name, prompt, everyMinutes); AidenBotWatchWire.uuid(mutationId); sourceChoiceId?.let(AidenBotWatchWire::uuid); expectedRevision?.let(AidenBotWatchWire::revision) }
}
@Serializable
data class AidenBotWatchMutation(val expectedRevision: String, val mutationId: String, val enabled: Boolean? = null) {
    init { AidenBotWatchWire.revision(expectedRevision); AidenBotWatchWire.uuid(mutationId) }
}
@Serializable
data class AidenBotWatchTestRequest(val id: String? = null, val expectedRevision: String? = null,
    val sourceChoiceId: String? = null, val condition: AidenBotWatchCondition? = null) {
    init {
        AidenBotWatchWire.require((id != null && expectedRevision != null && sourceChoiceId == null && condition == null) ||
            (id == null && expectedRevision == null && sourceChoiceId != null && condition != null), "test")
        id?.let(AidenBotWatchWire::uuid); sourceChoiceId?.let(AidenBotWatchWire::uuid); expectedRevision?.let(AidenBotWatchWire::revision)
    }
}
@Serializable
enum class AidenBotWatchCheckResult { @SerialName("baseline") BASELINE, @SerialName("empty") EMPTY, @SerialName("unchanged") UNCHANGED, @SerialName("changed") CHANGED }
@Serializable
data class AidenBotWatchTestResult(@Serializable(with = AidenBotWatchTimestampSerializer::class) val checkedAt: Long, val result: AidenBotWatchCheckResult,
    @Serializable(with = AidenStrictIntSerializer::class) val itemCount: Int,
    @Serializable(with = AidenStrictIntSerializer::class) val changeCount: Int, val preview: List<String>) {
    init {
        AidenBotWatchWire.require(checkedAt >= 0 && itemCount >= 0 && changeCount >= 0 && preview.size <= 8, "testResult")
        preview.forEach { AidenBotWatchWire.text(it, "preview", 500) }
    }
}
@Serializable
data class AidenBotWatchRemoval(val id: String, val revision: String, @Serializable(with = AidenStrictBooleanSerializer::class) val removed: Boolean) {
    init { AidenBotWatchWire.uuid(id); AidenBotWatchWire.revision(revision.removePrefix("deleted:")) }
}
@Serializable
data class AidenBotWatchRunResult(val id: String, val revision: String, @Serializable(with = AidenStrictBooleanSerializer::class) val admitted: Boolean) {
    init { AidenBotWatchWire.uuid(id); AidenBotWatchWire.revision(revision) }
}
