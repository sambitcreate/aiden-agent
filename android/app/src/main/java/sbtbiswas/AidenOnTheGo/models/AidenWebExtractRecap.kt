package sbtbiswas.AidenOnTheGo.models

import androidx.compose.runtime.Immutable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * The values a `web_fetch` extract call read, carried on its completed
 * timeline step so the transcript can show each value with the page line it
 * came from (contract revision 38). Display-only: it never holds the page or
 * the request. Mirrors the desktop's `WebExtractRecapV1` and its
 * `parseWebExtractRecap` rules.
 */
@Immutable
data class AidenWebExtractRecap(
    val version: Int,
    val host: String,
    val cut: Boolean,
    val error: Failure?,
    val fields: List<Field>
) {
    /** Why extraction failed; the page text was read instead. */
    enum class Failure(val wire: String) {
        SETUP("setup"),
        AUTH("auth"),
        QUOTA("quota"),
        TIMEOUT("timeout"),
        UNAVAILABLE("unavailable"),
        INVALID_RESPONSE("invalid-response")
    }

    enum class Status(val wire: String) {
        /** Typed, confident and found on the page. */
        EXTRACTED("extracted"),
        /** A guess, never a value read from the page. */
        UNCERTAIN("uncertain"),
        /** The page has no value. */
        ABSENT("null")
    }

    @Immutable
    data class Field(
        val name: String,
        val status: Status,
        /** Display form of the value or the guess. */
        val value: String? = null,
        val confidence: Double? = null,
        val sourceLine: String? = null,
        /** An uncertain value that appears nowhere on the page. */
        val notFound: Boolean? = null
    ) {
        /** A field name as people read it: `pro_monthly` reads `pro monthly`. */
        val label: String
            get() = name.split('_').filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { name }
    }

    val isValid: Boolean
        get() {
            if (version != VERSION || !isOneLine(host, MAX_HOST_LENGTH)) return false
            // A failed page has no fields; a page that worked has one to sixteen.
            if (if (error != null) fields.isNotEmpty() else fields.size !in 1..MAX_FIELDS) return false
            if (fields.map { it.name }.toSet().size != fields.size) return false
            return fields.all { field ->
                if (!FIELD_NAME.matches(field.name)) return@all false
                if (field.status == Status.ABSENT) {
                    return@all field.value == null && field.confidence == null &&
                        field.sourceLine == null && field.notFound == null
                }
                val value = field.value
                val confidence = field.confidence
                val sourceLine = field.sourceLine
                when {
                    value != null && !isOneLine(value, MAX_VALUE_LENGTH) -> false
                    confidence != null && !(confidence.isFinite() && confidence in 0.0..1.0) -> false
                    sourceLine != null && !isOneLine(sourceLine, MAX_SOURCE_LINE_LENGTH) -> false
                    field.notFound != null && !(field.notFound && field.status == Status.UNCERTAIN) -> false
                    // Extracted means typed, confident and on the page: all three are present.
                    field.status == Status.EXTRACTED -> value != null && confidence != null && sourceLine != null
                    else -> true
                }
            }
        }

    fun toJson(): JsonObject = buildJsonObject {
        put("version", version)
        put("host", host)
        put("cut", cut)
        error?.let { put("error", it.wire) }
        putJsonArray("fields") {
            for (field in fields) {
                add(buildJsonObject {
                    put("name", field.name)
                    put("status", field.status.wire)
                    field.value?.let { put("value", it) }
                    field.confidence?.let { put("confidence", it) }
                    field.sourceLine?.let { put("sourceLine", it) }
                    field.notFound?.let { put("notFound", it) }
                })
            }
        }
    }

    companion object {
        const val VERSION = 1
        const val TOOL_NAME = "web_fetch"
        const val MAX_FIELDS = 16
        const val MAX_HOST_LENGTH = 253
        const val MAX_VALUE_LENGTH = 200
        const val MAX_SOURCE_LINE_LENGTH = 200
        private val FIELD_NAME = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")

        /** The whitespace JavaScript's `\s` matches, so phones accept what the desktop accepts. */
        private val LINE_BREAKING_SPACES: Set<Int> = setOf(
            0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
            0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029,
            0x202F, 0x205F, 0x3000, 0xFEFF
        )

        /**
         * Lenient decode: anything malformed yields null so the step (and the
         * chat) still render, just without the recap.
         */
        fun fromJson(element: JsonElement): AidenWebExtractRecap? {
            val obj = element as? JsonObject ?: return null
            val version = obj["version"].numberOrNull()?.intOrNull ?: return null
            val host = obj["host"].stringOrNull() ?: return null
            val cut = obj["cut"].numberOrNull()?.booleanOrNull ?: return null
            val error = if (obj.containsKey("error")) {
                val wire = obj["error"].stringOrNull() ?: return null
                Failure.entries.firstOrNull { it.wire == wire } ?: return null
            } else {
                null
            }
            val rawFields = obj["fields"] as? JsonArray ?: return null
            if (rawFields.size > MAX_FIELDS) return null
            val fields = rawFields.map { raw ->
                val field = raw as? JsonObject ?: return null
                val statusWire = field["status"].stringOrNull() ?: return null
                Field(
                    name = field["name"].stringOrNull() ?: return null,
                    status = Status.entries.firstOrNull { it.wire == statusWire } ?: return null,
                    value = if (field.containsKey("value")) field["value"].stringOrNull() ?: return null else null,
                    confidence = if (field.containsKey("confidence")) {
                        field["confidence"].numberOrNull()?.doubleOrNull ?: return null
                    } else {
                        null
                    },
                    sourceLine = if (field.containsKey("sourceLine")) {
                        field["sourceLine"].stringOrNull() ?: return null
                    } else {
                        null
                    },
                    notFound = if (field.containsKey("notFound")) {
                        field["notFound"].numberOrNull()?.booleanOrNull ?: return null
                    } else {
                        null
                    }
                )
            }
            return AidenWebExtractRecap(version, host, cut, error, fields).takeIf { it.isValid }
        }

        private fun JsonElement?.stringOrNull(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** A non-string primitive (number or boolean); JSON null reads as missing. */
        private fun JsonElement?.numberOrNull(): JsonPrimitive? =
            (this as? JsonPrimitive)?.takeIf { !it.isString && it.content != "null" }

        /**
         * Non-empty, within [maximum] code points, free of control characters, and
         * spaced only by single U+0020 spaces with none at either end.
         */
        private fun isOneLine(value: String, maximum: Int): Boolean {
            if (value.isEmpty() || value.codePointCount(0, value.length) > maximum) return false
            if (value.first() == ' ' || value.last() == ' ') return false
            var previousWasSpace = false
            var offset = 0
            while (offset < value.length) {
                val codePoint = value.codePointAt(offset)
                if (codePoint < 32 || codePoint == 127 || codePoint in LINE_BREAKING_SPACES) return false
                val isSpace = codePoint == ' '.code
                if (isSpace && previousWasSpace) return false
                previousWasSpace = isSpace
                offset += Character.charCount(codePoint)
            }
            return true
        }
    }
}

/**
 * Decodes a step's `extraction` without ever failing the step: a malformed
 * recap becomes null. Encodes the validated shape back for the chat cache.
 */
object AidenWebExtractRecapSerializer : KSerializer<AidenWebExtractRecap?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor.nullable

    override fun deserialize(decoder: Decoder): AidenWebExtractRecap? {
        val json = decoder as? JsonDecoder ?: throw SerializationException("extract recaps decode from JSON only")
        return AidenWebExtractRecap.fromJson(json.decodeJsonElement())
    }

    override fun serialize(encoder: Encoder, value: AidenWebExtractRecap?) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("extract recaps encode to JSON only")
        if (value == null) json.encodeNull() else json.encodeJsonElement(value.toJson())
    }
}
