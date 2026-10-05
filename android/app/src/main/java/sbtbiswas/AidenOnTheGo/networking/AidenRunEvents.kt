package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenQuestionContractCodec
import sbtbiswas.AidenOnTheGo.models.AidenRemoteRunQuestion
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.AidenSSEParserException
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.time.Instant

// Contract revision 21: phone observation and control of runs started on the
// Mac, in Telegram or by the scheduler.

enum class AidenRemoteRunEndState(val wireName: String) {
    DONE("done"),
    FAILED("failed"),
    CANCELLED("cancelled");

    companion object {
        fun fromWire(raw: String?): AidenRemoteRunEndState? = entries.firstOrNull { it.wireName == raw }
    }
}

/** The phone projection of a run approval. It never carries tool details;
 * `canAllow` is false for approvals only the desktop may allow, and `scopes`
 * appears only when the phone may allow. */
data class AidenRemoteRunApproval(
    val approvalId: String,
    val summary: String,
    val toolCallId: String?,
    val toolName: String,
    val canAllow: Boolean,
    val scopes: List<AidenApprovalScope>?
)

/** A run snapshot. `reason: "gap"` restates the pending prompts after missed
 * events and the transcript must be reconciled; its frame sequence is
 * `nextSequence - 1`, which is 0 when nothing earlier was retained. */
data class AidenRemoteRunSnapshot(
    val runId: String,
    val chatId: String,
    val reason: String,
    val state: String?,
    val approvals: List<AidenRemoteRunApproval>,
    val questions: List<AidenRemoteRunQuestion>,
    val nextSequence: Long
)

/** One frame of `/chats/{id}/runs/current/events` or `/runs/{id}/events`.
 * Content events reuse the strict `/streams` decoder unchanged; run-only
 * events are decoded here. `run.ended` repeats the last event's sequence. */
data class AidenRemoteRunEvent(
    val streamId: String,
    val sequence: Int,
    val timestamp: Instant,
    val terminal: Boolean,
    val kind: Kind
) {
    val runId: String get() = streamId

    sealed interface Kind {
        data class Started(val chatId: String, val origin: String) : Kind
        data class Content(val event: AidenRemoteStreamEvent) : Kind
        data class ApprovalRequired(val approval: AidenRemoteRunApproval) : Kind
        data class ApprovalResolved(val approvalId: String, val decision: AidenApprovalDecision?) : Kind
        data class QuestionRequired(val question: AidenRemoteRunQuestion) : Kind
        data class QuestionResolved(val promptId: String, val outcome: String?) : Kind
        data class Snapshot(val snapshot: AidenRemoteRunSnapshot) : Kind
        data class Ended(val chatId: String, val state: AidenRemoteRunEndState) : Kind
    }
}

object AidenRunEventCodec {
    val RUN_ONLY_TYPES = setOf(
        "run.started", "run.ended", "snapshot", "approval_required", "approval_resolved",
        "question_required", "question_resolved"
    )
    private val ENVELOPE_KEYS = setOf("protocolVersion", "streamId", "sequence", "timestamp", "type", "terminal", "payload")
    private val json = Json { ignoreUnknownKeys = false }

    fun decode(rawBytes: ByteArray): AidenRemoteRunEvent {
        if (rawBytes.size > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) throw AidenRemoteContractException.PayloadTooLarge
        val root = try {
            json.parseToJsonElement(String(rawBytes, Charsets.UTF_8))
        } catch (_: Exception) {
            throw AidenRemoteContractException.InvalidJson("Invalid JSON in run event")
        } as? JsonObject ?: throw AidenRemoteContractException.InvalidJson("Expected run event object")
        val type = (root["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw AidenRemoteContractException.UnsafePayloadField("type")
        if (type !in RUN_ONLY_TYPES) {
            val content = AidenSSEParser.decodeStreamEvent(rawBytes)
            // Progress snapshots belong to the chat progress channel, never a run.
            if (content.type == AidenRemoteEventType.TASK_UPDATE || content.type == AidenRemoteEventType.AGENTS_UPDATE) {
                throw AidenRemoteContractException.UnsafePayloadField("type")
            }
            return AidenRemoteRunEvent(
                streamId = content.streamId,
                sequence = content.sequence,
                timestamp = content.timestamp,
                terminal = content.terminal,
                kind = AidenRemoteRunEvent.Kind.Content(content)
            )
        }
        assertKeys(root, ENVELOPE_KEYS, "run event")
        if ((root["protocolVersion"] as? JsonPrimitive)?.intOrNull != AidenRemoteProtocol.VERSION) {
            throw AidenRemoteContractException.InvalidProtocolVersion
        }
        val streamId = (root["streamId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (streamId.isNullOrEmpty() || streamId.codePointCount(0, streamId.length) > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH) {
            throw AidenRemoteContractException.InvalidStreamIdentity
        }
        val sequence = (root["sequence"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
            ?: throw AidenRemoteContractException.InvalidSequence
        val minimumSequence = if (type == "snapshot") 0 else 1
        if (sequence < minimumSequence) throw AidenRemoteContractException.InvalidSequence
        val timestamp = (root["timestamp"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let {
            try { Instant.parse(it) } catch (_: Exception) { null }
        } ?: throw AidenRemoteContractException.InvalidJson("Invalid timestamp")
        val terminal = (root["terminal"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            ?: throw AidenRemoteContractException.InvalidJson("Missing terminal")
        if (terminal != (type == "run.ended")) throw AidenRemoteContractException.InvalidTerminalClassification
        val payload = root["payload"] as? JsonObject
            ?: throw AidenRemoteContractException.InvalidJson("Missing payload object")
        if (payload.size > AidenRemoteProtocol.MAX_EVENT_PAYLOAD_PROPERTIES) throw AidenRemoteContractException.PayloadTooLarge

        val kind: AidenRemoteRunEvent.Kind = when (type) {
            "run.started" -> {
                assertKeys(payload, setOf("runId", "chatId", "origin"), "run.started")
                if (payload.string("runId", "run.started") != streamId) throw AidenRemoteContractException.InvalidStreamIdentity
                AidenRemoteRunEvent.Kind.Started(
                    chatId = payload.string("chatId", "run.started"),
                    origin = payload.string("origin", "run.started", maxLength = 64)
                )
            }
            "run.ended" -> {
                assertKeys(payload, setOf("runId", "chatId", "state"), "run.ended")
                if (payload.string("runId", "run.ended") != streamId) throw AidenRemoteContractException.InvalidStreamIdentity
                AidenRemoteRunEvent.Kind.Ended(
                    chatId = payload.string("chatId", "run.ended"),
                    state = AidenRemoteRunEndState.fromWire(payload.string("state", "run.ended", maxLength = 16))
                        ?: throw AidenRemoteContractException.UnsafePayloadField("state")
                )
            }
            "snapshot" -> {
                val snapshot = parseSnapshot(payload)
                if (snapshot.runId != streamId) throw AidenRemoteContractException.InvalidStreamIdentity
                AidenRemoteRunEvent.Kind.Snapshot(snapshot)
            }
            "approval_required" -> AidenRemoteRunEvent.Kind.ApprovalRequired(parseApproval(payload))
            "approval_resolved" -> {
                assertKeys(payload, setOf("approvalId", "decision"), "approval_resolved")
                AidenRemoteRunEvent.Kind.ApprovalResolved(
                    approvalId = payload.string("approvalId", "approval_resolved"),
                    decision = payload.optionalString("decision", "approval_resolved", 16)?.let { raw ->
                        decisionFromWire(raw) ?: throw AidenRemoteContractException.UnsafePayloadField("decision")
                    }
                )
            }
            "question_required" -> AidenRemoteRunEvent.Kind.QuestionRequired(
                AidenQuestionContractCodec.parseRunQuestion(payload, "question_required")
            )
            else -> {
                assertKeys(payload, setOf("promptId", "outcome"), "question_resolved")
                AidenRemoteRunEvent.Kind.QuestionResolved(
                    promptId = payload.string("promptId", "question_resolved"),
                    outcome = payload.optionalString("outcome", "question_resolved", 32)
                )
            }
        }
        return AidenRemoteRunEvent(streamId, sequence, timestamp, terminal, kind)
    }

    fun parseApproval(obj: JsonObject, label: String = "approval_required"): AidenRemoteRunApproval {
        // Tool arguments and host previews (`details`) stay on the Mac.
        assertKeys(obj, setOf("approvalId", "summary", "toolCallId", "toolName", "canAllow", "scopes"), label)
        val canAllow = (obj["canAllow"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            ?: throw AidenRemoteContractException.UnsafePayloadField("canAllow")
        val scopes = obj["scopes"]?.let { element ->
            if (!canAllow) throw AidenRemoteContractException.UnsafePayloadField("scopes")
            val raw = (element as? JsonArray)?.map { item ->
                (item as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?: throw AidenRemoteContractException.UnsafePayloadField("scopes")
            } ?: throw AidenRemoteContractException.UnsafePayloadField("scopes")
            val parsed = raw.mapNotNull { name -> AidenApprovalScope.entries.firstOrNull { it.wireName == name } }
            if (parsed.isEmpty() || parsed.size != raw.size || parsed.toSet().size != parsed.size) {
                throw AidenRemoteContractException.UnsafePayloadField("scopes")
            }
            parsed
        }
        return AidenRemoteRunApproval(
            approvalId = obj.string("approvalId", label),
            summary = obj.string("summary", label, AidenRemoteProtocol.MAX_APPROVAL_SUMMARY_LENGTH, allowEmpty = true),
            toolCallId = obj.optionalString("toolCallId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH, allowEmpty = true),
            toolName = obj.string("toolName", label, AidenRemoteProtocol.MAX_TOOL_NAME_LENGTH),
            canAllow = canAllow,
            scopes = scopes
        )
    }

    private fun parseSnapshot(obj: JsonObject): AidenRemoteRunSnapshot {
        val label = "run snapshot"
        assertKeys(
            obj,
            setOf(
                "runId", "chatId", "reason", "epoch", "state", "pendingApprovalIds", "pendingQuestionIds",
                "approvals", "questions", "nextSequence"
            ),
            label
        )
        val nextSequence = (obj["nextSequence"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        if (nextSequence == null || nextSequence !in 1..AidenRemoteProtocol.MAX_SAFE_INTEGER) {
            throw AidenRemoteContractException.UnsafePayloadField("nextSequence")
        }
        for (key in listOf("pendingApprovalIds", "pendingQuestionIds")) {
            val ids = obj[key] ?: continue
            if (ids !is JsonArray || ids.any { (it as? JsonPrimitive)?.isString != true }) {
                throw AidenRemoteContractException.UnsafePayloadField(key)
            }
        }
        return AidenRemoteRunSnapshot(
            runId = obj.string("runId", label),
            chatId = obj.string("chatId", label),
            reason = obj.string("reason", label, 32),
            state = obj.optionalString("state", label, 32),
            approvals = (obj["approvals"] as? JsonArray ?: JsonArray(emptyList())).map { element ->
                parseApproval(element as? JsonObject ?: throw AidenRemoteContractException.UnsafePayloadField("approvals"), "$label.approvals")
            },
            questions = (obj["questions"] as? JsonArray ?: JsonArray(emptyList())).map { element ->
                AidenQuestionContractCodec.parseRunQuestion(element, "$label.questions")
            },
            nextSequence = nextSequence
        )
    }

    private fun decisionFromWire(raw: String): AidenApprovalDecision? = when (raw) {
        "allow" -> AidenApprovalDecision.ALLOW
        "deny" -> AidenApprovalDecision.DENY
        else -> null
    }

    private fun assertKeys(obj: JsonObject, allowed: Set<String>, label: String) {
        val unsupported = obj.keys.firstOrNull { it !in allowed }
        if (unsupported != null) throw AidenRemoteContractException.UnsafePayloadField("$label.$unsupported")
        for (key in obj.keys) {
            if (AidenRemoteProtocol.FORBIDDEN_WIRE_KEYS.contains(key)) throw AidenRemoteContractException.UnsafePayloadField(key)
        }
    }

    private fun JsonObject.string(
        key: String,
        label: String,
        maxLength: Int = AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH,
        allowEmpty: Boolean = false
    ): String = optionalString(key, label, maxLength, allowEmpty)
        ?: throw AidenRemoteContractException.UnsafePayloadField("$label.$key")

    private fun JsonObject.optionalString(
        key: String,
        label: String,
        maxLength: Int,
        allowEmpty: Boolean = false
    ): String? {
        val element: JsonElement = this[key] ?: return null
        val primitive = (element as? JsonPrimitive)?.takeIf { it.isString }
            ?: throw AidenRemoteContractException.UnsafePayloadField("$label.$key")
        val value = primitive.contentOrNull ?: throw AidenRemoteContractException.UnsafePayloadField("$label.$key")
        if ((!allowEmpty && value.isEmpty()) || value.codePointCount(0, value.length) > maxLength) {
            throw AidenRemoteContractException.UnsafePayloadField("$label.$key")
        }
        return value
    }
}

/** SSE framing for run feeds. Identical to the turn parser except that a gap
 * snapshot may carry sequence 0. */
class AidenRunSSEParser {
    private var eventID: String? = null
    private var eventName: String? = null
    private val dataLines = mutableListOf<String>()
    private var frameBytes = 0

    fun consume(line: String): AidenRemoteRunEvent? {
        frameBytes += line.toByteArray(Charsets.UTF_8).size + 1
        if (frameBytes > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) throw AidenSSEParserException.FrameTooLarge
        if (line.isEmpty()) return finishFrame()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon == -1) line else line.substring(0, colon)
        var value = if (colon == -1) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "id" -> eventID = value
            "event" -> eventName = value
            "data" -> dataLines.add(value)
        }
        return null
    }

    /** EOF is not a frame delimiter: a truncated frame never applies. */
    fun finish(): AidenRemoteRunEvent? {
        reset()
        return null
    }

    private fun finishFrame(): AidenRemoteRunEvent? {
        try {
            if (dataLines.isEmpty()) {
                if (eventID == null && eventName == null) return null
                throw AidenSSEParserException.MissingData
            }
            val sequence = eventID?.toIntOrNull()
            if (sequence == null || sequence < 0) throw AidenSSEParserException.InvalidEventID
            val rawBytes = dataLines.joinToString("\n").toByteArray(Charsets.UTF_8)
            if (rawBytes.size > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) throw AidenRemoteContractException.PayloadTooLarge
            AidenRawJsonDuplicateKeyScanner.validate(rawBytes)
            val event = AidenRunEventCodec.decode(rawBytes)
            if (event.sequence != sequence) throw AidenSSEParserException.EventIDMismatch
            if (eventName != null && eventName != wireType(event)) throw AidenSSEParserException.EventNameMismatch
            return event
        } finally {
            reset()
        }
    }

    private fun reset() {
        eventID = null
        eventName = null
        dataLines.clear()
        frameBytes = 0
    }

    companion object {
        fun wireType(event: AidenRemoteRunEvent): String = when (val kind = event.kind) {
            is AidenRemoteRunEvent.Kind.Started -> "run.started"
            is AidenRemoteRunEvent.Kind.Ended -> "run.ended"
            is AidenRemoteRunEvent.Kind.Snapshot -> "snapshot"
            is AidenRemoteRunEvent.Kind.ApprovalRequired -> "approval_required"
            is AidenRemoteRunEvent.Kind.ApprovalResolved -> "approval_resolved"
            is AidenRemoteRunEvent.Kind.QuestionRequired -> "question_required"
            is AidenRemoteRunEvent.Kind.QuestionResolved -> "question_resolved"
            is AidenRemoteRunEvent.Kind.Content -> kind.event.type.rawValue
        }

        /** Parses one run feed. With [expectedRunId] null (the chat's current
         * run) the first frame fixes the identity; any frame naming another
         * run ends the feed. */
        fun parseStream(inputStream: InputStream, expectedRunId: String? = null): Flow<AidenRemoteRunEvent> = flow {
            val reader = BufferedReader(InputStreamReader(inputStream, Charsets.UTF_8))
            val parser = AidenRunSSEParser()
            var runId = expectedRunId
            var line = reader.readLine()
            while (line != null) {
                val event = parser.consume(line)
                if (event != null) {
                    if (runId == null) runId = event.runId
                    if (event.runId != runId) throw AidenRemoteContractException.InvalidStreamIdentity
                    emit(event)
                }
                line = reader.readLine()
            }
            parser.finish()
        }
    }
}

data class AidenRemoteRunCancelResult(
    val runId: String,
    val chatId: String,
    val state: String,
    val cancelRequested: Boolean
)

data class AidenRemoteRunApprovalResult(
    val runId: String,
    val approvalId: String,
    val decision: AidenApprovalDecision,
    val scope: AidenApprovalScope?,
    val resolvedAt: Instant
)

data class AidenRemoteRunQuestionResult(
    val runId: String,
    val promptId: String,
    val outcome: String,
    val resolvedAt: Instant
)
