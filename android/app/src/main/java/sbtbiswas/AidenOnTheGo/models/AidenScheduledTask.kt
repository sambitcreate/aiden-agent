package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone

@Serializable
enum class AidenScheduledTaskMode {
    @SerialName("llm") LLM,
    @SerialName("script") SCRIPT;

    val title: String get() = if (this == LLM) "Ask Aiden" else "Run Script"
}

@Serializable
enum class AidenScheduledTaskPermission {
    @SerialName("read-only") READ_ONLY,
    @SerialName("full") FULL;

    val title: String get() = if (this == READ_ONLY) "Read Only" else "Full"
}

@Serializable
enum class AidenScheduledTaskResult {
    @SerialName("success") SUCCESS,
    @SerialName("error") ERROR,
    @SerialName("silent") SILENT,
    @SerialName("blocked") BLOCKED
}

@Serializable
data class AidenScheduledTask(
    val id: String,
    val revision: String,
    val name: String,
    val enabled: Boolean,
    val schedule: String,
    val timezone: String,
    val mode: AidenScheduledTaskMode,
    val permission: AidenScheduledTaskPermission,
    val workspaceId: String? = null,
    val providerId: String? = null,
    val modelId: String? = null,
    val mcpServerIds: List<String>? = null,
    val scriptId: String? = null,
    val prompt: String? = null,
    val notify: Boolean,
    val running: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val nextRunAt: Instant? = null,
    @Serializable(with = InstantIso8601Serializer::class) val lastRunAt: Instant? = null,
    val lastResult: AidenScheduledTaskResult? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant
)

@Serializable
data class AidenScheduledTaskMutation(
    val name: String,
    val schedule: String,
    val timezone: String,
    val mode: AidenScheduledTaskMode,
    val permission: AidenScheduledTaskPermission,
    val workspaceId: String? = null,
    val providerId: String? = null,
    val modelId: String? = null,
    val mcpServerIds: List<String>? = null,
    val scriptId: String? = null,
    val prompt: String? = null,
    val notify: Boolean,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenScheduledRunAccepted(
    val taskId: String,
    val runId: String,
    val status: String,
    @Serializable(with = InstantIso8601Serializer::class) val acceptedAt: Instant
)

@Serializable
data class AidenScheduledRun(
    val id: String,
    val taskId: String,
    val status: String,
    @Serializable(with = InstantIso8601Serializer::class) val startedAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val finishedAt: Instant? = null,
    val summary: String? = null,
    val errorCode: String? = null
)

@Serializable
data class AidenScheduledScript(
    val id: String,
    val name: String
)

@Serializable
data class AidenScheduledMcpServer(
    val id: String,
    val name: String
)

@Serializable
data class AidenScheduledPreview(
    val dates: List<@Serializable(with = InstantIso8601Serializer::class) Instant>
)

@Serializable
data class AidenScheduledSettings(
    val revision: String,
    val enabled: Boolean,
    val defaultMode: AidenScheduledTaskMode,
    val defaultPermission: AidenScheduledTaskPermission,
    val defaultMcpEnabled: Boolean,
    val defaultNotify: Boolean,
    val defaultTimezone: String
)

@Serializable
data class AidenScheduledSettingsMutation(
    val enabled: Boolean? = null,
    val defaultMode: AidenScheduledTaskMode? = null,
    val defaultPermission: AidenScheduledTaskPermission? = null,
    val defaultMcpEnabled: Boolean? = null,
    val defaultNotify: Boolean? = null,
    val defaultTimezone: String? = null,
    val confirmedForeground: Boolean = true
)

data class AidenScheduledTaskDraft(
    var name: String = "",
    var schedule: String = "",
    var timezone: String = TimeZone.getDefault().id,
    var mode: AidenScheduledTaskMode = AidenScheduledTaskMode.LLM,
    var permission: AidenScheduledTaskPermission = AidenScheduledTaskPermission.READ_ONLY,
    var workspaceId: String? = null,
    var providerId: String? = null,
    var modelId: String? = null,
    var mcpServerIds: Set<String> = emptySet(),
    var scriptId: String? = null,
    var prompt: String = "",
    var notify: Boolean = true
) {
    constructor(task: AidenScheduledTask) : this(
        name = task.name,
        schedule = task.schedule,
        timezone = task.timezone,
        mode = task.mode,
        permission = task.permission,
        workspaceId = task.workspaceId,
        providerId = task.providerId,
        modelId = task.modelId,
        mcpServerIds = task.mcpServerIds?.toSet() ?: emptySet(),
        scriptId = task.scriptId,
        prompt = task.prompt ?: "",
        notify = task.notify
    )

    val validationMessage: String?
        get() {
            if (name.trim().isEmpty()) return "Name is required."
            if (schedule.trim().isEmpty()) return "Schedule is required."
            if (timezone.trim().isEmpty()) return "Timezone is required."
            if (mode == AidenScheduledTaskMode.LLM && prompt.trim().isEmpty()) return "Prompt is required."
            if (mode == AidenScheduledTaskMode.SCRIPT && scriptId == null) return "Choose a script from Aiden Agent."
            if (mode == AidenScheduledTaskMode.SCRIPT && permission != AidenScheduledTaskPermission.FULL) return "Script tasks require Full permission."
            return null
        }

    val mutation: AidenScheduledTaskMutation
        get() = AidenScheduledTaskMutation(
            name = name.trim(),
            schedule = schedule.trim(),
            timezone = timezone.trim(),
            mode = mode,
            permission = permission,
            workspaceId = workspaceId,
            providerId = if (mode == AidenScheduledTaskMode.LLM) providerId else null,
            modelId = if (mode == AidenScheduledTaskMode.LLM) modelId else null,
            mcpServerIds = if (mode == AidenScheduledTaskMode.LLM && mcpServerIds.isNotEmpty()) mcpServerIds.sorted() else null,
            scriptId = if (mode == AidenScheduledTaskMode.SCRIPT) scriptId else null,
            prompt = if (mode == AidenScheduledTaskMode.LLM) prompt.trim() else null,
            notify = notify
        )
}

enum class AidenScheduledTaskFilter(val title: String) {
    ALL("All"),
    ACTIVE("Active"),
    PAUSED("Paused")
}

object AidenScheduledTaskPresentation {
    private val weekdayNames = mapOf(
        "0" to "Sunday",
        "1" to "Monday",
        "2" to "Tuesday",
        "3" to "Wednesday",
        "4" to "Thursday",
        "5" to "Friday",
        "6" to "Saturday",
        "7" to "Sunday"
    )

    fun visible(
        tasks: List<AidenScheduledTask>,
        query: String,
        filter: AidenScheduledTaskFilter
    ): List<AidenScheduledTask> {
        val needle = query.trim()
        return tasks.filter { task ->
            val matchesFilter = when (filter) {
                AidenScheduledTaskFilter.ALL -> true
                AidenScheduledTaskFilter.ACTIVE -> task.enabled
                AidenScheduledTaskFilter.PAUSED -> !task.enabled
            }
            matchesFilter && (needle.isEmpty() ||
                task.name.contains(needle, ignoreCase = true) ||
                task.prompt?.contains(needle, ignoreCase = true) == true)
        }.sortedWith(
            compareByDescending<AidenScheduledTask> { it.enabled }
                .thenBy { it.nextRunAt ?: Instant.MAX }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }
        )
    }

    fun schedule(task: AidenScheduledTask): String {
        val fields = task.schedule.trim().split(Regex("\\s+"))
        if (fields.size != 5) return "Custom schedule"
        val (minute, hour, dayOfMonth, month, dayOfWeek) = fields
        if (minute.startsWith("*/") && hour == "*" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            val interval = minute.removePrefix("*/").toIntOrNull()
            if (interval != null && interval > 0) return "Every $interval minute${if (interval == 1) "" else "s"}"
        }
        if (minute == "0" && hour.startsWith("*/") && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            val interval = hour.removePrefix("*/").toIntOrNull()
            if (interval != null && interval > 0) return "Every $interval hour${if (interval == 1) "" else "s"}"
        }
        val minuteValue = minute.toIntOrNull()
        val hourValue = hour.toIntOrNull()
        if (minuteValue in 0..59 && hour == "*" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            return if (minuteValue == 0) {
                "Every hour"
            } else {
                "Every hour at $minuteValue minute${if (minuteValue == 1) "" else "s"} past"
            }
        }
        if (minuteValue in 0..59 && hourValue in 0..23 && dayOfMonth == "*" && month == "*") {
            val time = clockTime(hourValue!!, minuteValue!!)
            return when (dayOfWeek) {
                "*" -> "Daily at $time"
                "1-5" -> "Weekdays at $time"
                else -> weekdayNames[dayOfWeek]?.let { "$it at $time" } ?: "Custom schedule"
            }
        }
        return "Custom schedule"
    }

    fun timestamp(value: Instant?, zoneId: ZoneId = ZoneId.systemDefault()): String? {
        if (value == null) return null
        return DateTimeFormatter.ofPattern("MMM d 'at' h:mm a", Locale.getDefault())
            .withZone(zoneId)
            .format(value)
    }

    fun status(task: AidenScheduledTask): String = when {
        task.running -> "Running"
        task.enabled -> "Active"
        else -> "Paused"
    }

    private fun clockTime(hour: Int, minute: Int): String {
        val suffix = if (hour < 12) "AM" else "PM"
        val displayHour = when (val normalized = hour % 12) {
            0 -> 12
            else -> normalized
        }
        return String.format(Locale.US, "%d:%02d %s", displayHour, minute, suffix)
    }
}

object AidenScheduledTaskValidation {
    fun tasks(tasks: List<AidenScheduledTask>): List<AidenScheduledTask> {
        if (tasks.size > 10_000) throw AidenRemoteClientException.InvalidResponse()
        val ids = mutableSetOf<String>()
        for (task in tasks) {
            val mcpServerIds = task.mcpServerIds.orEmpty()
            if (!task.id.matches(Regex("^[A-Za-z0-9._:-]{1,160}$")) || !ids.add(task.id) ||
                !task.revision.startsWith("rev_") || task.revision.length > 160 ||
                task.name.isEmpty() || task.name.length > 120 ||
                task.schedule.isEmpty() || task.schedule.length > 500 ||
                task.timezone.isEmpty() || task.timezone.length > 120 ||
                (task.prompt != null && task.prompt.length > 32_768) ||
                (task.workspaceId != null && (task.workspaceId.isEmpty() || task.workspaceId.length > 128)) ||
                (task.providerId != null && (task.providerId.isEmpty() || task.providerId.length > 256)) ||
                (task.modelId != null && (task.modelId.isEmpty() || task.modelId.length > 256)) ||
                mcpServerIds.size > 64 || mcpServerIds.toSet().size != mcpServerIds.size ||
                mcpServerIds.any { it.isEmpty() || it.length > 256 } ||
                (task.scriptId != null && !task.scriptId.matches(Regex("^script_[A-Za-z0-9_-]{43}$")))
            ) {
                throw AidenRemoteClientException.InvalidResponse()
            }
        }
        return tasks
    }

    fun runs(runs: List<AidenScheduledRun>, taskId: String): List<AidenScheduledRun> {
        if (runs.size > 50 || runs.any { it.taskId != taskId || (it.summary != null && it.summary.length > 20_000) }) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        return runs
    }
}
