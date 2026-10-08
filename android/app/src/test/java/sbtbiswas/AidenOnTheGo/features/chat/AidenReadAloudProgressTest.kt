package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class AidenReadAloudProgressTest {
    private fun ratio(
        phase: AidenReadAloudPhase,
        ready: Int = 0,
        total: Int = 4,
        playing: Int = 0,
        fraction: Float = 0f
    ) = AidenReadAloudProgress.ratio(phase, ready, total, playing, fraction)

    @Test
    fun nothingIsProgressedBeforeTheDesktopReportsSegments() {
        assertEquals(0f, ratio(AidenReadAloudPhase.IDLE, ready = 3), 0f)
        assertEquals(0f, ratio(AidenReadAloudPhase.PREPARING, ready = 3), 0f)
        assertEquals(0f, ratio(AidenReadAloudPhase.GENERATING, ready = 0, total = 0), 0f)
    }

    @Test
    fun generationTracksReadySegments() {
        assertEquals(0.4f, ratio(AidenReadAloudPhase.GENERATING, ready = 2, total = 5), 0.0001f)
        assertEquals(1f, ratio(AidenReadAloudPhase.GENERATING, ready = 5, total = 5), 0f)
    }

    @Test
    fun playbackCombinesFinishedSegmentsWithTheCurrentSegmentPosition() {
        assertEquals(0.375f, ratio(AidenReadAloudPhase.PLAYING, ready = 4, playing = 1, fraction = 0.5f), 0.0001f)
        assertEquals(0.75f, ratio(AidenReadAloudPhase.PLAYING, ready = 4, playing = 3, fraction = 0f), 0.0001f)
    }

    @Test
    fun outOfRangeReportsStayWithinTheTrack() {
        assertEquals(1f, ratio(AidenReadAloudPhase.GENERATING, ready = 9, total = 5), 0f)
        assertEquals(1f, ratio(AidenReadAloudPhase.PLAYING, playing = 12, fraction = 3f), 0f)
        assertEquals(0f, ratio(AidenReadAloudPhase.PLAYING, playing = -2, fraction = -1f), 0f)
    }

    @Test
    fun segmentsFillInOrderUpToTheOverallRatio() {
        val fills = (0 until 4).map { AidenReadAloudProgress.segmentFill(it, 4, 0.375f) }
        assertEquals(listOf(1f, 0.5f, 0f, 0f), fills)
    }

    @Test
    fun longReadsCollapseToOneContinuousTrack() {
        assertEquals(5, AidenReadAloudProgress.visibleSegments(5))
        assertEquals(1, AidenReadAloudProgress.visibleSegments(AidenReadAloudProgress.MAXIMUM_VISIBLE_SEGMENTS + 1))
        assertEquals(1, AidenReadAloudProgress.visibleSegments(0))
        assertEquals(0.6f, AidenReadAloudProgress.segmentFill(0, 1, 0.6f), 0f)
    }

    @Test
    fun labelNamesThePhaseAndOneBasedSegmentPosition() {
        assertEquals("Preparing audio", AidenReadAloudProgress.label(AidenReadAloudPhase.PREPARING, 0, 0, 0))
        assertEquals("Generating audio · 2 of 5", AidenReadAloudProgress.label(AidenReadAloudPhase.GENERATING, 2, 5, 0))
        assertEquals("Reading aloud · 2 of 4", AidenReadAloudProgress.label(AidenReadAloudPhase.PLAYING, 4, 4, 1))
        assertEquals("Reading aloud", AidenReadAloudProgress.label(AidenReadAloudPhase.PLAYING, 1, 1, 0))
    }
}
