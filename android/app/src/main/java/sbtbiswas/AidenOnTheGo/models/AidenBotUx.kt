package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KeepGeneratedSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant

// Aiden Remote contract revision 61 (provisional): the Bot UX simplification on phones.
// `bot:settings-changes` adds `settings_change` entries; `bot:suggestions` adds `skill_proposal`,
// `lesson` and `memory_tidy` entries; `approvals:settings` adds the Mac's approval mode and rules
// page. Each shape mirrors its host parser in `main/services/aiden-remote-bot-ux.ts` and
// `aiden-remote-approval-settings.ts`: exact keys, no null literals, bounded text.

private object BotUxEntryWire {
    const val MAX_TITLE = 80
    const val MAX_LINES = 10
    const val MAX_LINE = 400
    const val MAX_INSTRUCTIONS = 32_000
    const val MAX_DIFF_LINES = 2_000
    const val MAX_DIFF_TEXT = 4_000
    const val MAX_SKILL_NAME = 120
    const val MAX_SKILL_TEXT = 400
    const val MAX_PREVIEW = 16_000
    const val MAX_LESSON = 400
    const val MAX_ROUTINE_NAME = 200
    private val ENTRY_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val OPAQUE_ID = Regex("^[A-Za-z0-9._:-]{1,160}$")

    fun entryId(value: String) {
        if (!ENTRY_ID.matches(value)) throw AidenBotContractException.InvalidField("entry.id")
    }

    fun opaque(value: String, field: String) {
        if (!OPAQUE_ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }

    fun text(value: String, field: String, max: Int, blank: Boolean = false) {
        if (value.codePointCount(0, value.length) > max || (!blank && value.isBlank())) {
            throw AidenBotContractException.InvalidField(field)
        }
    }
}

/**
 * Sets the discriminator aside and refuses a null literal anywhere in the entry: the host leaves
 * an absent value out, and its parser refuses `null` for every field.
 */
private fun JsonElement.botUxEntryBody(): JsonElement {
    val body = this as? JsonObject ?: return this
    if (body.values.any { it is JsonNull }) throw AidenBotContractException.InvalidField("entry")
    return if ("type" in body) JsonObject(body - "type") else body
}

// --- `bot:settings-changes` ---

@Serializable
enum class AidenBotSettingsChangeMode { @SerialName("applied") APPLIED, @SerialName("held") HELD }

@Serializable
enum class AidenBotSettingsChangeStatus {
    @SerialName("pending") PENDING,
    @SerialName("restored") RESTORED,
    @SerialName("undo_refused") UNDO_REFUSED,
    @SerialName("applied") APPLIED,
    @SerialName("edited") EDITED,
    @SerialName("dismissed") DISMISSED
}

@Serializable
enum class AidenBotSettingsHeldReason {
    @SerialName("not_owner") NOT_OWNER,
    @SerialName("outside_content") OUTSIDE_CONTENT,
    @SerialName("widens") WIDENS
}

@Serializable
enum class AidenBotSettingsField {
    @SerialName("name") NAME,
    @SerialName("description") DESCRIPTION,
    @SerialName("look") LOOK,
    @SerialName("instructions") INSTRUCTIONS,
    @SerialName("dailyCheckIns") DAILY_CHECK_INS,
    @SerialName("notifications") NOTIFICATIONS,
    @SerialName("model") MODEL
}

@Serializable
enum class AidenBotInstructionsDiffKind { @SerialName("same") SAME, @SerialName("added") ADDED, @SerialName("removed") REMOVED }

@Serializable
data class AidenBotInstructionsDiffLine(val kind: AidenBotInstructionsDiffKind, val text: String) {
    init {
        BotUxEntryWire.text(text, "instructionsDiff.text", BotUxEntryWire.MAX_DIFF_TEXT, blank = true)
    }
}

/**
 * Revision 61 (`bot:settings-changes`): a change the Bot made to its own settings. `held` is the
 * card a run the person did not start produced (Apply / Dismiss while `pending`, Edit on the Mac);
 * `applied` is a receipt with Undo while `pending` and [undoable].
 */
@OptIn(ExperimentalSerializationApi::class)
@KeepGeneratedSerializer
@Serializable(with = AidenBotSettingsChangeEntrySerializer::class)
@SerialName("settings_change")
data class AidenBotSettingsChangeEntry(
    override val id: String,
    val changeId: String,
    val mode: AidenBotSettingsChangeMode,
    val status: AidenBotSettingsChangeStatus,
    val title: String,
    val fields: List<AidenBotSettingsField>,
    val lines: List<String>,
    val heldReason: AidenBotSettingsHeldReason? = null,
    val instructions: String? = null,
    val previousInstructions: String? = null,
    val instructionsDiff: List<AidenBotInstructionsDiffLine>? = null,
    @Serializable(with = AidenStrictBooleanSerializer::class) val undoable: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
) : AidenBotSessionEntry() {
    init {
        BotUxEntryWire.entryId(id)
        BotUxEntryWire.opaque(changeId, "entry.changeId")
        BotUxEntryWire.text(title, "entry.title", BotUxEntryWire.MAX_TITLE)
        if (fields.size > AidenBotSettingsField.entries.size) throw AidenBotContractException.InvalidField("entry.fields")
        if (lines.size > BotUxEntryWire.MAX_LINES) throw AidenBotContractException.InvalidField("entry.lines")
        lines.forEach { BotUxEntryWire.text(it, "entry.lines", BotUxEntryWire.MAX_LINE) }
        instructions?.let { BotUxEntryWire.text(it, "entry.instructions", BotUxEntryWire.MAX_INSTRUCTIONS, blank = true) }
        previousInstructions?.let { BotUxEntryWire.text(it, "entry.previousInstructions", BotUxEntryWire.MAX_INSTRUCTIONS, blank = true) }
        if ((instructionsDiff?.size ?: 0) > BotUxEntryWire.MAX_DIFF_LINES) throw AidenBotContractException.InvalidField("entry.instructionsDiff")
        // Only a held change carries a reason and proposed instructions.
        if (mode == AidenBotSettingsChangeMode.APPLIED && (heldReason != null || instructions != null || previousInstructions != null)) {
            throw AidenBotContractException.InvalidCombination("applied settings change")
        }
    }

    val isHeld: Boolean get() = mode == AidenBotSettingsChangeMode.HELD
    /** A held card still waiting for Apply or Dismiss. */
    val awaitsAnswer: Boolean get() = isHeld && status == AidenBotSettingsChangeStatus.PENDING
    /** A receipt Undo can still put back. */
    val offersUndo: Boolean get() = !isHeld && undoable && status == AidenBotSettingsChangeStatus.PENDING
}

object AidenBotSettingsChangeEntrySerializer :
    JsonTransformingSerializer<AidenBotSettingsChangeEntry>(AidenBotSettingsChangeEntry.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement = element.botUxEntryBody()
}

@Serializable
enum class AidenBotSettingsChangeDecision { @SerialName("apply") APPLY, @SerialName("dismiss") DISMISS, @SerialName("undo") UNDO }

@Serializable
data class AidenBotSettingsChangeRespondRequest(val decision: AidenBotSettingsChangeDecision)

/** `200 {changeId, status, message?}`; an Undo the Mac cannot make is `undo_refused`. */
@Serializable
data class AidenBotSettingsChangeRespondResult(
    val changeId: String,
    val status: AidenBotSettingsChangeStatus,
    val message: String? = null
) {
    init {
        BotUxEntryWire.opaque(changeId, "changeId")
        message?.let { BotUxEntryWire.text(it, "message", 400) }
    }
}

// --- `bot:suggestions` ---

@Serializable
enum class AidenBotSkillProposalStatus { @SerialName("pending") PENDING, @SerialName("added") ADDED, @SerialName("dismissed") DISMISSED }

/**
 * Revision 61 (`bot:suggestions`): a skill the Bot proposed. [preview] is the new file or a diff,
 * at most 16,000 characters; a longer one is cut and flagged [previewTruncated], and such a skill
 * is added on the Mac only (a phone offers Not now).
 */
@OptIn(ExperimentalSerializationApi::class)
@KeepGeneratedSerializer
@Serializable(with = AidenBotSkillProposalEntrySerializer::class)
@SerialName("skill_proposal")
data class AidenBotSkillProposalEntry(
    override val id: String,
    val proposalId: String,
    val name: String,
    val description: String,
    val reason: String? = null,
    @Serializable(with = AidenStrictBooleanSerializer::class) val update: Boolean,
    val preview: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val previewTruncated: Boolean? = null,
    val status: AidenBotSkillProposalStatus,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
) : AidenBotSessionEntry() {
    init {
        BotUxEntryWire.entryId(id)
        BotUxEntryWire.opaque(proposalId, "entry.proposalId")
        BotUxEntryWire.text(name, "entry.name", BotUxEntryWire.MAX_SKILL_NAME)
        BotUxEntryWire.text(description, "entry.description", BotUxEntryWire.MAX_SKILL_TEXT, blank = true)
        reason?.let { BotUxEntryWire.text(it, "entry.reason", BotUxEntryWire.MAX_SKILL_TEXT) }
        BotUxEntryWire.text(preview, "entry.preview", BotUxEntryWire.MAX_PREVIEW, blank = true)
        if (previewTruncated == false) throw AidenBotContractException.InvalidField("entry.previewTruncated")
    }

    /** Add needs the whole preview: a truncated one is added on the Mac. */
    val canAddHere: Boolean get() = previewTruncated != true
}

object AidenBotSkillProposalEntrySerializer :
    JsonTransformingSerializer<AidenBotSkillProposalEntry>(AidenBotSkillProposalEntry.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement = element.botUxEntryBody()
}

@Serializable
enum class AidenBotLessonKind { @SerialName("proposal") PROPOSAL, @SerialName("learned") LEARNED }

@Serializable
enum class AidenBotLessonStatus {
    @SerialName("pending") PENDING,
    @SerialName("active") ACTIVE,
    @SerialName("dismissed") DISMISSED,
    @SerialName("retired") RETIRED
}

/**
 * Revision 61: a lesson. A `proposal` is a suggestion card (Keep / Not now while pending); a
 * `learned` one is a receipt line with Undo while active.
 */
@OptIn(ExperimentalSerializationApi::class)
@KeepGeneratedSerializer
@Serializable(with = AidenBotLessonEntrySerializer::class)
@SerialName("lesson")
data class AidenBotLessonEntry(
    override val id: String,
    val lessonId: String,
    val kind: AidenBotLessonKind,
    val text: String,
    val routineName: String? = null,
    @Serializable(with = AidenStrictIntSerializer::class) val runs: Int? = null,
    val status: AidenBotLessonStatus,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
) : AidenBotSessionEntry() {
    init {
        BotUxEntryWire.entryId(id)
        BotUxEntryWire.opaque(lessonId, "entry.lessonId")
        BotUxEntryWire.text(text, "entry.text", BotUxEntryWire.MAX_LESSON)
        routineName?.let { BotUxEntryWire.text(it, "entry.routineName", BotUxEntryWire.MAX_ROUTINE_NAME) }
        if (runs != null && runs < 0) throw AidenBotContractException.InvalidField("entry.runs")
    }
}

object AidenBotLessonEntrySerializer :
    JsonTransformingSerializer<AidenBotLessonEntry>(AidenBotLessonEntry.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement = element.botUxEntryBody()
}

/** Revision 61: "Tidied memory", with Undo while [changeId] is present. */
@OptIn(ExperimentalSerializationApi::class)
@KeepGeneratedSerializer
@Serializable(with = AidenBotMemoryTidyEntrySerializer::class)
@SerialName("memory_tidy")
data class AidenBotMemoryTidyEntry(
    override val id: String,
    val changeId: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null
) : AidenBotSessionEntry() {
    init {
        BotUxEntryWire.entryId(id)
        changeId?.let { BotUxEntryWire.opaque(it, "entry.changeId") }
    }
}

object AidenBotMemoryTidyEntrySerializer :
    JsonTransformingSerializer<AidenBotMemoryTidyEntry>(AidenBotMemoryTidyEntry.generatedSerializer()) {
    override fun transformDeserialize(element: JsonElement): JsonElement = element.botUxEntryBody()
}

@Serializable
enum class AidenBotSkillProposalDecision { @SerialName("add") ADD, @SerialName("dismiss") DISMISS }

@Serializable
data class AidenBotSkillProposalRespondRequest(val decision: AidenBotSkillProposalDecision)

@Serializable
data class AidenBotSkillProposalRespondResult(val proposalId: String, val status: AidenBotSkillProposalStatus) {
    init { BotUxEntryWire.opaque(proposalId, "proposalId") }
}

@Serializable
enum class AidenBotLessonDecision { @SerialName("keep") KEEP, @SerialName("dismiss") DISMISS }

@Serializable
data class AidenBotLessonRespondRequest(val decision: AidenBotLessonDecision)

@Serializable
data class AidenBotLessonRespondResult(val lessonId: String, val status: AidenBotLessonStatus) {
    init { BotUxEntryWire.opaque(lessonId, "lessonId") }
}

@Serializable
data class AidenBotLearningUndoResult(
    val changeId: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val undone: Boolean
) {
    init { BotUxEntryWire.opaque(changeId, "changeId") }
}

// --- `approvals:settings` ---

enum class AidenApprovalMode(val wire: String) { AUTO("auto"), ASK("ask"), NEVER("never") }

/** `GET /approvals/mode`: the mode the Mac runs in now, and whether Auto can be chosen. */
data class AidenApprovalModeView(val mode: AidenApprovalMode, val autoAvailable: Boolean) {
    companion object {
        fun parse(element: JsonElement): AidenApprovalModeView {
            val obj = BotUxJson.obj(element, "approvalMode", setOf("mode", "autoAvailable"))
            return AidenApprovalModeView(
                mode = BotUxJson.member(obj["mode"], "approvalMode.mode", AidenApprovalMode.entries) { it.wire },
                autoAvailable = BotUxJson.bool(obj["autoAvailable"], "approvalMode.autoAvailable")
            )
        }

        fun request(mode: AidenApprovalMode): JsonObject = buildJsonObject { put("mode", mode.wire) }
    }
}

enum class AidenApprovalRuleGroup(val wire: String) { ALLOW("allow"), ASK("ask"), BLOCK("block"), MAC("mac") }
enum class AidenApprovalRuleDecision(val wire: String) { ALLOW("allow"), ASK("ask"), BLOCK("block") }
enum class AidenApprovalRuleScopeKind(val wire: String) { MAC("mac"), WORKSPACE("workspace"), BOT("bot"), CHAT("chat") }

/**
 * One row of the Mac's rules page. [ref] is opaque: it goes back to the Mac exactly as it came.
 * [decisions] lists what the row's Allow / Ask / Block control offers; empty means read and remove only.
 */
data class AidenApprovalRuleRow(
    val ref: JsonObject,
    val group: AidenApprovalRuleGroup,
    val title: String,
    val kind: String,
    val scopeKind: AidenApprovalRuleScopeKind,
    val scopeLabel: String?,
    val legacy: Boolean,
    val decisions: List<AidenApprovalRuleDecision>,
    val handOff: Boolean?,
    val createdAt: String?
) {
    /** The decision this row stands for now, as its segment shows it. */
    val decision: AidenApprovalRuleDecision?
        get() = when (group) {
            AidenApprovalRuleGroup.ALLOW -> AidenApprovalRuleDecision.ALLOW
            AidenApprovalRuleGroup.ASK -> AidenApprovalRuleDecision.ASK
            AidenApprovalRuleGroup.BLOCK -> AidenApprovalRuleDecision.BLOCK
            AidenApprovalRuleGroup.MAC -> null
        }
}

data class AidenApprovalRulesView(val rows: List<AidenApprovalRuleRow>, val unreadable: Boolean) {
    companion object {
        const val MAX_ROWS = 2_000
        private const val TITLE_MAX = 400
        private const val KIND_MAX = 80
        private const val LABEL_MAX = 200

        fun parse(element: JsonElement): AidenApprovalRulesView {
            val obj = BotUxJson.obj(element, "approvalRules", setOf("rows", "unreadable"))
            val unreadable = obj["unreadable"]?.let { if (!BotUxJson.bool(it, "approvalRules.unreadable")) throw AidenBotUxContractException("approvalRules.unreadable"); true } ?: false
            return AidenApprovalRulesView(BotUxJson.array(obj["rows"], "approvalRules.rows", MAX_ROWS).map(::parseRow), unreadable)
        }

        private fun bounded(element: JsonElement?, field: String, max: Int): String {
            val value = BotUxJson.string(element, field)
            if (value.isEmpty() || value.length > max) throw AidenBotUxContractException(field)
            return value
        }

        private fun parseRow(element: JsonElement): AidenApprovalRuleRow {
            val obj = BotUxJson.obj(element, "rule", setOf("ref", "group", "title", "kind", "scope", "legacy", "decisions", "handOff", "createdAt"))
            val scope = BotUxJson.obj(obj["scope"], "rule.scope", setOf("kind", "label"))
            val decisions = BotUxJson.array(obj["decisions"], "rule.decisions", AidenApprovalRuleDecision.entries.size).map {
                BotUxJson.member(it, "rule.decisions", AidenApprovalRuleDecision.entries) { d -> d.wire }
            }
            if (obj.containsKey("legacy") && !BotUxJson.bool(obj["legacy"], "rule.legacy")) throw AidenBotUxContractException("rule.legacy")
            val handOff = obj["handOff"]?.let { BotUxJson.bool(BotUxJson.obj(it, "rule.handOff", setOf("on"))["on"], "rule.handOff.on") }
            return AidenApprovalRuleRow(
                ref = opaqueObject(obj["ref"], "rule.ref"),
                group = BotUxJson.member(obj["group"], "rule.group", AidenApprovalRuleGroup.entries) { it.wire },
                title = bounded(obj["title"], "rule.title", TITLE_MAX),
                kind = bounded(obj["kind"], "rule.kind", KIND_MAX),
                scopeKind = BotUxJson.member(scope["kind"], "rule.scope.kind", AidenApprovalRuleScopeKind.entries) { it.wire },
                scopeLabel = scope["label"]?.let { bounded(it, "rule.scope.label", LABEL_MAX) },
                legacy = obj.containsKey("legacy"),
                decisions = decisions,
                handOff = handOff,
                createdAt = obj["createdAt"]?.let { BotUxJson.iso(it, "rule.createdAt") }
            )
        }

        /** A row ref or picker target: an object of short strings, sent back untouched. */
        internal fun opaqueObject(element: JsonElement?, field: String): JsonObject {
            val obj = element as? JsonObject ?: throw AidenBotUxContractException(field)
            if (obj.isEmpty() || obj.size > 8) throw AidenBotUxContractException(field)
            for (value in obj.values) {
                val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw AidenBotUxContractException(field)
                if (text.isEmpty() || text.length > 512) throw AidenBotUxContractException(field)
            }
            return obj
        }

        fun changeRequest(ref: JsonObject, decision: AidenApprovalRuleDecision): JsonObject =
            buildJsonObject { put("ref", ref); put("decision", decision.wire) }

        fun removeRequest(ref: JsonObject): JsonObject = buildJsonObject { put("ref", ref) }

        fun addRequest(target: JsonObject, decision: AidenApprovalRuleDecision): JsonObject =
            buildJsonObject { put("target", target); put("decision", decision.wire) }
    }
}

/** One Add rule choice: Aiden's built-in tools, then each connected app. */
data class AidenApprovalRulePickerOption(val target: JsonObject, val label: String, val group: String, val description: String?) {
    companion object {
        const val MAX_OPTIONS = 2_000

        fun parseList(element: JsonElement): List<AidenApprovalRulePickerOption> {
            val obj = BotUxJson.obj(element, "rulePicker", setOf("options"))
            return BotUxJson.array(obj["options"], "rulePicker.options", MAX_OPTIONS).map { raw ->
                val option = BotUxJson.obj(raw, "rulePicker.option", setOf("target", "label", "group", "description"))
                val target = AidenApprovalRulesView.opaqueObject(option["target"], "rulePicker.target")
                // A rule in the person's own words is written on the Mac, never picked.
                if ((target["kind"] as? JsonPrimitive)?.content.let { it == null || it == "text" }) {
                    throw AidenBotUxContractException("rulePicker.target")
                }
                fun bounded(key: String, max: Int): String {
                    val value = BotUxJson.string(option[key], "rulePicker.$key")
                    if (value.isEmpty() || value.length > max) throw AidenBotUxContractException("rulePicker.$key")
                    return value
                }
                AidenApprovalRulePickerOption(
                    target = target,
                    label = bounded("label", 200),
                    group = bounded("group", 200),
                    description = if (option.containsKey("description")) bounded("description", 400) else null
                )
            }
        }
    }
}

/** Revision 61 (`bot:templates`): the version a template detail was opened at, checked on create. */
internal object AidenBotTemplateWire {
    const val MAX_SAMPLE_LINES = 8
    const val MAX_SAMPLE_LINE = 280

    fun validate(version: Int?, instructions: String?, sample: List<String>?, existingBotId: String?) {
        val any = version != null || instructions != null || sample != null || existingBotId != null
        if (!any) return
        if (version == null || version < 1 || instructions == null || sample == null) {
            throw AidenBotContractException.InvalidField("preset.version")
        }
        BotUxEntryWire.text(instructions, "preset.instructions", BotUxEntryWire.MAX_INSTRUCTIONS)
        if (sample.size > MAX_SAMPLE_LINES) throw AidenBotContractException.InvalidField("preset.sample")
        sample.forEach { BotUxEntryWire.text(it, "preset.sample", MAX_SAMPLE_LINE) }
        existingBotId?.let { BotUxEntryWire.opaque(it, "preset.existingBotId") }
    }
}
