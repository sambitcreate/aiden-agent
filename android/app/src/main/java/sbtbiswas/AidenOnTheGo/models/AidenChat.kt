package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID

@Serializable
enum class AidenChatRole {
    @SerialName("user") USER,
    @SerialName("assistant") ASSISTANT
}

@Serializable
enum class AidenAttachmentKind {
    @SerialName("image") IMAGE,
    @SerialName("text") TEXT
}

@Serializable
data class AidenMessageAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val kind: AidenAttachmentKind,
    val size: Int
) {
    val isWireSafe: Boolean
        get() = id.isNotEmpty() &&
                id.length <= 256 &&
                id.all { c -> c in '0'..'9' || c in 'A'..'Z' || c in 'a'..'z' || c == '-' || c == '.' || c == ':' || c == '_' } &&
                name.isNotEmpty() &&
                name.length <= 255 &&
                name.all { c -> c.code > 0x1f && c.code != 0x7f && c != '/' && c != '\\' } &&
                mimeType.isNotEmpty() &&
                mimeType.length <= 120 &&
                size in 0..AidenRemoteProtocol.MAX_SAFE_INTEGER
}

@Serializable
sealed interface AidenAttachmentUpload {
    val name: String
    val mimeType: String
    val kind: AidenAttachmentKind

    @Serializable
    @SerialName("image")
    data class Image(
        override val name: String,
        override val mimeType: String,
        val data: String,
        override val kind: AidenAttachmentKind = AidenAttachmentKind.IMAGE
    ) : AidenAttachmentUpload

    @Serializable
    @SerialName("text")
    data class Text(
        override val name: String,
        override val mimeType: String,
        val text: String,
        override val kind: AidenAttachmentKind = AidenAttachmentKind.TEXT
    ) : AidenAttachmentUpload
}

typealias AidenMessageAttachmentUpload = AidenAttachmentUpload

object AidenAttachmentImageValidation {
    const val MAXIMUM_BYTES = 8 * 1_048_576
    const val MAXIMUM_DIMENSION = 16_384
    const val MAXIMUM_PIXELS = 40_000_000L

    fun validatedData(
        data: ByteArray,
        mimeType: String,
        declaredSize: Int? = null
    ): ByteArray? {
        if (data.isEmpty() || data.size > MAXIMUM_BYTES) return null
        if (declaredSize != null && declaredSize != data.size) return null
        if (!hasMatchingSignature(data, mimeType)) return null

        val (width, height) = readImageDimensions(data, mimeType) ?: return null
        if (width <= 0 || height <= 0 || width > MAXIMUM_DIMENSION || height > MAXIMUM_DIMENSION) return null
        if (width.toLong() * height.toLong() > MAXIMUM_PIXELS) return null
        return data
    }

    private fun hasMatchingSignature(data: ByteArray, mimeType: String): Boolean {
        return when (mimeType.lowercase()) {
            "image/png" -> {
                if (data.size < 20) return false
                val header = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
                val trailer = byteArrayOf(0, 0, 0, 0, 73, 69, 78, 68, 174.toByte(), 66, 96, 130.toByte())
                for (i in 0..7) if (data[i] != header[i]) return false
                val start = data.size - 12
                for (i in 0..11) if (data[start + i] != trailer[i]) return false
                true
            }
            "image/jpeg" -> {
                if (data.size < 4) return false
                val headerMatch = (data[0] == 0xFF.toByte() && data[1] == 0xD8.toByte() && data[2] == 0xFF.toByte())
                val trailerMatch = (data[data.size - 2] == 0xFF.toByte() && data[data.size - 1] == 0xD9.toByte())
                headerMatch && trailerMatch
            }
            else -> false
        }
    }

    private fun readImageDimensions(data: ByteArray, mimeType: String): Pair<Int, Int>? {
        if (mimeType.equals("image/png", ignoreCase = true)) {
            if (data.size < 24) return null
            val ihdr = byteArrayOf(73, 72, 68, 82)
            for (i in 0..3) if (data[12 + i] != ihdr[i]) return null
            fun dimension(offset: Int): Int {
                return ((data[offset].toInt() and 0xFF) shl 24) or
                        ((data[offset + 1].toInt() and 0xFF) shl 16) or
                        ((data[offset + 2].toInt() and 0xFF) shl 8) or
                        (data[offset + 3].toInt() and 0xFF)
            }
            return Pair(dimension(16), dimension(20))
        } else if (mimeType.equals("image/jpeg", ignoreCase = true)) {
            var offset = 2
            while (offset + 8 < data.size) {
                if (data[offset] != 0xFF.toByte()) {
                    offset++
                    continue
                }
                val marker = data[offset + 1].toInt() and 0xFF
                if (marker == 0xC0 || marker == 0xC1 || marker == 0xC2) {
                    val height = ((data[offset + 5].toInt() and 0xFF) shl 8) or (data[offset + 6].toInt() and 0xFF)
                    val width = ((data[offset + 7].toInt() and 0xFF) shl 8) or (data[offset + 8].toInt() and 0xFF)
                    return Pair(width, height)
                }
                val length = ((data[offset + 2].toInt() and 0xFF) shl 8) or (data[offset + 3].toInt() and 0xFF)
                offset += 2 + length
            }
            return null
        }
        return null
    }
}

@Serializable
enum class AidenMessageOutcomeStatus {
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED
}

@Serializable
data class AidenMessageOutcome(
    val status: AidenMessageOutcomeStatus,
    val category: String? = null,
    val attempts: Int? = null,
    val retryExhausted: Boolean? = null
) {
    val isWireSafe: Boolean
        get() = (category == null || CATEGORIES.contains(category)) &&
                (attempts == null || attempts in 0..16)

    companion object {
        val CATEGORIES = setOf(
            "network", "timeout", "service_unavailable", "rate_limit", "authentication", "quota",
            "invalid_request", "context_window", "output_limit", "interrupted", "context_management",
            "unknown"
        )
    }
}

@Serializable
enum class AidenAgentStepStatus {
    @SerialName("pending") PENDING,
    @SerialName("awaiting_approval") AWAITING_APPROVAL,
    @SerialName("running") RUNNING,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
    @SerialName("blocked") BLOCKED,
    @SerialName("cancelled") CANCELLED;

    val isActive: Boolean
        get() = this == PENDING || this == AWAITING_APPROVAL || this == RUNNING

    val isIssue: Boolean
        get() = this == FAILED || this == BLOCKED || this == CANCELLED
}

@Serializable
data class AidenAgentLineChanges(
    val additions: Int,
    val deletions: Int
)

@Serializable
data class AidenAgentStep(
    val id: String,
    val order: Int,
    val kind: Kind,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val label: String? = null,
    val status: AidenAgentStepStatus? = null,
    val startedAt: Double,
    val updatedAt: Double,
    val finishedAt: Double? = null,
    val contentOffset: Int? = null,
    val durationMs: Double? = null,
    val target: String? = null,
    val detail: String? = null,
    val lineChanges: AidenAgentLineChanges? = null
) {
    @Serializable
    enum class Kind {
        @SerialName("tool") TOOL,
        @SerialName("thinking") THINKING
    }

    val isActive: Boolean
        get() = if (kind == Kind.THINKING) finishedAt == null else status?.isActive == true
}

@Serializable
enum class AidenGenerationTimelineStatus {
    @SerialName("running") RUNNING,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED
}

@Serializable
enum class AidenGenerationCancellationOrigin {
    @SerialName("user_stop") USER_STOP,
    @SerialName("chat_deletion") CHAT_DELETION,
    @SerialName("workspace_authority_change") WORKSPACE_AUTHORITY_CHANGE,
    @SerialName("computer_use_disabled") COMPUTER_USE_DISABLED,
    @SerialName("scheduled_task_cancel") SCHEDULED_TASK_CANCEL,
    @SerialName("application_shutdown") APPLICATION_SHUTDOWN
}

@Serializable
data class AidenGenerationClaimCheck(
    val kind: Kind,
    val stepIds: List<String>
) {
    @Serializable
    enum class Kind {
        @SerialName("unverified_success") UNVERIFIED_SUCCESS
    }
}

@Serializable
data class AidenGenerationTimeline(
    val version: Int,
    val generationId: String,
    val status: AidenGenerationTimelineStatus,
    val startedAt: Double,
    val finishedAt: Double? = null,
    val steps: List<AidenAgentStep>,
    val cancellationOrigin: AidenGenerationCancellationOrigin? = null,
    val claimCheck: AidenGenerationClaimCheck? = null
) {
    val issueCount: Int
        get() = steps.count { it.kind == AidenAgentStep.Kind.TOOL && it.status?.isIssue == true }

    fun isRendererSafe(contentLength: Int? = null): Boolean {
        if (version !in 1..3 || generationId.isEmpty() || generationId.length > 128 ||
            !isSafeIdentifier(generationId) || steps.size > 200 ||
            !startedAt.isFinite() || startedAt < 0 ||
            (finishedAt != null && (!finishedAt.isFinite() || finishedAt < 0)) ||
            (cancellationOrigin != null && status != AidenGenerationTimelineStatus.CANCELLED)
        ) return false

        var previousOffset = 0
        for ((index, step) in steps.withIndex()) {
            if (step.order != index || step.order !in 0..199 ||
                !step.startedAt.isFinite() || !step.updatedAt.isFinite() ||
                step.startedAt < 0 || step.updatedAt < 0 ||
                (step.finishedAt != null && (!step.finishedAt.isFinite() || step.finishedAt < 0)) ||
                (step.contentOffset != null && (step.contentOffset < 0 || step.contentOffset > AidenRemoteProtocol.MAX_SAFE_INTEGER)) ||
                (step.durationMs != null && (!step.durationMs.isFinite() || step.durationMs < 0)) ||
                (step.label != null && (step.label.isEmpty() || step.label.length > 120)) ||
                (step.toolName != null && (step.toolName.isEmpty() || step.toolName.length > 80)) ||
                (step.detail != null && (step.detail.isEmpty() || step.detail.length > 120 || step.detail.any { it.code < 32 || it.code == 127 })) ||
                (step.target != null && !isValidTarget(step.target)) ||
                (step.lineChanges != null && (
                    version != 3 ||
                    step.kind != AidenAgentStep.Kind.TOOL ||
                    (step.toolName != "write_file" && step.toolName != "edit_file") ||
                    step.status != AidenAgentStepStatus.COMPLETED ||
                    step.lineChanges.additions !in 0..100_000_000 ||
                    step.lineChanges.deletions !in 0..100_000_000
                ))
            ) return false

            if (version == 3) {
                val offset = step.contentOffset ?: return false
                if (offset < previousOffset || (contentLength != null && offset > contentLength)) return false
                previousOffset = offset
            }

            when (step.kind) {
                AidenAgentStep.Kind.TOOL -> {
                    if (!step.id.matches(Regex("^tool-[1-9][0-9]*$")) || step.id.length > 128 ||
                        step.toolCallId == null || step.toolCallId.length > 128 ||
                        !step.toolCallId.matches(Regex("^call-[1-9][0-9]*$")) ||
                        step.toolName == null || step.label == null || step.status == null
                    ) return false
                }
                AidenAgentStep.Kind.THINKING -> {
                    if (version == 1 || step.id.length > 128 || !step.id.matches(Regex("^think-[1-9][0-9]*$"))) {
                        return false
                    }
                }
            }
        }

        if (claimCheck != null) {
            val issueStepIDs = steps.filter { it.kind == AidenAgentStep.Kind.TOOL && it.status?.isIssue == true }
                .map { it.id }.toSet()
            if (status == AidenGenerationTimelineStatus.RUNNING ||
                claimCheck.stepIds.size !in 1..20 ||
                claimCheck.stepIds.toSet().size != claimCheck.stepIds.size ||
                !claimCheck.stepIds.all { issueStepIDs.contains(it) }
            ) return false
        }

        return true
    }

    private fun isValidTarget(target: String): Boolean {
        if (target.isEmpty() || target.length > 240) return false
        val normalized = target.replace('\\', '/')
        val hasDrivePrefix = normalized.length >= 3 && normalized[1] == ':' && normalized[0].isLetter() && normalized[2] == '/'
        return !normalized.startsWith("/") && !normalized.startsWith("~") && !hasDrivePrefix && !normalized.split("/").contains("..")
    }

    private fun isSafeIdentifier(value: String): Boolean {
        return value.all { c -> c in '0'..'9' || c in 'A'..'Z' || c in 'a'..'z' || c == '-' || c == '.' || c == ':' || c == '_' }
    }
}

object AidenAgentActivityPresentation {
    const val RENDER_ARTIFACT_TOOL_NAME = "render_artifact"

    private val verbs = mapOf(
        "read_file" to Pair("Reading", "Read"),
        "list_dir" to Pair("Listing", "Listed"),
        "glob" to Pair("Searching files", "Searched files"),
        "grep" to Pair("Grepping", "Grepped"),
        "write_file" to Pair("Writing", "Wrote"),
        "edit_file" to Pair("Editing", "Edited"),
        "run_command" to Pair("Running", "Ran"),
        "web_search" to Pair("Searching the web", "Searched the web"),
        "schedule_task" to Pair("Scheduling", "Scheduled"),
        "edit_automation" to Pair("Editing automation", "Edited automation"),
        "computer_use" to Pair("Using Mac", "Used Mac"),
        "compact_context" to Pair("Compacting context", "Compacted context")
    )

    fun duration(milliseconds: Double?): String {
        if (milliseconds == null || milliseconds < 2_000.0) return "briefly"
        val seconds = Math.round(milliseconds / 1_000.0).toInt()
        if (seconds < 60) return "for ${seconds}s"
        val minutes = seconds / 60
        val remainder = seconds % 60
        return if (remainder == 0) "for ${minutes}m" else "for ${minutes}m ${remainder}s"
    }

    fun hasActiveThinkingStep(timeline: AidenGenerationTimeline?): Boolean {
        if (timeline == null || timeline.status != AidenGenerationTimelineStatus.RUNNING) return false
        for (step in timeline.steps.asReversed()) {
            if (step.kind == AidenAgentStep.Kind.TOOL) return false
            return step.finishedAt == null
        }
        return false
    }

    fun hasActiveToolStep(timeline: AidenGenerationTimeline?, toolName: String): Boolean {
        if (timeline == null || timeline.status != AidenGenerationTimelineStatus.RUNNING) return false
        return timeline.steps.any { step ->
            step.kind == AidenAgentStep.Kind.TOOL && step.toolName == toolName && step.status?.isActive == true
        }
    }

    fun reasoningLabel(timeline: AidenGenerationTimeline?, active: Boolean): String {
        if (active) return "Thinking"
        val durationMs = timeline?.steps
            ?.filter { it.kind == AidenAgentStep.Kind.THINKING }
            ?.mapNotNull { it.durationMs }
            ?.sum()
            ?.takeIf { it > 0.0 }
        return "Thought ${duration(durationMs)}"
    }

    fun visualizingLabel(timeline: AidenGenerationTimeline?): String? {
        return if (hasActiveToolStep(timeline, RENDER_ARTIFACT_TOOL_NAME)) "Visualizing" else null
    }

    fun line(step: AidenAgentStep): String {
        if (step.kind == AidenAgentStep.Kind.THINKING) {
            return if (step.isActive) "Thinking" else "Thought ${duration(step.durationMs)}"
        }
        val label = step.label ?: "Tool"
        val pair = verbs[step.toolName ?: ""]
        val verb = when (step.status) {
            AidenAgentStepStatus.PENDING, AidenAgentStepStatus.RUNNING -> pair?.first ?: label
            AidenAgentStepStatus.COMPLETED -> pair?.second ?: label
            AidenAgentStepStatus.AWAITING_APPROVAL -> "$label needs approval"
            AidenAgentStepStatus.FAILED -> "$label failed"
            AidenAgentStepStatus.BLOCKED -> "$label denied"
            AidenAgentStepStatus.CANCELLED -> "$label cancelled"
            null -> label
        }
        val obj: String? = if (step.toolName == "grep" && step.detail != null && step.target != null) {
            "${step.detail} in ${step.target}"
        } else {
            step.detail ?: step.target
        }
        return if (obj != null) "$verb $obj" else verb
    }

    fun summary(timeline: AidenGenerationTimeline): String {
        val tools = timeline.steps.filter { it.kind == AidenAgentStep.Kind.TOOL }
        if (tools.isEmpty()) {
            return if (timeline.status == AidenGenerationTimelineStatus.RUNNING) "Thinking"
            else "Thought ${duration(timeline.steps.mapNotNull { it.durationMs }.sum())}"
        }
        val running = timeline.status == AidenGenerationTimelineStatus.RUNNING
        val files = tools.count { it.toolName == "read_file" }
        val searches = tools.count { it.toolName == "grep" || it.toolName == "glob" }
        val directories = tools.count { it.toolName == "list_dir" }
        val commands = tools.count { it.toolName == "run_command" }
        val changes = tools.count { it.toolName == "write_file" || it.toolName == "edit_file" }
        val web = tools.count { it.toolName == "web_search" }
        val mac = tools.count { it.toolName == "computer_use" }
        val compactions = tools.count { it.toolName == "compact_context" }
        val tallied = setOf(
            "read_file", "grep", "glob", "list_dir", "run_command", "write_file", "edit_file",
            "web_search", "computer_use", "compact_context"
        )
        val other = tools.count { step ->
            val toolName = step.toolName ?: return@count true
            !tallied.contains(toolName)
        }
        val clauses = mutableListOf<String>()
        val exploredList = listOfNotNull(
            if (files > 0) "$files file${if (files == 1) "" else "s"}" else null,
            if (searches > 0) "$searches search${if (searches == 1) "" else "es"}" else null,
            if (directories > 0) "$directories director${if (directories == 1) "y" else "ies"}" else null
        )
        if (exploredList.isNotEmpty()) {
            clauses.add("${if (running) "Exploring" else "Explored"} ${exploredList.joinToString(", ")}")
        }
        if (changes > 0) clauses.add("${if (running) "editing" else "edited"} $changes file${if (changes == 1) "" else "s"}")
        if (commands > 0) clauses.add("${if (running) "running" else "ran"} $commands command${if (commands == 1) "" else "s"}")
        if (web > 0) clauses.add("$web web search${if (web == 1) "" else "es"}")
        if (mac > 0) clauses.add("$mac Mac action${if (mac == 1) "" else "s"}")
        if (compactions > 0) clauses.add(if (running) "compacting context" else "compacted context")
        if (other > 0) clauses.add("$other tool call${if (other == 1) "" else "s"}")
        if (clauses.isEmpty()) return if (running) "Working" else "Used ${tools.size} tool${if (tools.size == 1) "" else "s"}"
        val sentence = clauses.joinToString(", ")
        return if (exploredList.isEmpty() && sentence.isNotEmpty()) {
            sentence.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
        } else {
            sentence
        }
    }
}

@Serializable
data class AidenChatMessage(
    val id: String,
    val role: AidenChatRole,
    val text: String,
    val attachments: List<AidenMessageAttachment>? = null,
    val htmlArtifacts: List<AidenHtmlArtifact>? = null,
    val outcome: AidenMessageOutcome? = null,
    val timeline: AidenGenerationTimeline? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant
) {
    val isWireSafe: Boolean
        get() = id.isNotEmpty() &&
                id.length <= AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH &&
                text.codePointCount(0, text.length) <= AidenRemoteProtocol.MAX_TEXT_LENGTH &&
                (attachments?.size ?: 0) <= 20 &&
                (attachments?.all { it.isWireSafe } ?: true) &&
                (htmlArtifacts?.size ?: 0) <= 40 &&
                (htmlArtifacts?.all { it.isWireSafe } ?: true) &&
                (outcome?.isWireSafe ?: true) &&
                (timeline?.isRendererSafe(text.length) ?: true)
}

@Serializable
data class AidenHtmlArtifact(
    val id: String,
    val title: String
) {
    val isWireSafe: Boolean
        get() = id.isNotEmpty() &&
                id.length <= 256 &&
                title.isNotEmpty() &&
                title.length <= 120
}

@Serializable
data class AidenChat(
    val id: String,
    var workspaceId: String,
    var botId: String? = null,
    var title: String,
    var providerId: String? = null,
    var modelId: String? = null,
    var messages: List<AidenChatMessage>,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) var updatedAt: Instant,
    var revision: String,
    var titlePending: Boolean? = null
) {
    val isBotChat: Boolean get() = botId != null
    val isTitlePending: Boolean get() = titlePending == true

    init {
        if (id.isEmpty() || id.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            workspaceId.isEmpty() || workspaceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            (botId != null && (botId!!.isEmpty() || botId!!.length > AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH || !isPathSafe(botId!!))) ||
            revision.isEmpty() || revision.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            title.length > 1_024 ||
            ((providerId == null) != (modelId == null)) ||
            (providerId != null && (providerId!!.isEmpty() || providerId!!.length > 256)) ||
            (modelId != null && (modelId!!.isEmpty() || modelId!!.length > 512)) ||
            messages.size > 10_000 ||
            !messages.all { it.isWireSafe } ||
            titlePending == false ||
            updatedAt.isBefore(createdAt)
        ) {
            throw AidenRemoteContractException.InvalidJson("Invalid Chat model")
        }
    }

    private fun isPathSafe(value: String): Boolean =
        value.all { c -> c in '0'..'9' || c in 'A'..'Z' || c in 'a'..'z' || c == '-' || c == '.' || c == ':' || c == '_' }

    companion object {
        fun regularWorkspaceChats(chats: List<AidenChat>): List<AidenChat> = chats.filter { !it.isBotChat }
    }
}

@Serializable
data class AidenModel(
    val id: String,
    val label: String,
    val supportsImages: Boolean? = null,
    val thinkingLevels: List<String>? = null,
    val defaultThinkingLevel: String? = null,
    val thinkingCanDisable: Boolean? = null,
    val hidden: Boolean? = null
) {
    val isHidden: Boolean get() = hidden == true
    val acceptsImageInput: Boolean get() = supportsImages != false

    val effectiveThinkingLevel: String?
        get() {
            if (thinkingLevels.isNullOrEmpty()) return null
            if (defaultThinkingLevel != null && thinkingLevels.contains(defaultThinkingLevel)) return defaultThinkingLevel
            if (thinkingLevels.contains("medium")) return "medium"
            if (thinkingLevels.contains("high")) return "high"
            if (thinkingLevels.contains("low")) return "low"
            if (thinkingLevels.contains("off")) return "off"
            return thinkingLevels.firstOrNull()
        }

    fun thinkingLabel(level: String): String {
        return if (level == "off" && thinkingCanDisable == false) "Hide" else level.replaceFirstChar { it.uppercase() }
    }
}

@Serializable
data class AidenProviderArtwork(
    val mimeType: String,
    val dataBase64: String
) {
    val boundedPNGData: ByteArray?
        get() {
            if (mimeType != "image/png" || dataBase64.length > 44_000) return null
            val bytes = try { Base64.getDecoder().decode(dataBase64) } catch (_: Exception) { return null }
            if (bytes.size > 32 * 1024 || bytes.size < 24) return null
            val pngHeader = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
            for (i in 0..7) if (bytes[i] != pngHeader[i]) return null
            val ihdr = byteArrayOf(73, 72, 68, 82)
            for (i in 0..3) if (bytes[12 + i] != ihdr[i]) return null
            fun dimension(offset: Int): Long {
                return ((bytes[offset].toLong() and 0xFF) shl 24) or
                        ((bytes[offset + 1].toLong() and 0xFF) shl 16) or
                        ((bytes[offset + 2].toLong() and 0xFF) shl 8) or
                        (bytes[offset + 3].toLong() and 0xFF)
            }
            val width = dimension(16)
            val height = dimension(20)
            if (width <= 0 || height <= 0 || width > 64 || height > 64) return null
            return bytes
        }
}

@Serializable
data class AidenProvider(
    val id: String,
    val label: String,
    val artwork: AidenProviderArtwork? = null,
    val models: List<AidenModel>
) {
    val visibleModels: List<AidenModel> get() = models.filter { !it.isHidden }
}

@Serializable
data class AidenModelCatalog(
    val providers: List<AidenProvider>,
    val defaults: Map<String, String> = emptyMap()
) {
    val visibleProviders: List<AidenProvider>
        get() = providers.mapNotNull { p ->
            val v = p.visibleModels
            if (v.isEmpty()) null else p.copy(models = v)
        }
}

@Serializable
data class AidenTurnStart(
    val text: String,
    val providerId: String? = null,
    val modelId: String? = null,
    val thinkingLevel: String? = null,
    val attachmentIds: List<String>? = null
)

@Serializable
data class AidenTurnStartResponse(
    val turnId: String,
    val streamId: String,
    val status: String,
    val message: AidenChatMessage
)

@Serializable
enum class AidenStreamState {
    @SerialName("queued") QUEUED,
    @SerialName("running") RUNNING,
    @SerialName("waiting_for_approval") WAITING_FOR_APPROVAL,
    @SerialName("reconciling") RECONCILING,
    @SerialName("done") DONE,
    @SerialName("error") ERROR,
    @SerialName("cancelled") CANCELLED,
    @SerialName("interrupted") INTERRUPTED;

    val isTerminal: Boolean
        get() = this == DONE || this == ERROR || this == CANCELLED || this == INTERRUPTED
}

@Serializable
data class AidenStreamStatus(
    val streamId: String,
    val chatId: String,
    val turnId: String,
    val state: AidenStreamState,
    val lastSequence: Int,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant
)

@Serializable
data class AidenStreamPendingApproval(
    val approvalId: String,
    val streamId: String,
    val chatId: String,
    val summary: String,
    val toolCallId: String,
    val toolName: String,
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant,
    val canAllow: Boolean
)

@Serializable
data class AidenStreamApprovalSnapshot(
    val approval: AidenStreamPendingApproval? = null
)

@Serializable
enum class AidenApprovalDecision {
    @SerialName("allow") ALLOW,
    @SerialName("deny") DENY
}

@Serializable
data class AidenApprovalResponse(
    val approvalId: String,
    val decision: AidenApprovalDecision,
    @Serializable(with = InstantIso8601Serializer::class) val resolvedAt: Instant
)

data class AidenPendingApproval(
    val id: String,
    val summary: String,
    val toolName: String,
    val expiresAt: Instant,
    val canRespond: Boolean,
    val hasRequiredWriteCapability: Boolean,
    val hostCanAllow: Boolean,
    val canAllow: Boolean
)

data class AidenApprovalCapabilities(
    val canRespond: Boolean,
    val canWriteSchedules: Boolean
) {
    companion object {
        val UNRESTRICTED = AidenApprovalCapabilities(canRespond = true, canWriteSchedules = true)
    }
}

object AidenApprovalPresentation {
    private val automationTools = setOf("schedule_task", "edit_automation")

    fun oneLineSummary(summary: String): String {
        val collapsed = summary.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return if (collapsed.isEmpty()) "Review requested action" else collapsed
    }

    fun isAutomation(toolName: String): Boolean = automationTools.contains(toolName)

    fun title(toolName: String): String = when (toolName) {
        "schedule_task" -> "Create this automation?"
        "edit_automation" -> "Save these automation changes?"
        else -> "Approval Required"
    }

    fun requiresMacConfirmation(approval: AidenPendingApproval): Boolean =
        isAutomation(approval.toolName) && approval.canRespond &&
                approval.hasRequiredWriteCapability && !approval.hostCanAllow
}

object AidenPendingApprovalResolution {
    fun resolve(
        approval: AidenStreamPendingApproval?,
        streamId: String,
        chatId: String,
        capabilities: AidenApprovalCapabilities = AidenApprovalCapabilities.UNRESTRICTED,
        now: Instant = Instant.now()
    ): AidenPendingApproval? {
        if (approval == null || approval.streamId != streamId || approval.chatId != chatId || !approval.expiresAt.isAfter(now)) {
            return null
        }
        val hasRequiredWriteCapability =
            !AidenApprovalPresentation.isAutomation(approval.toolName) || capabilities.canWriteSchedules
        return AidenPendingApproval(
            id = approval.approvalId,
            summary = approval.summary,
            toolName = approval.toolName,
            expiresAt = approval.expiresAt,
            canRespond = capabilities.canRespond,
            hasRequiredWriteCapability = hasRequiredWriteCapability,
            hostCanAllow = approval.canAllow,
            canAllow = approval.canAllow && capabilities.canRespond && hasRequiredWriteCapability
        )
    }
}

data class AidenLiveTool(
    val id: String,
    val name: String,
    var status: String? = null
)

@Serializable
data class AidenUsageTokens(
    val input: Int,
    val output: Int,
    val cacheRead: Int,
    val cacheWrite: Int,
    val cacheWrite1h: Int? = null,
    val reasoning: Int,
    val total: Int
)

@Serializable
data class AidenUsageTotals(
    val requests: Int,
    val completedRequests: Int,
    val failedRequests: Int,
    val cancelledRequests: Int,
    val reportedTokenRequests: Int,
    val unmeteredRequests: Int,
    val localRequests: Int,
    val costedRequests: Int,
    val unpricedHostedRequests: Int,
    val hostedCostUsd: Double,
    val activeDays: Int,
    val currentStreak: Int,
    val longestStreak: Int,
    val tokens: AidenUsageTokens
)

@Serializable
data class AidenUsageDay(
    val date: String,
    val requests: Int,
    val reportedTokenRequests: Int,
    val unmeteredRequests: Int,
    val tokens: AidenUsageTokens,
    val hostedCostUsd: Double
)

@Serializable
data class AidenUsageModel(
    val providerId: String,
    val providerLabel: String,
    val modelId: String,
    val modelLabel: String,
    val local: Boolean,
    val requests: Int,
    val reportedTokenRequests: Int,
    val unmeteredRequests: Int,
    val tokens: AidenUsageTokens,
    val hostedCostUsd: Double
) {
    val id: String get() = "$providerId:$modelId:$local"
}

@Serializable
data class AidenUsageSummary(
    val range: String,
    val startDate: String,
    val endDate: String,
    val totals: AidenUsageTotals,
    val days: List<AidenUsageDay>,
    val models: List<AidenUsageModel>
)

@Serializable
data class AidenAttachmentReference(
    val id: String,
    val name: String,
    val mimeType: String,
    val kind: AidenAttachmentKind,
    val size: Int,
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant
) {
    fun isValid(now: Instant = Instant.now()): Boolean {
        if (!id.matches(Regex("^att_[A-Za-z0-9_-]{43}$")) || !expiresAt.isAfter(now) || size !in 0..8 * 1_048_576 ||
            name.isEmpty() || name.length > 255 || name.any { it.code <= 0x1f || it.code == 0x7f || it == '/' || it == '\\' } ||
            mimeType.isEmpty() || mimeType.length > 120
        ) return false

        return when (kind) {
            AidenAttachmentKind.IMAGE -> mimeType == "image/jpeg" || mimeType == "image/png"
            AidenAttachmentKind.TEXT -> size <= 400_000 && ALLOWED_TEXT_MIME_TYPES.contains(mimeType)
        }
    }

    companion object {
        val ALLOWED_TEXT_MIME_TYPES = setOf(
            "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
            "application/yaml", "application/x-yaml", "application/javascript", "application/typescript"
        )
    }
}

data class AidenBotReplyProjection(
    val finalText: String,
    val progressText: String
) {
    companion object {
        fun resolve(
            text: String,
            timeline: AidenGenerationTimeline?,
            isActive: Boolean
        ): AidenBotReplyProjection {
            val cleanedText = text.trim()
            if (cleanedText.isEmpty()) {
                return AidenBotReplyProjection(finalText = "", progressText = "")
            }
            val toolSteps = timeline?.steps?.filter { it.kind == AidenAgentStep.Kind.TOOL } ?: emptyList()
            val maxContentOffset = toolSteps.mapNotNull { it.contentOffset }.maxOrNull()
            if (isActive || timeline == null || maxContentOffset == null) {
                return if (isActive) {
                    AidenBotReplyProjection(finalText = "", progressText = deduplicatedProgress(text))
                } else {
                    AidenBotReplyProjection(finalText = cleanedText, progressText = "")
                }
            }
            val boundary = minOf(maxContentOffset, text.length)
            val progress = text.substring(0, boundary)
            val final = text.substring(boundary)
            return AidenBotReplyProjection(
                finalText = final.trim(),
                progressText = deduplicatedProgress(progress)
            )
        }

        private fun deduplicatedProgress(text: String): String {
            val seen = mutableSetOf<String>()
            val paragraphs = text.split("\n\n")
            val result = mutableListOf<String>()
            for (paragraph in paragraphs) {
                val cleaned = paragraph.trim()
                if (cleaned.isEmpty()) continue
                val identity = cleaned.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
                if (seen.add(identity)) {
                    result.add(cleaned)
                }
            }
            return result.joinToString("\n\n")
        }
    }
}

object AidenChatTitleReconciliation {
    val retryMilliseconds = listOf(400L, 800L, 1200L, 2000L, 3000L, 3500L, 3500L)
}

class AidenTerminalReplayGate {
    var hasReplayedTerminalCursor = false
        private set

    fun shouldReplay(state: AidenStreamState): Boolean {
        if (state.isTerminal && !hasReplayedTerminalCursor) {
            hasReplayedTerminalCursor = true
            return true
        }
        return false
    }
}

object AidenTerminalReconciliation {
    fun retryDelayMilliseconds(attempt: Int): Long {
        val safeAttempt = maxOf(0, minOf(attempt, 5))
        return minOf(30_000L, 1_000L * (1L shl safeAttempt))
    }

    fun isDefinitiveMissingStream(error: Throwable): Boolean {
        if (error is AidenRemoteContractException) {
            return false
        }
        return false
    }
}

data class AidenAttachmentContent(
    val data: ByteArray,
    val mimeType: String
)

enum class AidenMissingStreamResolutionState {
    CANCELLED,
    FAILED,
    COMPLETE,
    INTERRUPTED
}

object AidenMissingStreamResolution {
    fun resolve(messages: List<AidenChatMessage>): AidenMissingStreamResolutionState {
        val last = messages.lastOrNull() ?: return AidenMissingStreamResolutionState.INTERRUPTED
        if (last.role == AidenChatRole.USER) {
            return AidenMissingStreamResolutionState.INTERRUPTED
        }
        val outcome = last.outcome
        if (outcome != null) {
            return when (outcome.status) {
                AidenMessageOutcomeStatus.CANCELLED -> AidenMissingStreamResolutionState.CANCELLED
                AidenMessageOutcomeStatus.FAILED -> AidenMissingStreamResolutionState.FAILED
            }
        }
        return AidenMissingStreamResolutionState.COMPLETE
    }
}

class AidenTurnAttemptTracker {
    private var pendingRequest: AidenTurnStart? = null
    private var pendingKey: UUID? = null

    @Synchronized
    fun key(request: AidenTurnStart): UUID {
        if (pendingRequest == request && pendingKey != null) {
            return pendingKey!!
        }
        val key = UUID.randomUUID()
        pendingRequest = request
        pendingKey = key
        return key
    }

    @Synchronized
    fun reset() {
        pendingRequest = null
        pendingKey = null
    }
}

object AidenTurnRequestBuilder {
    fun make(
        text: String,
        providerId: String?,
        modelId: String?,
        thinkingLevel: String?,
        attachments: List<AidenAttachmentReference>
    ): AidenTurnStart {
        return AidenTurnStart(
            text = text,
            providerId = providerId,
            modelId = modelId,
            thinkingLevel = thinkingLevel,
            attachmentIds = if (attachments.isEmpty()) null else attachments.map { it.id }
        )
    }
}

object AidenDraftSendReconciliation {
    fun failedDraft(submitted: String, current: String): String {
        if (current.isEmpty()) return submitted
        return "$submitted\n\n$current"
    }

    fun failedAttachments(
        submitted: List<AidenAttachmentReference>,
        current: List<AidenAttachmentReference>
    ): List<AidenAttachmentReference> {
        val combined = submitted + current
        val seen = mutableSetOf<String>()
        return combined.filter { seen.add(it.id) }
    }
}

data class AidenChatModelSelection(
    val providerId: String?,
    val modelId: String?,
    val thinkingLevel: String?
)

object AidenChatModelAuthority {
    fun resolvedSelection(
        chat: AidenChat,
        catalog: AidenModelCatalog?,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?
    ): AidenChatModelSelection {
        if (chat.isBotChat) {
            val provider = catalog?.providers?.firstOrNull { it.id == chat.providerId }
            val model = provider?.models?.firstOrNull { it.id == chat.modelId }
            return AidenChatModelSelection(
                providerId = chat.providerId,
                modelId = chat.modelId,
                thinkingLevel = model?.effectiveThinkingLevel
            )
        }

        if (catalog == null) {
            return AidenChatModelSelection(
                providerId = selectedProviderId,
                modelId = selectedModelId,
                thinkingLevel = selectedThinkingLevel
            )
        }

        var providerId = selectedProviderId
        if (providerId == null || catalog.providers.none { it.id == providerId }) {
            providerId = catalog.defaults["providerId"] ?: catalog.visibleProviders.firstOrNull()?.id
        }
        val provider = catalog.providers.firstOrNull { it.id == providerId }
        var modelId = selectedModelId
        if (modelId == null || provider?.models?.any { it.id == modelId } != true) {
            modelId = catalog.defaults["modelId"] ?: provider?.visibleModels?.firstOrNull()?.id
        }
        val model = provider?.models?.firstOrNull { it.id == modelId }
        return AidenChatModelSelection(
            providerId = providerId,
            modelId = modelId,
            thinkingLevel = selectedThinkingLevel ?: model?.effectiveThinkingLevel
        )
    }

    fun turnSelection(
        chat: AidenChat,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?
    ): AidenChatModelSelection {
        return AidenChatModelSelection(
            providerId = if (chat.isBotChat) chat.providerId else selectedProviderId,
            modelId = if (chat.isBotChat) chat.modelId else selectedModelId,
            thinkingLevel = selectedThinkingLevel
        )
    }
}
