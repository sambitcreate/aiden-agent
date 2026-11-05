@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.*
import kotlinx.serialization.json.*
import java.time.ZoneId

/** Revision 59: closed, bounded owner-reviewed choices. Identifiers never become provider credentials. */
object AidenRoutineModelWire {
    const val PUBLIC_BYTES = 900 * 1024
    const val MUTATION_BYTES = 16 * 1024
    fun id(value: String) = AidenOpenWorkWire.id(value)
    fun costReceiptId(value: String) = AidenOpenWorkWire.check(Regex("^cost_[a-f0-9]{64}$").matches(value))
    fun label(value: String) = AidenOpenWorkWire.text(value,160,640)
    fun <T> decode(serializer: KSerializer<T>, text: String): T {
        AidenOpenWorkWire.check(text.toByteArray(Charsets.UTF_8).size <= PUBLIC_BYTES)
        val element = AidenBotWireJson.json.parseToJsonElement(text)
        fun rejectNull(value: JsonElement) {
            when(value) {
                JsonNull -> AidenOpenWorkWire.check(false)
                is JsonObject -> value.values.forEach(::rejectNull)
                is JsonArray -> value.forEach(::rejectNull)
                else -> Unit
            }
        }
        rejectNull(element)
        return AidenBotWireJson.json.decodeFromJsonElement(serializer,element)
    }
    fun runs(rows: List<AidenRoutineModelRun>): List<AidenRoutineModelRun> = rows.also {
        AidenOpenWorkWire.check(it.size <= 64 && it.distinctBy { row -> row.runId }.size == it.size)
    }
}
@Serializable enum class AidenRoutineThinkingLevel {
    @SerialName("off") OFF, @SerialName("minimal") MINIMAL, @SerialName("low") LOW,
    @SerialName("medium") MEDIUM, @SerialName("high") HIGH, @SerialName("xhigh") XHIGH, @SerialName("max") MAX
}
@Serializable data class AidenRoutineModelChoice(val providerId: String, val modelId: String, val thinkingLevel: AidenRoutineThinkingLevel) {
    init { AidenRoutineModelWire.id(providerId); AidenRoutineModelWire.id(modelId) }
}
@Serializable enum class AidenRoutineModelMode { @SerialName("inherit") INHERIT, @SerialName("selected") SELECTED }
@Serializable data class AidenRoutineModelSelection(val mode: AidenRoutineModelMode, val primary: AidenRoutineModelChoice? = null, val fallback: AidenRoutineModelChoice? = null) {
    init { AidenOpenWorkWire.check(if(mode == AidenRoutineModelMode.INHERIT) primary == null && fallback == null else primary != null) }
    companion object { val Inherit = AidenRoutineModelSelection(AidenRoutineModelMode.INHERIT) }
}
@Serializable data class AidenRoutineModelSettings(val botId: String, val routineId: String, val revision: String, val selection: AidenRoutineModelSelection,
    @Serializable(with=AidenBotWatchTimestampSerializer::class) val updatedAt: Long, val lastMutationId: String? = null) {
    init { AidenRoutineModelWire.id(botId); AidenRoutineModelWire.id(routineId); AidenRoutineModelWire.id(revision); lastMutationId?.let(AidenOpenWorkWire::uuid) }
}
@Serializable data class AidenRoutineModelSave(val botId: String, val routineId: String, val mutationId: String, val expectedRevision: String, val catalogRevision: String, val selection: AidenRoutineModelSelection) {
    init { AidenRoutineModelWire.id(botId); AidenRoutineModelWire.id(routineId); AidenOpenWorkWire.uuid(mutationId); AidenRoutineModelWire.id(expectedRevision); AidenRoutineModelWire.id(catalogRevision) }
}
@Serializable data class AidenRoutineModelOption(val id: String, val label: String,
    @Serializable(with=AidenStrictBooleanSerializer::class) val available: Boolean,
    @Serializable(with=AidenStrictBooleanSerializer::class) val supportsImages: Boolean, val thinkingLevels: List<AidenRoutineThinkingLevel>) {
    init { AidenRoutineModelWire.id(id); AidenRoutineModelWire.label(label); AidenOpenWorkWire.check(thinkingLevels.size <= 7 && thinkingLevels.distinct().size == thinkingLevels.size) }
}
@Serializable data class AidenRoutineModelProvider(val id: String, val label: String,
    @Serializable(with=AidenStrictBooleanSerializer::class) val available: Boolean, val models: List<AidenRoutineModelOption>) {
    init { AidenRoutineModelWire.id(id); AidenRoutineModelWire.label(label); AidenOpenWorkWire.check(models.size <= 512 && models.distinctBy { it.id }.size == models.size) }
}
@Serializable data class AidenRoutineModelCatalog(val revision: String, val providers: List<AidenRoutineModelProvider>) {
    init { AidenRoutineModelWire.id(revision); AidenOpenWorkWire.check(providers.size <= 64 && providers.sumOf { it.models.size } <= 512 && providers.distinctBy { it.id }.size == providers.size) }
    fun admits(choice: AidenRoutineModelChoice): Boolean = providers.any { p -> p.id == choice.providerId && p.available && p.models.any { it.id == choice.modelId && it.available && choice.thinkingLevel in it.thinkingLevels } }
    fun label(choice: AidenRoutineModelChoice): String? = providers.find { it.id == choice.providerId }?.let { p -> p.models.find { it.id == choice.modelId }?.let { "${p.label} · ${it.label}" } }
}
@Serializable enum class AidenRoutineModelError { @SerialName("conflict") CONFLICT, @SerialName("invalid") INVALID, @SerialName("unavailable") UNAVAILABLE, @SerialName("not_found") NOT_FOUND, @SerialName("history_full") HISTORY_FULL }
@Serializable data class AidenRoutineModelResult(@Serializable(with=AidenStrictBooleanSerializer::class) val ok: Boolean, val settings: AidenRoutineModelSettings? = null, val mutationId: String? = null,
    @Serializable(with=AidenStrictBooleanSerializer::class) val replayed: Boolean? = null, val code: AidenRoutineModelError? = null, val error: String? = null) {
    init {
        if(ok) { AidenOpenWorkWire.check(settings != null && mutationId != null && replayed != null && code == null && error == null); AidenOpenWorkWire.uuid(mutationId!!) }
        else { AidenOpenWorkWire.check(code != null && error != null && mutationId == null && replayed == null); AidenRoutineModelWire.label(error!!) }
    }
}
@Serializable enum class AidenRoutineFallbackReason { @SerialName("model_unavailable") MODEL_UNAVAILABLE, @SerialName("credentials_unavailable") CREDENTIALS_UNAVAILABLE }
@Serializable data class AidenRoutineRunModel(val chosen: AidenRoutineModelChoice, val actual: AidenRoutineModelChoice, val providerLabel: String, val modelLabel: String,
    val chosenProviderLabel: String, val chosenModelLabel: String, val fallbackReason: AidenRoutineFallbackReason? = null) {
    init { listOf(providerLabel,modelLabel,chosenProviderLabel,chosenModelLabel).forEach(AidenRoutineModelWire::label) }
}
@Serializable enum class AidenRoutineModelTrigger { @SerialName("scheduled") SCHEDULED, @SerialName("manual") MANUAL, @SerialName("event") EVENT, @SerialName("retry") RETRY, @SerialName("catch_up") CATCH_UP }
@Serializable data class AidenRoutineModelRun(val runId: String, val submissionId: String? = null,
    @Serializable(with=AidenBotWatchTimestampSerializer::class) val admittedAt: Long,
    @Serializable(with=AidenBotWatchTimestampSerializer::class) val startedAt: Long? = null,
    @Serializable(with=AidenBotWatchTimestampSerializer::class) val scheduledFor: Long? = null,
    val timezone: String? = null, val triggerKind: AidenRoutineModelTrigger, val model: AidenRoutineRunModel) {
    init {
        AidenRoutineModelWire.id(runId); submissionId?.let(AidenOpenWorkWire::decimal)
        AidenOpenWorkWire.check(scheduledFor == null || timezone != null)
        timezone?.let { AidenOpenWorkWire.check(it.length <= 100 && it.isNotEmpty() && it in ZoneId.getAvailableZoneIds().plus("UTC")) }
    }
}
@Serializable enum class AidenRoutineModelKind { @SerialName("scheduled") SCHEDULED, @SerialName("event") EVENT, @SerialName("watch") WATCH }
@Serializable data class AidenRoutineModelDirectoryEntry(val id: String, val name: String, val kind: AidenRoutineModelKind) {
    init { AidenRoutineModelWire.id(id); AidenRoutineModelWire.label(name) }
}
@Serializable data class AidenRoutineModelDirectory(val botId: String, val routines: List<AidenRoutineModelDirectoryEntry>) {
    init { AidenRoutineModelWire.id(botId); AidenOpenWorkWire.check(routines.size <= 1024 && routines.distinctBy { it.id }.size == routines.size) }
}
@Serializable data class AidenBotResumeStatus(@Serializable(with=AidenStrictBooleanSerializer::class) val requiresUnknownCostAcknowledgement: Boolean, val interruptedSubmissionId: String? = null, val costReceiptId: String? = null) {
    init {
        AidenOpenWorkWire.check(!requiresUnknownCostAcknowledgement || interruptedSubmissionId != null)
        AidenOpenWorkWire.check(requiresUnknownCostAcknowledgement == (costReceiptId != null))
        interruptedSubmissionId?.let(AidenOpenWorkWire::decimal);costReceiptId?.let(AidenRoutineModelWire::costReceiptId)
    }
}
@Serializable data class AidenBotResumeRequest(@EncodeDefault(EncodeDefault.Mode.NEVER) @Serializable(with=AidenStrictBooleanSerializer::class) val acknowledgeUnknownCost: Boolean? = null, val expectedSubmissionId: String? = null, val expectedCostReceiptId: String? = null) {
    init {
        AidenOpenWorkWire.check(if(acknowledgeUnknownCost == null) expectedSubmissionId == null && expectedCostReceiptId == null else acknowledgeUnknownCost && expectedSubmissionId != null && expectedCostReceiptId != null)
        expectedSubmissionId?.let(AidenOpenWorkWire::decimal);expectedCostReceiptId?.let(AidenRoutineModelWire::costReceiptId)
    }
}
const val AIDEN_BOT_UNKNOWN_COST_CONFIRMATION = "The cost of an earlier provider request is unconfirmed. Resuming may incur another charge. Known spending limits still apply."
