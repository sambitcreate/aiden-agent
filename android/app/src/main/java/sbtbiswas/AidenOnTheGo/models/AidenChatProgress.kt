package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant

/** Public, bounded task state exposed by the Mac-owned chat progress projection. */
@Serializable
enum class AidenChatTaskStatus {
    @SerialName("pending") PENDING,
    @SerialName("in_progress") IN_PROGRESS,
    @SerialName("completed") COMPLETED,
    @SerialName("deleted") DELETED
}

@Serializable
data class AidenChatTask(
    val id: Long,
    val subject: String,
    val status: AidenChatTaskStatus,
    val activeForm: String? = null,
    val blockedBy: List<Long>? = null
)

@Serializable
enum class AidenChatProgressAvailability {
    @SerialName("ready") READY,
    @SerialName("unavailable") UNAVAILABLE
}

@Serializable
enum class AidenChatTaskUnavailableReason {
    @SerialName("storage_not_enabled") STORAGE_NOT_ENABLED,
    @SerialName("invalid_snapshot") INVALID_SNAPSHOT,
    @SerialName("unsupported") UNSUPPORTED
}

@Serializable
data class AidenChatTaskProgress(
    val version: Int,
    val chatId: String,
    val availability: AidenChatProgressAvailability,
    val unavailableReason: AidenChatTaskUnavailableReason? = null,
    val epoch: String,
    val revision: Long,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val tasks: List<AidenChatTask>
)

@Serializable
enum class AidenChatAgentState {
    @SerialName("queued") QUEUED,
    @SerialName("starting") STARTING,
    @SerialName("running") RUNNING,
    @SerialName("needs_attention") NEEDS_ATTENTION,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
    @SerialName("timed_out") TIMED_OUT,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("stopped") STOPPED,
    @SerialName("unknown") UNKNOWN
}

@Serializable
enum class AidenChatAgentRole {
    @SerialName("scout") SCOUT,
    @SerialName("planner") PLANNER,
    @SerialName("reviewer") REVIEWER
}

@Serializable
enum class AidenChatAgentMilestone {
    @SerialName("reading") READING,
    @SerialName("listing") LISTING,
    @SerialName("matching") MATCHING,
    @SerialName("searching") SEARCHING,
    @SerialName("inspecting") INSPECTING,
    @SerialName("composing") COMPOSING
}

@Serializable
enum class AidenChatAgentNotice {
    @SerialName("task_truncated") TASK_TRUNCATED,
    @SerialName("report_truncated") REPORT_TRUNCATED,
    @SerialName("display_filtered") DISPLAY_FILTERED
}

/**
 * Public agent metadata only. `taskPreview`, `error`, and `warnings` are wire
 * contract fields retained for strict decoding, but the Android UI deliberately
 * never renders them because they can contain private child-run text.
 */
@Serializable
data class AidenChatAgent(
    val agentId: String,
    val parentAgentId: String? = null,
    val depth: Int,
    val revision: Long,
    val role: AidenChatAgentRole,
    val label: String,
    val taskPreview: String,
    val state: AidenChatAgentState,
    val activity: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val startedAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val finishedAt: Instant? = null,
    val modelId: String,
    val turns: Long,
    val tools: Long,
    val tokens: Long,
    val milestones: List<AidenChatAgentMilestone>? = null,
    val notices: List<AidenChatAgentNotice>? = null,
    val error: String? = null,
    val warnings: List<String>? = null
) {
    val isTerminal: Boolean
        get() = state in setOf(
            AidenChatAgentState.COMPLETED,
            AidenChatAgentState.FAILED,
            AidenChatAgentState.TIMED_OUT,
            AidenChatAgentState.INTERRUPTED,
            AidenChatAgentState.STOPPED,
            AidenChatAgentState.UNKNOWN
        )
}

@Serializable
enum class AidenChatAgentUnavailableReason {
    @SerialName("unsupported") UNSUPPORTED,
    @SerialName("invalid_snapshot") INVALID_SNAPSHOT
}

@Serializable
data class AidenChatPreviousTurn(
    val turnId: String,
    @Serializable(with = InstantIso8601Serializer::class) val startedAt: Instant
)

@Serializable
data class AidenChatAgentRoster(
    val version: Int,
    val chatId: String,
    val turnId: String? = null,
    /** Newest-first public turn references; raw private run ids never appear. */
    val previousTurns: List<AidenChatPreviousTurn> = emptyList(),
    val availability: AidenChatProgressAvailability,
    val unavailableReason: AidenChatAgentUnavailableReason? = null,
    val epoch: String,
    val revision: Long,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val agents: List<AidenChatAgent>
)

/** Strict decoder for the progress DTOs. Unknown fields are rejected. */
object AidenChatProgressCodec {
    private val json = Json {
        ignoreUnknownKeys = false
        explicitNulls = true
    }

    private val identifierPattern = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val epochPattern = Regex("^[A-Za-z0-9._:-]{1,64}$")
    private val roles = setOf("scout", "planner", "reviewer")
    private val taskStatuses = setOf("pending", "in_progress", "completed", "deleted")
    private val agentStates = setOf(
        "queued", "starting", "running", "needs_attention", "completed", "failed",
        "timed_out", "interrupted", "stopped", "unknown"
    )
    private val milestones = setOf("reading", "listing", "matching", "searching", "inspecting", "composing")
    private val notices = setOf("task_truncated", "report_truncated", "display_filtered")
    private val terminalStates = setOf("completed", "failed", "timed_out", "interrupted", "stopped", "unknown")

    fun decodeTaskProgress(bytes: ByteArray): AidenChatTaskProgress {
        validateWire(bytes)
        return parseTaskProgress(parseObject(bytes, "task progress"), "task progress")
    }

    fun decodeAgentRoster(bytes: ByteArray): AidenChatAgentRoster {
        validateWire(bytes)
        return parseAgentRoster(parseObject(bytes, "agent roster"), "agent roster")
    }

    fun parseTaskProgress(element: JsonElement, label: String = "Chat task progress"): AidenChatTaskProgress {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("version", "chatId", "availability", "unavailableReason", "epoch", "revision", "updatedAt", "tasks"), label)
        requireField(obj, "version", label).asNumber(label, "version").also {
            if (it != 1L) invalid("$label version")
        }
        val chatId = obj.requiredString("chatId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        val availability = obj.requiredString("availability", label, 16)
        if (availability !in setOf("ready", "unavailable")) invalid("$label availability")
        val epoch = obj.requiredIdentifier("epoch", label, epochPattern, AidenRemoteProtocol.CHAT_PROGRESS_EPOCH_MAX_LENGTH)
        val revision = obj.requiredPositiveLong("revision", label)
        val updatedAt = obj.requiredInstant("updatedAt", label)
        val taskArray = obj.requiredArray("tasks", label)
        if (taskArray.size > AidenRemoteProtocol.MAX_CHAT_TASKS) invalid("$label tasks")
        val tasks = taskArray.mapIndexed { index, value -> parseTask(value, "$label.tasks[$index]") }
        val taskIds = tasks.map { it.id }.toSet()
        if (taskIds.size != tasks.size) invalid("$label task ids")
        if (tasks.count { it.status == AidenChatTaskStatus.IN_PROGRESS } > 1) invalid("$label in_progress tasks")
        tasks.forEach { task ->
            task.blockedBy.orEmpty().forEach { dependency ->
                if (dependency == task.id || dependency !in taskIds) invalid("$label blockedBy")
            }
        }
        // Dependencies are a displayable plan, so reject cycles instead of
        // allowing a malicious snapshot to claim impossible progress.
        val dependencies = tasks.associate { it.id to it.blockedBy.orEmpty() }
        val visiting = mutableSetOf<Long>()
        val visited = mutableSetOf<Long>()
        fun visit(id: Long): Boolean {
            if (id in visiting) return false
            if (id in visited) return true
            visiting.add(id)
            val valid = dependencies[id].orEmpty().all(::visit)
            visiting.remove(id)
            if (valid) visited.add(id)
            return valid
        }
        if (dependencies.keys.any { !visit(it) }) invalid("$label blockedBy cycle")

        val reasonPresent = obj.containsKey("unavailableReason")
        val reason = if (reasonPresent) {
            obj.requiredString("unavailableReason", label, 32).let { raw ->
                when (raw) {
                    "storage_not_enabled" -> AidenChatTaskUnavailableReason.STORAGE_NOT_ENABLED
                    "invalid_snapshot" -> AidenChatTaskUnavailableReason.INVALID_SNAPSHOT
                    "unsupported" -> AidenChatTaskUnavailableReason.UNSUPPORTED
                    else -> invalid("$label unavailableReason")
                }
            }
        } else null
        if (availability == "ready" && (reasonPresent || reason != null)) invalid("$label unavailableReason")
        if (availability == "unavailable" && (reason == null || tasks.isNotEmpty())) invalid("$label unavailable state")
        return AidenChatTaskProgress(
            version = 1,
            chatId = chatId,
            availability = if (availability == "ready") AidenChatProgressAvailability.READY else AidenChatProgressAvailability.UNAVAILABLE,
            unavailableReason = reason,
            epoch = epoch,
            revision = revision,
            updatedAt = updatedAt,
            tasks = tasks
        )
    }

    fun parseAgentRoster(element: JsonElement, label: String = "Chat agent roster"): AidenChatAgentRoster {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("version", "chatId", "turnId", "previousTurns", "availability", "unavailableReason", "epoch", "revision", "updatedAt", "agents"), label)
        if (requireField(obj, "version", label).asNumber(label, "version") != 1L) invalid("$label version")
        val chatId = obj.requiredString("chatId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        val turnId = obj.optionalIdentifier("turnId", label)
        val previousTurns = obj.optionalPreviousTurns("previousTurns", label, turnId)
        val availability = obj.requiredString("availability", label, 16)
        if (availability !in setOf("ready", "unavailable")) invalid("$label availability")
        val epoch = obj.requiredIdentifier("epoch", label, epochPattern, AidenRemoteProtocol.CHAT_PROGRESS_EPOCH_MAX_LENGTH)
        val revision = obj.requiredPositiveLong("revision", label)
        val updatedAt = obj.requiredInstant("updatedAt", label)
        val agentArray = obj.requiredArray("agents", label)
        if (agentArray.size > AidenRemoteProtocol.MAX_CHAT_AGENTS) invalid("$label agents")
        val agents = agentArray.mapIndexed { index, value -> parseAgent(value, "$label.agents[$index]") }
        val agentIds = agents.map { it.agentId }.toSet()
        if (agentIds.size != agents.size) invalid("$label agent ids")
        agents.forEach { agent ->
            if (agent.parentAgentId != null && agent.parentAgentId !in agentIds) invalid("$label parentAgentId")
        }
        val reasonPresent = obj.containsKey("unavailableReason")
        val reason = if (reasonPresent) {
            when (obj.requiredString("unavailableReason", label, 32)) {
                "unsupported" -> AidenChatAgentUnavailableReason.UNSUPPORTED
                "invalid_snapshot" -> AidenChatAgentUnavailableReason.INVALID_SNAPSHOT
                else -> invalid("$label unavailableReason")
            }
        } else null
        if (availability == "ready" && reasonPresent) invalid("$label unavailableReason")
        if (availability == "ready" && agents.isNotEmpty() && turnId == null) invalid("$label turnId")
        if (availability == "unavailable" && (reason == null || agents.isNotEmpty())) invalid("$label unavailable state")
        return AidenChatAgentRoster(
            version = 1,
            chatId = chatId,
            turnId = turnId,
            previousTurns = previousTurns,
            availability = if (availability == "ready") AidenChatProgressAvailability.READY else AidenChatProgressAvailability.UNAVAILABLE,
            unavailableReason = reason,
            epoch = epoch,
            revision = revision,
            updatedAt = updatedAt,
            agents = agents
        )
    }

    private fun parseTask(element: JsonElement, label: String): AidenChatTask {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("id", "subject", "status", "activeForm", "blockedBy"), label)
        val id = obj.requiredPositiveLong("id", label)
        val subject = obj.requiredString("subject", label, AidenRemoteProtocol.MAX_CHAT_TASK_SUBJECT_LENGTH)
        val statusRaw = obj.requiredString("status", label, 32)
        if (statusRaw !in taskStatuses) invalid("$label status")
        val activeForm = obj.optionalString("activeForm", label, AidenRemoteProtocol.MAX_CHAT_TASK_ACTIVE_FORM_LENGTH)
        val blockedBy = obj.optionalLongArray("blockedBy", label, AidenRemoteProtocol.MAX_CHAT_TASKS)
        if (blockedBy != null && blockedBy.toSet().size != blockedBy.size) invalid("$label blockedBy")
        return AidenChatTask(
            id = id,
            subject = subject,
            status = when (statusRaw) {
                "pending" -> AidenChatTaskStatus.PENDING
                "in_progress" -> AidenChatTaskStatus.IN_PROGRESS
                "completed" -> AidenChatTaskStatus.COMPLETED
                else -> AidenChatTaskStatus.DELETED
            },
            activeForm = activeForm,
            blockedBy = blockedBy
        )
    }

    private fun parseAgent(element: JsonElement, label: String): AidenChatAgent {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("agentId", "parentAgentId", "depth", "revision", "role", "label", "taskPreview", "state", "activity", "startedAt", "updatedAt", "finishedAt", "modelId", "turns", "tools", "tokens", "milestones", "notices", "error", "warnings"), label)
        val agentId = obj.requiredIdentifier("agentId", label, identifierPattern, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        val parentAgentId = obj.optionalIdentifier("parentAgentId", label)
        val depth = obj.requiredInt("depth", label)
        if (depth !in 1..AidenRemoteProtocol.MAX_CHAT_AGENT_DEPTH || ((depth >= 2) != (parentAgentId != null))) invalid("$label depth/parentAgentId")
        if (parentAgentId == agentId) invalid("$label parentAgentId")
        val revision = obj.requiredPositiveLong("revision", label)
        val roleRaw = obj.requiredString("role", label, 32)
        if (roleRaw !in roles) invalid("$label role")
        val agentLabel = obj.requiredString("label", label, AidenRemoteProtocol.MAX_CHAT_AGENT_LABEL_LENGTH)
        val taskPreview = obj.requiredString("taskPreview", label, AidenRemoteProtocol.MAX_CHAT_AGENT_TASK_PREVIEW_LENGTH)
        val stateRaw = obj.requiredString("state", label, 32)
        if (stateRaw !in agentStates) invalid("$label state")
        val activity = obj.optionalString("activity", label, AidenRemoteProtocol.MAX_CHAT_AGENT_ACTIVITY_LENGTH)
        val startedAt = obj.requiredInstant("startedAt", label)
        val updatedAt = obj.requiredInstant("updatedAt", label)
        if (updatedAt.isBefore(startedAt)) invalid("$label updatedAt")
        val finishedAt = obj.optionalInstant("finishedAt", label)
        if (finishedAt != null && finishedAt.isBefore(startedAt)) invalid("$label finishedAt")
        val modelId = obj.requiredString("modelId", label, AidenRemoteProtocol.MAX_CHAT_AGENT_MODEL_ID_LENGTH)
        val turns = obj.requiredNonNegativeLong("turns", label)
        val tools = obj.requiredNonNegativeLong("tools", label)
        val tokens = obj.requiredNonNegativeLong("tokens", label)
        val parsedMilestones = obj.optionalEnumArray("milestones", label, milestones, AidenRemoteProtocol.MAX_CHAT_AGENT_MILESTONES)?.map {
            when (it) {
                "reading" -> AidenChatAgentMilestone.READING
                "listing" -> AidenChatAgentMilestone.LISTING
                "matching" -> AidenChatAgentMilestone.MATCHING
                "searching" -> AidenChatAgentMilestone.SEARCHING
                "inspecting" -> AidenChatAgentMilestone.INSPECTING
                else -> AidenChatAgentMilestone.COMPOSING
            }
        }
        val parsedNotices = obj.optionalEnumArray("notices", label, notices, AidenRemoteProtocol.MAX_CHAT_AGENT_NOTICES)?.map {
            when (it) {
                "task_truncated" -> AidenChatAgentNotice.TASK_TRUNCATED
                "report_truncated" -> AidenChatAgentNotice.REPORT_TRUNCATED
                else -> AidenChatAgentNotice.DISPLAY_FILTERED
            }
        }
        val error = obj.optionalString("error", label, AidenRemoteProtocol.MAX_CHAT_AGENT_ERROR_LENGTH)
        val warnings = obj.optionalStringArray("warnings", label, AidenRemoteProtocol.MAX_CHAT_AGENT_WARNINGS, AidenRemoteProtocol.MAX_CHAT_AGENT_WARNING_LENGTH)
        val terminal = stateRaw in terminalStates
        if (terminal != (finishedAt != null)) invalid("$label finishedAt")
        if (!terminal && (error != null || !warnings.isNullOrEmpty())) invalid("$label terminal fields")
        if (!terminal && parsedNotices?.contains(AidenChatAgentNotice.REPORT_TRUNCATED) == true) invalid("$label notices")
        return AidenChatAgent(
            agentId = agentId,
            parentAgentId = parentAgentId,
            depth = depth,
            revision = revision,
            role = when (roleRaw) {
                "scout" -> AidenChatAgentRole.SCOUT
                "planner" -> AidenChatAgentRole.PLANNER
                else -> AidenChatAgentRole.REVIEWER
            },
            label = agentLabel,
            taskPreview = taskPreview,
            state = when (stateRaw) {
                "queued" -> AidenChatAgentState.QUEUED
                "starting" -> AidenChatAgentState.STARTING
                "running" -> AidenChatAgentState.RUNNING
                "needs_attention" -> AidenChatAgentState.NEEDS_ATTENTION
                "completed" -> AidenChatAgentState.COMPLETED
                "failed" -> AidenChatAgentState.FAILED
                "timed_out" -> AidenChatAgentState.TIMED_OUT
                "interrupted" -> AidenChatAgentState.INTERRUPTED
                "stopped" -> AidenChatAgentState.STOPPED
                else -> AidenChatAgentState.UNKNOWN
            },
            activity = activity,
            startedAt = startedAt,
            updatedAt = updatedAt,
            finishedAt = finishedAt,
            modelId = modelId,
            turns = turns,
            tools = tools,
            tokens = tokens,
            milestones = parsedMilestones,
            notices = parsedNotices,
            error = error,
            warnings = warnings
        )
    }

    private fun validateWire(bytes: ByteArray) {
        if (bytes.size > AidenRemoteProtocol.MAX_JSON_BODY_BYTES) throw AidenRemoteContractException.PayloadTooLarge
        AidenRawJsonDuplicateKeyScanner.validate(bytes)
        AidenBotPrivateResponseValidator.validate(bytes, AidenBotPrivateResponseScope.ChatProgressProjection)
    }

    private fun parseObject(bytes: ByteArray, label: String): JsonObject = try {
        val element = json.parseToJsonElement(String(bytes, Charsets.UTF_8))
        element.asObject(label)
    } catch (error: AidenRemoteContractException) {
        throw error
    } catch (_: Exception) {
        throw AidenRemoteContractException.InvalidJson("Invalid $label JSON")
    }

    private fun JsonElement.asObject(label: String): JsonObject = this as? JsonObject
        ?: invalid("$label must be an object")

    private fun requireField(obj: JsonObject, key: String, label: String): JsonElement = obj[key]
        ?: invalid("$label missing $key")

    private fun assertExactKeys(obj: JsonObject, allowed: Set<String>, label: String) {
        val unsupported = obj.keys.firstOrNull { it !in allowed }
        if (unsupported != null) invalid("$label field $unsupported")
    }

    private fun JsonElement.asNumber(label: String, field: String): Long {
        val primitive = this as? JsonPrimitive ?: invalid("$label $field")
        if (primitive.isString) invalid("$label $field")
        return primitive.longOrNull ?: invalid("$label $field")
    }

    private fun JsonObject.requiredString(key: String, label: String, maxLength: Int): String {
        val primitive = requireField(this, key, label) as? JsonPrimitive ?: invalid("$label $key")
        if (!primitive.isString) invalid("$label $key")
        val value = primitive.content
        if (value.isEmpty() || value.codePointCount(0, value.length) > maxLength) invalid("$label $key")
        return value
    }

    private fun JsonObject.optionalString(key: String, label: String, maxLength: Int): String? {
        if (!containsKey(key)) return null
        return requiredString(key, label, maxLength)
    }

    private fun JsonObject.requiredIdentifier(key: String, label: String, pattern: Regex, maxLength: Int): String {
        val value = requiredString(key, label, maxLength)
        if (!pattern.matches(value)) invalid("$label $key")
        return value
    }

    private fun JsonObject.optionalIdentifier(key: String, label: String): String? {
        if (!containsKey(key)) return null
        val primitive = getValue(key) as? JsonPrimitive ?: invalid("$label $key")
        if (!primitive.isString || primitive.content.isEmpty() || !identifierPattern.matches(primitive.content)) invalid("$label $key")
        return primitive.content
    }

    private fun JsonObject.optionalPreviousTurns(
        key: String,
        label: String,
        currentTurnId: String?
    ): List<AidenChatPreviousTurn> {
        if (!containsKey(key)) return emptyList()
        val array = requiredArray(key, label)
        if (array.size > AidenRemoteProtocol.MAX_CHAT_PREVIOUS_TURNS) invalid("$label $key")
        val turns = array.mapIndexed { index, value ->
            val turnLabel = "$label.$key[$index]"
            val turn = value as? JsonObject ?: invalid(turnLabel)
            assertExactKeys(turn, setOf("turnId", "startedAt"), turnLabel)
            AidenChatPreviousTurn(
                turnId = turn.requiredIdentifier("turnId", turnLabel, identifierPattern, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
                startedAt = turn.requiredInstant("startedAt", turnLabel)
            )
        }
        if (turns.map { it.turnId }.toSet().size != turns.size) invalid("$label $key")
        if (currentTurnId != null && turns.any { it.turnId == currentTurnId }) invalid("$label $key")
        if (turns.zipWithNext().any { (newer, older) -> newer.startedAt.isBefore(older.startedAt) }) {
            invalid("$label $key")
        }
        return turns
    }

    private fun JsonObject.requiredPositiveLong(key: String, label: String): Long {
        val value = requireField(this, key, label).asNumber(label, key)
        if (value !in 1..AidenRemoteProtocol.MAX_SAFE_INTEGER) invalid("$label $key")
        return value
    }

    private fun JsonObject.requiredNonNegativeLong(key: String, label: String): Long {
        val value = requireField(this, key, label).asNumber(label, key)
        if (value !in 0..AidenRemoteProtocol.MAX_SAFE_INTEGER) invalid("$label $key")
        return value
    }

    private fun JsonObject.requiredInt(key: String, label: String): Int {
        val value = requireField(this, key, label).asNumber(label, key)
        if (value !in Int.MIN_VALUE..Int.MAX_VALUE) invalid("$label $key")
        return value.toInt()
    }

    private fun JsonObject.requiredInstant(key: String, label: String): Instant {
        val value = requiredString(key, label, 80)
        return try {
            Instant.parse(value)
        } catch (_: Exception) {
            invalid("$label $key")
        }
    }

    private fun JsonObject.optionalInstant(key: String, label: String): Instant? {
        if (!containsKey(key)) return null
        return requiredInstant(key, label)
    }

    private fun JsonObject.requiredArray(key: String, label: String): JsonArray = requireField(this, key, label) as? JsonArray
        ?: invalid("$label $key")

    private fun JsonObject.optionalLongArray(key: String, label: String, maxItems: Int): List<Long>? {
        if (!containsKey(key)) return null
        val array = requiredArray(key, label)
        if (array.size > maxItems) invalid("$label $key")
        return array.map { value ->
            val result = value.asNumber(label, key)
            if (result < 1 || result > AidenRemoteProtocol.MAX_SAFE_INTEGER) invalid("$label $key")
            result
        }
    }

    private fun JsonObject.optionalStringArray(key: String, label: String, maxItems: Int, maxLength: Int): List<String>? {
        if (!containsKey(key)) return null
        val array = requiredArray(key, label)
        if (array.size > maxItems) invalid("$label $key")
        return array.map { value ->
            val primitive = value as? JsonPrimitive ?: invalid("$label $key")
            if (!primitive.isString || primitive.content.isEmpty() || primitive.content.codePointCount(0, primitive.content.length) > maxLength) invalid("$label $key")
            primitive.content
        }
    }

    private fun JsonObject.optionalEnumArray(key: String, label: String, allowed: Set<String>, maxItems: Int): List<String>? {
        val values = optionalStringArray(key, label, maxItems, 40) ?: return null
        if (values.toSet().size != values.size || values.any { it !in allowed }) invalid("$label $key")
        return values
    }

    private fun invalid(field: String): Nothing = throw AidenRemoteContractException.UnsafePayloadField(field)
}
