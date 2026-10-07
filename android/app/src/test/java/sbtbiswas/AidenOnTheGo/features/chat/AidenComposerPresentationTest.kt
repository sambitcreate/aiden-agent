package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenModel

class AidenComposerPresentationTest {
    @Test
    fun aStreamingResponseShowsTheStopStateEvenWhenADraftCouldBeSent() {
        assertEquals(AidenComposerActionState.BUSY, aidenComposerSendActionState(isStreaming = true, canSend = true))
        assertEquals(AidenComposerActionState.READY, aidenComposerSendActionState(isStreaming = false, canSend = true))
        assertEquals(AidenComposerActionState.IDLE, aidenComposerSendActionState(isStreaming = false, canSend = false))
    }

    @Test
    fun waitingActionsAreCirclesAndStoppingActionsAreSquircles() {
        val size = 48.dp
        for (waiting in listOf(AidenComposerActionState.IDLE, AidenComposerActionState.READY)) {
            assertEquals("$waiting is a circle", size / 2, aidenComposerActionCornerRadius(waiting, size))
        }
        for (active in listOf(AidenComposerActionState.BUSY, aidenComposerVoiceActionState(isListening = true))) {
            val radius = aidenComposerActionCornerRadius(active, size)
            assertTrue("$active radius $radius stays inside the 12-24dp squircle range", radius >= 12.dp && radius <= 24.dp)
            assertTrue("$active is visibly squarer than a circle", radius < size / 2)
        }
    }

    @Test
    fun aSmallActionNeverGetsCornersLargerThanACircle() {
        val size = 20.dp
        assertEquals(size / 2, aidenComposerActionCornerRadius(AidenComposerActionState.BUSY, size))
    }

    @Test
    fun thinkingLaddersUpToFourFitOneSegmentedRowAndLongerOnesBecomeAList() {
        assertEquals(AidenComposerThinkingSelector.NONE, aidenComposerThinkingSelector(emptyList()))
        assertEquals(AidenComposerThinkingSelector.SEGMENTED, aidenComposerThinkingSelector(listOf("low", "high")))
        assertEquals(AidenComposerThinkingSelector.SEGMENTED, aidenComposerThinkingSelector(listOf("off", "low", "medium", "high")))
        assertEquals(
            AidenComposerThinkingSelector.LIST,
            aidenComposerThinkingSelector(listOf("off", "minimal", "low", "medium", "high"))
        )
        // A lone level has nothing to segment against.
        assertEquals(AidenComposerThinkingSelector.LIST, aidenComposerThinkingSelector(listOf("high")))
    }

    @Test
    fun aStaleThinkingLevelFallsBackToTheModelDefault() {
        val model = AidenModel(id = "m", label = "M", thinkingLevels = listOf("low", "medium", "high"))
        assertEquals("high", aidenComposerSelectedThinkingLevel(model, "high"))
        assertEquals("medium", aidenComposerSelectedThinkingLevel(model, "xhigh"))
        assertEquals("medium", aidenComposerSelectedThinkingLevel(model, null))
    }
}
