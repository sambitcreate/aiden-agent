package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.time.Instant

/** Aiden On The Go `ask_user_question` wire DTOs. The Mac owns the shared
 * grammar; decoders enforce the same bounds the host validates so a malformed
 * prompt fails closed instead of reaching the card UI. */
data class AidenRemoteQuestionOption(
    val label: String,
    val description: String
)

data class AidenRemoteQuestion(
    val question: String,
    val header: String,
    val multiSelect: Boolean,
    val options: List<AidenRemoteQuestionOption>
)

data class AidenStreamPendingQuestion(
    val promptId: String,
    val streamId: String,
    val chatId: String,
    val toolCallId: String,
    val questions: List<AidenRemoteQuestion>,
    val expiresAt: Instant
)

data class AidenStreamQuestionSnapshot(
    val question: AidenStreamPendingQuestion?
)

/** The `question_required` journal payload; stream/chat identity comes from
 * the event envelope. */
data class AidenQuestionRequiredPayload(
    val promptId: String,
    val questions: List<AidenRemoteQuestion>,
    val expiresAt: Instant
)

/** One answer per addressed question index, mirroring the shared wire union. */
sealed class AidenQuestionAnswer {
    abstract val questionIndex: Int

    data class Option(override val questionIndex: Int, val answer: String) : AidenQuestionAnswer()
    data class Custom(override val questionIndex: Int, val answer: String) : AidenQuestionAnswer()
    data class Multi(override val questionIndex: Int, val selected: List<String>) : AidenQuestionAnswer()

    fun toJson(): JsonObject {
        val fields = mutableMapOf<String, JsonElement>(
            "questionIndex" to JsonPrimitive(questionIndex)
        )
        when (this) {
            is Option -> {
                fields["kind"] = JsonPrimitive("option")
                fields["answer"] = JsonPrimitive(answer)
            }
            is Custom -> {
                fields["kind"] = JsonPrimitive("custom")
                fields["answer"] = JsonPrimitive(answer)
            }
            is Multi -> {
                fields["kind"] = JsonPrimitive("multi")
                fields["selected"] = JsonArray(selected.map { JsonPrimitive(it) })
            }
        }
        return JsonObject(fields)
    }
}

data class AidenQuestionRespondRequest(
    val cancelled: Boolean,
    val answers: List<AidenQuestionAnswer>
) {
    fun toJson(): JsonObject = JsonObject(
        mapOf(
            "cancelled" to JsonPrimitive(cancelled),
            "answers" to JsonArray(answers.map { it.toJson() })
        )
    )
}

data class AidenQuestionRespondResponse(
    val promptId: String,
    val resolvedAt: Instant
)

/** Strict question contract codec, mirroring the Mac's shared `ask_user_question`
 * grammar: 1–4 unique questions, 2–4 unique non-reserved options each, and the
 * exact response envelope shapes. */
object AidenQuestionContractCodec {
    private val reservedOptionLabels = setOf("Other", "Type something.", "Next")

    fun parsePendingQuestion(element: JsonElement, label: String = "Pending question"): AidenStreamPendingQuestion {
        val obj = element.asObject(label)
        assertExactKeys(
            obj,
            setOf("promptId", "streamId", "chatId", "toolCallId", "questions", "expiresAt"),
            label
        )
        return AidenStreamPendingQuestion(
            promptId = obj.requiredString("promptId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            streamId = obj.requiredString("streamId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            chatId = obj.requiredString("chatId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            toolCallId = obj.requiredString("toolCallId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            questions = parseQuestions(obj.requiredArray("questions", label), label),
            expiresAt = obj.requiredInstant("expiresAt", label)
        )
    }

    fun parseSnapshot(element: JsonElement, label: String = "Pending question response"): AidenStreamQuestionSnapshot {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("question"), label)
        val question = obj["question"] ?: invalid("$label missing question")
        return AidenStreamQuestionSnapshot(
            question = if (question is JsonObject) {
                parsePendingQuestion(question, "$label.question")
            } else if (question is JsonNull) {
                null
            } else {
                invalid("$label.question")
            }
        )
    }

    fun parseRequiredPayload(element: JsonElement, label: String = "question_required payload"): AidenQuestionRequiredPayload {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("promptId", "questions", "expiresAt"), label)
        return AidenQuestionRequiredPayload(
            promptId = obj.requiredString("promptId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            questions = parseQuestions(obj.requiredArray("questions", label), label),
            expiresAt = obj.requiredInstant("expiresAt", label)
        )
    }

    fun parseRespondRequest(element: JsonElement, label: String = "Question respond request"): AidenQuestionRespondRequest {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("cancelled", "answers"), label)
        val cancelled = obj.requiredBoolean("cancelled", label)
        val answers = obj.requiredArray("answers", label)
        if (answers.size > AidenRemoteProtocol.MAX_QUESTION_COUNT) invalid("$label.answers")
        return AidenQuestionRespondRequest(
            cancelled = cancelled,
            answers = answers.map { parseAnswer(it, "$label.answers") }
        )
    }

    fun parseRespondResponse(element: JsonElement, label: String = "Question respond response"): AidenQuestionRespondResponse {
        val obj = element.asObject(label)
        assertExactKeys(obj, setOf("promptId", "resolvedAt"), label)
        return AidenQuestionRespondResponse(
            promptId = obj.requiredString("promptId", label, AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH),
            resolvedAt = obj.requiredInstant("resolvedAt", label)
        )
    }

    private fun parseAnswer(element: JsonElement, label: String): AidenQuestionAnswer {
        val obj = element.asObject(label)
        val indexPrimitive = obj["questionIndex"] as? JsonPrimitive ?: invalid("$label.questionIndex")
        val index = indexPrimitive.intOrNull
        if (index == null || index < 0) invalid("$label.questionIndex")
        val kindElement = obj["kind"] as? JsonPrimitive ?: invalid("$label.kind")
        return when (val kind = if (kindElement.isString) kindElement.content else invalid("$label.kind")) {
            "option" -> {
                assertExactKeys(obj, setOf("questionIndex", "kind", "answer"), label)
                AidenQuestionAnswer.Option(
                    questionIndex = index,
                    answer = obj.requiredString("answer", label, AidenRemoteProtocol.MAX_QUESTION_OPTION_LABEL_LENGTH)
                )
            }
            "custom" -> {
                assertExactKeys(obj, setOf("questionIndex", "kind", "answer"), label)
                AidenQuestionAnswer.Custom(
                    questionIndex = index,
                    answer = obj.requiredString("answer", label, AidenRemoteProtocol.MAX_QUESTION_CUSTOM_ANSWER_LENGTH)
                )
            }
            "multi" -> {
                assertExactKeys(obj, setOf("questionIndex", "kind", "selected"), label)
                val selected = obj.requiredArray("selected", label).map { value ->
                    val primitive = value as? JsonPrimitive ?: invalid("$label.selected")
                    if (!primitive.isString || primitive.content.isEmpty() ||
                        primitive.content.codePointCount(0, primitive.content.length) >
                        AidenRemoteProtocol.MAX_QUESTION_OPTION_LABEL_LENGTH
                    ) invalid("$label.selected")
                    primitive.content
                }
                if (selected.isEmpty() || selected.size > AidenRemoteProtocol.MAX_QUESTION_OPTIONS ||
                    selected.toSet().size != selected.size
                ) invalid("$label.selected")
                AidenQuestionAnswer.Multi(questionIndex = index, selected = selected)
            }
            else -> invalid("$label.kind $kind")
        }
    }

    private fun parseQuestions(array: JsonArray, label: String): List<AidenRemoteQuestion> {
        if (array.isEmpty() || array.size > AidenRemoteProtocol.MAX_QUESTION_COUNT) {
            invalid("$label.questions")
        }
        val questions = array.mapIndexed { index, value ->
            val questionLabel = "$label.questions[$index]"
            val obj = value.asObject(questionLabel)
            assertExactKeys(obj, setOf("question", "header", "multiSelect", "options"), questionLabel)
            val question = obj.requiredString("question", questionLabel, AidenRemoteProtocol.MAX_QUESTION_LENGTH)
            val header = obj.requiredString("header", questionLabel, AidenRemoteProtocol.MAX_QUESTION_HEADER_LENGTH)
            val multiSelect = obj.requiredBoolean("multiSelect", questionLabel)
            val options = obj.requiredArray("options", questionLabel).mapIndexed { optionIndex, optionValue ->
                val optionLabel = "$questionLabel.options[$optionIndex]"
                val option = optionValue.asObject(optionLabel)
                assertExactKeys(option, setOf("label", "description"), optionLabel)
                AidenRemoteQuestionOption(
                    label = option.requiredString("label", optionLabel, AidenRemoteProtocol.MAX_QUESTION_OPTION_LABEL_LENGTH),
                    description = option.requiredString("description", optionLabel, AidenRemoteProtocol.MAX_QUESTION_OPTION_DESCRIPTION_LENGTH)
                )
            }
            if (options.size !in AidenRemoteProtocol.MIN_QUESTION_OPTIONS..AidenRemoteProtocol.MAX_QUESTION_OPTIONS ||
                options.map { it.label }.toSet().size != options.size ||
                options.any { it.label in reservedOptionLabels }
            ) invalid("$questionLabel.options")
            AidenRemoteQuestion(
                question = question,
                header = header,
                multiSelect = multiSelect,
                options = options
            )
        }
        if (questions.map { it.question }.toSet().size != questions.size) invalid("$label.questions")
        return questions
    }

    private fun JsonElement.asObject(label: String): JsonObject = this as? JsonObject
        ?: invalid("$label must be an object")

    private fun assertExactKeys(obj: JsonObject, allowed: Set<String>, label: String) {
        val unsupported = obj.keys.firstOrNull { it !in allowed }
        if (unsupported != null) invalid("$label field $unsupported")
    }

    private fun JsonObject.requiredArray(key: String, label: String): JsonArray = this[key] as? JsonArray
        ?: invalid("$label missing $key")

    private fun JsonObject.requiredString(key: String, label: String, maxLength: Int): String {
        val primitive = this[key] as? JsonPrimitive ?: invalid("$label missing $key")
        if (!primitive.isString) invalid("$label $key")
        val value = primitive.content
        if (value.isEmpty() || value.codePointCount(0, value.length) > maxLength) invalid("$label $key")
        return value
    }

    private fun JsonObject.requiredBoolean(key: String, label: String): Boolean {
        val primitive = this[key] as? JsonPrimitive ?: invalid("$label missing $key")
        return primitive.booleanOrNull ?: invalid("$label $key")
    }

    private fun JsonObject.requiredInstant(key: String, label: String): Instant {
        val value = requiredString(key, label, 80)
        return try {
            Instant.parse(value)
        } catch (_: Exception) {
            invalid("$label $key")
        }
    }

    private fun invalid(field: String): Nothing = throw AidenRemoteContractException.UnsafePayloadField(field)
}

/** Pending prompt bound to the displayed stream/chat for card presentation. */
data class AidenPendingQuestion(
    val id: String,
    val questions: List<AidenRemoteQuestion>,
    val expiresAt: Instant,
    val canRespond: Boolean
)

object AidenPendingQuestionResolution {
    fun resolve(
        question: AidenStreamPendingQuestion?,
        streamId: String,
        chatId: String,
        canRespond: Boolean = true,
        now: Instant = Instant.now()
    ): AidenPendingQuestion? {
        if (question == null ||
            question.streamId != streamId ||
            question.chatId != chatId ||
            !question.expiresAt.isAfter(now)
        ) return null
        return AidenPendingQuestion(
            id = question.promptId,
            questions = question.questions,
            expiresAt = question.expiresAt,
            canRespond = canRespond
        )
    }
}

/** Builds the wire answers from the card's selection state. A non-blank custom
 * draft wins over option selections for that question; unaddressed questions
 * are omitted so the host records them as skipped. iOS parity:
 * AidenQuestionAnswerDraft. */
object AidenQuestionAnswerDraft {
    fun answers(
        questions: List<AidenRemoteQuestion>,
        selections: Map<Int, Set<String>>,
        customAnswers: Map<Int, String>
    ): List<AidenQuestionAnswer> {
        val answers = mutableListOf<AidenQuestionAnswer>()
        questions.forEachIndexed { index, question ->
            val custom = (customAnswers[index] ?: "").trim { it.isWhitespace() }
            if (custom.isNotEmpty()) {
                answers.add(AidenQuestionAnswer.Custom(questionIndex = index, answer = custom))
                return@forEachIndexed
            }
            val selected = selections[index] ?: emptySet()
            val ordered = question.options.map { it.label }.filter { selected.contains(it) }
            if (ordered.isEmpty()) return@forEachIndexed
            if (question.multiSelect) {
                answers.add(AidenQuestionAnswer.Multi(questionIndex = index, selected = ordered))
            } else {
                answers.add(AidenQuestionAnswer.Option(questionIndex = index, answer = ordered.first()))
            }
        }
        return answers
    }

    fun toggled(
        selections: Map<Int, Set<String>>,
        questionIndex: Int,
        label: String,
        multiSelect: Boolean
    ): Map<Int, Set<String>> {
        val next = selections.toMutableMap()
        val current = (next[questionIndex] ?: emptySet()).toMutableSet()
        if (current.contains(label)) {
            current.remove(label)
        } else if (multiSelect) {
            current.add(label)
        } else {
            current.clear()
            current.add(label)
        }
        if (current.isEmpty()) next.remove(questionIndex) else next[questionIndex] = current
        return next
    }
}
