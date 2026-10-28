package sbtbiswas.AidenOnTheGo.models

import androidx.compose.runtime.Immutable
import java.io.File
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol

/**
 * The video the agent recorded of a browser tab, carried on its completed
 * `browser_recording_stop` timeline step (contract revision 45). Display-only:
 * the recording's id, type, length and size, never the video, its path or the
 * page. The bytes are read from the Mac by id, for the chat that holds the step.
 * Mirrors the desktop's `BrowserRecordingRecapV1` and `parseBrowserRecordingRecap`.
 */
@Immutable
data class AidenBrowserRecordingRecap(
    val id: String,
    val mimeType: String,
    val durationMs: Long,
    val sizeBytes: Long
) {
    val isValid: Boolean
        get() = ID.matches(id) && mimeType in MIME_TYPES &&
            durationMs in 0..MAX_DURATION_MS && sizeBytes in 1..MAX_BYTES

    /** `0:07`, `1:30`: the length people read on a video. */
    val durationLabel: String
        get() = durationLabel(durationMs)

    /** `1.2 MB`, `640 KB`: the size the desktop card shows. */
    val sizeLabel: String
        get() = sizeLabel(sizeBytes)

    /** The file extension the Mac's type names. */
    val fileExtension: String
        get() = extension(mimeType)

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("mimeType", mimeType)
        put("durationMs", durationMs)
        put("sizeBytes", sizeBytes)
    }

    companion object {
        const val TOOL_NAME = "browser_recording_stop"
        const val MIME_MP4 = "video/mp4"
        const val MIME_WEBM = "video/webm"
        /** MP4 (H.264) plays everywhere; WebM is the Mac's fallback, and Android plays it too. */
        val MIME_TYPES: Set<String> = setOf(MIME_MP4, MIME_WEBM)
        /** The recorder stops itself at this size; the Mac never serves more. */
        const val MAX_BYTES: Long = 128L * 1_024 * 1_024
        /** The recorder stops itself after five minutes; the recap allows for the stop itself. */
        const val MAX_DURATION_MS: Long = 6L * 60_000
        private val ID = Regex("^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        private val KEYS = setOf("id", "mimeType", "durationMs", "sizeBytes")
        private val JSON_NUMBER = Regex("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$")
        /** JavaScript's `Number.MAX_SAFE_INTEGER`. */
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

        fun isValidId(value: String): Boolean = ID.matches(value)

        fun extension(mimeType: String): String = if (mimeType == MIME_MP4) "mp4" else "webm"

        fun durationLabel(durationMs: Long): String {
            // Math.round in JavaScript: halves round up, and lengths are never negative.
            val seconds = (maxOf(0L, durationMs) + 500) / 1_000
            return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
        }

        fun sizeLabel(bytes: Long): String {
            if (bytes >= 1_024L * 1_024) {
                // Exact binary value rounded half up, as JavaScript's toFixed(1) does.
                val megabytes = BigDecimal(bytes.toDouble() / (1_024.0 * 1_024.0)).setScale(1, RoundingMode.HALF_UP)
                return "${megabytes.toPlainString()} MB"
            }
            return "${maxOf(1L, (bytes + 512) / 1_024)} KB"
        }

        /**
         * The recap with exactly the four keys the desktop accepts, or null. A JSON
         * number counts as an integer when its value is one, as JavaScript reads it.
         */
        fun fromJson(element: JsonElement): AidenBrowserRecordingRecap? {
            val obj = element as? JsonObject ?: return null
            if (obj.keys != KEYS) return null
            val id = obj["id"].stringOrNull() ?: return null
            val mimeType = obj["mimeType"].stringOrNull() ?: return null
            val durationMs = obj["durationMs"].safeIntegerOrNull() ?: return null
            val sizeBytes = obj["sizeBytes"].safeIntegerOrNull() ?: return null
            return AidenBrowserRecordingRecap(id, mimeType, durationMs, sizeBytes).takeIf { it.isValid }
        }

        private fun JsonElement?.stringOrNull(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun JsonElement?.safeIntegerOrNull(): Long? {
            val primitive = (this as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
            if (!JSON_NUMBER.matches(primitive.content)) return null
            val value = primitive.content.toDoubleOrNull() ?: return null
            if (!value.isFinite() || value != Math.floor(value) || kotlin.math.abs(value) > MAX_SAFE_INTEGER) return null
            return value.toLong()
        }
    }
}

/**
 * Decodes a step's `recording` without ever failing the step: a malformed recap
 * becomes null. Encodes the validated shape back for the chat cache.
 */
object AidenBrowserRecordingRecapSerializer : KSerializer<AidenBrowserRecordingRecap?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor.nullable

    override fun deserialize(decoder: Decoder): AidenBrowserRecordingRecap? {
        val json = decoder as? JsonDecoder ?: throw SerializationException("recording recaps decode from JSON only")
        return AidenBrowserRecordingRecap.fromJson(json.decodeJsonElement())
    }

    override fun serialize(encoder: Encoder, value: AidenBrowserRecordingRecap?) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("recording recaps encode to JSON only")
        if (value == null) json.encodeNull() else json.encodeJsonElement(value.toJson())
    }
}

/**
 * Whether Play reads a recording from the Mac. The live `/server` features decide
 * once they are known; before that, the features this pairing last saw stand in,
 * as they do for the visual viewer.
 */
object AidenBrowserRecordingGate {
    fun isAvailable(liveFeatures: List<String>?, cachedFeatures: List<String>?): Boolean =
        (liveFeatures ?: cachedFeatures)?.contains(AidenRemoteProtocol.CHAT_BROWSER_RECORDINGS_FEATURE) == true
}

/** A recording the Mac served, saved under this phone's cache for the player. */
data class AidenBrowserRecordingFile(val file: File, val mimeType: String)

/** What pressing Play on a recording card found. */
sealed interface AidenBrowserRecordingLoad {
    data class Ready(val recording: AidenBrowserRecordingFile) : AidenBrowserRecordingLoad
    /** The Mac answered 404: the recording was deleted or the chat no longer names it. */
    data object Missing : AidenBrowserRecordingLoad
    /** Offline, refused, or a body that broke the route's rules. */
    data object Failed : AidenBrowserRecordingLoad
}
