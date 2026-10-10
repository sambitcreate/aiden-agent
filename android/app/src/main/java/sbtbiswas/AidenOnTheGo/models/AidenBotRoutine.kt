@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeParseException

// Contract revision 25 (`bot-routines-v1`) and (`bot-presets-v1`).

/** Bounds shared with the host parsers in `aiden-remote-protocol.ts`. */
object AidenBotRoutineWire {
    const val MAX_ROUTINES = 64
    const val MAX_ID_LENGTH = 160
    const val MAX_NAME_LENGTH = 120
    /** What the host stores and returns; the phone's editor stays under [MAX_MESSAGE_LENGTH]. */
    const val MAX_STORED_MESSAGE_LENGTH = 32_768
    const val MAX_MESSAGE_LENGTH = 32_000
    const val MAX_LABEL_LENGTH = 200
    const val MAX_TIMEZONE_LENGTH = 120
    const val MAX_ERROR_LENGTH = 500
    const val MAX_PRESETS = 8
    const val MAX_PRESET_CONNECTIONS = 8
    const val MAX_PRESET_SUBTITLE_LENGTH = 280

    fun validateTimezone(value: String, field: String) {
        AidenBotWire.validateString(value, field, MAX_TIMEZONE_LENGTH)
        if (value.trim() != value) throw AidenBotContractException.InvalidField(field)
    }

    /** Names and messages the person typed: the host refuses blank ones. */
    fun validateTyped(value: String, field: String, maxLength: Int) {
        AidenBotWire.validateString(value, field, maxLength)
        if (value.isBlank()) throw AidenBotContractException.InvalidField(field)
    }
    private val TIME = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")
    private val DATE = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

    fun validateTime(value: String) {
        if (!TIME.matches(value)) throw AidenBotContractException.InvalidField("schedule.time")
    }

    fun validateDate(value: String) {
        if (!DATE.matches(value)) throw AidenBotContractException.InvalidField("schedule.date")
        try {
            LocalDate.parse(value)
        } catch (_: DateTimeParseException) {
            throw AidenBotContractException.InvalidField("schedule.date")
        }
    }
}

/** Frequency-first schedule (never cron), discriminated by `kind`. `time` is 24-hour `HH:MM`. */
@Serializable
@JsonClassDiscriminator("kind")
sealed class AidenBotRoutineSchedule {
    abstract val time: String

    @Serializable
    @SerialName("once")
    data class Once(val date: String, override val time: String) : AidenBotRoutineSchedule() {
        init {
            AidenBotRoutineWire.validateDate(date)
            AidenBotRoutineWire.validateTime(time)
        }
    }

    @Serializable
    @SerialName("daily")
    data class Daily(override val time: String) : AidenBotRoutineSchedule() {
        init { AidenBotRoutineWire.validateTime(time) }
    }

    @Serializable
    @SerialName("weekdays")
    data class Weekdays(override val time: String) : AidenBotRoutineSchedule() {
        init { AidenBotRoutineWire.validateTime(time) }
    }

    /** [days] uses Sunday = 0 and is unique and sorted, one to seven entries. */
    @Serializable
    @SerialName("weekly")
    data class Weekly(val days: List<@Serializable(with = AidenStrictIntSerializer::class) Int>, override val time: String) : AidenBotRoutineSchedule() {
        init {
            if (days.isEmpty() || days.size > 7 || days.any { it !in 0..6 } || days != days.toSortedSet().toList()) {
                throw AidenBotContractException.InvalidField("schedule.days")
            }
            AidenBotRoutineWire.validateTime(time)
        }
    }

    @Serializable
    @SerialName("monthly")
    data class Monthly(@Serializable(with = AidenStrictIntSerializer::class) val day: Int, override val time: String) : AidenBotRoutineSchedule() {
        init {
            if (day !in 1..28) throw AidenBotContractException.InvalidField("schedule.day")
            AidenBotRoutineWire.validateTime(time)
        }
    }
}

@Serializable
enum class AidenBotRoutineResult {
    @SerialName("success") SUCCESS,
    @SerialName("error") ERROR,
    @SerialName("silent") SILENT,
    @SerialName("blocked") BLOCKED,
    @SerialName("skipped") SKIPPED
}

@Serializable
data class AidenBotRoutine(
    val id: String,
    val botId: String,
    val name: String,
    /** "What should it do?" */
    val message: String,
    /** Null only for a stored routine whose schedule became unreadable. */
    val schedule: AidenBotRoutineSchedule? = null,
    val timezone: String,
    /** Host-formatted friendly schedule; display it as-is. */
    val label: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val enabled: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val nextRunAt: Instant? = null,
    @Serializable(with = InstantIso8601Serializer::class) val lastRunAt: Instant? = null,
    val lastResult: AidenBotRoutineResult? = null,
    val lastError: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String
) {
    init {
        AidenBotWire.validateIdentifier(id, "routine.id", AidenBotRoutineWire.MAX_ID_LENGTH)
        AidenBotWire.validateIdentifier(botId, "routine.botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "routine.name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(message, "routine.message", AidenBotRoutineWire.MAX_STORED_MESSAGE_LENGTH, allowEmpty = true)
        AidenBotRoutineWire.validateTimezone(timezone, "routine.timezone")
        AidenBotWire.validateString(label, "routine.label", AidenBotRoutineWire.MAX_LABEL_LENGTH)
        lastError?.let { AidenBotWire.validateString(it, "routine.lastError", AidenBotRoutineWire.MAX_ERROR_LENGTH) }
        AidenBotWire.validateString(revision, "routine.revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
    }
}

@Serializable
data class AidenBotRoutineList(val routines: List<AidenBotRoutine>) {
    init {
        if (routines.size > AidenBotRoutineWire.MAX_ROUTINES || routines.map { it.id }.toSet().size != routines.size) {
            throw AidenBotContractException.InvalidField("routines")
        }
    }
}

@Serializable
data class AidenBotRoutineCreateRequest(
    val name: String,
    val schedule: AidenBotRoutineSchedule,
    val message: String,
    val timezone: String? = null
) {
    init {
        AidenBotRoutineWire.validateTyped(name, "name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotRoutineWire.validateTyped(message, "message", AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
        timezone?.let { AidenBotRoutineWire.validateTimezone(it, "timezone") }
    }
}

@Serializable
data class AidenBotRoutineUpdateRequest(
    val name: String? = null,
    val schedule: AidenBotRoutineSchedule? = null,
    val message: String? = null,
    val timezone: String? = null,
    @Serializable(with = AidenStrictBooleanSerializer::class) val enabled: Boolean? = null
) {
    init {
        if (name == null && schedule == null && message == null && timezone == null && enabled == null) {
            throw AidenBotContractException.InvalidCombination("empty routine update")
        }
        name?.let { AidenBotRoutineWire.validateTyped(it, "name", AidenBotRoutineWire.MAX_NAME_LENGTH) }
        message?.let { AidenBotRoutineWire.validateTyped(it, "message", AidenBotRoutineWire.MAX_MESSAGE_LENGTH) }
        timezone?.let { AidenBotRoutineWire.validateTimezone(it, "timezone") }
    }
}

// --- Presets (`bot-presets-v1`) ---

@Serializable
data class AidenBotConnectionChip(
    val pluginId: String,
    val name: String,
    val iconId: String
) {
    init {
        AidenBotSessionWire.validatePluginId(pluginId, "pluginId")
        AidenBotWire.validateString(name, "name", AidenBotSessionWire.MAX_NAME_LENGTH)
        AidenBotSessionWire.validatePluginId(iconId, "iconId")
    }
}

@Serializable
data class AidenBotPresetRoutine(val name: String, val label: String) {
    init {
        AidenBotWire.validateString(name, "suggestedRoutine.name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(label, "suggestedRoutine.label", AidenBotRoutineWire.MAX_LABEL_LENGTH)
    }
}

@Serializable
data class AidenBotPreset(
    val id: String,
    val name: String,
    val subtitle: String,
    val avatar: AidenBotAvatarRecipe,
    val suggestedConnections: List<AidenBotConnectionChip>,
    val suggestedRoutine: AidenBotPresetRoutine? = null
) {
    init {
        AidenBotSessionWire.validatePluginId(id, "preset.id")
        AidenBotWire.validateString(name, "preset.name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(subtitle, "preset.subtitle", AidenBotRoutineWire.MAX_PRESET_SUBTITLE_LENGTH)
        if (suggestedConnections.size > AidenBotRoutineWire.MAX_PRESET_CONNECTIONS) {
            throw AidenBotContractException.InvalidField("preset.suggestedConnections")
        }
    }
}

@Serializable
data class AidenBotPresetList(val presets: List<AidenBotPreset>) {
    init {
        if (presets.size > AidenBotRoutineWire.MAX_PRESETS || presets.map { it.id }.toSet().size != presets.size) {
            throw AidenBotContractException.InvalidField("presets")
        }
    }
}

@Serializable
data class AidenBotPresetCreateRequest(val presetId: String) {
    init {
        AidenBotSessionWire.validatePluginId(presetId, "presetId")
    }
}

@Serializable
data class AidenBotPresetCreateResult(
    /** True only for the request that made the Bot. */
    @Serializable(with = AidenStrictBooleanSerializer::class) val created: Boolean,
    val bot: AidenBotSummary
)

// --- Contract revision 27 (`bot-proactive-v1`) ---

/** A Bot's suggested routine: the person adds it or says Not now. */
@Serializable
enum class AidenBotRoutineProposalDecision {
    @SerialName("accept") ACCEPT,
    @SerialName("dismiss") DISMISS
}

/** `POST /bots/{botId}/routine-proposals/{proposalId}/respond` body; sent with an `Idempotency-Key`. */
@Serializable
data class AidenBotRoutineProposalRespondRequest(val decision: AidenBotRoutineProposalDecision)

@Serializable
enum class AidenBotRoutineProposalOutcome {
    @SerialName("accepted") ACCEPTED,
    @SerialName("dismissed") DISMISSED
}

/** The settled answer. Only an accepted proposal, and always one, names the routine it made. */
@Serializable
data class AidenBotRoutineProposalRespondResult(
    val status: AidenBotRoutineProposalOutcome,
    val routineId: String? = null
) {
    init {
        if ((routineId != null) != (status == AidenBotRoutineProposalOutcome.ACCEPTED)) {
            throw AidenBotContractException.InvalidCombination("routine proposal result")
        }
        routineId?.let { AidenBotWire.validateString(it, "routineId", AidenBotRoutineWire.MAX_ID_LENGTH) }
    }
}

/** A starter routine the editor opens prefilled (the daily check-in); nothing is made until Save. */
@Serializable
data class AidenBotRoutineSuggestion(
    val id: String,
    val name: String,
    val prompt: String,
    val schedule: AidenBotRoutineSchedule,
    /** Host-formatted friendly schedule; display it as-is. */
    val label: String
) {
    init {
        AidenBotSessionWire.validatePluginId(id, "suggestion.id")
        AidenBotWire.validateString(name, "suggestion.name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(prompt, "suggestion.prompt", AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
        AidenBotWire.validateString(label, "suggestion.label", AidenBotSessionWire.MAX_LABEL_LENGTH)
    }
}

/** `GET /bots/{botId}/routine-suggestions`: empty once the Bot has any routine. */
@Serializable
data class AidenBotRoutineSuggestionList(val suggestions: List<AidenBotRoutineSuggestion>) {
    init {
        if (suggestions.size > MAX_SUGGESTIONS || suggestions.map { it.id }.toSet().size != suggestions.size) {
            throw AidenBotContractException.InvalidField("suggestions")
        }
    }

    companion object {
        const val MAX_SUGGESTIONS = 8
    }
}

@Serializable
enum class AidenBotRoutineNotificationStatus {
    @SerialName("succeeded") SUCCEEDED,
    @SerialName("failed") FAILED
}

/** One finished Bot routine run the phone may post once, as `aiden.bot-routine.<id>`. */
@Serializable
data class AidenBotRoutineNotification(
    /** The routine run id. */
    val id: String,
    val botId: String,
    val botName: String,
    val routineId: String,
    val routineName: String,
    val status: AidenBotRoutineNotificationStatus,
    @Serializable(with = InstantIso8601Serializer::class) val finishedAt: Instant,
    /** First 160 characters of the reply (redacted), or a fixed failure line. */
    val preview: String
) {
    init {
        AidenBotWire.validateString(id, "notification.id", AidenBotRoutineWire.MAX_ID_LENGTH)
        AidenBotWire.validateIdentifier(botId, "notification.botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(botName, "notification.botName", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(routineId, "notification.routineId", AidenBotRoutineWire.MAX_ID_LENGTH)
        AidenBotWire.validateString(routineName, "notification.routineName", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(preview, "notification.preview", MAX_PREVIEW_LENGTH, allowEmpty = true)
    }

    companion object {
        const val MAX_PREVIEW_LENGTH = 160
    }
}

/** `GET /bots/routine-notifications?since=`: newest first, at most 100. Pass [now] as the next `since`. */
@Serializable
data class AidenBotRoutineNotificationList(
    val notifications: List<AidenBotRoutineNotification>,
    @Serializable(with = InstantIso8601Serializer::class) val now: Instant
) {
    init {
        if (notifications.size > MAX_NOTIFICATIONS || notifications.map { it.id }.toSet().size != notifications.size) {
            throw AidenBotContractException.InvalidField("notifications")
        }
    }

    companion object {
        const val MAX_NOTIFICATIONS = 100
    }
}
