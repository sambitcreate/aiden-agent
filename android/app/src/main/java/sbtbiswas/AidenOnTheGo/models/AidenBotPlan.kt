package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.*
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.*
import kotlinx.serialization.json.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

@Serializable enum class AidenBotPlanStatus { @SerialName("pending") PENDING, @SerialName("active") ACTIVE, @SerialName("finished") FINISHED, @SerialName("stopped") STOPPED, @SerialName("expired") EXPIRED }
@Serializable enum class AidenBotPlanStepStatus { @SerialName("pending") PENDING, @SerialName("done") DONE, @SerialName("skipped") SKIPPED }
@Serializable enum class AidenBotPlanDecision { @SerialName("approve") APPROVE, @SerialName("not_now") NOT_NOW, @SerialName("stop") STOP }

/** Display-only plan. Private proposal, Bot, revision and item identities never cross. */
@Serializable(with = AidenBotPlanSerializer::class)
data class AidenRemoteBotPlan(
    val planId: String, val status: AidenBotPlanStatus, val title: String, val why: String,
    val steps: List<Step>, val items: List<Item>, val expiresAt: String? = null, val from: String? = null
) {
    data class Step(val text: String, val status: AidenBotPlanStepStatus)
    data class Item(val line: String, val details: List<String>, val used: Int? = null, val max: Int? = null)
    val completedSteps: Int get() = steps.count { it.status != AidenBotPlanStepStatus.PENDING }
    val expiry: Instant? get() = expiresAt?.let(AidenBotPlanWire::timestamp)
    fun allows(decision: AidenBotPlanDecision): Boolean = if (status == AidenBotPlanStatus.PENDING) decision != AidenBotPlanDecision.STOP else status == AidenBotPlanStatus.ACTIVE && decision == AidenBotPlanDecision.STOP
    fun toJson(): JsonObject = buildJsonObject {
        put("planId", planId); put("status", status.name.lowercase()); put("title", title); put("why", why)
        put("steps", JsonArray(steps.map { buildJsonObject { put("text", it.text); put("status", it.status.name.lowercase()) } }))
        put("items", JsonArray(items.map { item -> buildJsonObject {
            put("line", item.line); put("details", JsonArray(item.details.map(::JsonPrimitive)))
            item.used?.let { put("used", it) }; item.max?.let { put("max", it) }
        } }))
        expiresAt?.let { put("expiresAt", it) }; from?.let { put("from", it) }
    }
    companion object {
        fun parse(element: JsonElement): AidenRemoteBotPlan {
            val body = AidenBotPlanWire.objectKeys(element, setOf("planId", "status", "title", "why", "steps", "items", "expiresAt", "from"))
            val id = AidenBotPlanWire.text(body, "planId", 64).also(AidenBotPlanWire::id)
            val status = AidenBotWireJson.json.decodeFromJsonElement(AidenBotPlanStatus.serializer(), body.getValue("status"))
            val steps = (body["steps"] as? JsonArray)?.takeIf { it.size in 1..10 } ?: AidenBotPlanWire.invalid()
            val items = (body["items"] as? JsonArray)?.takeIf { it.size in 1..8 } ?: AidenBotPlanWire.invalid()
            return AidenRemoteBotPlan(id, status, AidenBotPlanWire.text(body, "title", 80), AidenBotPlanWire.text(body, "why", 300),
                steps.map { step ->
                    val fields = AidenBotPlanWire.objectKeys(step, setOf("text", "status"))
                    Step(AidenBotPlanWire.text(fields, "text", 200), AidenBotWireJson.json.decodeFromJsonElement(AidenBotPlanStepStatus.serializer(), fields.getValue("status")))
                }, items.map { item ->
                    val fields = AidenBotPlanWire.objectKeys(item, setOf("line", "details", "used", "max"))
                    val details = (fields["details"] as? JsonArray)?.takeIf { it.size <= 6 } ?: AidenBotPlanWire.invalid()
                    val counted = "used" in fields || "max" in fields
                    fun count(key: String): Int = (fields[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull ?: AidenBotPlanWire.invalid()
                    val used = if (counted) count("used") else null
                    val max = if (counted) count("max") else null
                    if (counted && (used!! < 0 || max!! !in 1..25 || used > max)) AidenBotPlanWire.invalid()
                    Item(AidenBotPlanWire.text(fields, "line", 120), details.map { AidenBotPlanWire.displayText(it, 160) }, used, max)
                }, body["expiresAt"]?.let { AidenBotPlanWire.displayText(it, 80).also(AidenBotPlanWire::timestamp) },
                body["from"]?.let { AidenBotPlanWire.displayText(it, 120) })
        }
    }
}
internal object AidenBotPlanWire {
    private val controls = Regex("[\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB]")
    fun invalid(): Nothing = throw AidenBotContractException.InvalidField("plan")
    fun objectKeys(element: JsonElement, allowed: Set<String>): JsonObject = (element as? JsonObject)?.takeIf { it.keys.all(allowed::contains) } ?: invalid()
    fun displayText(element: JsonElement, maximum: Int): String {
        val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalid()
        if (value.isBlank() || value.codePointCount(0, value.length) > maximum || controls.containsMatchIn(value)) invalid()
        return value
    }
    fun text(body: JsonObject, key: String, maximum: Int): String = displayText(body[key] ?: invalid(), maximum)
    fun id(value: String) { if (!Regex("^[A-Za-z0-9-]{1,64}$").matches(value)) invalid() }
    fun timestamp(value: String): Instant {
        val match = Regex("^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:\\d{2})$").matchEntire(value) ?: invalid()
        val parts = match.groupValues
        val offset = parts[8]
        val hours = if (offset == "Z") 0 else offset.substring(1, 3).toInt()
        val minutes = if (offset == "Z") 0 else offset.substring(4, 6).toInt()
        if (hours > 23 || minutes > 59) invalid()
        val signedSeconds = (hours * 60L + minutes) * 60 * if (offset.startsWith("-")) -1 else 1
        return try {
            // LocalDateTime validates the calendar and leap year. Apply the host's full offset
            // range ourselves, since Java's ZoneOffset only permits offsets through 18:00.
            LocalDateTime.of(parts[1].toInt(), parts[2].toInt(), parts[3].toInt(), parts[4].toInt(), parts[5].toInt(), parts[6].toInt(), parts[7].padEnd(9, '0').take(9).toInt())
                .toInstant(ZoneOffset.UTC).minusSeconds(signedSeconds)
        } catch (_: Exception) { invalid() }
    }
}
object AidenBotPlanSerializer : KSerializer<AidenRemoteBotPlan> {
    override val descriptor = buildClassSerialDescriptor("AidenRemoteBotPlan")
    override fun serialize(encoder: Encoder, value: AidenRemoteBotPlan) = (encoder as JsonEncoder).encodeJsonElement(value.toJson())
    override fun deserialize(decoder: Decoder) = AidenRemoteBotPlan.parse((decoder as JsonDecoder).decodeJsonElement())
}
@Serializable data class AidenBotPlanRespondRequest(val decision: AidenBotPlanDecision)
@Serializable(with = AidenBotPlanRespondReceiptSerializer::class)
data class AidenBotPlanRespondReceipt(val planId: String, val status: AidenBotPlanStatus)
object AidenBotPlanRespondReceiptSerializer : KSerializer<AidenBotPlanRespondReceipt> {
    override val descriptor = buildClassSerialDescriptor("AidenBotPlanRespondReceipt")
    override fun serialize(encoder: Encoder, value: AidenBotPlanRespondReceipt) = (encoder as JsonEncoder).encodeJsonElement(buildJsonObject { put("planId", value.planId); put("status", value.status.name.lowercase()) })
    override fun deserialize(decoder: Decoder): AidenBotPlanRespondReceipt {
        val fields = AidenBotPlanWire.objectKeys((decoder as JsonDecoder).decodeJsonElement(), setOf("planId", "status"))
        val id = AidenBotPlanWire.text(fields, "planId", 64).also(AidenBotPlanWire::id)
        val status = AidenBotWireJson.json.decodeFromJsonElement(AidenBotPlanStatus.serializer(), fields.getValue("status"))
        if (status == AidenBotPlanStatus.PENDING) AidenBotPlanWire.invalid()
        return AidenBotPlanRespondReceipt(id, status)
    }
}
