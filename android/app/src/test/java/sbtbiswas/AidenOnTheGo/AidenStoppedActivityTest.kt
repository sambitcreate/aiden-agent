package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenAgentActivityPresentation
import sbtbiswas.AidenOnTheGo.models.AidenAgentActivityPresentation.StepMark
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenGenerationCancellationOrigin
import sbtbiswas.AidenOnTheGo.models.AidenGenerationClaimCheck
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus

/** A call the person ended with Stop reads "stopped", not as an issue; every other cancel still does. */
class AidenStoppedActivityTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun step(
        id: Int,
        toolName: String,
        label: String,
        status: AidenAgentStepStatus,
        stoppedByUser: Boolean? = null
    ) = AidenAgentStep(
        id = "tool-$id",
        order = id - 1,
        kind = AidenAgentStep.Kind.TOOL,
        toolCallId = "call-$id",
        toolName = toolName,
        label = label,
        status = status,
        startedAt = 1_000.0,
        updatedAt = 2_000.0,
        finishedAt = 2_000.0,
        contentOffset = 0,
        stoppedByUser = stoppedByUser
    )

    private fun cancelled(
        steps: List<AidenAgentStep>,
        origin: AidenGenerationCancellationOrigin?,
        claimCheck: AidenGenerationClaimCheck? = null
    ) = AidenGenerationTimeline(
        version = 3,
        generationId = "stream-1",
        status = AidenGenerationTimelineStatus.CANCELLED,
        startedAt = 1_000.0,
        finishedAt = 2_000.0,
        steps = steps,
        cancellationOrigin = origin,
        claimCheck = claimCheck
    )

    @Test
    fun callThePersonStoppedReadsStoppedWithANeutralMarkAndIsNotAnIssue() {
        val read = step(1, "read_file", "Read file", AidenAgentStepStatus.COMPLETED)
        val stopped = step(2, "compact_context", "Compact context", AidenAgentStepStatus.CANCELLED, stoppedByUser = true)
        val timeline = cancelled(listOf(read, stopped), AidenGenerationCancellationOrigin.USER_STOP)

        assertTrue(timeline.isRendererSafe())
        assertTrue(timeline.isStoppedByUser(stopped))
        assertFalse(timeline.isStoppedByUser(timeline.steps[0]))
        assertEquals(0, timeline.issueCount)
        assertEquals(setOf("tool-2"), timeline.userStoppedStepIds)
        assertEquals("Compact context stopped", AidenAgentActivityPresentation.line(stopped, stoppedByUser = true))
        assertEquals(StepMark.STOPPED, AidenAgentActivityPresentation.stepMark(stopped, stoppedByUser = true))
        assertEquals(StepMark.DONE, AidenAgentActivityPresentation.stepMark(timeline.steps[0]))
        // The wire-level status is unchanged: a cancelled call is still an issue status.
        assertTrue(stopped.status!!.isIssue)
    }

    @Test
    fun otherCancellationsAndFailuresStayIssues() {
        val run = step(1, "run_command", "Run command", AidenAgentStepStatus.CANCELLED)
        val origins = listOf(
            AidenGenerationCancellationOrigin.APPLICATION_SHUTDOWN,
            AidenGenerationCancellationOrigin.CHAT_DELETION,
            AidenGenerationCancellationOrigin.SCHEDULED_TASK_CANCEL,
            null
        )
        for (origin in origins) {
            val timeline = cancelled(listOf(run), origin)
            val stoppedByUser = timeline.isStoppedByUser(run)
            assertFalse("$origin", stoppedByUser)
            assertEquals("$origin", 1, timeline.issueCount)
            assertEquals("Run command cancelled", AidenAgentActivityPresentation.line(run, stoppedByUser))
            assertEquals(StepMark.ISSUE, AidenAgentActivityPresentation.stepMark(run, stoppedByUser))
        }

        // A run the person stopped does not hide a call cancelled earlier for
        // another reason: only the calls the Mac marked read as stopped.
        val detached = step(1, "edit_file", "Edit file", AidenAgentStepStatus.CANCELLED)
        val marked = step(2, "run_command", "Run command", AidenAgentStepStatus.CANCELLED, stoppedByUser = true)
        val mixed = cancelled(listOf(detached, marked), AidenGenerationCancellationOrigin.USER_STOP)
        assertFalse(mixed.isStoppedByUser(detached))
        assertTrue(mixed.isStoppedByUser(marked))
        assertEquals(setOf("tool-2"), mixed.userStoppedStepIds)
        assertEquals(1, mixed.issueCount)

        val failed = step(1, "edit_file", "Edit file", AidenAgentStepStatus.FAILED)
        val failedStop = cancelled(listOf(failed), AidenGenerationCancellationOrigin.USER_STOP)
        assertFalse(failedStop.isStoppedByUser(failed))
        assertEquals(1, failedStop.issueCount)
        assertEquals("Edit file failed", AidenAgentActivityPresentation.line(failed, failedStop.isStoppedByUser(failed)))
        assertEquals(StepMark.ISSUE, AidenAgentActivityPresentation.stepMark(failed, stoppedByUser = true))
    }

    @Test
    fun stoppedCallNamedByAClaimCheckStaysAnIssueAndStillValidates() {
        val run = step(1, "run_command", "Run command", AidenAgentStepStatus.CANCELLED, stoppedByUser = true)
        val timeline = cancelled(
            listOf(run),
            AidenGenerationCancellationOrigin.USER_STOP,
            AidenGenerationClaimCheck(AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS, listOf("tool-1"))
        )
        assertFalse(timeline.isStoppedByUser(run))
        assertEquals(1, timeline.issueCount)
        assertTrue(timeline.userStoppedStepIds.isEmpty())
        // The claim-check validator still sees the stopped call as an issue step.
        assertTrue(timeline.isRendererSafe())
    }

    /** Contract revision 61: the shared fixture reads the same here as on the Mac. */
    @Test
    fun stoppedStepsFixtureMatchesTheMac() {
        val root = Json.parseToJsonElement(javaClass.classLoader!!.getResource("contract.json")!!.readText()).jsonObject
        val section = root.getValue("stoppedSteps").jsonObject
        val timeline = json.decodeFromJsonElement(AidenGenerationTimeline.serializer(), section.getValue("timeline"))
        val stoppedIds = section.getValue("stoppedStepIds").jsonArray.map { it.jsonPrimitive.content }
        val issueIds = section.getValue("issueStepIds").jsonArray.map { it.jsonPrimitive.content }

        assertTrue(timeline.isRendererSafe())
        assertEquals(stoppedIds, timeline.steps.filter(timeline::isStoppedByUser).map { it.id })
        assertEquals(
            issueIds,
            timeline.steps.filter { it.status?.isIssue == true && !timeline.isStoppedByUser(it) }.map { it.id }
        )
        assertEquals(issueIds.size, timeline.issueCount)
    }

    @Test
    fun stopMarkDecodesOnlyAsTrueAndSurvivesARoundTrip() {
        fun decode(mark: String?): AidenAgentStep {
            val field = mark?.let { ",\"stoppedByUser\":$it" } ?: ""
            return json.decodeFromString(
                AidenAgentStep.serializer(),
                """{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"run_command","label":"Run command","status":"cancelled","startedAt":1000,"updatedAt":2000,"finishedAt":2000,"contentOffset":0$field}"""
            )
        }
        val marked = decode("true")
        assertEquals(true, marked.stoppedByUser)
        val roundTrip = json.decodeFromString(AidenAgentStep.serializer(), json.encodeToString(AidenAgentStep.serializer(), marked))
        assertEquals(true, roundTrip.stoppedByUser)
        val unmarked = decode(null)
        assertNull(unmarked.stoppedByUser)
        assertNull(json.decodeFromString(AidenAgentStep.serializer(), json.encodeToString(AidenAgentStep.serializer(), unmarked)).stoppedByUser)
        // An older or unexpected value never rejects the step; it reads as unmarked.
        assertNull(decode("false").stoppedByUser)
        assertNull(decode("\"yes\"").stoppedByUser)
        assertNull(decode("null").stoppedByUser)
        assertNull(decode("{}").stoppedByUser)
    }
}
