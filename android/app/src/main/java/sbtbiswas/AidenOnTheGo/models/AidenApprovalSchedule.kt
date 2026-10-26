package sbtbiswas.AidenOnTheGo.models

import androidx.compose.runtime.Immutable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

enum class AidenApprovalScheduleAction(val wire: String) {
    CREATE("create"), UPDATE("update"), PAUSE("pause"), RESUME("resume"), REMOVE("remove"), RUN_NOW("run_now");

    companion object {
        fun fromWire(value: String): AidenApprovalScheduleAction? = entries.firstOrNull { it.wire == value }
    }
}

enum class AidenApprovalScheduleMode(val wire: String) {
    LLM("llm"), SCRIPT("script");

    companion object {
        fun fromWire(value: String): AidenApprovalScheduleMode? = entries.firstOrNull { it.wire == value }
    }
}

enum class AidenApprovalSchedulePermission(val wire: String) {
    READ_ONLY("read-only"), FULL("full");

    companion object {
        fun fromWire(value: String): AidenApprovalSchedulePermission? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * Contract revision 38, `schedule:cards`: the display-only facts of a scheduled-task
 * approval. It never changes whether this phone may allow, which scopes it offers, or what the
 * summary says; it only lets the card show the task instead of the summary text. [nextRunAt]
 * keeps the host's exact text so the card round-trips; [nextRun] is the parsed instant.
 */
@Immutable
data class AidenApprovalSchedule(
    val action: AidenApprovalScheduleAction,
    val name: String,
    val cadence: String,
    val timezone: String,
    val nextRunAt: String? = null,
    val mode: AidenApprovalScheduleMode,
    val permission: AidenApprovalSchedulePermission,
    val workspaceName: String? = null,
    val connectors: List<String> = emptyList(),
    val providerName: String? = null,
    val modelName: String? = null,
    val notify: Boolean,
    /** The task's state once approved: true for a resume, false for a pause. */
    val enabled: Boolean,
    val schedulerEnabled: Boolean,
    val prompt: String? = null,
    val script: String? = null,
    /** The instructions or script were shortened to fit the wire bound. */
    val truncated: Boolean = false
) {
    val nextRun: Instant? get() = nextRunAt?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** The wire object, keys absent rather than null, exactly as the host writes it. */
    fun toJsonObject(): JsonObject = JsonObject(buildMap {
        put("action", JsonPrimitive(action.wire))
        put("name", JsonPrimitive(name))
        put("cadence", JsonPrimitive(cadence))
        put("timezone", JsonPrimitive(timezone))
        nextRunAt?.let { put("nextRunAt", JsonPrimitive(it)) }
        put("mode", JsonPrimitive(mode.wire))
        put("permission", JsonPrimitive(permission.wire))
        workspaceName?.let { put("workspaceName", JsonPrimitive(it)) }
        put("connectors", JsonArray(connectors.map(::JsonPrimitive)))
        providerName?.let { put("providerName", JsonPrimitive(it)) }
        modelName?.let { put("modelName", JsonPrimitive(it)) }
        put("notify", JsonPrimitive(notify))
        put("enabled", JsonPrimitive(enabled))
        put("schedulerEnabled", JsonPrimitive(schedulerEnabled))
        prompt?.let { put("prompt", JsonPrimitive(it)) }
        script?.let { put("script", JsonPrimitive(it)) }
        if (truncated) put("truncated", JsonPrimitive(true))
    })

    companion object {
        const val NAME_LIMIT = 120
        const val CADENCE_LIMIT = 200
        const val TIMEZONE_LIMIT = 128
        const val NEXT_RUN_LIMIT = 40
        const val WORKSPACE_NAME_LIMIT = 120
        const val CONNECTOR_LIMIT = 16
        const val CONNECTOR_NAME_LIMIT = 120
        const val PROVIDER_NAME_LIMIT = 120
        const val MODEL_NAME_LIMIT = 256
        const val TEXT_LIMIT = 2_000

        private val KEYS = setOf(
            "action", "name", "cadence", "timezone", "nextRunAt", "mode", "permission", "workspaceName",
            "connectors", "providerName", "modelName", "notify", "enabled", "schedulerEnabled", "prompt",
            "script", "truncated"
        )
        private val RFC3339_UTC = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$""")

        /** The tool whose approvals may carry a card. Any other approval ignores one. */
        const val TOOL_NAME = "schedule_task"

        /** [schedule] only when it belongs on [toolName]'s card. */
        fun forTool(toolName: String, schedule: AidenApprovalSchedule?): AidenApprovalSchedule? =
            schedule.takeIf { toolName == TOOL_NAME }

        /**
         * Mirrors the host's `parseAidenRemoteApprovalSchedule`: exact keys, the three
         * enumerations, bounded safe text, and content that matches its mode. Fails closed: any
         * value it would reject reads as no card (null), so the approval still decodes with its
         * own `canAllow` and scopes. It never throws.
         */
        fun parseOrNull(element: JsonElement?): AidenApprovalSchedule? = try {
            parse(element)
        } catch (_: InvalidSchedule) {
            null
        }

        private class InvalidSchedule : Exception()

        private fun parse(element: JsonElement?): AidenApprovalSchedule {
            val record = element as? JsonObject ?: throw InvalidSchedule()
            if (!KEYS.containsAll(record.keys)) throw InvalidSchedule()
            val action = AidenApprovalScheduleAction.fromWire(rawString(record["action"]) ?: "") ?: throw InvalidSchedule()
            val mode = AidenApprovalScheduleMode.fromWire(rawString(record["mode"]) ?: "") ?: throw InvalidSchedule()
            val permission = AidenApprovalSchedulePermission.fromWire(rawString(record["permission"]) ?: "")
                ?: throw InvalidSchedule()
            val connectorArray = record["connectors"] as? JsonArray ?: throw InvalidSchedule()
            if (connectorArray.size > CONNECTOR_LIMIT) throw InvalidSchedule()
            val connectors = connectorArray.map { safeText(it, CONNECTOR_NAME_LIMIT) ?: throw InvalidSchedule() }
            val nextRunAt = optionalText(record, "nextRunAt", NEXT_RUN_LIMIT)
            if (nextRunAt != null && (!RFC3339_UTC.matches(nextRunAt) || runCatching { Instant.parse(nextRunAt) }.isFailure)) {
                throw InvalidSchedule()
            }
            val providerName = optionalText(record, "providerName", PROVIDER_NAME_LIMIT)
            val modelName = optionalText(record, "modelName", MODEL_NAME_LIMIT)
            val prompt = optionalText(record, "prompt", TEXT_LIMIT, multiline = true)
            val script = optionalText(record, "script", TEXT_LIMIT, multiline = true)
            val mismatched = when (mode) {
                AidenApprovalScheduleMode.LLM -> script != null
                AidenApprovalScheduleMode.SCRIPT -> prompt != null || providerName != null || modelName != null
            }
            if (mismatched) throw InvalidSchedule()
            val truncated = record["truncated"]
            if (truncated != null && (!isTrue(truncated) || (prompt ?: script) == null)) throw InvalidSchedule()
            val workspaceName = optionalText(record, "workspaceName", WORKSPACE_NAME_LIMIT)
            return AidenApprovalSchedule(
                action = action,
                name = text(record, "name", NAME_LIMIT),
                cadence = text(record, "cadence", CADENCE_LIMIT),
                timezone = text(record, "timezone", TIMEZONE_LIMIT),
                nextRunAt = nextRunAt,
                mode = mode,
                permission = permission,
                workspaceName = workspaceName,
                connectors = connectors,
                providerName = providerName,
                modelName = modelName,
                notify = flag(record, "notify"),
                enabled = flag(record, "enabled"),
                schedulerEnabled = flag(record, "schedulerEnabled"),
                prompt = prompt,
                script = script,
                truncated = truncated != null
            )
        }

        private fun rawString(element: JsonElement?): String? =
            (element as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun isTrue(element: JsonElement): Boolean =
            element is JsonPrimitive && element !is JsonNull && !element.isString && element.content == "true"

        private fun flag(record: JsonObject, key: String): Boolean {
            val value = record[key] as? JsonPrimitive ?: throw InvalidSchedule()
            if (value is JsonNull || value.isString) throw InvalidSchedule()
            return when (value.content) {
                "true" -> true
                "false" -> false
                else -> throw InvalidSchedule()
            }
        }

        private fun text(record: JsonObject, key: String, limit: Int, multiline: Boolean = false): String =
            safeText(record[key], limit, multiline) ?: throw InvalidSchedule()

        /** Absent is null; present must pass, so a JSON null rejects the card just as on the host. */
        private fun optionalText(record: JsonObject, key: String, limit: Int, multiline: Boolean = false): String? =
            if (!record.containsKey(key)) null else text(record, key, limit, multiline)

        /**
         * The host's `safeApprovalText`: a string of 1 to [limit] UTF-16 code units (JavaScript
         * `length`, which Kotlin's [String.length] also counts), equal to its own JavaScript
         * trim, with no control, line or bidi formatting character. Tabs and line breaks pass
         * only in [multiline] text.
         */
        internal fun safeText(element: JsonElement?, limit: Int, multiline: Boolean = false): String? {
            val value = rawString(element) ?: return null
            if (value.isEmpty() || value.length > limit) return null
            if (isJavaScriptWhitespace(value.first().code) || isJavaScriptWhitespace(value.last().code)) return null
            var index = 0
            while (index < value.length) {
                val codePoint = value.codePointAt(index)
                if (isUnsafeCodePoint(codePoint, multiline)) return null
                index += Character.charCount(codePoint)
            }
            return value
        }

        private fun isUnsafeCodePoint(codePoint: Int, multiline: Boolean): Boolean {
            val allowedWhitespace = multiline && (codePoint == 0x09 || codePoint == 0x0A || codePoint == 0x0D)
            return (!allowedWhitespace && codePoint <= 0x1F) ||
                codePoint in 0x7F..0x9F ||
                codePoint == 0x061C ||
                codePoint == 0x200E ||
                codePoint == 0x200F ||
                codePoint in 0x202A..0x202E ||
                codePoint == 0x2028 ||
                codePoint == 0x2029 ||
                codePoint in 0x2066..0x2069
        }

        /** What JavaScript's `String.prototype.trim` strips: WhiteSpace and LineTerminator. */
        private fun isJavaScriptWhitespace(code: Int): Boolean = when (code) {
            0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
            in 0x2000..0x200A -> true
            else -> false
        }
    }
}

/**
 * Reads an optional `schedule` on a leniently decoded approval. Any value the wire validator
 * rejects decodes as null instead of failing the approval around it.
 */
object AidenApprovalScheduleLenientSerializer : KSerializer<AidenApprovalSchedule?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): AidenApprovalSchedule? {
        val json = decoder as? JsonDecoder ?: return null
        return AidenApprovalSchedule.parseOrNull(json.decodeJsonElement())
    }

    override fun serialize(encoder: Encoder, value: AidenApprovalSchedule?) {
        val json = encoder as? JsonEncoder ?: error("The schedule card is JSON only.")
        json.encodeJsonElement(value?.toJsonObject() ?: JsonNull)
    }
}

/** What the card's "Runs in" row names, in the host's order of precedence. */
sealed interface AidenApprovalScheduleLocation {
    data class Project(val name: String) : AidenApprovalScheduleLocation
    data class Connectors(val names: List<String>) : AidenApprovalScheduleLocation
    /** Full access with no project and no connectors: the host runs it anywhere on the computer. */
    data object Anywhere : AidenApprovalScheduleLocation
    data object NoProject : AidenApprovalScheduleLocation
}

/** A soft note under the card's details. */
enum class AidenApprovalScheduleNote { SCHEDULING_OFF, STAYS_PAUSED }

/** Text and choices for the scheduled-task card, kept out of Compose so they can be tested directly. */
object AidenApprovalSchedulePresentation {
    /** The card's question by what approving would do. Matches desktop and iOS. */
    fun title(action: AidenApprovalScheduleAction): String = when (action) {
        AidenApprovalScheduleAction.CREATE -> "Save this scheduled task?"
        AidenApprovalScheduleAction.UPDATE -> "Update this scheduled task?"
        AidenApprovalScheduleAction.PAUSE -> "Pause this scheduled task?"
        AidenApprovalScheduleAction.RESUME -> "Resume this scheduled task?"
        AidenApprovalScheduleAction.REMOVE -> "Delete this scheduled task?"
        AidenApprovalScheduleAction.RUN_NOW -> "Run this scheduled task now?"
    }

    fun location(schedule: AidenApprovalSchedule): AidenApprovalScheduleLocation = when {
        schedule.workspaceName != null -> AidenApprovalScheduleLocation.Project(schedule.workspaceName)
        schedule.connectors.isNotEmpty() -> AidenApprovalScheduleLocation.Connectors(schedule.connectors)
        schedule.permission == AidenApprovalSchedulePermission.FULL -> AidenApprovalScheduleLocation.Anywhere
        else -> AidenApprovalScheduleLocation.NoProject
    }

    /** "OpenRouter · Qwen3 Coder" from the parts present; null when neither is, or for a script. */
    fun model(schedule: AidenApprovalSchedule): String? {
        if (schedule.mode == AidenApprovalScheduleMode.SCRIPT) return null
        return listOfNotNull(schedule.providerName, schedule.modelName).joinToString(" · ").ifEmpty { null }
    }

    /**
     * The next run worth naming: only when the host sent one and the task will start on its own
     * (enabled, scheduling on, not being deleted), as on desktop.
     */
    fun nextRun(schedule: AidenApprovalSchedule): Instant? = schedule.nextRun.takeIf {
        enabledOnceApproved(schedule) && schedule.schedulerEnabled && schedule.action != AidenApprovalScheduleAction.REMOVE
    }

    fun note(schedule: AidenApprovalSchedule): AidenApprovalScheduleNote? = when {
        !schedule.schedulerEnabled -> AidenApprovalScheduleNote.SCHEDULING_OFF
        // A pause says so in its question.
        !enabledOnceApproved(schedule) &&
            schedule.action != AidenApprovalScheduleAction.REMOVE &&
            schedule.action != AidenApprovalScheduleAction.PAUSE -> AidenApprovalScheduleNote.STAYS_PAUSED
        else -> null
    }

    /** The task's state once approved: a resume runs again and a pause stops, as the Mac sends it, whatever `enabled` says. */
    private fun enabledOnceApproved(schedule: AidenApprovalSchedule): Boolean = when (schedule.action) {
        AidenApprovalScheduleAction.RESUME -> true
        AidenApprovalScheduleAction.PAUSE -> false
        else -> schedule.enabled
    }

    /** The instructions or script the card shows. */
    fun body(schedule: AidenApprovalSchedule): String? = when (schedule.mode) {
        AidenApprovalScheduleMode.LLM -> schedule.prompt
        AidenApprovalScheduleMode.SCRIPT -> schedule.script
    }

    /**
     * "today at 9:00 AM", "tomorrow at 9:00 AM", or "Thu, Oct 23 at 9:00 AM" in [zone], the
     * device's time. Matches the desktop card's wording after "Next run".
     */
    fun nextRunText(
        at: Instant,
        now: Instant,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
        use24Hour: Boolean = false
    ): String {
        val local = at.atZone(zone)
        val time = DateTimeFormatter.ofPattern(if (use24Hour) "H:mm" else "h:mm a", locale).format(local)
        val days = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), local.toLocalDate())
        return when (days) {
            0L -> "today at $time"
            1L -> "tomorrow at $time"
            else -> "${DateTimeFormatter.ofPattern("EEE, MMM d", locale).format(local)} at $time"
        }
    }
}
