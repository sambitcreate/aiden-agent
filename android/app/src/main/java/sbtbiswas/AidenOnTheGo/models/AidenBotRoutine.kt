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

// Contract revision 26 (`bot-routines-v1`) and (`bot-presets-v1`).

object AidenBotRoutineWire {
    const val MAX_ROUTINES = 64
    const val MAX_NAME_LENGTH = 120
    const val MAX_MESSAGE_LENGTH = 32_000
    const val MAX_LABEL_LENGTH = 200
    const val MAX_TIMEZONE_LENGTH = 64
    const val MAX_ERROR_LENGTH = 2_000
    const val MAX_PRESETS = 8
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
    data class Weekly(val days: List<Int>, override val time: String) : AidenBotRoutineSchedule() {
        init {
            if (days.isEmpty() || days.size > 7 || days.any { it !in 0..6 } || days != days.toSortedSet().toList()) {
                throw AidenBotContractException.InvalidField("schedule.days")
            }
            AidenBotRoutineWire.validateTime(time)
        }
    }

    @Serializable
    @SerialName("monthly")
    data class Monthly(val day: Int, override val time: String) : AidenBotRoutineSchedule() {
        init {
            if (day !in 1..31) throw AidenBotContractException.InvalidField("schedule.day")
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
    val enabled: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val nextRunAt: Instant? = null,
    @Serializable(with = InstantIso8601Serializer::class) val lastRunAt: Instant? = null,
    val lastResult: AidenBotRoutineResult? = null,
    val lastError: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String
) {
    init {
        AidenBotWire.validateString(id, "routine.id", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateIdentifier(botId, "routine.botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "routine.name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(message, "routine.message", AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
        AidenBotWire.validateString(timezone, "routine.timezone", AidenBotRoutineWire.MAX_TIMEZONE_LENGTH)
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
        AidenBotWire.validateString(name, "name", AidenBotRoutineWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(message, "message", AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
        timezone?.let { AidenBotWire.validateString(it, "timezone", AidenBotRoutineWire.MAX_TIMEZONE_LENGTH) }
    }
}

@Serializable
data class AidenBotRoutineUpdateRequest(
    val name: String? = null,
    val schedule: AidenBotRoutineSchedule? = null,
    val message: String? = null,
    val timezone: String? = null,
    val enabled: Boolean? = null
) {
    init {
        if (name == null && schedule == null && message == null && timezone == null && enabled == null) {
            throw AidenBotContractException.InvalidCombination("empty routine update")
        }
        name?.let { AidenBotWire.validateString(it, "name", AidenBotRoutineWire.MAX_NAME_LENGTH) }
        message?.let { AidenBotWire.validateString(it, "message", AidenBotRoutineWire.MAX_MESSAGE_LENGTH) }
        timezone?.let { AidenBotWire.validateString(it, "timezone", AidenBotRoutineWire.MAX_TIMEZONE_LENGTH) }
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
        AidenBotWire.validateIdentifier(pluginId, "pluginId")
        AidenBotWire.validateString(name, "name", AidenBotSessionWire.MAX_NAME_LENGTH)
        AidenBotWire.validateIdentifier(iconId, "iconId")
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
        AidenBotWire.validateIdentifier(id, "preset.id")
        AidenBotWire.validateString(name, "preset.name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(subtitle, "preset.subtitle", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        if (suggestedConnections.size > 16 || suggestedConnections.map { it.pluginId }.toSet().size != suggestedConnections.size) {
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
        AidenBotWire.validateIdentifier(presetId, "presetId")
    }
}

@Serializable
data class AidenBotPresetCreateResult(
    /** True only for the request that made the Bot. */
    val created: Boolean,
    val bot: AidenBotSummary
)
