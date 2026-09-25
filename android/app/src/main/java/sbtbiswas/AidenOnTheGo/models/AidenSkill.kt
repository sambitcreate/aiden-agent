package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

/** Aiden On The Go invocable-skill wire DTOs (GET /chats/{chatId}/skills and
 * the `skill` field on POST /chats/{chatId}/turns). Entries carry the same
 * bounded, renderer-safe projection the desktop slash palette consumes: an
 * opaque invocation lease plus safe display metadata — never skill paths,
 * instructions, fingerprints, or registry internals. */
@Serializable
enum class AidenRemoteSkillSource(val rawValue: String) {
    @SerialName("configured") CONFIGURED("configured"),
    @SerialName("workspace") WORKSPACE("workspace"),
    @SerialName("global") GLOBAL("global");

    companion object {
        fun fromRaw(value: String): AidenRemoteSkillSource? = entries.firstOrNull { it.rawValue == value }
    }
}

data class AidenRemoteSkillCatalogEntry(
    val invocationId: String,
    val name: String,
    val description: String,
    val source: AidenRemoteSkillSource,
    val available: Boolean,
    val unavailableReason: String?
)

data class AidenRemoteSkillCatalog(
    val skills: List<AidenRemoteSkillCatalogEntry>
)

/** Opaque invocation lease redeemed on POST /chats/{chatId}/turns. The Mac
 * resolves, expands, and binds it to the appended user message exactly like a
 * desktop slash selection; the client never expands skill content itself. */
@Serializable
data class AidenSkillInvocation(
    val version: Int = 1,
    val invocationId: String,
    val displayName: String,
    val source: AidenRemoteSkillSource
) {
    constructor(entry: AidenRemoteSkillCatalogEntry) : this(
        invocationId = entry.invocationId,
        displayName = entry.name,
        source = entry.source
    )
}

/** Strict skill-catalog codec enforcing the same bounds the host validates:
 * ≤500 unique leases, bounded display fields, and a reason exactly when the
 * entry is unavailable. */
object AidenSkillContractCodec {
    const val MAX_ENTRIES = 500
    private const val MAX_INVOCATION_ID_LENGTH = 64
    private const val MAX_NAME_LENGTH = 80
    private const val MAX_DESCRIPTION_LENGTH = 240
    private const val MAX_UNAVAILABLE_REASON_LENGTH = 160
    private val invocationIdFormat = Regex("^sk1_[A-Za-z0-9_-]{43}$")

    fun parseCatalog(element: JsonElement, label: String = "Skill catalog"): AidenRemoteSkillCatalog {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("skills"), label)
        val skills = obj.requiredArray("skills", label)
        if (skills.size > MAX_ENTRIES) invalid("$label.skills")
        val entries = skills.mapIndexed { index, value ->
            parseEntry(value, "$label.skills[$index]")
        }
        if (entries.map { it.invocationId }.toSet().size != entries.size) {
            invalid("$label.skills")
        }
        return AidenRemoteSkillCatalog(skills = entries)
    }

    private fun parseEntry(element: JsonElement, label: String): AidenRemoteSkillCatalogEntry {
        val obj = element.asObject(label)
        assertExactKeys(
            obj,
            setOf("invocationId", "name", "description", "source", "available", "unavailableReason"),
            label
        )
        val invocationId = obj.requiredString("invocationId", label, MAX_INVOCATION_ID_LENGTH)
        if (!invocationIdFormat.matches(invocationId)) invalid("$label.invocationId")
        val source = AidenRemoteSkillSource.fromRaw(
            obj.requiredString("source", label, 16)
        ) ?: invalid("$label.source")
        val available = obj.requiredBoolean("available", label)
        val unavailableReason = if (obj.containsKey("unavailableReason")) {
            obj.requiredString("unavailableReason", label, MAX_UNAVAILABLE_REASON_LENGTH)
        } else {
            null
        }
        if (available != (unavailableReason == null)) invalid("$label.unavailableReason")
        return AidenRemoteSkillCatalogEntry(
            invocationId = invocationId,
            name = obj.requiredString("name", label, MAX_NAME_LENGTH),
            // A skill with no description frontmatter legitimately projects "".
            description = obj.requiredString("description", label, MAX_DESCRIPTION_LENGTH, allowEmpty = true),
            source = source,
            available = available,
            unavailableReason = unavailableReason
        )
    }

    private fun JsonElement.asObject(label: String): JsonObject = this as? JsonObject
        ?: invalid("$label must be an object")

    private fun assertExactKeys(obj: JsonObject, allowed: Set<String>, label: String) {
        val unsupported = obj.keys.firstOrNull { it !in allowed }
        if (unsupported != null) invalid("$label field $unsupported")
    }

    private fun JsonObject.requiredArray(key: String, label: String): JsonArray = this[key] as? JsonArray
        ?: invalid("$label missing $key")

    private fun JsonObject.requiredString(key: String, label: String, maxLength: Int, allowEmpty: Boolean = false): String {
        val primitive = this[key] as? JsonPrimitive ?: invalid("$label missing $key")
        if (!primitive.isString) invalid("$label $key")
        val value = primitive.content
        if ((!allowEmpty && value.isEmpty()) || value.codePointCount(0, value.length) > maxLength) invalid("$label $key")
        return value
    }

    private fun JsonObject.requiredBoolean(key: String, label: String): Boolean {
        val primitive = this[key] as? JsonPrimitive ?: invalid("$label missing $key")
        return primitive.booleanOrNull ?: invalid("$label $key")
    }

    private fun invalid(field: String): Nothing = throw AidenRemoteContractException.UnsafePayloadField(field)
}
