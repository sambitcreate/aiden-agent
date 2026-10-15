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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol

/**
 * What the owner chose in a settled `ask_user_question` card, carried on that
 * tool's completed timeline step so the transcript can show the questions and
 * answers in place of the generic activity line. Mirrors the desktop's
 * `AskUserQuestionRecapV1` and its `parseAskUserQuestionRecap` rules.
 */
@Immutable
data class AidenQuestionnaireRecap(
    val version: Int,
    val outcome: Outcome,
    val items: List<Item>
) {
    /** `dismissed`: the owner closed the card. `expired`: the agent stopped waiting. */
    enum class Outcome(val wire: String) { ANSWERED("answered"), DISMISSED("dismissed"), EXPIRED("expired") }

    enum class ItemKind(val wire: String) { OPTION("option"), MULTI("multi"), CUSTOM("custom"), SKIPPED("skipped") }

    @Immutable
    data class Item(
        val question: String,
        val header: String,
        val kind: ItemKind,
        val answers: List<String>
    )

    /** How one item's answer reads beneath its question. */
    sealed interface Answer {
        /** One option label, or a multi-select's labels joined with ", ". */
        data class Choice(val text: String) : Answer
        /** The owner's own words, shown quoted. */
        data class Custom(val text: String) : Answer
        /** No answer; the label depends on why ([Outcome]). */
        data class Unanswered(val outcome: Outcome) : Answer
    }

    fun answer(item: Item): Answer = when (item.kind) {
        ItemKind.SKIPPED -> Answer.Unanswered(outcome)
        ItemKind.CUSTOM -> Answer.Custom(item.answers.first())
        ItemKind.OPTION, ItemKind.MULTI -> Answer.Choice(item.answers.joinToString(", "))
    }

    val isValid: Boolean
        get() = version == VERSION &&
            items.size in 1..AidenRemoteProtocol.MAX_QUESTION_COUNT &&
            items.all { item ->
                isRecapString(item.question, AidenRemoteProtocol.MAX_QUESTION_LENGTH) &&
                    isRecapString(item.header, AidenRemoteProtocol.MAX_QUESTION_HEADER_LENGTH) &&
                    when (item.kind) {
                        ItemKind.SKIPPED -> item.answers.isEmpty()
                        ItemKind.OPTION -> outcome == Outcome.ANSWERED && item.answers.size == 1 &&
                            isRecapString(item.answers[0], AidenRemoteProtocol.MAX_QUESTION_OPTION_LABEL_LENGTH)
                        ItemKind.MULTI -> outcome == Outcome.ANSWERED &&
                            item.answers.size in 1..AidenRemoteProtocol.MAX_QUESTION_OPTIONS &&
                            item.answers.toSet().size == item.answers.size &&
                            item.answers.all { isRecapString(it, AidenRemoteProtocol.MAX_QUESTION_OPTION_LABEL_LENGTH) }
                        ItemKind.CUSTOM -> outcome == Outcome.ANSWERED && item.answers.size == 1 &&
                            isRecapString(item.answers[0], MAX_CUSTOM_LENGTH)
                    }
            }

    fun toJson(): JsonObject = buildJsonObject {
        put("version", version)
        put("outcome", outcome.wire)
        putJsonArray("items") {
            for (item in items) {
                add(buildJsonObject {
                    put("question", item.question)
                    put("header", item.header)
                    put("kind", item.kind.wire)
                    putJsonArray("answers") { item.answers.forEach { add(it) } }
                })
            }
        }
    }

    companion object {
        const val VERSION = 1
        const val TOOL_NAME = "ask_user_question"
        /** Longest custom answer a recap keeps; the host clips longer text. */
        const val MAX_CUSTOM_LENGTH = 1_000

        /**
         * Lenient decode: anything malformed yields null so the step (and the
         * chat) still render, just without the recap.
         */
        fun fromJson(element: JsonElement): AidenQuestionnaireRecap? {
            val obj = element as? JsonObject ?: return null
            val version = (obj["version"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull ?: return null
            val outcomeWire = obj["outcome"].stringOrNull() ?: return null
            val outcome = Outcome.entries.firstOrNull { it.wire == outcomeWire } ?: return null
            val rawItems = obj["items"] as? JsonArray ?: return null
            if (rawItems.size !in 1..AidenRemoteProtocol.MAX_QUESTION_COUNT) return null
            val items = rawItems.map { raw ->
                val item = raw as? JsonObject ?: return null
                val kindWire = item["kind"].stringOrNull() ?: return null
                val answers = (item["answers"] as? JsonArray ?: return null).map { it.stringOrNull() ?: return null }
                Item(
                    question = item["question"].stringOrNull() ?: return null,
                    header = item["header"].stringOrNull() ?: return null,
                    kind = ItemKind.entries.firstOrNull { it.wire == kindWire } ?: return null,
                    answers = answers
                )
            }
            return AidenQuestionnaireRecap(version, outcome, items).takeIf { it.isValid }
        }

        private fun JsonElement?.stringOrNull(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** Non-blank, within [maximum] code points, and free of C0 controls (tab and newline aside) and DEL. */
        private fun isRecapString(value: String, maximum: Int): Boolean =
            value.isNotBlank() &&
                value.codePointCount(0, value.length) <= maximum &&
                value.none { (it.code < 32 && it.code != 9 && it.code != 10) || it.code == 127 }
    }
}

/**
 * Decodes a step's `questionnaire` without ever failing the step: a malformed
 * recap becomes null. Encodes the validated shape back for the chat cache.
 */
object AidenQuestionnaireRecapSerializer : KSerializer<AidenQuestionnaireRecap?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor.nullable

    override fun deserialize(decoder: Decoder): AidenQuestionnaireRecap? {
        val json = decoder as? JsonDecoder ?: throw SerializationException("questionnaire recaps decode from JSON only")
        return AidenQuestionnaireRecap.fromJson(json.decodeJsonElement())
    }

    override fun serialize(encoder: Encoder, value: AidenQuestionnaireRecap?) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("questionnaire recaps encode to JSON only")
        if (value == null) json.encodeNull() else json.encodeJsonElement(value.toJson())
    }
}
