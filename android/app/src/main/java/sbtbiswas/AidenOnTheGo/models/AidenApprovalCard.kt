package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Aiden Remote contract revision 61 (provisional), `approval:cards`: the typed approval card the
// desktop draws, sent to a holder beside the summary fields of a stream approval, a phone's run
// `approval_required` (and gap snapshot), and a Bot session approval. It mirrors
// `parseAidenRemoteApprovalCard` in `main/services/aiden-remote-bot-ux.ts`: exact keys, bounded
// text, Deny first, and `allowOnMac` exactly when the card offers no allow button.

/** Thrown for any card, entry or settings payload that breaks the revision-61 contract. */
class AidenBotUxContractException(field: String) : IllegalArgumentException("Invalid $field")

enum class AidenApprovalCardKind(val wire: String) {
    GENERIC("generic"), EXPLICIT("explicit"), MAC("mac"), BATCH("batch"), HELD_CHANGE("held_change"), SCHEDULE("schedule")
}

enum class AidenApprovalCardMac(val wire: String) { SHELL("shell"), FILES("files"), COMPUTER_USE("computer_use") }

enum class AidenApprovalCardTextFormat(val wire: String) { COMMAND("command"), TEXT("text") }

data class AidenApprovalCardText(val format: AidenApprovalCardTextFormat, val text: String)
data class AidenApprovalCardArgument(val key: String, val value: String)
data class AidenApprovalCardRow(val label: String, val value: String)

/**
 * One of the card's buttons. [scope] is null for a one-time allow and for Deny; [answered] is the
 * status line the card shows once this answer is given ("Allowed once", "Denied").
 */
data class AidenApprovalCardButton(
    val label: String,
    val decision: AidenApprovalDecision,
    val scope: AidenApprovalScope?,
    val answered: String
) {
    /** The scope this button answers with: a button without one allows once. */
    val effectiveScope: AidenApprovalScope get() = scope ?: AidenApprovalScope.ONCE
}

/** What a typed card settles to once a button is tapped: its title and the button's answered line. */
data class AidenApprovalAnsweredLine(val approvalId: String, val title: String, val answered: String)

data class AidenApprovalCard(
    val kind: AidenApprovalCardKind,
    val mac: AidenApprovalCardMac?,
    val title: String,
    /** Rakazo order: short values first. */
    val arguments: List<AidenApprovalCardArgument>,
    val body: AidenApprovalCardText?,
    val previous: AidenApprovalCardText?,
    val rows: List<AidenApprovalCardRow>?,
    val notes: List<String>?,
    /** Deny first, then the allow buttons the desktop offers. */
    val buttons: List<AidenApprovalCardButton>,
    /** Present exactly when this device may only deny: why, and where to allow it. */
    val allowOnMac: String?
) {
    val denyButton: AidenApprovalCardButton get() = buttons.first()
    val allowButtons: List<AidenApprovalCardButton> get() = buttons.filter { it.decision == AidenApprovalDecision.ALLOW }

    /** `canAllow` for a holder: the card has an allow button. */
    val hasAllow: Boolean get() = allowButtons.isNotEmpty()

    /** The button that answers [decision] with [scope], or null when the card offers no such answer. */
    fun button(decision: AidenApprovalDecision, scope: AidenApprovalScope = AidenApprovalScope.ONCE): AidenApprovalCardButton? =
        if (decision == AidenApprovalDecision.DENY) denyButton.takeIf { scope == AidenApprovalScope.ONCE }
        else allowButtons.firstOrNull { it.effectiveScope == scope }

    /**
     * The card as a device that may not allow it reads it: Deny alone, saying where to allow it.
     * Used when this phone lacks the grant the allow needs, though the Mac would take it.
     */
    fun denyOnly(reason: String = ALLOW_ON_MAC): AidenApprovalCard =
        if (!hasAllow) this else copy(buttons = listOf(denyButton), allowOnMac = allowOnMac ?: reason)

    /**
     * The card as a Bot approval's route can answer it. `POST /approvals/{waitId}/respond` for a
     * Bot takes a one-time allow or Always, so an allow in any other scope is never shown; with no
     * allow left the card is Deny alone, saying where to allow it.
     */
    fun forBotRoute(): AidenApprovalCard {
        val kept = buttons.filter {
            it.decision == AidenApprovalDecision.DENY || it.effectiveScope == AidenApprovalScope.ONCE || it.effectiveScope == AidenApprovalScope.ALWAYS
        }
        if (kept.size == buttons.size) return this
        return if (kept.any { it.decision == AidenApprovalDecision.ALLOW }) copy(buttons = kept)
        else copy(buttons = kept, allowOnMac = allowOnMac ?: ALLOW_ON_MAC)
    }

    /** The card without its Always button, for a Bot approval this device can't make standing. */
    fun withoutAlways(): AidenApprovalCard =
        copy(buttons = buttons.filter { it.scope != AidenApprovalScope.ALWAYS })

    /** `approvalCardAllows`: an allow with [scope] is on one of the card's buttons. */
    fun allows(scope: AidenApprovalScope = AidenApprovalScope.ONCE): Boolean =
        allowButtons.any { it.effectiveScope == scope }

    fun toJson(): JsonObject = buildJsonObject {
        put("kind", kind.wire)
        mac?.let { put("mac", it.wire) }
        put("title", title)
        put("arguments", buildJsonArray { arguments.forEach { add(buildJsonObject { put("key", it.key); put("value", it.value) }) } })
        body?.let { put("body", it.json()) }
        previous?.let { put("previous", it.json()) }
        rows?.let { list -> put("rows", buildJsonArray { list.forEach { add(buildJsonObject { put("label", it.label); put("value", it.value) }) } }) }
        notes?.let { list -> put("notes", buildJsonArray { list.forEach { add(JsonPrimitive(it)) } }) }
        put("buttons", buildJsonArray {
            buttons.forEach { button ->
                add(buildJsonObject {
                    put("label", button.label)
                    put("decision", if (button.decision == AidenApprovalDecision.ALLOW) "allow" else "deny")
                    button.scope?.let { put("scope", it.wireName) }
                    put("answered", button.answered)
                })
            }
        })
        allowOnMac?.let { put("allowOnMac", it) }
    }

    private fun AidenApprovalCardText.json() = buildJsonObject { put("format", format.wire); put("text", text) }

    companion object {
        const val MAX_TITLE = 200
        const val MAX_ARGUMENTS = 16
        const val MAX_KEY = 40
        const val MAX_VALUE = 500
        const val MAX_BODY = 16_000
        const val MAX_ROWS = 60
        const val MAX_NOTES = 6
        const val MAX_NOTE = 400
        const val MAX_BUTTONS = 5
        const val MAX_BUTTON_TEXT = 80
        const val MAX_ALLOW_ON_MAC = 120
        /** The desktop's own line for a card a phone can only deny. */
        const val ALLOW_ON_MAC = "Allow it on your Mac."
        /** Why a task card is Deny-only on a phone without `schedule:write` (the summary card's own note). */
        const val SCHEDULE_WRITE_REQUIRED = "Schedule write access is required to approve this task."

        private val CARD_KEYS = setOf("kind", "mac", "title", "arguments", "body", "previous", "rows", "notes", "buttons", "allowOnMac")

        /** Strict parse, as a revision-61 client decodes the card. Throws [AidenBotUxContractException]. */
        fun parse(element: JsonElement): AidenApprovalCard {
            val obj = BotUxJson.obj(element, "card", CARD_KEYS)
            val kind = BotUxJson.member(obj["kind"], "card.kind", AidenApprovalCardKind.entries) { it.wire }
            if (obj.containsKey("mac") && kind != AidenApprovalCardKind.MAC) throw AidenBotUxContractException("card.mac")
            val buttonsJson = BotUxJson.array(obj["buttons"], "card.buttons", MAX_BUTTONS)
            if (buttonsJson.isEmpty()) throw AidenBotUxContractException("card.buttons")
            val buttons = buttonsJson.mapIndexed { index, raw -> parseButton(raw, index) }
            val allows = buttons.any { it.decision == AidenApprovalDecision.ALLOW }
            if (obj.containsKey("allowOnMac") == allows) throw AidenBotUxContractException("card.allowOnMac")
            return AidenApprovalCard(
                kind = kind,
                mac = obj["mac"]?.let { BotUxJson.member(it, "card.mac", AidenApprovalCardMac.entries) { m -> m.wire } },
                title = BotUxJson.text(obj["title"], "card.title", MAX_TITLE),
                arguments = BotUxJson.array(obj["arguments"], "card.arguments", MAX_ARGUMENTS).map { raw ->
                    val argument = BotUxJson.obj(raw, "card.argument", setOf("key", "value"))
                    AidenApprovalCardArgument(
                        key = BotUxJson.text(argument["key"], "card.argument.key", MAX_KEY),
                        value = BotUxJson.text(argument["value"], "card.argument.value", MAX_VALUE)
                    )
                },
                body = obj["body"]?.let { parseText(it, "card.body") },
                previous = obj["previous"]?.let { parseText(it, "card.previous") },
                rows = obj["rows"]?.let { raw ->
                    BotUxJson.array(raw, "card.rows", MAX_ROWS).map { rowRaw ->
                        val row = BotUxJson.obj(rowRaw, "card.row", setOf("label", "value"))
                        AidenApprovalCardRow(
                            label = BotUxJson.text(row["label"], "card.row.label", MAX_KEY * 2),
                            value = BotUxJson.text(row["value"], "card.row.value", MAX_VALUE, blank = true)
                        )
                    }
                },
                notes = obj["notes"]?.let { raw ->
                    BotUxJson.array(raw, "card.notes", MAX_NOTES).map { BotUxJson.text(it, "card.note", MAX_NOTE) }
                },
                buttons = buttons,
                allowOnMac = obj["allowOnMac"]?.let { BotUxJson.text(it, "card.allowOnMac", MAX_ALLOW_ON_MAC) }
            )
        }

        private fun parseText(element: JsonElement, field: String): AidenApprovalCardText {
            val obj = BotUxJson.obj(element, field, setOf("format", "text"))
            return AidenApprovalCardText(
                format = BotUxJson.member(obj["format"], "$field.format", AidenApprovalCardTextFormat.entries) { it.wire },
                text = BotUxJson.text(obj["text"], "$field.text", MAX_BODY)
            )
        }

        private fun parseButton(element: JsonElement, index: Int): AidenApprovalCardButton {
            val obj = BotUxJson.obj(element, "card.button", setOf("label", "decision", "scope", "answered"))
            val decision = when (BotUxJson.string(obj["decision"], "card.button.decision")) {
                "allow" -> AidenApprovalDecision.ALLOW
                "deny" -> AidenApprovalDecision.DENY
                else -> throw AidenBotUxContractException("card.button.decision")
            }
            if (obj.containsKey("scope") && decision != AidenApprovalDecision.ALLOW) throw AidenBotUxContractException("card.button.scope")
            if (index == 0 && decision != AidenApprovalDecision.DENY) throw AidenBotUxContractException("card.buttons")
            return AidenApprovalCardButton(
                label = BotUxJson.text(obj["label"], "card.button.label", MAX_BUTTON_TEXT),
                decision = decision,
                scope = obj["scope"]?.let { raw ->
                    when (BotUxJson.string(raw, "card.button.scope")) {
                        "chat" -> AidenApprovalScope.CHAT
                        "always" -> AidenApprovalScope.ALWAYS
                        else -> throw AidenBotUxContractException("card.button.scope")
                    }
                },
                answered = BotUxJson.text(obj["answered"], "card.button.answered", MAX_BUTTON_TEXT)
            )
        }

        /**
         * A stream or run approval's summary fields must agree with its card: `canAllow` is exactly
         * whether the card has an allow button, and every offered scope is one a button offers.
         * Mirrors `parsePhoneApprovalCard` in `aiden-remote-protocol.ts`.
         */
        fun requireAgrees(card: AidenApprovalCard, canAllow: Boolean, scopes: List<String>?) {
            if (canAllow != card.hasAllow) throw AidenBotUxContractException("canAllow")
            scopes?.forEach { name ->
                val scope = AidenApprovalScope.entries.firstOrNull { it.wireName == name } ?: throw AidenBotUxContractException("scopes")
                if (!card.allows(scope)) throw AidenBotUxContractException("scopes")
            }
        }
    }
}

/** Reads and writes [AidenApprovalCard] through its strict parser, for kotlinx DTOs that carry one. */
object AidenApprovalCardSerializer : KSerializer<AidenApprovalCard> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AidenApprovalCard")
    override fun serialize(encoder: Encoder, value: AidenApprovalCard) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("Approval cards are JSON only")
        json.encodeJsonElement(value.toJson())
    }
    override fun deserialize(decoder: Decoder): AidenApprovalCard {
        val json = decoder as? JsonDecoder ?: throw SerializationException("Approval cards are JSON only")
        return AidenApprovalCard.parse(json.decodeJsonElement())
    }
}

/** Strict JSON readers for revision 61, matching the host's `text`, `member` and `list` helpers. */
internal object BotUxJson {
    fun obj(element: JsonElement?, field: String, keys: Set<String>): JsonObject {
        val obj = element as? JsonObject ?: throw AidenBotUxContractException(field)
        if (!keys.containsAll(obj.keys)) throw AidenBotUxContractException(field)
        return obj
    }

    fun string(element: JsonElement?, field: String): String =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw AidenBotUxContractException(field)

    /** A string of at most [max] code points; blank only when [blank]. */
    fun text(element: JsonElement?, field: String, max: Int, blank: Boolean = false): String {
        val value = string(element, field)
        if (value.codePointCount(0, value.length) > max) throw AidenBotUxContractException(field)
        if (!blank && value.isBlank()) throw AidenBotUxContractException(field)
        return value
    }

    fun <T> member(element: JsonElement?, field: String, values: List<T>, wire: (T) -> String): T {
        val raw = string(element, field)
        return values.firstOrNull { wire(it) == raw } ?: throw AidenBotUxContractException(field)
    }

    fun array(element: JsonElement?, field: String, max: Int): JsonArray {
        val array = element as? JsonArray ?: throw AidenBotUxContractException(field)
        if (array.size > max) throw AidenBotUxContractException(field)
        return array
    }

    fun bool(element: JsonElement?, field: String): Boolean {
        val primitive = (element as? JsonPrimitive)?.takeIf { !it.isString } ?: throw AidenBotUxContractException(field)
        return when (primitive.content) {
            "true" -> true
            "false" -> false
            else -> throw AidenBotUxContractException(field)
        }
    }

    /** A positive safe integer, unquoted. */
    fun positiveInt(element: JsonElement?, field: String): Int {
        val primitive = (element as? JsonPrimitive)?.takeIf { !it.isString } ?: throw AidenBotUxContractException(field)
        val value = primitive.content.toIntOrNull() ?: throw AidenBotUxContractException(field)
        if (value < 1) throw AidenBotUxContractException(field)
        return value
    }

    private val OPAQUE_ID = Regex("^[A-Za-z0-9._:-]{1,160}$")

    /** An id the host made (`opaque` in the host parser). */
    fun opaque(element: JsonElement?, field: String): String {
        val value = text(element, field, 160)
        if (!OPAQUE_ID.matches(value)) throw AidenBotUxContractException(field)
        return value
    }

    fun iso(element: JsonElement?, field: String): String {
        val value = text(element, field, 40)
        try {
            java.time.OffsetDateTime.parse(value)
        } catch (_: Exception) {
            throw AidenBotUxContractException(field)
        }
        return value
    }
}
