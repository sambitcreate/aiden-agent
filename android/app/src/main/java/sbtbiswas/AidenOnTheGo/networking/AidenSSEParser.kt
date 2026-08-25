package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.AidenSSEParserException
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.time.Instant

@Serializable
data class AidenRemoteEventPayload(
    val chatId: String? = null,
    val turnId: String? = null,
    val nextSequence: Long? = null,
    val state: String? = null,
    val text: String? = null,
    val toolId: String? = null,
    val name: String? = null,
    val status: String? = null,
    val label: String? = null,
    val timeline: AidenGenerationTimeline? = null,
    val approvalId: String? = null,
    val summary: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant? = null,
    val messageId: String? = null,
    val code: AidenRemoteErrorCode? = null,
    val message: String? = null,
    val source: String? = null
) {
    operator fun get(key: String): JsonPrimitive? {
        return when (key) {
            "chatId" -> chatId?.let { JsonPrimitive(it) }
            "turnId" -> turnId?.let { JsonPrimitive(it) }
            "nextSequence" -> nextSequence?.let { JsonPrimitive(it) }
            "state" -> state?.let { JsonPrimitive(it) }
            "text" -> text?.let { JsonPrimitive(it) }
            "toolId" -> toolId?.let { JsonPrimitive(it) }
            "name" -> name?.let { JsonPrimitive(it) }
            "status" -> status?.let { JsonPrimitive(it) }
            "label" -> label?.let { JsonPrimitive(it) }
            "approvalId" -> approvalId?.let { JsonPrimitive(it) }
            "summary" -> summary?.let { JsonPrimitive(it) }
            "messageId" -> messageId?.let { JsonPrimitive(it) }
            "message" -> message?.let { JsonPrimitive(it) }
            "source" -> source?.let { JsonPrimitive(it) }
            else -> null
        }
    }
}

@Serializable
data class AidenRemoteStreamEvent(
    val protocolVersion: Int,
    val streamId: String,
    val sequence: Int,
    @Serializable(with = InstantIso8601Serializer::class) val timestamp: Instant,
    val type: AidenRemoteEventType,
    val terminal: Boolean = false,
    val payload: AidenRemoteEventPayload? = null
) {
    val shouldApply: Boolean get() = AidenRemoteEventType.V1_KNOWN.contains(type)
}

typealias AidenRemoteEvent = AidenRemoteStreamEvent

class AidenSSEParser {
    private var eventID: String? = null
    private var eventName: String? = null
    private val dataLines = mutableListOf<String>()
    private var frameBytes = 0

    fun consume(line: String): AidenRemoteStreamEvent? {
        frameBytes += line.toByteArray(Charsets.UTF_8).size + 1
        if (frameBytes > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) {
            throw AidenSSEParserException.FrameTooLarge
        }
        if (line.isEmpty()) {
            return finishFrame()
        }
        if (line.startsWith(":")) {
            return null
        }

        val field: String
        val value: String
        val colonIndex = line.indexOf(':')
        if (colonIndex != -1) {
            field = line.substring(0, colonIndex)
            var start = colonIndex + 1
            if (start < line.length && line[start] == ' ') {
                start++
            }
            value = line.substring(start)
        } else {
            field = line
            value = ""
        }

        when (field) {
            "id" -> eventID = value
            "event" -> eventName = value
            "data" -> dataLines.add(value)
        }
        return null
    }

    fun finish(): AidenRemoteStreamEvent? {
        if (frameBytes > 0) {
            return finishFrame()
        }
        return null
    }

    private fun finishFrame(): AidenRemoteStreamEvent? {
        try {
            if (dataLines.isEmpty()) {
                if (eventID == null && eventName == null) return null
                throw AidenSSEParserException.MissingData
            }
            val currentId = eventID
            val sequence = currentId?.toIntOrNull()
            if (sequence == null || sequence <= 0) {
                throw AidenSSEParserException.InvalidEventID
            }

            val rawJson = dataLines.joinToString("\n")
            val rawBytes = rawJson.toByteArray(Charsets.UTF_8)
            if (rawBytes.size > AidenRemoteProtocol.MAX_SSE_FRAME_BYTES) {
                throw AidenRemoteContractException.PayloadTooLarge
            }

            AidenRawJsonDuplicateKeyScanner.validate(rawBytes)

            val event = decodeStreamEvent(rawBytes)

            if (event.sequence != sequence) {
                throw AidenSSEParserException.EventIDMismatch
            }
            if (eventName != null && eventName != event.type.rawValue) {
                throw AidenSSEParserException.EventNameMismatch
            }
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
        private val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

        fun decodeStreamEvent(rawBytes: ByteArray): AidenRemoteStreamEvent {
            val jsonString = String(rawBytes, Charsets.UTF_8)
            val rootElement = try {
                json.parseToJsonElement(jsonString)
            } catch (e: Exception) {
                throw AidenRemoteContractException.InvalidJson("Invalid JSON in SSE data")
            }
            val rootObj = rootElement as? JsonObject
                ?: throw AidenRemoteContractException.InvalidJson("Expected JSON object in SSE data")

            if (rootObj.size > AidenRemoteProtocol.MAX_EVENT_ENVELOPE_PROPERTIES) {
                throw AidenRemoteContractException.PayloadTooLarge
            }

            // Check forbidden keys in envelope
            validateNoForbiddenKeys(rootObj)

            // Extract envelope properties
            val protocolVersion = rootObj["protocolVersion"]?.jsonPrimitive?.intOrNull
                ?: throw AidenRemoteContractException.InvalidProtocolVersion
            if (protocolVersion != AidenRemoteProtocol.VERSION) {
                throw AidenRemoteContractException.InvalidProtocolVersion
            }

            val streamId = rootObj["streamId"]?.jsonPrimitive?.contentOrNull
                ?: throw AidenRemoteContractException.InvalidStreamIdentity
            if (streamId.isEmpty() || streamId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH) {
                throw AidenRemoteContractException.InvalidStreamIdentity
            }

            val sequence = rootObj["sequence"]?.jsonPrimitive?.intOrNull
                ?: throw AidenRemoteContractException.InvalidSequence
            if (sequence !in 1..AidenRemoteProtocol.MAX_SAFE_INTEGER) {
                throw AidenRemoteContractException.InvalidSequence
            }

            val timestampStr = rootObj["timestamp"]?.jsonPrimitive?.contentOrNull
                ?: throw AidenRemoteContractException.InvalidJson("Missing timestamp")
            val timestamp = try {
                Instant.parse(timestampStr)
            } catch (e: Exception) {
                throw AidenRemoteContractException.InvalidJson("Invalid timestamp format")
            }

            val typeRaw = rootObj["type"]?.jsonPrimitive?.contentOrNull
                ?: throw AidenRemoteContractException.UnsafePayloadField("type")
            if (typeRaw.isEmpty() || typeRaw.length > AidenRemoteProtocol.MAX_EVENT_TYPE_LENGTH) {
                throw AidenRemoteContractException.UnsafePayloadField("type")
            }
            val type = AidenRemoteEventType(typeRaw)

            val terminal = rootObj["terminal"]?.jsonPrimitive?.booleanOrNull
                ?: (type.isTerminal)

            if (!AidenRemoteEventType.V1_KNOWN.contains(type)) {
                if (terminal) {
                    throw AidenRemoteContractException.UnknownTerminalEvent(type.rawValue)
                }
                // Unknown event allowed, parse payload loosely if present
                val payloadObj = rootObj["payload"] as? JsonObject
                if (payloadObj != null) {
                    if (payloadObj.size > AidenRemoteProtocol.MAX_EVENT_PAYLOAD_PROPERTIES) {
                        throw AidenRemoteContractException.PayloadTooLarge
                    }
                    validateNoForbiddenKeys(payloadObj)
                }
                return AidenRemoteStreamEvent(
                    protocolVersion = protocolVersion,
                    streamId = streamId,
                    sequence = sequence,
                    timestamp = timestamp,
                    type = type,
                    terminal = terminal,
                    payload = null
                )
            }

            if (terminal != type.isTerminal) {
                throw AidenRemoteContractException.InvalidTerminalClassification
            }

            val payloadElement = rootObj["payload"]
            val payloadObj = payloadElement as? JsonObject
                ?: throw AidenRemoteContractException.InvalidJson("Missing payload object")

            if (payloadObj.size > AidenRemoteProtocol.MAX_EVENT_PAYLOAD_PROPERTIES) {
                throw AidenRemoteContractException.PayloadTooLarge
            }
            validateNoForbiddenKeys(payloadObj)

            val presentKeys = payloadObj.keys
            val allowedKeys: Set<String> = when (type) {
                AidenRemoteEventType.SNAPSHOT -> setOf("chatId", "turnId", "nextSequence")
                AidenRemoteEventType.STATUS -> setOf("state")
                AidenRemoteEventType.TEXT_DELTA, AidenRemoteEventType.REASONING_DELTA -> setOf("text")
                AidenRemoteEventType.TOOL_STARTED -> setOf("toolId", "name")
                AidenRemoteEventType.TOOL_FINISHED -> setOf("toolId", "status")
                AidenRemoteEventType.TIMELINE -> setOf("timeline")
                AidenRemoteEventType.APPROVAL_REQUIRED -> setOf("approvalId", "summary", "expiresAt")
                AidenRemoteEventType.DONE -> setOf("messageId")
                AidenRemoteEventType.ERROR -> setOf("code", "message")
                AidenRemoteEventType.CANCELLED -> setOf("source")
                AidenRemoteEventType.HEARTBEAT -> emptySet()
                else -> emptySet()
            }

            val unsupported = presentKeys - allowedKeys
            if (unsupported.isNotEmpty()) {
                throw AidenRemoteContractException.UnsafePayloadField(unsupported.first())
            }
            if (presentKeys != allowedKeys) {
                throw AidenRemoteContractException.UnsafePayloadField("missing-required-field")
            }

            // Specific type validations
            if (type == AidenRemoteEventType.STATUS) {
                val state = payloadObj["state"]?.jsonPrimitive?.contentOrNull
                if (state !in listOf("queued", "running", "waiting_for_approval", "reconciling")) {
                    throw AidenRemoteContractException.UnsafePayloadField("state")
                }
            }
            if (type == AidenRemoteEventType.SNAPSHOT) {
                val nextSeq = payloadObj["nextSequence"]?.jsonPrimitive?.longOrNull
                if (nextSeq == null || nextSeq !in 1..AidenRemoteProtocol.MAX_SAFE_INTEGER) {
                    throw AidenRemoteContractException.UnsafePayloadField("nextSequence")
                }
            }
            if (type == AidenRemoteEventType.TOOL_FINISHED) {
                val status = payloadObj["status"]?.jsonPrimitive?.contentOrNull
                if (status !in listOf("succeeded", "failed", "cancelled")) {
                    throw AidenRemoteContractException.UnsafePayloadField("status")
                }
            }
            if (type == AidenRemoteEventType.CANCELLED) {
                val source = payloadObj["source"]?.jsonPrimitive?.contentOrNull
                if (source !in listOf("device", "server")) {
                    throw AidenRemoteContractException.UnsafePayloadField("source")
                }
            }

            val decodedPayload = json.decodeFromJsonElement(AidenRemoteEventPayload.serializer(), payloadObj)

            return AidenRemoteStreamEvent(
                protocolVersion = protocolVersion,
                streamId = streamId,
                sequence = sequence,
                timestamp = timestamp,
                type = type,
                terminal = terminal,
                payload = decodedPayload
            )
        }

        private fun validateNoForbiddenKeys(obj: JsonObject) {
            for ((key, value) in obj) {
                if (AidenRemoteProtocol.FORBIDDEN_WIRE_KEYS.contains(key)) {
                    throw AidenRemoteContractException.UnsafePayloadField(key)
                }
                if (value is JsonObject) {
                    validateNoForbiddenKeys(value)
                } else if (value is JsonArray) {
                    for (item in value) {
                        if (item is JsonObject) validateNoForbiddenKeys(item)
                    }
                }
            }
        }

        fun parseStream(
            inputStream: InputStream,
            expectedStreamId: String? = null,
            startSequence: Int = 0
        ): Flow<AidenRemoteStreamEvent> = flow {
            val reader = BufferedReader(InputStreamReader(inputStream, Charsets.UTF_8))
            val parser = AidenSSEParser()
            var lastSequence = startSequence

            var line: String? = reader.readLine()
            while (line != null) {
                val event = parser.consume(line)
                if (event != null) {
                    if (expectedStreamId != null && event.streamId != expectedStreamId) {
                        throw AidenRemoteContractException.InvalidStreamIdentity
                    }
                    if (event.sequence <= lastSequence && lastSequence > 0) {
                        // ignore duplicate
                    } else {
                        lastSequence = event.sequence
                        emit(event)
                    }
                }
                line = reader.readLine()
            }
            val finalEvent = parser.finish()
            if (finalEvent != null) {
                if (expectedStreamId != null && finalEvent.streamId != expectedStreamId) {
                    throw AidenRemoteContractException.InvalidStreamIdentity
                }
                if (finalEvent.sequence > lastSequence || lastSequence == 0) {
                    emit(finalEvent)
                }
            }
        }
    }
}
