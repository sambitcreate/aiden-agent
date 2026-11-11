package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    private fun step(id: Int, toolName: String, label: String, status: AidenAgentStepStatus) = AidenAgentStep(
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
        contentOffset = 0
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
        val stopped = step(2, "compact_context", "Compact context", AidenAgentStepStatus.CANCELLED)
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

        val failed = step(1, "edit_file", "Edit file", AidenAgentStepStatus.FAILED)
        val failedStop = cancelled(listOf(failed), AidenGenerationCancellationOrigin.USER_STOP)
        assertFalse(failedStop.isStoppedByUser(failed))
        assertEquals(1, failedStop.issueCount)
        assertEquals("Edit file failed", AidenAgentActivityPresentation.line(failed, failedStop.isStoppedByUser(failed)))
        assertEquals(StepMark.ISSUE, AidenAgentActivityPresentation.stepMark(failed, stoppedByUser = true))
    }

    @Test
    fun stoppedCallNamedByAClaimCheckStaysAnIssueAndStillValidates() {
        val run = step(1, "run_command", "Run command", AidenAgentStepStatus.CANCELLED)
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
}
