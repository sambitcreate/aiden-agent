package sbtbiswas.AidenOnTheGo.features.chat

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenAgentActivityPresentation
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus

class AidenImageGenerationPlaceholderTest {
    private fun imageStep(
        status: AidenAgentStepStatus,
        detail: String? = null,
        index: Int = 1,
        toolName: String = "generate_image",
        updatedAt: Double = 2_000.0
    ) = AidenAgentStep(
        id = "tool-$index",
        order = index - 1,
        kind = AidenAgentStep.Kind.TOOL,
        toolCallId = "call-$index",
        toolName = toolName,
        label = "Generate image",
        status = status,
        startedAt = 1_000.0,
        updatedAt = updatedAt,
        finishedAt = if (status == AidenAgentStepStatus.COMPLETED) updatedAt else null,
        contentOffset = 0,
        detail = detail
    )

    private fun timeline(
        steps: List<AidenAgentStep>,
        status: AidenGenerationTimelineStatus = AidenGenerationTimelineStatus.RUNNING
    ) = AidenGenerationTimeline(
        version = 3,
        generationId = "generation-1",
        status = status,
        startedAt = 1_000.0,
        finishedAt = if (status == AidenGenerationTimelineStatus.RUNNING) null else 9_000.0,
        steps = steps
    )

    @Test
    fun runningCallShowsPlaceholderInItsRequestedShape() {
        val items = AidenImageGenerationPlaceholderState.items(
            timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING, detail = "16:9", updatedAt = 4_000.0)))
        )
        assertEquals(
            listOf(
                AidenImageGenerationPlaceholderItem(
                    id = "call-1",
                    aspectRatio = AidenImageAspectRatio.LANDSCAPE_16_9,
                    runningSince = Instant.ofEpochMilli(4_000)
                )
            ),
            items
        )
        assertEquals(16f / 9f, items.single().aspectRatio.widthOverHeight, 1e-6f)
    }

    @Test
    fun missingOrUnknownShapeFallsBackToSquare() {
        val items = AidenImageGenerationPlaceholderState.items(
            timeline(
                listOf(
                    imageStep(AidenAgentStepStatus.RUNNING, detail = null, index = 1),
                    imageStep(AidenAgentStepStatus.RUNNING, detail = "21:9", index = 2)
                )
            )
        )
        assertEquals(listOf(AidenImageAspectRatio.SQUARE, AidenImageAspectRatio.SQUARE), items.map { it.aspectRatio })
    }

    @Test
    fun callsBeforeApprovalOrThatEndedWithoutAnImageShowNoPlaceholder() {
        listOf(
            AidenAgentStepStatus.PENDING,
            AidenAgentStepStatus.AWAITING_APPROVAL,
            AidenAgentStepStatus.FAILED,
            AidenAgentStepStatus.BLOCKED,
            AidenAgentStepStatus.CANCELLED
        ).forEach { status ->
            assertEquals(
                status.name,
                emptyList<AidenImageGenerationPlaceholderItem>(),
                AidenImageGenerationPlaceholderState.items(timeline(listOf(imageStep(status, detail = "1:1"))))
            )
        }
    }

    @Test
    fun completedCallHoldsUntilTheTurnSettlesThenClears() {
        // The image reaches the phone with the settled message, so a finished call keeps
        // its placeholder while the turn still streams.
        assertEquals(
            listOf(AidenImageAspectRatio.PORTRAIT_3_4),
            AidenImageGenerationPlaceholderState.items(
                timeline(listOf(imageStep(AidenAgentStepStatus.COMPLETED, detail = "3:4")))
            ).map { it.aspectRatio }
        )
        listOf(
            AidenGenerationTimelineStatus.COMPLETED,
            AidenGenerationTimelineStatus.FAILED,
            AidenGenerationTimelineStatus.CANCELLED
        ).forEach { status ->
            assertTrue(
                AidenImageGenerationPlaceholderState.items(
                    timeline(listOf(imageStep(AidenAgentStepStatus.COMPLETED)), status)
                ).isEmpty()
            )
        }
        assertTrue(AidenImageGenerationPlaceholderState.items(null).isEmpty())
    }

    @Test
    fun otherToolsNeverShowAPlaceholder() {
        assertTrue(
            AidenImageGenerationPlaceholderState.items(
                timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING, detail = "16:9", toolName = "display_image")))
            ).isEmpty()
        )
    }

    @Test
    fun arrivalRevealIsArmedOnlyForGenerationsWatchedRunning() {
        assertEquals(
            "generation-1",
            AidenImageGenerationPlaceholderState.arrivalRevealGenerationId(
                timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING)))
            )
        )
        assertEquals(
            "generation-1",
            AidenImageGenerationPlaceholderState.arrivalRevealGenerationId(
                timeline(listOf(imageStep(AidenAgentStepStatus.COMPLETED)), AidenGenerationTimelineStatus.COMPLETED)
            )
        )
        assertNull(
            AidenImageGenerationPlaceholderState.arrivalRevealGenerationId(
                timeline(listOf(imageStep(AidenAgentStepStatus.AWAITING_APPROVAL)))
            )
        )
        assertNull(
            AidenImageGenerationPlaceholderState.arrivalRevealGenerationId(
                timeline(listOf(imageStep(AidenAgentStepStatus.BLOCKED)))
            )
        )
    }

    @Test
    fun reduceMotionAndBatterySaverHoldTheStillPose() {
        assertEquals(AidenImagePlaceholderMotion.ANIMATED, AidenImagePlaceholderMotion.resolve(false, false))
        assertEquals(AidenImagePlaceholderMotion.STILL, AidenImagePlaceholderMotion.resolve(true, false))
        assertEquals(AidenImagePlaceholderMotion.STILL, AidenImagePlaceholderMotion.resolve(false, true))
        // The still lens rests around 40% of the placeholder.
        val height = 100f
        val center = AidenImagePlaceholderSpec.stillLensTop(height) +
            height * AidenImagePlaceholderSpec.LENS_HEIGHT_FRACTION / 2
        assertEquals(0.4f, center / height, 0.05f)
    }

    @Test
    fun lensTravelsTopToBottomThenRests() {
        val height = 200f
        val lens = height * AidenImagePlaceholderSpec.LENS_HEIGHT_FRACTION
        assertEquals(-lens, AidenImagePlaceholderSpec.lensTop(AidenImagePlaceholderSpec.lensProgress(0f), height), 1e-3f)
        assertEquals(height, AidenImagePlaceholderSpec.lensTop(AidenImagePlaceholderSpec.lensProgress(0.78f), height), 1e-3f)
        assertEquals(1f, AidenImagePlaceholderSpec.lensProgress(0.9f), 0f)
        assertTrue(AidenImagePlaceholderSpec.lensProgress(0.2f) < AidenImagePlaceholderSpec.lensProgress(0.6f))
        // Eases in: the first fifth of the travel covers less than a fifth of the distance.
        assertTrue(AidenImagePlaceholderSpec.lensProgress(0.78f * 0.2f) < 0.2f)
    }

    @Test
    fun longRunsSlowDownAndSayStillGenerating() {
        assertEquals("Generating · 12s", AidenImagePlaceholderSpec.caption(12))
        assertEquals("Generating · 0s", AidenImagePlaceholderSpec.caption(-3))
        assertEquals("Still generating · 1m 12s", AidenImagePlaceholderSpec.caption(72))
        assertEquals("Still generating · 1m 05s", AidenImagePlaceholderSpec.caption(65))
        assertEquals(2_800, AidenImagePlaceholderSpec.periodMs(59))
        assertEquals(5_200, AidenImagePlaceholderSpec.periodMs(60))
    }

    @Test
    fun generateImageActivityLineNamesTheShape() {
        assertEquals(
            "Generating image 16:9",
            AidenAgentActivityPresentation.line(imageStep(AidenAgentStepStatus.RUNNING, detail = "16:9"))
        )
        assertEquals(
            "Generated image",
            AidenAgentActivityPresentation.line(imageStep(AidenAgentStepStatus.COMPLETED))
        )
    }
}
