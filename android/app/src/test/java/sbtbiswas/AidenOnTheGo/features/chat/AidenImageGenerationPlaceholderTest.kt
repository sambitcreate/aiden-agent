package sbtbiswas.AidenOnTheGo.features.chat

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenAgentActivityPresentation
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenChatVisual
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment

class AidenImageGenerationPlaceholderTest {
    private fun imageStep(
        status: AidenAgentStepStatus,
        detail: String? = null,
        index: Int = 1,
        toolName: String = "generate_image",
        startedAt: Double = 1_000.0,
        updatedAt: Double = 2_000.0,
        target: String? = null
    ) = AidenAgentStep(
        id = "tool-$index",
        order = index - 1,
        kind = AidenAgentStep.Kind.TOOL,
        toolCallId = "call-$index",
        toolName = toolName,
        label = "Generate image",
        status = status,
        startedAt = startedAt,
        updatedAt = updatedAt,
        finishedAt = if (status == AidenAgentStepStatus.COMPLETED) updatedAt else null,
        contentOffset = 0,
        target = target,
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
                    elapsedAtObservationMs = 3_000
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

    private fun armed(vararg timelines: AidenGenerationTimeline): Set<String> =
        timelines.fold(emptySet()) { armed, timeline ->
            AidenImageGenerationPlaceholderState.armedArrivalReveals(armed, timeline)
        }

    @Test
    fun arrivalRevealIsArmedOnlyWhenAGenerateImageCallCompletes() {
        assertEquals(emptySet<String>(), armed(timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING)))))
        assertEquals(
            setOf("generation-1"),
            armed(
                timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING))),
                timeline(listOf(imageStep(AidenAgentStepStatus.COMPLETED)))
            )
        )
        // A phone that joins after the call finished still reveals the image.
        assertEquals(
            setOf("generation-1"),
            armed(timeline(listOf(imageStep(AidenAgentStepStatus.COMPLETED)), AidenGenerationTimelineStatus.COMPLETED))
        )
    }

    @Test
    fun failedOrCancelledCallsNeverArmTheReveal() {
        listOf(
            AidenAgentStepStatus.FAILED,
            AidenAgentStepStatus.BLOCKED,
            AidenAgentStepStatus.CANCELLED,
            AidenAgentStepStatus.AWAITING_APPROVAL
        ).forEach { status ->
            assertEquals(
                status.name,
                emptySet<String>(),
                armed(
                    timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING))),
                    timeline(listOf(imageStep(status)), AidenGenerationTimelineStatus.FAILED)
                )
            )
        }
        // Another generation's armed reveal survives an unrelated failed turn.
        assertEquals(
            setOf("generation-0"),
            AidenImageGenerationPlaceholderState.armedArrivalReveals(
                setOf("generation-0"),
                timeline(listOf(imageStep(AidenAgentStepStatus.FAILED)), AidenGenerationTimelineStatus.FAILED)
            )
        )
    }

    private fun image(id: String, call: String? = null) = AidenMessageAttachment(
        id = id, name = "$id.png", mimeType = "image/png", kind = AidenAttachmentKind.IMAGE, size = 10, toolCallId = call
    )

    private fun settledMessage(
        steps: List<AidenAgentStep>,
        attachments: List<AidenMessageAttachment>,
        visuals: List<AidenChatVisual>? = null
    ) = AidenChatMessage(
        id = "assistant-1",
        role = AidenChatRole.ASSISTANT,
        text = "Here it is.",
        attachments = attachments,
        visuals = visuals,
        timeline = timeline(steps, AidenGenerationTimelineStatus.COMPLETED),
        createdAt = Instant.ofEpochSecond(9)
    )

    @Test
    fun onlyTheGeneratedImageRevealsNotVisualSnapshots() {
        val message = settledMessage(
            steps = listOf(imageStep(AidenAgentStepStatus.COMPLETED)),
            attachments = listOf(image("visual-snapshot_chart"), image("chart-png"), image("generated")),
            visuals = listOf(
                AidenChatVisual(id = "ui-1", kind = "ui", title = "Chart", snapshotAttachmentId = "chart-png")
            )
        )
        assertEquals("generated", AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(message))
    }

    @Test
    fun displayImageResultsAndFailedCallsDoNotReveal() {
        // Attachments carry no tool association, so a turn that also displayed an image
        // cannot single out the generated one: nothing reveals.
        val mixed = settledMessage(
            steps = listOf(
                imageStep(AidenAgentStepStatus.COMPLETED, index = 1),
                imageStep(AidenAgentStepStatus.COMPLETED, index = 2, toolName = "display_image")
            ),
            attachments = listOf(image("shown"), image("generated"))
        )
        assertNull(AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(mixed))
        val displayOnly = settledMessage(
            steps = listOf(imageStep(AidenAgentStepStatus.COMPLETED, toolName = "display_image")),
            attachments = listOf(image("shown"))
        )
        assertNull(AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(displayOnly))
        val failed = settledMessage(listOf(imageStep(AidenAgentStepStatus.FAILED)), listOf(image("other")))
        assertNull(AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(failed))
    }

    @Test
    fun imagesThatNameTheirStepRevealOnlyTheGeneratedOne() {
        // Revision 44: each image names its call, so the generated image is found even
        // after a shared image and beside a displayed one.
        val placed = settledMessage(
            steps = listOf(
                imageStep(AidenAgentStepStatus.COMPLETED, index = 1, toolName = "share_image"),
                imageStep(AidenAgentStepStatus.COMPLETED, index = 2),
                imageStep(AidenAgentStepStatus.COMPLETED, index = 3, toolName = "display_image")
            ),
            attachments = listOf(image("shared_a", "call-1"), image("generated", "call-2"), image("shown", "call-3"))
        )
        assertEquals("generated", AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(placed))
        // A placed reply whose generated image never arrived reveals nothing.
        val missing = settledMessage(
            steps = listOf(
                imageStep(AidenAgentStepStatus.COMPLETED, index = 1, toolName = "share_image"),
                imageStep(AidenAgentStepStatus.COMPLETED, index = 2)
            ),
            attachments = listOf(image("shared_a", "call-1"))
        )
        assertNull(AidenImageGenerationPlaceholderState.arrivalRevealAttachmentId(missing))
    }

    @Test
    fun elapsedTimeUsesHostTimestampsNotThePhoneClock() {
        // Started at 1s host time; the newest host time in the timeline is 13s, so the
        // call has run 12s whatever the phone's clock says.
        val items = AidenImageGenerationPlaceholderState.items(
            timeline(
                listOf(
                    imageStep(AidenAgentStepStatus.RUNNING, index = 1, startedAt = 1_000.0, updatedAt = 3_000.0),
                    imageStep(
                        AidenAgentStepStatus.RUNNING, index = 2, toolName = "read_file",
                        startedAt = 13_000.0, updatedAt = 13_000.0
                    )
                )
            )
        )
        assertEquals(listOf(12_000L), items.map { it.elapsedAtObservationMs })
        val skewed = AidenImageGenerationPlaceholderState.items(
            timeline(listOf(imageStep(AidenAgentStepStatus.RUNNING, startedAt = 5_000.0, updatedAt = 5_000.0)))
        )
        assertEquals(listOf(0L), skewed.map { it.elapsedAtObservationMs })
    }

    @Test
    fun captionNamesTheModelWhenTheHostSendsAValidTarget() {
        val item = AidenImageGenerationPlaceholderState.items(
            timeline(
                listOf(imageStep(AidenAgentStepStatus.RUNNING, target = "openrouter/google/gemini-2.5-flash-image"))
            )
        ).single()
        assertEquals(
            "Generating · 12s · OpenRouter · google/gemini-2.5-flash-image",
            AidenImagePlaceholderSpec.caption(12, item.model)
        )
        assertEquals(
            "Still generating · 1m 05s · fal · fal-ai/flux",
            AidenImagePlaceholderSpec.caption(65, AidenImageGenerationModelLabel.fromTarget("fal/fal-ai/flux"))
        )
        listOf(null, "", "no-slash", "/model", "replicate/", "a".repeat(200) + "/m", "fal/x\ny").forEach { target ->
            assertNull(target.toString(), AidenImageGenerationModelLabel.fromTarget(target))
        }
        assertEquals("Generating · 12s", AidenImagePlaceholderSpec.caption(12, null))
    }

    @Test
    fun lensPhaseStaysContinuousWhenThePassSlowsAtOneMinute() {
        assertEquals(
            AidenImagePlaceholderSpec.phase(59_999),
            AidenImagePlaceholderSpec.phase(60_001),
            1e-3f
        )
        // Each regime still completes one pass per its own period.
        assertEquals(0.5f, AidenImagePlaceholderSpec.phase(1_400), 1e-6f)
        val advance = AidenImagePlaceholderSpec.phase(72_600) - AidenImagePlaceholderSpec.phase(70_000)
        assertEquals(0.5f, advance - kotlin.math.floor(advance), 1e-4f)
        assertEquals(0f, AidenImagePlaceholderSpec.phase(-5_000), 0f)
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
