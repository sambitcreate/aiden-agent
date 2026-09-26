package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenPendingQuestionResolution
import sbtbiswas.AidenOnTheGo.models.AidenQuestionAnswer
import sbtbiswas.AidenOnTheGo.models.AidenQuestionAnswerDraft
import sbtbiswas.AidenOnTheGo.models.AidenQuestionContractCodec
import sbtbiswas.AidenOnTheGo.models.AidenQuestionRespondRequest
import sbtbiswas.AidenOnTheGo.models.AidenRemoteQuestion
import sbtbiswas.AidenOnTheGo.models.AidenRemoteQuestionOption
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import java.time.Instant

/** On The Go `ask_user_question` contract rules (iOS parity: AidenChatTests
 * question draft/resolution tests). The same decision table drives both
 * platforms. */
class AidenQuestionTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun option(label: String) = AidenRemoteQuestionOption(label, "$label description")

    private fun question(
        header: String = "Scope",
        prompt: String = "Which scope?",
        multiSelect: Boolean = false,
        options: List<AidenRemoteQuestionOption> = listOf(option("Small"), option("Large"))
    ) = AidenRemoteQuestion(
        question = prompt,
        header = header,
        multiSelect = multiSelect,
        options = options
    )

    private fun pendingJson(questions: String) = json.parseToJsonElement(
        """{
          "promptId": "q-1",
          "streamId": "stream-1",
          "chatId": "chat-1",
          "toolCallId": "tool-1",
          "questions": $questions,
          "expiresAt": "2026-08-18T19:06:10.000Z"
        }"""
    )

    private fun questionJson(
        prompt: String = "Which scope?",
        multiSelect: Boolean = false,
        options: String = """[{"label":"Small","description":"s"},{"label":"Large","description":"l"}]"""
    ) = """{"question":"$prompt","header":"Scope","multiSelect":$multiSelect,"options":$options}"""

    @Test
    fun questionDraftBuildsOptionMultiAndCustomAnswers() {
        val questions = listOf(
            question(header = "Scope", prompt = "Which scope?"),
            question(
                header = "Steps", prompt = "Which steps?", multiSelect = true,
                options = listOf(option("Lint"), option("Test"), option("Docs"))
            ),
            question(header = "Notes", prompt = "Any notes?")
        )
        val answers = AidenQuestionAnswerDraft.answers(
            questions = questions,
            selections = mapOf(0 to setOf("Large"), 1 to setOf("Lint", "Test")),
            customAnswers = mapOf(2 to "  Ship it.  ")
        )
        assertEquals(
            listOf(
                AidenQuestionAnswer.Option(questionIndex = 0, answer = "Large"),
                AidenQuestionAnswer.Multi(questionIndex = 1, selected = listOf("Lint", "Test")),
                AidenQuestionAnswer.Custom(questionIndex = 2, answer = "Ship it.")
            ),
            answers
        )
    }

    @Test
    fun questionDraftCustomAnswerOverridesSelectionAndBlanksAreSkipped() {
        val questions = listOf(question())
        val customWins = AidenQuestionAnswerDraft.answers(
            questions = questions,
            selections = mapOf(0 to setOf("Small")),
            customAnswers = mapOf(0 to "directly")
        )
        assertEquals(listOf(AidenQuestionAnswer.Custom(0, "directly")), customWins)

        val blankSkipped = AidenQuestionAnswerDraft.answers(
            questions = questions,
            selections = emptyMap(),
            customAnswers = mapOf(0 to "   ")
        )
        assertTrue(blankSkipped.isEmpty())
    }

    @Test
    fun questionDraftSingleSelectKeepsWireOrderAndFirstSelection() {
        val questions = listOf(
            question(options = listOf(option("A"), option("B"), option("C")))
        )
        val answers = AidenQuestionAnswerDraft.answers(
            questions = questions,
            selections = mapOf(0 to setOf("C", "A")),
            customAnswers = emptyMap()
        )
        // Single-choice collapses to the first advertised label in option order.
        assertEquals(listOf(AidenQuestionAnswer.Option(0, "A")), answers)
    }

    @Test
    fun questionDraftToggleHonorsSingleAndMultiSemantics() {
        var selections = emptyMap<Int, Set<String>>()
        selections = AidenQuestionAnswerDraft.toggled(selections, 0, "Small", multiSelect = false)
        assertEquals(setOf("Small"), selections[0])
        // Single-select replaces rather than accumulates.
        selections = AidenQuestionAnswerDraft.toggled(selections, 0, "Large", multiSelect = false)
        assertEquals(setOf("Large"), selections[0])
        // Toggling the same label off removes the empty set.
        selections = AidenQuestionAnswerDraft.toggled(selections, 0, "Large", multiSelect = false)
        assertNull(selections[0])

        var multi = emptyMap<Int, Set<String>>()
        multi = AidenQuestionAnswerDraft.toggled(multi, 1, "A", multiSelect = true)
        multi = AidenQuestionAnswerDraft.toggled(multi, 1, "B", multiSelect = true)
        assertEquals(setOf("A", "B"), multi[1])
        multi = AidenQuestionAnswerDraft.toggled(multi, 1, "A", multiSelect = true)
        assertEquals(setOf("B"), multi[1])
    }

    @Test
    fun pendingQuestionResolutionBindsStreamChatAndExpiry() {
        val pending = AidenQuestionContractCodec.parsePendingQuestion(
            pendingJson("[${questionJson()}]")
        )
        val now = Instant.parse("2026-08-18T19:00:00.000Z")
        val resolved = AidenPendingQuestionResolution.resolve(
            pending, streamId = "stream-1", chatId = "chat-1", now = now
        )
        assertEquals("q-1", resolved?.id)
        assertEquals(true, resolved?.canRespond)
        assertNull(
            AidenPendingQuestionResolution.resolve(
                pending, streamId = "stream-2", chatId = "chat-1", now = now
            )
        )
        assertNull(
            AidenPendingQuestionResolution.resolve(
                pending, streamId = "stream-1", chatId = "chat-2", now = now
            )
        )
        assertNull(
            AidenPendingQuestionResolution.resolve(
                pending, streamId = "stream-1", chatId = "chat-1",
                now = Instant.parse("2026-08-18T19:07:00.000Z")
            )
        )
        assertNull(AidenPendingQuestionResolution.resolve(null, "stream-1", "chat-1", now = now))
    }

    @Test
    fun questionCodecRejectsMalformedPrompts() {
        // Unknown field fails closed.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                json.parseToJsonElement(
                    """{"promptId":"q","streamId":"s","chatId":"c","toolCallId":"t",
                       "questions":${"[" + questionJson() + "]"},
                       "expiresAt":"2026-08-18T19:06:10.000Z","extra":1}"""
                )
            )
        }
        // More than four questions.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                pendingJson("[${questionJson("Q1?")},${questionJson("Q2?")},${questionJson("Q3?")},${questionJson("Q4?")},${questionJson("Q5?")}]")
            )
        }
        // Fewer than two options.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                pendingJson("""[${questionJson(options = """[{"label":"Only","description":"o"}]""")}]""")
            )
        }
        // Duplicate option labels.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                pendingJson("""[${questionJson(options = """[{"label":"Same","description":"a"},{"label":"Same","description":"b"}]""")}]""")
            )
        }
        // Reserved label.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                pendingJson("""[${questionJson(options = """[{"label":"Other","description":"o"},{"label":"Fine","description":"f"}]""")}]""")
            )
        }
        // Duplicate question prompts.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parsePendingQuestion(
                pendingJson("[${questionJson("Same?")},${questionJson("Same?")}]")
            )
        }
    }

    @Test
    fun questionRespondRequestCodecEnforcesEnvelopeAndKinds() {
        val valid = AidenQuestionContractCodec.parseRespondRequest(
            json.parseToJsonElement(
                """{"cancelled":false,"answers":[{"questionIndex":0,"kind":"option","answer":"Small"}]}"""
            )
        )
        assertEquals(listOf(AidenQuestionAnswer.Option(0, "Small")), valid.answers)

        val multi = AidenQuestionContractCodec.parseRespondRequest(
            json.parseToJsonElement(
                """{"cancelled":false,"answers":[{"questionIndex":1,"kind":"multi","selected":["A","B"]}]}"""
            )
        )
        assertEquals(listOf(AidenQuestionAnswer.Multi(1, listOf("A", "B"))), multi.answers)

        // Extra envelope key fails closed.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parseRespondRequest(
                json.parseToJsonElement("""{"cancelled":false,"answers":[],"turnId":"t"}""")
            )
        }
        // Unknown kind.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parseRespondRequest(
                json.parseToJsonElement("""{"cancelled":false,"answers":[{"questionIndex":0,"kind":"freeform","answer":"x"}]}""")
            )
        }
        // Stray per-kind key.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parseRespondRequest(
                json.parseToJsonElement(
                    """{"cancelled":false,"answers":[{"questionIndex":0,"kind":"option","answer":"x","selected":["y"]}]}"""
                )
            )
        }
        // Duplicate multi labels.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parseRespondRequest(
                json.parseToJsonElement("""{"cancelled":false,"answers":[{"questionIndex":0,"kind":"multi","selected":["A","A"]}]}""")
            )
        }
        // Negative index.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenQuestionContractCodec.parseRespondRequest(
                json.parseToJsonElement("""{"cancelled":false,"answers":[{"questionIndex":-1,"kind":"option","answer":"x"}]}""")
            )
        }
    }

    @Test
    fun questionRespondRequestEncodesExactWireShape() {
        val request = AidenQuestionRespondRequest(
            cancelled = false,
            answers = listOf(
                AidenQuestionAnswer.Option(0, "Small"),
                AidenQuestionAnswer.Custom(2, "note"),
                AidenQuestionAnswer.Multi(3, listOf("A", "B"))
            )
        )
        val encoded = request.toJson()
        assertEquals(setOf("cancelled", "answers"), encoded.keys)
        val answers = encoded["answers"] as kotlinx.serialization.json.JsonArray
        assertEquals(
            setOf("questionIndex", "kind", "answer"),
            (answers[0] as kotlinx.serialization.json.JsonObject).keys
        )
        assertEquals(
            setOf("questionIndex", "kind", "selected"),
            (answers[2] as kotlinx.serialization.json.JsonObject).keys
        )
        assertTrue(
            AidenQuestionRespondRequest(cancelled = true, answers = emptyList())
                .toJson()["cancelled"].toString().toBooleanStrict()
        )
    }
}
