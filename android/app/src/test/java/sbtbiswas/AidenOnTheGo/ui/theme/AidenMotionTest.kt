package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.VectorConverter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AidenMotionTest {
    private fun FiniteAnimationSpec<Float>.durationMillis(): Long =
        vectorize(Float.VectorConverter).getDurationNanos(
            AnimationVector1D(0f),
            AnimationVector1D(1f),
            AnimationVector1D(0f)
        ) / 1_000_000L

    @Test
    fun shortAndLongStepsRunForTheirUntitledDurations() {
        assertEquals(200L, AidenMotion.short<Float>().durationMillis())
        assertEquals(360L, AidenMotion.long<Float>().durationMillis())
    }

    @Test
    fun reducedMotionMakesTransitionsInstant() {
        assertEquals(0L, AidenMotion.short<Float>(reduceMotion = true).durationMillis())
        assertEquals(0L, AidenMotion.long<Float>(reduceMotion = true).durationMillis())
    }

    @Test
    fun systemRemoveAnimationsReducesMotionEvenWhenTheAppSettingIsOff() {
        assertTrue(AidenMotion.isReducedMotion(appPreference = false, systemAnimatorScale = 0f))
        assertTrue(AidenMotion.isReducedMotion(appPreference = true, systemAnimatorScale = 1f))
        assertFalse(AidenMotion.isReducedMotion(appPreference = false, systemAnimatorScale = 0.5f))
        assertFalse(AidenMotion.isReducedMotion(appPreference = false, systemAnimatorScale = 1f))
    }

    @Test
    fun easingsDecelerateTowardsTheEnd() {
        // Ease-out curves cover most of the distance in the first half.
        assertTrue(AidenMotion.StandardEasing.transform(0.5f) > 0.85f)
        assertTrue(AidenMotion.EmphasizedEasing.transform(0.5f) > 0.85f)
        assertEquals(1f, AidenMotion.StandardEasing.transform(1f), 0.001f)
    }
}
