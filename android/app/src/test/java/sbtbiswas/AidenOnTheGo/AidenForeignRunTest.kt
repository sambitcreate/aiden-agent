package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenForeignRunProjection
import sbtbiswas.AidenOnTheGo.models.AidenForeignRunProjection.Effect
import sbtbiswas.AidenOnTheGo.models.AidenForeignRunResolution
import sbtbiswas.AidenOnTheGo.models.AidenStreamState
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEndState
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRunEventCodec
import sbtbiswas.AidenOnTheGo.networking.AidenRunSSEParser
import sbtbiswas.AidenOnTheGo.networking.AidenSSEParser
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import sbtbiswas.AidenOnTheGo.protocol.AidenSSEParserException

/** Contract revision 21: phones observe and control runs started elsewhere. */
class AidenForeignRunTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun contractText(): String =
        javaClass.classLoader!!.getResource("contract.json")!!.readText()

    private fun fixtureRunEvents(): List<AidenRemoteRunEvent> =
        Json.parseToJsonElement(contractText()).jsonObject.getValue("phoneRunEvents").jsonArray.map {
            AidenRunEventCodec.decode(it.toString().toByteArray(Charsets.UTF_8))
        }

    private fun consumeAll(lines: List<String>): List<AidenRemoteRunEvent> {
        val parser = AidenRunSSEParser()
        return lines.mapNotNull { parser.consume(it) }
    }

    @Test
    fun phoneRunFixtureDrivesForeignRunProjectionThroughFirstResponderOutcomes() {
        val events = fixtureRunEvents()
        assertEquals(13, events.size)
        assertTrue(events.all { it.runId == "run_fixture_02" })
        // `run.ended` repeats the content terminal's sequence and is the only
        // run-level terminal frame.
        assertEquals(listOf(12, 12), events.takeLast(2).map { it.sequence })
        assertEquals(AidenRemoteRunEvent.Kind.Ended("chat_fixture_01", AidenRemoteRunEndState.DONE), events.last().kind)

        val projection = AidenForeignRunProjection("run_fixture_02")
        val effects = events.take(6).map { projection.apply(it) }
        // Attaching mid-run surfaces status, text and tool rows like an owned run.
        assertEquals("Checking the build.", projection.liveText)
        assertEquals(listOf("run_command"), projection.tools.map { it.name })
        assertEquals("succeeded", projection.tools.first().status)
        assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, projection.state)
        val allowable = requireNotNull(projection.pendingApproval)
        assertEquals("approval_fixture_02", allowable.approvalId)
        assertTrue(allowable.canAllow)
        assertEquals(listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT), allowable.scopes)
        assertEquals(listOf(Effect.ApprovalRequired("approval_fixture_02")), effects.last())

        // The Mac answered first: the phone learns the winning decision.
        val lost = projection.apply(events[6])
        assertEquals(
            listOf(Effect.AnsweredElsewhere(AidenForeignRunResolution(
                AidenForeignRunResolution.Prompt.Approval(AidenApprovalDecision.ALLOW), events[6].timestamp
            ))),
            lost
        )
        assertNull(projection.pendingApproval)
        assertEquals(AidenStreamState.RUNNING, projection.state)
        assertEquals("Answered on Mac: allowed", (lost.single() as Effect.AnsweredElsewhere).resolution.notice)

        // A host-only approval reaches the phone as deny-only, without scopes.
        projection.apply(events[7])
        val hostOnly = requireNotNull(projection.pendingApproval)
        assertFalse(hostOnly.canAllow)
        assertNull(hostOnly.scopes)
        // This phone answered it, so its resolution is not "answered elsewhere".
        projection.markAnsweredLocally(hostOnly.approvalId)
        assertEquals(emptyList<Effect>(), projection.apply(events[8]))

        assertEquals(listOf(Effect.QuestionRequired("q-fixture-02")), projection.apply(events[9]))
        assertEquals("Chamfer", projection.pendingQuestion?.questions?.first()?.header)
        assertEquals(
            listOf(Effect.AnsweredElsewhere(AidenForeignRunResolution(
                AidenForeignRunResolution.Prompt.Question("answered"), events[10].timestamp
            ))),
            projection.apply(events[10])
        )

        // A replayed frame is ignored; the content terminal and run.ended share
        // a sequence and only run.ended closes the projection.
        assertEquals(emptyList<Effect>(), projection.apply(events[3]))
        assertEquals(emptyList<Effect>(), projection.apply(events[11]))
        assertFalse(projection.isEnded)
        assertEquals(listOf(Effect.Ended(AidenRemoteRunEndState.DONE)), projection.apply(events[12]))
        assertTrue(projection.isEnded)
        assertEquals(AidenStreamState.DONE, projection.state)
        assertEquals("An ended run accepts nothing further.", emptyList<Effect>(), projection.apply(events[12]))
    }

    @Test
    fun runStreamGapSnapshotAtSequenceZeroRestatesPendingPrompts() {
        val snapshot = """{"protocolVersion":1,"streamId":"run-1","sequence":0,"timestamp":"2026-10-05T10:00:00Z","type":"snapshot","terminal":false,"payload":{"runId":"run-1","chatId":"chat-1","reason":"gap","epoch":"e1","state":"running","pendingApprovalIds":["approval-1"],"pendingQuestionIds":[],"approvals":[{"approvalId":"approval-1","summary":"Run the tests?","toolName":"run_command","canAllow":true,"scopes":["once"]}],"questions":[],"nextSequence":1}}"""
        val text = """{"protocolVersion":1,"streamId":"run-1","sequence":1,"timestamp":"2026-10-05T10:00:01Z","type":"text_delta","terminal":false,"payload":{"text":"Still going"}}"""
        val events = consumeAll(
            listOf("id: 0", "event: snapshot", "data: $snapshot", "", ": keep-alive", "id: 1", "event: text_delta", "data: $text", "")
        )
        assertEquals(listOf(0, 1), events.map { it.sequence })

        val projection = AidenForeignRunProjection("run-1")
        assertEquals(listOf(Effect.Reconcile), projection.apply(events[0]))
        assertEquals("approval-1", projection.pendingApproval?.approvalId)
        assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, projection.state)
        assertEquals(listOf(Effect.TextAppended("Still going")), projection.apply(events[1]))
        assertEquals(1, projection.lastSequence)

        // The projection of a different run never absorbs these frames.
        val other = AidenForeignRunProjection("run-2")
        assertEquals(emptyList<Effect>(), other.apply(events[1]))
        assertEquals("", other.liveText)

        // Turn streams keep their sequence floor of 1, and run frames must
        // agree with their SSE id and event name.
        val turnParser = AidenSSEParser()
        assertThrows(AidenSSEParserException.InvalidEventID::class.java) {
            listOf("id: 0", "data: $text", "").forEach { turnParser.consume(it) }
        }
        assertThrows(AidenSSEParserException.EventIDMismatch::class.java) {
            consumeAll(listOf("id: 2", "data: $text", ""))
        }
        assertThrows(AidenSSEParserException.EventNameMismatch::class.java) {
            consumeAll(listOf("id: 1", "event: snapshot", "data: $text", ""))
        }
    }

    @Test
    fun snapshotStillListingAnUnconfirmedLocalAnswerRestoresThePrompt() {
        fun snapshot(sequence: Int): AidenRemoteRunEvent = AidenRunEventCodec.decode(
            """{"protocolVersion":1,"streamId":"run-1","sequence":$sequence,"timestamp":"2026-10-05T10:00:00Z","type":"snapshot","terminal":false,"payload":{"runId":"run-1","chatId":"chat-1","reason":"gap","epoch":"e1","state":"waiting_for_approval","pendingApprovalIds":["approval-1"],"pendingQuestionIds":["q-1"],"approvals":[{"approvalId":"approval-1","summary":"Run the tests?","toolName":"run_command","canAllow":true,"scopes":["once"]}],"questions":[{"promptId":"q-1","questions":[{"question":"Which branch?","header":"Branch","multiSelect":false,"options":[{"label":"main","description":"Default."},{"label":"release","description":"Release."}]}],"toolCallId":"call-q"}],"nextSequence":${sequence + 1}}}"""
                .toByteArray(Charsets.UTF_8)
        )
        val projection = AidenForeignRunProjection("run-1")
        projection.apply(snapshot(0))
        assertEquals("approval-1", projection.pendingApproval?.approvalId)
        assertEquals("q-1", projection.pendingQuestion?.promptId)

        // Marked before the write is sent: a snapshot taken while it is in
        // flight does not bring the answered cards back.
        projection.markAnsweredLocally("approval-1")
        projection.markAnsweredLocally("q-1")
        projection.apply(snapshot(0))
        assertNull(projection.pendingApproval)
        assertNull(projection.pendingQuestion)

        // Both writes failed. The Mac still lists both prompts, so the next
        // authoritative snapshot makes them actionable again.
        projection.answerUnconfirmed("approval-1")
        projection.answerUnconfirmed("q-1")
        projection.apply(snapshot(0))
        assertEquals("approval-1", projection.pendingApproval?.approvalId)
        assertEquals("q-1", projection.pendingQuestion?.promptId)
        assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, projection.state)
    }

    @Test
    fun runApprovalProjectionRejectsToolDetailsAndUnearnedScopes() {
        fun frame(payload: String, type: String = "approval_required", terminal: Boolean = false): ByteArray =
            """{"protocolVersion":1,"streamId":"run-1","sequence":3,"timestamp":"2026-10-05T10:00:00Z","type":"$type","terminal":$terminal,"payload":$payload}"""
                .toByteArray(Charsets.UTF_8)

        val denyOnly = AidenRunEventCodec.decode(
            frame("""{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":false}""")
        ).kind as AidenRemoteRunEvent.Kind.ApprovalRequired
        assertFalse(denyOnly.approval.canAllow)

        val rejected = listOf(
            // Tool arguments and host previews stay on the Mac.
            frame("""{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":true,"details":{"path":"/etc/hosts"}}"""),
            // Scopes are offered only when the phone may allow.
            frame("""{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":false,"scopes":["once"]}"""),
            frame("""{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":true,"scopes":["once","once"]}"""),
            // run.ended is the only run-level terminal, and names its own run.
            frame("""{"runId":"run-1","chatId":"chat-1","state":"done"}""", type = "run.ended", terminal = false),
            frame("""{"runId":"run-other","chatId":"chat-1","state":"done"}""", type = "run.ended", terminal = true),
            // Progress snapshots belong to the chat progress channel, never a run.
            frame("""{"tasks":[]}""", type = "task_update")
        )
        for (bytes in rejected) {
            assertThrows(String(bytes), Exception::class.java) { AidenRunEventCodec.decode(bytes) }
        }
    }

    @Test
    fun firstResponderLoserEnvelopeNamesTheWinningAnswer() {
        fun loser(status: Int, body: String): AidenForeignRunResolution? = AidenForeignRunResolution.loser(
            AidenRemoteClientException.Server(status, json.decodeFromString<AidenRemoteErrorEnvelope>(body).error)
        )
        val fixtureError = requireNotNull(
            json.decodeFromString<sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture>(contractText()).runControlError
        ).error
        val denied = requireNotNull(AidenForeignRunResolution.loser(AidenRemoteClientException.Server(409, fixtureError)))
        assertEquals(AidenForeignRunResolution.Prompt.Approval(AidenApprovalDecision.DENY), denied.prompt)
        assertEquals("Answered on Mac: denied", denied.notice)
        assertNotNull(denied.resolvedAt)

        val expired = requireNotNull(loser(409, """{"error":{"code":"question_already_resolved","message":"Resolved.","requestId":"r1","retryable":false,"details":{"outcome":"expired","resolvedAt":"2026-10-05T10:00:00.000Z"}}}"""))
        assertEquals("Question expired on Mac", expired.notice)
        assertNull(loser(403, """{"error":{"code":"capability_denied","message":"No.","requestId":"r2","retryable":false}}"""))
        assertNull(AidenForeignRunResolution.loser(AidenRemoteClientException.InvalidResponse()))
    }
}
