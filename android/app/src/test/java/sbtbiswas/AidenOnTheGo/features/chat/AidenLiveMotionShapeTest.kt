package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class AidenLiveMotionShapeTest {
    @Test
    fun streamingCursorBreathesWithinItsBoundsAndLoopsWithoutAJump() {
        val samples = (0..100).map { it / 100f }
        samples.forEach { phase ->
            val alpha = AidenStreamingCursorMotion.alpha(phase)
            val width = AidenStreamingCursorMotion.width(phase)
            assertTrue(alpha in AidenStreamingCursorMotion.MIN_ALPHA..1f)
            assertTrue(width >= AidenStreamingCursorMotion.MinWidth && width <= AidenStreamingCursorMotion.MaxWidth)
        }
        assertEquals(AidenStreamingCursorMotion.alpha(0f), AidenStreamingCursorMotion.alpha(1f), 0.0001f)
        assertEquals(AidenStreamingCursorMotion.width(0f).value, AidenStreamingCursorMotion.width(1f).value, 0.0001f)
        // Brightest and widest together, dimmest and narrowest together.
        assertEquals(1f, AidenStreamingCursorMotion.alpha(0f), 0.0001f)
        assertEquals(AidenStreamingCursorMotion.MaxWidth.value, AidenStreamingCursorMotion.width(0f).value, 0.0001f)
        assertEquals(AidenStreamingCursorMotion.MIN_ALPHA, AidenStreamingCursorMotion.alpha(0.5f), 0.0001f)
        assertEquals(AidenStreamingCursorMotion.MinWidth.value, AidenStreamingCursorMotion.width(0.5f).value, 0.0001f)
        // The reduced-motion capsule fits the slot the breathing capsule reserves.
        assertTrue(AidenStreamingCursorMotion.StaticWidth <= AidenStreamingCursorMotion.MaxWidth)
    }

    @Test
    fun frozenHarmonicCurveStillShowsTheLiveLevelAndStaysInsideItsEnvelope() {
        val height = 36f
        val mid = height / 2f
        fun peak(amplitude: Float) = AidenHarmonicWaveformShape
            .points(320f, height, amplitude, AidenHarmonicWaveformShape.FROZEN_PHASE)
            .maxOf { abs(it.y - mid) }

        val loud = AidenHarmonicWaveformShape.points(320f, height, 1f, AidenHarmonicWaveformShape.FROZEN_PHASE)
        assertEquals(AidenHarmonicWaveformShape.POINTS, loud.size)
        assertEquals(mid, loud.first().y, 0.001f)
        assertEquals(mid, loud.last().y, 0.001f)
        assertEquals(320f, loud.last().x, 0.001f)
        assertTrue(loud.all { abs(it.y - mid) <= mid * 0.85f + 0.001f })
        // A still curve must keep reading the microphone: louder input, taller wave.
        assertTrue(peak(1f) > mid * 0.5f)
        assertTrue(peak(1f) > peak(0.3f))
        // Silence is floored so the curve never collapses to a flat line.
        assertEquals(peak(0.1f), peak(0f), 0.001f)
        assertTrue(peak(0f) > 0f)
    }

    @Test
    fun voiceBarsPeakInTheCentreFollowTheLevelAndKeepAMinimumHeight() {
        val loud = AidenVoiceWaveformBars.heights(1f, 7, maxHeight = 24f, minHeight = 4f)
        assertEquals(7, loud.size)
        loud.zip(loud.reversed()).forEach { (a, b) -> assertEquals(a, b, 0.001f) }
        assertEquals(loud.max(), loud[3], 0.0001f)
        assertTrue(loud.all { it in 4f..24f })

        val quiet = AidenVoiceWaveformBars.heights(0.2f, 7, maxHeight = 24f, minHeight = 4f)
        assertTrue(quiet.zip(loud).all { (q, l) -> q <= l })
        assertTrue(quiet.zip(loud).any { (q, l) -> q < l })
        assertTrue(AidenVoiceWaveformBars.heights(0f, 7, 24f, 4f).all { it >= 4f })

        assertTrue(AidenVoiceWaveformBars.heights(1f, 0, 24f, 4f).isEmpty())
        assertEquals(1, AidenVoiceWaveformBars.heights(1f, 1, 24f, 4f).size)
    }
}
